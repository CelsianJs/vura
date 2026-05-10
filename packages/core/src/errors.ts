/**
 * ThenJS Error Handling — Structured error system with dev/prod modes.
 *
 * Features:
 *   - Structured error codes (like CelsianJS)
 *   - Dev vs production error responses
 *   - Error boundary for page rendering
 *   - Global error handler registration
 *   - Integration with Logger and Hook system
 *
 * Error codes follow the pattern: CATEGORY_SPECIFIC
 *   VALIDATION_ERROR, AUTH_UNAUTHORIZED, ROUTE_NOT_FOUND, etc.
 */

import type { ThenReply } from './handler.js';
import type { Logger } from './logger.js';

// ─── Error Codes ───

/**
 * Predefined error codes for common scenarios.
 * Extendable — users can use any string as an error code.
 */
export const ErrorCode = {
  // Request errors (4xx)
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // Server errors (5xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',

  // Framework errors
  RENDER_ERROR: 'RENDER_ERROR',
  HANDLER_ERROR: 'HANDLER_ERROR',
  HOOK_ERROR: 'HOOK_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode] | string;

// ─── HTTP Error Class ───

/**
 * Structured HTTP error with code, status, and optional details.
 * Throw this from handlers for clean error responses.
 *
 * @example
 * ```ts
 * throw new HttpError(404, 'NOT_FOUND', 'User not found', { userId: '123' });
 * ```
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeValue;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /**
   * Convert to a response body suitable for JSON serialization.
   */
  toJSON(isDev: boolean = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      error: this.message,
      code: this.code,
    };

    if (isDev) {
      body.statusCode = this.statusCode;
      if (this.details) body.details = this.details;
      body.stack = this.stack;
    }

    return body;
  }
}

// ─── Convenience Error Factories ───

export function badRequest(message: string = 'Bad Request', details?: unknown): HttpError {
  return new HttpError(400, ErrorCode.BAD_REQUEST, message, details);
}

export function unauthorized(message: string = 'Unauthorized', details?: unknown): HttpError {
  return new HttpError(401, ErrorCode.UNAUTHORIZED, message, details);
}

export function forbidden(message: string = 'Forbidden', details?: unknown): HttpError {
  return new HttpError(403, ErrorCode.FORBIDDEN, message, details);
}

export function notFound(message: string = 'Not Found', details?: unknown): HttpError {
  return new HttpError(404, ErrorCode.NOT_FOUND, message, details);
}

export function methodNotAllowed(message: string = 'Method Not Allowed', details?: unknown): HttpError {
  return new HttpError(405, ErrorCode.METHOD_NOT_ALLOWED, message, details);
}

export function conflict(message: string = 'Conflict', details?: unknown): HttpError {
  return new HttpError(409, ErrorCode.CONFLICT, message, details);
}

export function rateLimited(message: string = 'Too Many Requests', details?: unknown): HttpError {
  return new HttpError(429, ErrorCode.RATE_LIMITED, message, details);
}

export function internalError(message: string = 'Internal Server Error', details?: unknown): HttpError {
  return new HttpError(500, ErrorCode.INTERNAL_ERROR, message, details);
}

export function serviceUnavailable(message: string = 'Service Unavailable', details?: unknown): HttpError {
  return new HttpError(503, ErrorCode.SERVICE_UNAVAILABLE, message, details);
}

// ─── Error Response Formatter ───

/**
 * Environment mode for error formatting.
 */
export type ErrorMode = 'development' | 'production';

/**
 * Detect the current error mode from NODE_ENV.
 */
export function getErrorMode(): ErrorMode {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * Format an error into a client-safe response body.
 *
 * Development mode: includes stack trace, details, original message.
 * Production mode: generic message, no internals exposed.
 */
export function formatErrorResponse(
  error: Error,
  mode?: ErrorMode,
): { statusCode: number; body: Record<string, unknown> } {
  const isDev = (mode ?? getErrorMode()) === 'development';

  // HttpError — use its structured data
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      body: error.toJSON(isDev),
    };
  }

  // Unknown error — generic 500
  const statusCode = 500;
  const body: Record<string, unknown> = {
    error: isDev ? error.message : 'Internal Server Error',
    code: ErrorCode.INTERNAL_ERROR,
  };

  if (isDev) {
    body.stack = error.stack;
    body.name = error.name;
  }

  return { statusCode, body };
}

