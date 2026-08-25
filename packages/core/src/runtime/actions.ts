/**
 * Server actions — call a server function from the browser by importing it.
 *
 * A file under `src/actions/` is server-only. Every function it exports becomes
 * callable from client code:
 *
 * ```ts
 * // src/actions/todos.ts
 * export async function addTodo(text: string) {
 *   return db.todos.insert({ text });          // runs on the server, always
 * }
 * ```
 * ```tsx
 * // src/pages/index.tsx
 * import { addTodo } from '../actions/todos';  // the real module on the server,
 * await addTodo('milk');                       // a fetch stub in the browser
 * ```
 *
 * The browser never receives the module. The build resolves any import that
 * lands in `src/actions/` to a generated stub *before esbuild reads the file*,
 * so a database URL or an API key in an action file cannot reach a client
 * bundle even by accident. `tests/self-host-audit/actions.test.ts` asserts that
 * against a real built application rather than trusting the claim.
 *
 * ── Why a global registry ────────────────────────────────────────────────────
 *
 * what-framework ships its own `action()` whose registry is a module-level
 * `Map`, and whose IDs are random when no compiler supplies them. Neither
 * survives Vura's bundling model: `dist/server/entry.js` inlines its
 * dependencies while `dist/server/actions/*.js` keep them external, so a
 * module-level `Map` is two different Maps, and a random ID differs between the
 * server bundle and the browser bundle that has to name it. This registry hangs
 * off `globalThis` under a `Symbol.for` key — the same fix the loader context
 * needed, for the same reason — and IDs are derived from the file path and the
 * export name, so they are stable across builds and readable in a network tab.
 */

import { formatErrorResponse, getErrorMode } from '../errors.js';

// ─── Types ───

export type ActionFn = (...args: any[]) => unknown;

export interface ActionRegistry {
  register(id: string, fn: ActionFn): void;
  get(id: string): ActionFn | undefined;
  ids(): string[];
  clear(): void;
}

/** Outcome of dispatching one action call. Transport-agnostic on purpose. */
export interface ActionOutcome {
  status: number;
  body: unknown;
  /** Set when the response should also install a cookie. */
  setCookie?: string;
}

export interface ActionRequestLike {
  method: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** Already-parsed JSON body, or undefined when there was none. */
  body?: unknown;
  /** Full request URL, used for the same-origin comparison. */
  url: string;
}

// ─── Registry ───

const REGISTRY_KEY = Symbol.for('vura.actions.registry');

interface RegistryGlobal {
  [REGISTRY_KEY]?: Map<string, ActionFn>;
}

const globalStore = globalThis as unknown as RegistryGlobal;

function store(): Map<string, ActionFn> {
  return (globalStore[REGISTRY_KEY] ??= new Map<string, ActionFn>());
}

export const actionRegistry: ActionRegistry = {
  register(id, fn) {
    store().set(id, fn);
  },
  get(id) {
    return store().get(id);
  },
  ids() {
    return [...store().keys()];
  },
  clear() {
    store().clear();
  },
};

/**
 * Register every export of every action module.
 *
 * `modules` maps an action module id (`'todos'`, `'admin/users'`) to the loaded
 * module. Non-function exports are skipped: an action file is allowed to export
 * a type, a constant or a zod schema without those becoming callable endpoints.
 */
export function registerActionModules(
  modules: Record<string, Record<string, unknown>>,
): void {
  for (const [moduleId, mod] of Object.entries(modules)) {
    if (!mod) continue;
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      actionRegistry.register(actionId(moduleId, exportName), value as ActionFn);
    }
  }
}

/** `todos` + `addTodo` → `todos#addTodo`. The wire format, and the log format. */
export function actionId(moduleId: string, exportName: string): string {
  return `${moduleId}#${exportName}`;
}

// ─── CSRF ───

/**
 * The token cookie.
 *
 * Over HTTPS the `__Host-` prefix is used, which the browser only accepts with
 * `Secure`, `Path=/` and no `Domain` — meaning a sibling subdomain cannot set
 * it. That closes the hole in naive double-submit CSRF, where an attacker who
 * controls `evil.example.com` writes a cookie for `example.com` and then knows
 * both halves. Plain HTTP (dev) cannot use the prefix at all.
 */
export function csrfCookieName(secure: boolean): string {
  return secure ? '__Host-vura-csrf' : 'vura-csrf';
}

