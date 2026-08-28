/**
 * The `@celsian/vura-core` runtime shim, in one place.
 *
 * When the CLI or an adapter bundles a project's server modules, a bare
 * `@celsian/vura-core` import must resolve to the *runtime* slice of this
 * package rather than to `index.ts`, which also pulls in the build system and
 * would drag esbuild and `node:fs` into every function bundle.
 *
 * This module exists because that allowlist used to be copy-pasted into three
 * files (core's builder, the Lambda adapter, the Cloudflare adapter). 0.6.0
 * added `useLoaderData` to the public API and to none of the three, so every
 * page that used the headline feature of that release failed to build with
 * `No matching export in "vura-core-runtime-shim"`. One list, imported three
 * times, cannot drift like that.
 *
 * One list can still fall behind the docs, and it did: eleven documented
 * symbols across logging, auth, tasks and streaming were unusable in a built
 * app for a full release cycle. `test/runtime-shim.test.ts` now bundles every
 * `@celsian/vura-core` import the docs show, so a symbol becomes covered when
 * somebody documents it rather than when somebody remembers this file.
 *
 * Being on the list at all is a second question, and it is answered by whether
 * the module can be bundled with `platform: 'neutral'` and run without Node.
 * That is a property of the code, not a fact about it, so where a symbol sits
 * below can be changed by changing the module. It has been, three times now:
 * `getLogger` dropped `node:crypto` for `crypto.randomUUID`, `cookieSession`
 * dropped `node:crypto` and `@celsian/core` for `signed-cookie.ts`, and
 * `getMimeType` and `parseRangeHeader` left `streaming.ts` for a module with no
 * `node:fs` in it. What remains in the server group remains for a reason each
 * entry states, and those reasons are about the runtime, not about the list.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding this package's compiled (or source) modules. */
export const CORE_PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * `ts` when running from source (tests, monorepo), `js` when running from
 * the published `dist/`. The shim's re-export specifiers need the real one.
 */
export function coreModuleExt(moduleName: string, packageDir = CORE_PACKAGE_DIR): 'ts' | 'js' {
  return existsSync(join(packageDir, `${moduleName}.ts`)) ? 'ts' : 'js';
}

export interface RuntimeShimOptions {
  /**
   * Directory to resolve the re-export specifiers against. Adapters pass their
   * own resolved copy of core.
   */
  packageDir?: string;
  /**
   * Include the Node server runtime (HTTP server, API app, ISR cache, page
   * renderer, task runner). Off for the Lambda and Cloudflare adapters, whose
   * function bundles have no Node server in them.
   */
  includeServerRuntime?: boolean;
  /** Extra module source appended after the shared exports. */
  extra?: string;
}

/**
 * The module source the `vura-core-runtime-shim` namespace loads.
 *
 * Every entry here is part of the public API surface a user's server-side
 * route or page is allowed to import. Adding a public runtime export to
 * `index.ts` without adding it here makes that export unusable in a built app.
 */
