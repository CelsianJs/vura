export {
  buildManifest,
  extractApiExports,
  extractPageConfig,
  fileToUrlPattern,
} from './manifest.js';

export type {
  RouteManifest,
  ApiRoute,
  PageRoute,
  LayoutRoute,
  RouteKind,
  PageMode,
  HttpMethod,
} from './manifest.js';

export {
  defineConfig,
} from './config.js';

export type {
  ThenConfig,
  ThenAdapter,
  AdapterBuildContext,
} from './config.js';

export {
  build,
  generateServerEntry,
  generateFunctionEntry,
  generateTaskEntry,
} from './build.js';

export type {
  BuildResult,
} from './build.js';

export {
  renderStaticPages,
  wrapDocument,
  escapeHtml,
  generateClientPageEntry,
} from './static-render.js';

export type {
  PageRenderResult,
  DocumentOptions,
  StaticRenderOptions,
} from './static-render.js';

export {
  parseNodeBody,
} from './body-parser.js';

export type {
  BodyParserOptions,
} from './body-parser.js';

export {
  compileRoutes,
  matchApiPath,
  compilePageRoutes,
  matchPageRoute,
} from './match.js';

export type {
  CompiledRoute,
  RouteMatch,
  CompiledPageRoute,
  PageRouteMatch,
} from './match.js';

/**
 * Canonical list of filenames (relative to project root) that Vura treats as
 * global hook files. Exported here so vite-plugin and cli stay in sync without
 * duplicating the list.
 */
export const GLOBAL_HOOKS_FILENAMES: readonly string[] = [
  'src/api/_hooks.ts',
  'src/api/_hooks.js',
  'src/api/_hooks.mjs',
  'src/hooks.ts',
  'src/hooks.js',
  'src/hooks.mjs',
] as const;

export {
  finalizeNodeHandlerResult,
} from './handler.js';

export type {
  ThenRequest,
  ThenReply,
  ThenHandler,
  NodeHandlerFinalizationState,
  NodeHandlerFinalizationResult,
} from './handler.js';


export {
  Logger,
  ChildLogger,
  getLogger,
  createLogger,
  setDefaultLogger,
} from './logger.js';

export type {
  LogLevel,
  LogFormat,
  LogEntry,
  LoggerConfig,
  RequestLogContext,
} from './logger.js';

export {
  defineSchema,
  validate,
  withValidation,
  validateRequest,
} from './validation.js';

export type {
  ZodLikeSchema,
  RouteSchema,
  ValidatedData,
  ValidationError,
  ValidationResult,
} from './validation.js';

export {
  HookRegistry,
  createHookRegistry,
  getHookRegistry,
  setDefaultHookRegistry,
  executeWithHooks,
} from './hooks.js';

export type {
  OnRequestHook,
  OnErrorHook,
  OnResponseHook,
  ResponseInfo,
  RouteHooks,
} from './hooks.js';

export {
  HttpError,
  ErrorCode,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  conflict,
  rateLimited,
  internalError,
  serviceUnavailable,
  formatErrorResponse,
  sendErrorResponse,
  renderErrorPage,
  setGlobalErrorHandler,
  getGlobalErrorHandler,
  reportError,
  getErrorMode,
} from './errors.js';

export type {
  ErrorCodeValue,
  ErrorMode,
  ErrorBoundaryResult,
  ErrorPageHandler,
  GlobalErrorHandler,
} from './errors.js';

export {
  streamResponse,
  createSSEChannel,
  streamFile,
  getMimeType,
  parseRangeHeader,
} from './streaming.js';

export type {
  FileStreamOptions,
  SSEChannel,
  StreamableResponse,
  StreamableRequest,
} from './streaming.js';

export {
  buildWhatRoutes,
  createVuraRenderRoute,
  createPagesHandler,
} from './runtime/pages.js';

export type {
  RuntimePage,
  WhatPageRoute,
  PagesHandlerOptions,
} from './runtime/pages.js';

export {
  buildVuraCacheTagHeader,
  MAX_VURA_CACHE_TAGS,
  MAX_VURA_CACHE_TAG_LENGTH,
} from './runtime/cache-tags.js';

export {
  createVuraCache,
  revalidatePath,
  revalidateTag,
} from './runtime/cache.js';

export type {
  VuraCacheConfig,
} from './runtime/cache.js';

export {
  createApiApp,
} from './runtime/api-app.js';

export type {
  RuntimeApiRoute,
  GlobalHooks,
  ApiAppOptions,
} from './runtime/api-app.js';

export {
  applyThenCompat,
} from './compat.js';
// Note: ThenRequest/ThenReply/ThenHandler are exported via handler.js above
// (handler.js re-exports them from compat.js — no duplication needed here).

export {
  startVuraServer,
  serveStaticIfFound,
} from './runtime/server.js';

export type {
  VuraServerOptions,
  VuraServer,
} from './runtime/server.js';

export {
  runTaskOnce,
  createTaskResultStore,
  isTaskAdminAuthorized,
  registerTaskCrons,
  readOptionalJsonBody,
} from './runtime/tasks.js';

export type {
  TaskRunResult,
  TaskRunDefinition,
  TaskAdminJob,
} from './runtime/tasks.js';

export type {
  HotPeer,
  HotPeerEvents,
  HotRequest,
  HotWebsocketHandler,
} from './runtime/hot.js';

export {
  isOriginAllowed,
  createWsUpgradeHandler,
  createNoServerWebSocketServer,
} from './runtime/ws-upgrade.js';

export type {
  WsUpgradeHandler,
  WsUpgradeHandlerOptions,
  WsRegistryLike,
} from './runtime/ws-upgrade.js';

// Re-export Node↔Web bridge helpers from @celsian/core so vite-plugin and cli
// can import them without taking a direct @celsian/core dep.
export { nodeToWebRequest, writeWebResponse } from '@celsian/core';

// Canonical request/reply types for API route handlers (the non-deprecated
// names behind the ThenRequest/ThenReply compat aliases).
export type { CelsianRequest, CelsianReply } from '@celsian/core';

export {
  cookieSession,
  jwt,
  createJWTGuard,
} from './auth.js';

export type {
  CookieSessionOpts,
} from './auth.js';
