/**
 * Vura runtime — CelsianApp-backed API application factory (A1.3).
 *
 * Creates a CelsianApp from a Vura route manifest, wiring up:
 *   - Per-method handlers with the ThenRequest compat shim
 *   - Global lifecycle hooks (onRequest / onError / onResponse)
 *   - The /__vura/revalidate webhook for ISR cache invalidation
 *
 * Route registration uses Celsian's direct method registrars (app.get, app.post,
 * etc.) which accept the same `:param` URL pattern syntax as Vura manifests.
 */

import { createApp, HttpError as CelsianHttpError, ValidationError as CelsianValidationError, type CelsianApp, type CelsianRequest, type CelsianReply } from '@celsian/core';
import { dispatchAction, issueActionToken, type ActionRequestLike } from './actions.js';
import { applyThenCompat } from '../compat.js';
import { getErrorMode, isHttpError } from '../errors.js';
import type { ApiRoute, HttpMethod } from '../manifest.js';

export interface RuntimeApiRoute extends ApiRoute {
  /** Loaded module exports: GET/POST/... handlers, optional schema/hooks exports */
  module: Record<string, unknown>;
}

export interface GlobalHooks {
  onRequest?: Array<(req: CelsianRequest, reply: CelsianReply) => unknown>;
  onError?: Array<(err: unknown, req: CelsianRequest, reply: CelsianReply) => unknown>;
  onResponse?: Array<(req: CelsianRequest, reply: CelsianReply) => unknown>;
}

export interface ApiAppOptions {
  routes: RuntimeApiRoute[];
  globalHooks?: GlobalHooks;
  /**
   * Optional revalidation webhook handler. When provided, a POST route is
   * mounted at /__vura/revalidate. The handler receives a plain-object
   * representation of the request (headers record + parsed body) so it
   * doesn't need to deal with Web Request APIs.
   *
   * Both `headers` and `body` are marked optional here so that what-isr's
   * `WebhookRequest`-typed handler (`headers?: …; body?: …`) is directly
   * assignable without a cast. The call site always passes both fields, so
   * the looser parameter contract is safe — TypeScript's contravariance rule
   * requires the *option* type to be no stricter than the callee's param type.
   */
  revalidateWebhook?: (reqLike: { headers?: Record<string, string>; body?: any }) => Promise<{ status: number; body?: unknown }>;
  /**
   * Mount `GET/POST /__vura/action` when the project has server actions.
   * Off by default: a project with no `src/actions/` should not expose the
   * endpoint at all, so a probe for it gets a 404 rather than a 403.
   */
  enableActions?: boolean;
}