export function isSecureRequest(req: ActionRequestLike): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  if (forwarded) return forwarded.split(',')[0]!.trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function issueCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function csrfSetCookie(token: string, secure: boolean): string {
  const parts = [
    `${csrfCookieName(secure)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Length-checked, constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is this request same-origin?
 *
 * Fails closed. A browser always sends `Sec-Fetch-Site` (or at minimum `Origin`
 * on a cross-origin POST), so a request carrying neither is not a browser doing
 * a normal same-origin fetch — it is a script, and a script should be calling
 * an API route. Rejecting it costs a documented sentence and removes a class of
 * confused-deputy bug.
 */
export function isSameOrigin(req: ActionRequestLike): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';

  const origin = req.headers['origin'];
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

// ─── Dispatch ───

export interface ActionDispatchOptions {
  /** Cap on the JSON body, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Error mode passed through to `formatErrorResponse`. */
  errorMode?: 'development' | 'production';
}

const DEFAULT_MAX_BODY = 1024 * 1024;

/** `GET /__vura/action` — hand out a CSRF token and set its cookie. */
export function issueActionToken(req: ActionRequestLike): ActionOutcome {
  if (!isSameOrigin(req)) {
    return { status: 403, body: { error: 'Cross-origin action request rejected' } };
  }
  const secure = isSecureRequest(req);
  const token = issueCsrfToken();
  return {
    status: 200,
    body: { token },
    setCookie: csrfSetCookie(token, secure),
  };
}

/**
 * `POST /__vura/action` — run one action and return its result.
 *
 * Three gates before anything user-supplied is touched: same-origin, a JSON
 * content type (an HTML form cannot send one cross-site without a preflight),
 * and a CSRF token matching the HttpOnly cookie.
 */
export async function dispatchAction(
  req: ActionRequestLike,
  options: ActionDispatchOptions = {},
): Promise<ActionOutcome> {
  if (!isSameOrigin(req)) {
    return { status: 403, body: { error: 'Cross-origin action request rejected' } };
  }

  const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
  if (contentType !== 'application/json') {
    return { status: 415, body: { error: 'Actions accept application/json only' } };
  }

  const secure = isSecureRequest(req);
  const cookieToken = readCookie(req.headers['cookie'], csrfCookieName(secure));
  const headerToken = req.headers['x-vura-csrf'];
  if (!cookieToken || !headerToken || !timingSafeEqual(headerToken, cookieToken)) {
    return { status: 403, body: { error: 'Invalid or missing CSRF token' } };
  }

  const id = req.headers['x-vura-action'];
  if (!id) {
    return { status: 400, body: { error: 'Missing x-vura-action header' } };
  }

  const body = req.body;
  if (body === undefined || body === null || typeof body !== 'object') {
    return { status: 400, body: { error: 'JSON body required' } };
  }

  const args = (body as { args?: unknown }).args;
  // An array specifically: a plain object here would let a caller reach
  // __proto__ through argument spreading.
  if (!Array.isArray(args)) {
    return { status: 400, body: { error: 'Action arguments must be an array' } };
  }

  const max = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  if (JSON.stringify(args).length > max) {
    return { status: 413, body: { error: 'Action arguments too large' } };
  }

  const fn = actionRegistry.get(id);
  if (!fn) {
    // Deliberately does not echo the id: a 404 that repeats attacker input is
    // a reflection primitive, and the id is already in the request they sent.
    return { status: 404, body: { error: 'Action not found' } };
  }

  try {
    const result = await fn(...args);
    return { status: 200, body: { result: result === undefined ? null : result } };
  } catch (error) {
    // A thrown HttpError is deliberate and client-facing: `notFound()` from an
    // action should reach the caller as a 404, exactly as it does from an API
    // route. Unexpected errors are logged here and sanitised before they leave.
    //
    // Detected structurally rather than with `instanceof`, and formatted by
    // calling the error's own `toJSON`. Each server bundle inlines its own copy
    // of core, so an HttpError thrown by an action module is a different class
    // object from the one this module closes over: `instanceof` is false for
    // exactly the errors it is meant to recognise, and `formatErrorResponse`
    // gates on `instanceof` internally, so routing a cross-bundle HttpError
    // through it would flatten a deliberate 404 into a generic 500. The
    // instance's own method has no such problem.
    const isDev = (options.errorMode ?? getErrorMode()) === 'development';
    if (isHttpErrorLike(error)) {
      return { status: error.statusCode, body: error.toJSON(isDev) };
    }
    console.error(`[vura] action "${id}" failed:`, error);
    const { statusCode, body: errBody } = formatErrorResponse(
      error instanceof Error ? error : new Error(String(error)),
      options.errorMode,
    );
    return { status: statusCode, body: errBody };
  }
}

/**
 * Structural HttpError check — see the note in `dispatchAction`.
 *
 * Requires `toJSON` as well as the two data fields, because the formatting
 * policy (which messages are safe to send in production) lives in that method
 * and is not duplicated here. An error carrying a numeric `statusCode` but no
 * `toJSON` is some other library's error and takes the generic path.
 */
function isHttpErrorLike(
  error: unknown,
): error is Error & {
  statusCode: number;
  code: string;
  toJSON(isDev: boolean): Record<string, unknown>;
} {
  return (
    error instanceof Error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { toJSON?: unknown }).toJSON === 'function'
  );
}
