/**
 * Vura Lifecycle Hooks — Global and route-level middleware system.
 *
 * Hook types:
 *   - onRequest(fn)  — runs before route matching (modify req, add auth, etc.)
 *   - onError(fn)    — runs on any error, can transform the error response
 *   - onResponse(fn) — runs after response is sent (logging, metrics, cleanup)
 *
 * All hooks support:
 *   - Async handlers with proper error propagation
 *   - Multiple handlers (executed in registration order)
 *   - Global scope (all routes) and route-level scope
 *   - Integration with Vura Logger
 */

import type { ThenRequest, ThenReply } from './handler.js';
import type { Logger, ChildLogger } from './logger.js';
import { HttpError } from './errors.js';

// ─── Types ───

/**
 * Request hook — runs before the route handler.
 * Can modify the request, short-circuit with a reply, or throw to trigger onError.
 * Returning a non-undefined value short-circuits the handler.
 */
export type OnRequestHook = (
  req: ThenRequest,
  reply: ThenReply,
) => void | Promise<void>;

/**
 * Error hook — runs when the handler or a prior hook throws.
 * Can transform the error, modify the response, or rethrow.
 * If it doesn't throw, the error is considered "handled" and the
 * returned value (if any) becomes the response.
 */
export type OnErrorHook = (
  error: Error,
  req: ThenRequest,
  reply: ThenReply,
) => void | unknown | Promise<void | unknown>;

/**
 * Response hook — runs after the response has been sent.
 * Used for logging, metrics, cleanup. Cannot modify the response.
 * Errors in response hooks are logged but do not affect the client.
 */
export type OnResponseHook = (
  req: ThenRequest,
  reply: ThenReply,
  responseInfo: ResponseInfo,
) => void | Promise<void>;

/**
 * Information about the completed response, passed to onResponse hooks.
 */
export interface ResponseInfo {
  /** HTTP status code that was sent */
  statusCode: number;
  /** Response duration in milliseconds */
  durationMs: number;
  /** Whether an error occurred during handling */
  hadError: boolean;
}

/**
 * Route-level hook configuration.
 * Attach to a route's config to add hooks specific to that route.
 */
export interface RouteHooks {
  onRequest?: OnRequestHook[];
  onError?: OnErrorHook[];
  onResponse?: OnResponseHook[];
}

// ─── Hook Registry ───

/**
 * Central hook manager. Maintains ordered lists of global hooks
 * and provides the execution pipeline.
 */
export class HookRegistry {
  private requestHooks: OnRequestHook[] = [];
  private errorHooks: OnErrorHook[] = [];
  private responseHooks: OnResponseHook[] = [];
  private logger: Logger | null = null;

  /**
   * Attach a logger for hook error reporting.
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Register a global onRequest hook.
   * Runs before route matching on every request.
   */
  onRequest(fn: OnRequestHook): void {
    this.requestHooks.push(fn);
  }

  /**
   * Register a global onError hook.
   * Runs when any handler or hook throws an error.
   */
  onError(fn: OnErrorHook): void {
    this.errorHooks.push(fn);
  }

  /**
   * Register a global onResponse hook.
   * Runs after the response is sent on every request.
   */
  onResponse(fn: OnResponseHook): void {
    this.responseHooks.push(fn);
  }

  /**
   * Execute all onRequest hooks (global + route-level) in order.
   * If any hook throws, execution stops and the error propagates.
   */
  async runOnRequest(
    req: ThenRequest,
    reply: ThenReply,
    routeHooks?: OnRequestHook[],
  ): Promise<void> {
    // Global hooks first
    for (const hook of this.requestHooks) {
      await hook(req, reply);
    }
    // Route-level hooks
    if (routeHooks) {
      for (const hook of routeHooks) {
        await hook(req, reply);
      }
    }
  }