/** Flatten a Web `Headers` into the lower-cased record the action layer reads. */
function headerRecord(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((value: string, key: string) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function toActionRequest(req: CelsianRequest): ActionRequestLike {
  return {
    method: req.method,
    headers: headerRecord(req.headers),
    body: req.parsedBody,
    url: req.url,
  };
}

/**
 * The status Celsian's own default error handler would send for `error`.
 *
 * Mirrors `handleError` in @celsian/core: its own ValidationError is a 400, its
 * own HttpError keeps its status, and anything else is a sanitised 500 whatever
 * `statusCode` it happens to carry. Using Celsian's exported classes rather than
 * a structural `statusCode` read means the answer agrees with the response that
 * actually goes on the wire, including when Celsian declines to trust a status.
 * Both this module and the Celsian copy that throws those errors live in the
 * server entry, so instanceof is sound here in a way it is not across bundles.
 */
function celsianDefaultStatus(error: unknown): number {
  if (error instanceof CelsianValidationError) return 400;
  if (error instanceof CelsianHttpError) return error.statusCode;
  return 500;
}

/** Per-request marker so the onResponse hooks fire at most once. */
const RESPONSE_HOOKS_RAN = '__vuraResponseHooksRan';

// Map Vura HttpMethod → CelsianApp method registrar name
const METHOD_REGISTRARS: Record<HttpMethod, 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options'> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  DELETE: 'delete',
  PATCH: 'patch',
  HEAD: 'head',
  OPTIONS: 'options',
};

/**
 * Build a CelsianApp from a Vura route manifest.
 *
 * @example
 * ```ts
 * const app = createApiApp({ routes: manifest.api.map(r => ({ ...r, module: await import(r.filePath) })) });
 * export default { fetch: app.fetch };
 * ```
 */
export function createApiApp(opts: ApiAppOptions): CelsianApp {
  // logger: false — silent no-op logger; serverless runtimes handle their own
  // logging and we don't want console noise in unit tests.
  const app = createApp({ logger: false });


  // ─── Global hooks ───
  // addHook lifecycle names verified against celsian/packages/core/src/types.ts
  // lines 26-34: onRequest, preParsing, preValidation, preHandler,
  // preSerialization, onSend, onResponse, onError — all valid.

  const onResponseHooks = (opts.globalHooks?.onResponse ?? []) as Array<
    (
      req: CelsianRequest,
      reply: CelsianReply,
      info: { statusCode: number; durationMs: number; hadError: boolean },
    ) => unknown
  >;

  // Stamp request start time FIRST, before user onRequest hooks, so durationMs
  // in the onResponse shim is as accurate as possible.
  if (onResponseHooks.length > 0) {
    app.addHook('onRequest', (req: CelsianRequest) => {
      (req as any).__vuraStart = Date.now();
    });
  }

  /**
   * Run the project's onResponse hooks once for this request.
   *
   * Celsian reaches its own onResponse hooks only when the lifecycle completes.
   * A request whose handler throws is answered out of `handleError` and returns
   * before them, so an access log or a metrics counter written as an onResponse
   * hook recorded every success and silently omitted every failure, which is the
   * half of the traffic such a hook usually exists for. Vura therefore drives
   * the hooks itself on the error path, and this guard stops the two paths both
   * firing for one request.
   *
   * `statusCode` is passed in rather than read off the reply because the error
   * response is built fresh by `handleError` and never touches `reply`.
   */
  async function runResponseHooks(
    req: CelsianRequest,
    reply: CelsianReply,
    statusCode: number,
    hadError: boolean,
  ): Promise<void> {
    if (onResponseHooks.length === 0) return;
    const stamped = req as unknown as Record<string, unknown>;
    if (stamped[RESPONSE_HOOKS_RAN]) return;
    stamped[RESPONSE_HOOKS_RAN] = true;

    const start = stamped.__vuraStart as number | undefined;
    const info = {
      statusCode,
      durationMs: start !== undefined ? Date.now() - start : 0,
      hadError,
    };
    for (const fn of onResponseHooks) {
      // Same contract Celsian gives its own onResponse hooks: a throw is
      // reported and swallowed, never allowed to alter the response.
      try {
        await fn(req, reply, info);
      } catch (err) {
        console.error('[vura] onResponse hook error', err);
      }
    }
  }

  for (const fn of opts.globalHooks?.onRequest ?? []) {
    app.addHook('onRequest', fn as (req: CelsianRequest, reply: CelsianReply) => void | Promise<void>);
  }

  // Each user onError hook is wrapped rather than registered raw: a hook that
  // returns a Response ends Celsian's error chain, so the hooks behind it never
  // run. Wrapping keeps the response observable whichever hook answers, and the
  // status reported is the one that hook actually sent.
  for (const fn of opts.globalHooks?.onError ?? []) {
    // onError signature: (error, request, reply) — cast matches OnErrorHandler
    const userFn = fn as (err: Error, req: CelsianRequest, reply: CelsianReply) => unknown;
    app.addHook('onError', (async (err: Error, req: CelsianRequest, reply: CelsianReply) => {
      const result = await userFn(err, req, reply);
      if (result instanceof Response) await runResponseHooks(req, reply, result.status, true);
      return result;
    }) as unknown as (err: Error, req: CelsianRequest, reply: CelsianReply) => void);
  }

  // Vura owns the HTTP status of its own errors rather than relying on the host
  // framework to infer one. Celsian's default handler recognises only
  // `instanceof HttpError` against *its* class and gives everything else a 500
  // — deliberately, so that a driver error carrying `statusCode: 400` cannot
  // pick its own status or skip production sanitisation. A Vura `HttpError` is
  // a different class (a different package, and a different inlined copy per
  // server bundle, so `instanceof` fails even against Vura's own), and without
  // this hook a `throw notFound()` from an API route left as a 500.
  //
  // Registered last, so a user's own onError hooks still get first refusal;
  // returning a non-Response falls through to Celsian's default handler, so
  // Celsian's errors, validation failures and unknown throws are untouched.
  // Only errors Vura itself constructed carry the brand, and the decision
  // about which messages are safe to send stays inside the error's `toJSON`.
  //
  // Being last also makes it the one place that knows an error reached the end
  // of the chain unclaimed, which is where the onResponse hooks get their status
  // for everything Celsian answers by default.
  app.addHook('onError', (async (error: Error, req: CelsianRequest, reply: CelsianReply) => {
    if (isHttpError(error)) {
      await runResponseHooks(req, reply, error.statusCode, true);
      return new Response(JSON.stringify(error.toJSON(getErrorMode() === 'development')), {
        status: error.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    await runResponseHooks(req, reply, celsianDefaultStatus(error), true);
    return undefined;
  }) as unknown as (err: Error, req: CelsianRequest, reply: CelsianReply) => void);

  // The success path. Celsian's own onResponse stage supplies the completed
  // lifecycle; the third argument is synthesized because Celsian's hooks take
  // only (req, reply). reply.statusCode is the value set by the last
  // reply.status() call before the response was built (verified in
  // celsian/packages/core/src/reply.ts lines 41-46).
  if (onResponseHooks.length > 0) {
    app.addHook('onResponse', (req: CelsianRequest, reply: CelsianReply) =>
      runResponseHooks(req, reply, reply.statusCode ?? 0, false));
  }

  // ─── Route registration ───
  for (const route of opts.routes) {
    // 'task' routes are not HTTP routes — handled by the task worker (Task 11)
    if (route.kind === 'task') continue;

    // Optional schema export: `export const schema = { body: ..., querystring: ... }`
    const schema = route.module.schema as Record<string, unknown> | undefined;

    for (const method of route.methods) {
      const handler = route.module[method];
      if (typeof handler !== 'function') continue;

      // Wrap handler: apply ThenRequest compat shim so req.body aliases parsedBody
      const wrapped = (req: CelsianRequest, reply: CelsianReply) =>
        (handler as (r: unknown, rp: unknown) => unknown)(applyThenCompat(req), reply);

      const registrar = METHOD_REGISTRARS[method];

      if (schema) {
        // Map vura's 'query' key to celsian's 'querystring'
        const celsianSchema = schema.query !== undefined
          ? { ...schema, querystring: schema.query }
          : schema;
        // Options-object signature: app.post(url, { schema, handler })
        // Verified at celsian/packages/core/src/app.ts line 280:
        //   _routeWithSchema resolves handler from opts.handler when no trailing arg.
        (app as any)[registrar](route.urlPattern, { schema: celsianSchema, handler: wrapped });
      } else {
        (app as any)[registrar](route.urlPattern, wrapped);
      }
    }
  }

  // ─── ISR revalidation webhook ───
  if (opts.revalidateWebhook) {
    const webhook = opts.revalidateWebhook;
    app.post('/__vura/revalidate', async (req: CelsianRequest, reply: CelsianReply) => {
      // Guard: require a parsed JSON body — reject plain or missing bodies early.
      // reply.status(n).json(obj) is the correct celsian chaining API
      // (verified at celsian/packages/core/src/reply.ts lines 59-61 + json method).
      if (req.parsedBody === undefined) {
        return reply.status(400).json({ error: 'JSON body required' });
      }
      // Flatten Headers object to plain Record for the webhook contract
      const headers: Record<string, string> = {};
      req.headers.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v; });
      const out = await webhook({ headers, body: req.parsedBody });
      return reply.status(out.status).json(out.body);
    });
  }

  // ─── Server actions ───
  if (opts.enableActions) {
    // GET hands out a CSRF token and sets the matching HttpOnly cookie. A
    // cross-origin page cannot read the body (no CORS headers are sent), so the
    // token stays same-origin even though the endpoint is unauthenticated.
    app.get('/__vura/action', async (req: CelsianRequest, reply: CelsianReply) => {
      const outcome = issueActionToken(toActionRequest(req));
      if (outcome.setCookie) reply.header('set-cookie', outcome.setCookie);
      return reply
        .header('cache-control', 'no-store')
        .status(outcome.status)
        .json(outcome.body);
    });

    app.post('/__vura/action', async (req: CelsianRequest, reply: CelsianReply) => {
      const outcome = await dispatchAction(toActionRequest(req));
      return reply
        .header('cache-control', 'no-store')
        .status(outcome.status)
        .json(outcome.body);
    });
  }

  return app;
}
