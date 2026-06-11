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

import { createApp, type CelsianApp, type CelsianRequest, type CelsianReply } from '@celsian/core';
import { applyThenCompat } from '../compat.js';
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
   */
  revalidateWebhook?: (reqLike: { headers: Record<string, string>; body: unknown }) => Promise<{ status: number; body: unknown }>;
}

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
  for (const fn of opts.globalHooks?.onRequest ?? []) {
    app.addHook('onRequest', fn as (req: CelsianRequest, reply: CelsianReply) => void | Promise<void>);
  }
  for (const fn of opts.globalHooks?.onError ?? []) {
    // onError signature: (error, request, reply) — cast matches OnErrorHandler
    app.addHook('onError', fn as (err: Error, req: CelsianRequest, reply: CelsianReply) => void | Promise<void>);
  }
  for (const fn of opts.globalHooks?.onResponse ?? []) {
    app.addHook('onResponse', fn as (req: CelsianRequest, reply: CelsianReply) => void | Promise<void>);
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
        // Options-object signature: app.post(url, { schema, handler })
        // Verified at celsian/packages/core/src/app.ts line 280:
        //   _routeWithSchema resolves handler from opts.handler when no trailing arg.
        (app as any)[registrar](route.urlPattern, { schema, handler: wrapped });
      } else {
        (app as any)[registrar](route.urlPattern, wrapped);
      }
    }
  }

  // ─── ISR revalidation webhook ───
  if (opts.revalidateWebhook) {
    const webhook = opts.revalidateWebhook;
    app.post('/__vura/revalidate', async (req: CelsianRequest, reply: CelsianReply) => {
      // Flatten Headers object to plain Record for the webhook contract
      const headers: Record<string, string> = {};
      req.headers.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v; });
      const out = await webhook({ headers, body: req.parsedBody });
      return reply.status(out.status).json(out.body);
    });
  }

  return app;
}