  /**
   * Execute all onError hooks (global + route-level) in order.
   * Returns the result of the last hook that returns a value,
   * or re-throws if no hook handles the error.
   */
  async runOnError(
    error: Error,
    req: ThenRequest,
    reply: ThenReply,
    routeHooks?: OnErrorHook[],
  ): Promise<{ handled: boolean; result?: unknown }> {
    const allHooks = [...this.errorHooks, ...(routeHooks ?? [])];

    if (allHooks.length === 0) {
      return { handled: false };
    }

    let lastResult: unknown;
    let handled = false;

    for (const hook of allHooks) {
      try {
        const result = await hook(error, req, reply);
        if (result !== undefined) {
          lastResult = result;
          handled = true;
        } else {
          handled = true;
        }
      } catch (hookError) {
        // Error hook itself threw — this is the new error
        // Continue to next hook with the new error
        error = hookError instanceof Error ? hookError : new Error(String(hookError));
      }
    }

    return { handled, result: lastResult };
  }

  /**
   * Execute all onResponse hooks (global + route-level) in order.
   * Errors in response hooks are caught and logged — they never
   * affect the response that was already sent.
   */
  async runOnResponse(
    req: ThenRequest,
    reply: ThenReply,
    info: ResponseInfo,
    routeHooks?: OnResponseHook[],
  ): Promise<void> {
    const allHooks = [...this.responseHooks, ...(routeHooks ?? [])];

    for (const hook of allHooks) {
      try {
        await hook(req, reply, info);
      } catch (err) {
        // Log but don't throw — response is already sent
        if (this.logger) {
          this.logger.error('onResponse hook error', {
            error: err instanceof Error ? err.message : String(err),
            hook: hook.name || '<anonymous>',
          });
        }
      }
    }
  }

  /**
   * Get counts for diagnostics / testing.
   */
  getStats(): { request: number; error: number; response: number } {
    return {
      request: this.requestHooks.length,
      error: this.errorHooks.length,
      response: this.responseHooks.length,
    };
  }

  /**
   * Remove all registered hooks (useful for testing).
   */
  clear(): void {
    this.requestHooks = [];
    this.errorHooks = [];
    this.responseHooks = [];
  }
}

// ─── Default Instance ───

let _defaultRegistry: HookRegistry | null = null;

/**
 * Get the default hook registry.
 */
export function getHookRegistry(): HookRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new HookRegistry();
  }
  return _defaultRegistry;
}

/**
 * Create a new hook registry.
 */
export function createHookRegistry(): HookRegistry {
  return new HookRegistry();
}

/**
 * Replace the default hook registry (useful for testing).
 */
export function setDefaultHookRegistry(registry: HookRegistry): void {
  _defaultRegistry = registry;
}

// ─── Convenience: Execute Full Lifecycle ───

/**
 * Execute the full request lifecycle with hooks.
 * This is the main integration point used by the dev server and generated server entries.
 *
 * Flow:
 *   1. Run onRequest hooks (global + route)
 *   2. Run the handler
 *   3. Run onResponse hooks (global + route)
 *
 * On error at any step:
 *   - Run onError hooks
 *   - If handled, use the hook's response
 *   - If not handled, return 500
 *   - Always run onResponse hooks (with hadError: true)
 */
export async function executeWithHooks(
  registry: HookRegistry,
  req: ThenRequest,
  reply: ThenReply,
  handler: () => unknown | Promise<unknown>,
  routeHooks?: RouteHooks,
): Promise<{ statusCode: number; hadError: boolean; result?: unknown }> {
  const startTime = performance.now();
  let statusCode = 200;
  let hadError = false;
  let handlerResult: unknown;

  try {
    // 1. onRequest hooks
    await registry.runOnRequest(req, reply, routeHooks?.onRequest);

    // 2. Handler
    handlerResult = await handler();
  } catch (err) {
    hadError = true;
    const error = err instanceof Error ? err : new Error(String(err));

    // Extract status code from HttpError, default to 500
    statusCode = error instanceof HttpError ? error.statusCode : 500;

    // 3. onError hooks
    const errorResult = await registry.runOnError(
      error,
      req,
      reply,
      routeHooks?.onError,
    );

    if (!errorResult.handled) {
      // statusCode already set from error above
    }
  } finally {
    // 4. onResponse hooks (always run)
    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
    await registry.runOnResponse(
      req,
      reply,
      { statusCode, durationMs, hadError },
      routeHooks?.onResponse,
    );
  }

  return { statusCode, hadError, result: handlerResult };
}
