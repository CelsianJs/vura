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
    `export { HttpError, ErrorCode, badRequest, unauthorized, forbidden, notFound, methodNotAllowed, conflict, rateLimited, internalError, serviceUnavailable, formatErrorResponse, sendErrorResponse, renderErrorPage, setGlobalErrorHandler, getGlobalErrorHandler, reportError, getErrorMode } from './errors.${ext('errors')}';`,
    `export { defineSchema, validate, withValidation, validateRequest } from './validation.${ext('validation')}';`,
    `export { HookRegistry, createHookRegistry, getHookRegistry, setDefaultHookRegistry, executeWithHooks } from './hooks.${ext('hooks')}';`,
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
    );
  }

  if (options.extra) lines.push(options.extra.trim());

  return `\n${lines.join('\n')}\n`;
}

/**
 * esbuild plugin: make `@celsian/vura-core` browser-safe inside a client or
 * hybrid page bundle.
 *
 * The package root reaches `node:fs`, `node:crypto` and `node:http`. A page
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