export function vuraCoreRuntimeShimContents(options: RuntimeShimOptions = {}): string {
  const packageDir = options.packageDir ?? CORE_PACKAGE_DIR;
  const ext = (mod: string) => coreModuleExt(mod, packageDir);
  const lines = [
    `export { defineConfig } from './config.${ext('config')}';`,
    `export { HttpError, ErrorCode, badRequest, unauthorized, forbidden, notFound, methodNotAllowed, conflict, rateLimited, internalError, serviceUnavailable, formatErrorResponse, sendErrorResponse, renderErrorPage, setGlobalErrorHandler, getGlobalErrorHandler, reportError, getErrorMode, isHttpError, VURA_HTTP_ERROR } from './errors.${ext('errors')}';`,
    `export { defineSchema, validate, withValidation, validateRequest } from './validation.${ext('validation')}';`,
    `export { HookRegistry, createHookRegistry, getHookRegistry, setDefaultHookRegistry, executeWithHooks } from './hooks.${ext('hooks')}';`,
    // enqueue reaches the task broker over `fetch` and imports nothing but
    // errors.ts, so it is safe in a Worker and a Lambda alike. The Node-built-in
    // groups below are not.
    `export { enqueue } from './enqueue.${ext('enqueue')}';`,
    // The logger used to sit in the server group because it took node:crypto
    // for a request id, which does not resolve under the Cloudflare adapter's
    // `platform: 'neutral'`. That made `getLogger` unbuildable in a route
    // handler and in `src/api/_hooks.ts`, which are the two places the docs
    // show it. logger.ts now imports nothing and reads `process` defensively,
    // so it belongs here with the rest of the runtime-neutral surface.
    `export { Logger, ChildLogger, getLogger, createLogger, setDefaultLogger } from './logger.${ext('logger')}';`,
    // Signed cookie sessions. auth.ts took node:crypto for a synchronous HMAC
    // and @celsian/core for the cookie serialiser, and either one alone made it
    // unbuildable here — @celsian/core's package root is a Node HTTP server, so
    // it fails on node:fs, node:fs/promises, node:path and node:http before the
    // cookie helpers are even reached. Both now come from signed-cookie.ts,
    // which is arithmetic and string work and nothing else. The hard part was
    // that Web Crypto could not replace node:crypto the way crypto.randomUUID
    // replaced it for the logger: the commit seam is a Proxy trap and
    // crypto.subtle.sign is async. signed-cookie.ts records that in full.
    //
    // jwt and createJWTGuard are NOT here. They are Celsian's, and
    // @celsian/jwt imports @celsian/core, so they carry that same package root
    // with them wherever they go. See auth-jwt.ts.
    `export { cookieSession } from './auth.${ext('auth')}';`,
    // Two of the five streaming helpers are pure string functions: a content
    // type from an extension, and the byte offsets in a Range header. A Worker
    // serving an R2 object needs both. They were excluded only because they
    // shared streaming.ts with node:fs, so they now live in their own module
    // and streaming.ts re-exports them.
    `export { getMimeType, parseRangeHeader } from './streaming-headers.${ext('streaming-headers')}';`,
  ];

  if (options.includeServerRuntime !== false) {
    lines.push(
      // RFC 0001. Pages are the only consumers of the loader accessor and are
      // only ever bundled by core's own builder, so this belongs to the server
      // group. Adding it to a function bundle instead would pull
      // what-framework into every Lambda and Worker artifact, where the
      // framework is external and not installed, and the artifact dies on its
      // first invocation with ERR_MODULE_NOT_FOUND.
      `export { useLoaderData, readLoaderPayload, LoaderDataProvider, LOADER_PAYLOAD_ID, createLoaderContext, runLoaderChain, serializeLoaderPayload, isLoaderNotFound, isLoaderRedirect, LoaderNotFoundError, LoaderRedirectError } from './runtime/loader.${ext('runtime/loader')}';`,
      `export { createMiddlewareRunner, compileMatcher, parseCookies } from './runtime/middleware.${ext('runtime/middleware')}';`,
      `export { startVuraServer, serveStaticIfFound } from './runtime/server.${ext('runtime/server')}';`,
      `export { createApiApp } from './runtime/api-app.${ext('runtime/api-app')}';`,
      `export { createVuraCache, revalidatePath, revalidateTag } from './runtime/cache.${ext('runtime/cache')}';`,
      `export { buildWhatRoutes, createPagesHandler, createVuraRenderRoute, createVuraStreamRoute, isStreamingPage } from './runtime/pages.${ext('runtime/pages')}';`,
      `export { runTaskOnce, buildTaskEnvelope } from './runtime/tasks.${ext('runtime/tasks')}';`,
      // What is left of the two groups that used to sit here whole.
      //
      // jwt and createJWTGuard reach `@celsian/jwt`, which imports
      // `@celsian/core`, whose package root is a Node HTTP server. Nothing in
      // Vura can move them: stub that one `CelsianError` import and the rest of
      // `@celsian/jwt` bundles neutrally at 69 KB with jose inside it and no
      // `node:` import left, so the fix is a subpath export upstream, not a
      // counterfeit `@celsian/core` shipped from here. auth-jwt.ts has the
      // detail.
      `export { jwt, createJWTGuard } from './auth-jwt.${ext('auth-jwt')}';`,
      // streamFile needs a filesystem, which a Worker has not got.
      // streamResponse and createSSEChannel need something subtler: they write
      // to a Node ServerResponse and read from a Node Readable, and a Worker
      // handler is handed neither. workerd has ReadableStream and
      // TransformStream, so events over a stream are perfectly possible there —
      // just not through these signatures. Bundling them would trade a build
      // error for `res.writeHead is not a function` on the first request.
      `export { streamResponse, createSSEChannel, streamFile } from './streaming.${ext('streaming')}';`,
    );
  }

  if (options.extra) lines.push(options.extra.trim());

  return `\n${lines.join('\n')}\n`;
}

/**
 * The `revalidateTag` / `revalidatePath` a per-function serverless bundle gets
 * in place of the real ISR runtime.
 *
 * `runtimeLabel` names the runtime in the warning, e.g. `'Lambda functions'`.
 *
 * A function bundle has no local ISR cache, and importing the real
 * `runtime/cache` module would drag what-framework into every artifact. Both
 * adapters therefore ship warn-only stubs, and only Lambda had them: the same
 * project built for Lambda and hard-failed for Workers with
 *
 *   No matching export in "vura-core-runtime-shim:@celsian/vura-core"
 *   for import "revalidateTag"
 *
 * which is the same drift this module was created to end. One definition,
 * imported twice, cannot fall out of step the way two copies did.
 */
export function serverlessRevalidateStubs(runtimeLabel: string): string {
  const advice = JSON.stringify(
    `is a no-op inside ${runtimeLabel} today — call your cache host's /__vura/revalidate webhook instead.`,
  );
  return [
    'export async function revalidateTag(tag) {',
    `  console.warn('[vura] revalidateTag("' + tag + '") ' + ${advice});`,
    '}',
    'export async function revalidatePath(path) {',
    `  console.warn('[vura] revalidatePath("' + path + '") ' + ${advice});`,
    '}',
  ].join('\n');
}

/**
 * esbuild plugin: make `@celsian/vura-core` browser-safe inside a client or
 * hybrid page bundle.
 *
 * The package root reaches `node:fs` and `node:http`. A page
 * that runs on both sides — server-rendered, then hydrated — still wants to
 * import `useLoaderData` from the documented path, so in a browser bundle the
 * bare specifier is redirected to `client.ts`, which holds only the pure
 * exports. Importing a server-only symbol in a browser page then fails with
 * esbuild's "No matching export" naming that symbol, which is the truth: it
 * cannot run there.
 */
export function vuraBrowserResolvePlugin(options: { packageDir?: string } = {}) {
  const packageDir = options.packageDir ?? CORE_PACKAGE_DIR;
  const clientModule = () =>
    join(packageDir, `client.${coreModuleExt('client', packageDir)}`);
  return {
    name: 'vura-core-browser-resolve',
    setup(build: any) {
      build.onResolve({ filter: /^@celsian\/vura-core(\/client)?$/ }, () => ({
        path: clientModule(),
      }));
    },
  };
}
