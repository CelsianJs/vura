/**
 * Browser-safe entry point: `@celsian/vura-core/client`.
 *
 * The package root (`@celsian/vura-core`) reaches Node built-ins — `node:fs`,
 * `node:crypto`, `node:http` — because it carries the build system and the
 * server runtime. A browser bundle that imports it therefore fails to build,
 * which is exactly what happened to `useLoaderData` in 0.6.0: the accessor is
 * pure, but its only export path was not.
 *
 * Everything re-exported here is free of Node built-ins and safe to pull into
 * a `client` or `hybrid` page bundle. The CLI also maps a bare
 * `@celsian/vura-core` import to this module when it bundles for the browser,
 * so the documented import path keeps working in a page that runs on both
 * sides.
 */

export {
  useLoaderData,
  readLoaderPayload,
  LoaderDataProvider,
  LOADER_PAYLOAD_ID,
  LoaderNotFoundError,
  LoaderRedirectError,
  isLoaderNotFound,
  isLoaderRedirect,
} from './runtime/loader.js';

export type {
  Loader,
  LoaderContext,
  LoaderData,
} from './runtime/loader.js';