/**
 * Send an error response through ThenReply.
 */
export function sendErrorResponse(
  reply: ThenReply,
  error: Error,
  mode?: ErrorMode,
): unknown {
  const { statusCode, body } = formatErrorResponse(error, mode);
  return reply.status(statusCode).json(body);
}

// ─── Error Boundary for Page Rendering ───

/**
 * Result of an error boundary catch.
 */
export interface ErrorBoundaryResult {
  html: string;
  statusCode: number;
}

/**
 * Default error page renderer for development mode.
 * Shows the full stack trace and error details.
 */
function devErrorPage(error: Error, route?: string): string {
  const stack = escapeHtml(error.stack ?? error.message);
  const errorName = escapeHtml(error.name);
  const errorMessage = escapeHtml(error.message);
  const routeInfo = route ? `<p style="color: #999; margin: 4px 0;">Route: ${escapeHtml(route)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - ThenJS</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #1a1a2e; color: #e0e0e0; }
    h1 { color: #ff6b6b; font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 12px; }
    .error-code { color: #ffd93d; font-size: 14px; font-weight: 600; }
    pre { background: #16213e; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.6; border: 1px solid #333; }
    .badge { display: inline-block; background: #ff6b6b; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <span class="badge">ThenJS Dev Error</span>
  <h1>${errorName}: ${errorMessage}</h1>
  ${routeInfo}
  <pre>${stack}</pre>
</body>
</html>`;
}

/**
 * Default error page renderer for production mode.
 * Shows a generic error message.
 */
function prodErrorPage(statusCode: number): string {
  const message = statusCode === 404 ? 'Page Not Found' : 'Something went wrong';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${statusCode} - Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #333; }
    .container { text-align: center; }
    h1 { font-size: 72px; margin: 0; color: #999; }
    p { font-size: 18px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${statusCode}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

/**
 * Custom error page handler type.
 * Return HTML string or null to fall back to default.
 */
export type ErrorPageHandler = (
  error: Error,
  statusCode: number,
  route?: string,
) => string | null;

/**
 * Render an error page with error boundary protection.
 * Falls back to a safe error page if the custom handler itself throws.
 */
export function renderErrorPage(
  error: Error,
  options: {
    mode?: ErrorMode;
    route?: string;
    customHandler?: ErrorPageHandler;
  } = {},
): ErrorBoundaryResult {
  const mode = options.mode ?? getErrorMode();
  const statusCode = error instanceof HttpError ? error.statusCode : 500;

  // Try custom handler first
  if (options.customHandler) {
    try {
      const html = options.customHandler(error, statusCode, options.route);
      if (html !== null) {
        return { html, statusCode };
      }
    } catch {
      // Custom handler threw — fall through to defaults
    }
  }

  // Default error pages
  const html = mode === 'development'
    ? devErrorPage(error, options.route)
    : prodErrorPage(statusCode);

  return { html, statusCode };
}

// ─── Global Error Handler ───

/**
 * Global error handler callback type.
 */
export type GlobalErrorHandler = (
  error: Error,
  context: { method?: string; path?: string; requestId?: string },
) => void;

let _globalErrorHandler: GlobalErrorHandler | null = null;

/**
 * Register a global error handler for uncaught handler errors.
 * This runs in addition to (not instead of) the standard error response.
 * Useful for error reporting services (Sentry, etc.).
 */
export function setGlobalErrorHandler(handler: GlobalErrorHandler): void {
  _globalErrorHandler = handler;
}

/**
 * Get the current global error handler.
 */
export function getGlobalErrorHandler(): GlobalErrorHandler | null {
  return _globalErrorHandler;
}

/**
 * Report an error through the global error handler.
 * Safe to call even if no handler is registered (no-op).
 */
export function reportError(
  error: Error,
  context: { method?: string; path?: string; requestId?: string } = {},
  logger?: Logger,
): void {
  // Log it
  if (logger) {
    logger.error('unhandled error', {
      error: error.message,
      code: error instanceof HttpError ? error.code : 'UNKNOWN',
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.method ? { method: context.method } : {}),
      ...(context.path ? { path: context.path } : {}),
    });
  }

  // Report to global handler
  if (_globalErrorHandler) {
    try {
      _globalErrorHandler(error, context);
    } catch {
      // Global handler itself threw — absorb it
    }
  }
}

// ─── Internal ───

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
