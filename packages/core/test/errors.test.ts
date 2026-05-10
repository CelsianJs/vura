import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
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
} from '../src/errors.js';
import type { ThenReply } from '../src/handler.js';
import { createLogger } from '../src/logger.js';

// ─── Test Helpers ───

function createReply(): ThenReply & { _status: number; _data: unknown } {
  const state = { _status: 200, _data: null as unknown };
  const reply: ThenReply & typeof state = {
    ...state,
    status(code: number) { state._status = code; reply._status = code; return reply; },
    header(_name: string, _value: string) { return reply; },
    json(data: unknown) { state._data = data; reply._data = data; return null; },
    send(data: string) { state._data = data; reply._data = data; return null; },
  };
  return reply;
}

// ─── Tests ───

describe('HttpError', () => {
  it('creates with all properties', () => {
    const err = new HttpError(404, 'NOT_FOUND', 'User not found', { userId: '123' });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('User not found');
    expect(err.details).toEqual({ userId: '123' });
    expect(err.name).toBe('HttpError');
  });

  it('has a stack trace', () => {
    const err = new HttpError(500, 'INTERNAL_ERROR', 'boom');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('HttpError');
  });

  it('serializes to JSON in dev mode', () => {
    const err = new HttpError(400, 'BAD_REQUEST', 'Invalid input', { field: 'email' });
    const json = err.toJSON(true);

    expect(json.error).toBe('Invalid input');
    expect(json.code).toBe('BAD_REQUEST');
    expect(json.statusCode).toBe(400);
    expect(json.details).toEqual({ field: 'email' });
    expect(json.stack).toBeDefined();
  });

  it('serializes to JSON in prod mode (minimal)', () => {
    const err = new HttpError(400, 'BAD_REQUEST', 'Invalid input', { field: 'email' });
    const json = err.toJSON(false);

    expect(json.error).toBe('Invalid input');
    expect(json.code).toBe('BAD_REQUEST');
    expect(json.statusCode).toBeUndefined();
    expect(json.details).toBeUndefined();
    expect(json.stack).toBeUndefined();
  });
});

describe('error factories', () => {
  it('badRequest creates 400 error', () => {
    const err = badRequest('Missing field');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ErrorCode.BAD_REQUEST);
    expect(err.message).toBe('Missing field');
  });

  it('unauthorized creates 401 error', () => {
    const err = unauthorized();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('forbidden creates 403 error', () => {
    const err = forbidden();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('notFound creates 404 error', () => {
    const err = notFound('Page not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('methodNotAllowed creates 405 error', () => {
    const err = methodNotAllowed();
    expect(err.statusCode).toBe(405);
    expect(err.code).toBe(ErrorCode.METHOD_NOT_ALLOWED);
  });

  it('conflict creates 409 error', () => {
    const err = conflict('Username taken');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe(ErrorCode.CONFLICT);
  });

  it('rateLimited creates 429 error', () => {
    const err = rateLimited();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe(ErrorCode.RATE_LIMITED);
  });

  it('internalError creates 500 error', () => {
    const err = internalError();
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('serviceUnavailable creates 503 error', () => {
    const err = serviceUnavailable();
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });

  it('all factories accept details', () => {
    const err = badRequest('fail', { fields: ['email', 'name'] });
    expect(err.details).toEqual({ fields: ['email', 'name'] });
  });

  it('all factories have default messages', () => {
    expect(badRequest().message).toBe('Bad Request');
    expect(unauthorized().message).toBe('Unauthorized');
    expect(forbidden().message).toBe('Forbidden');
    expect(notFound().message).toBe('Not Found');
    expect(methodNotAllowed().message).toBe('Method Not Allowed');
    expect(conflict().message).toBe('Conflict');
    expect(rateLimited().message).toBe('Too Many Requests');
    expect(internalError().message).toBe('Internal Server Error');
    expect(serviceUnavailable().message).toBe('Service Unavailable');
  });
});

describe('formatErrorResponse', () => {
  it('formats HttpError in dev mode', () => {
    const err = new HttpError(422, 'VALIDATION_ERROR', 'Invalid data', { field: 'x' });
    const { statusCode, body } = formatErrorResponse(err, 'development');

    expect(statusCode).toBe(422);
    expect(body.error).toBe('Invalid data');
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual({ field: 'x' });
    expect(body.stack).toBeDefined();
  });

  it('formats HttpError in production mode', () => {
    const err = new HttpError(422, 'VALIDATION_ERROR', 'Invalid data', { field: 'x' });
    const { statusCode, body } = formatErrorResponse(err, 'production');

    expect(statusCode).toBe(422);
    expect(body.error).toBe('Invalid data');
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toBeUndefined();
    expect(body.stack).toBeUndefined();
  });

  it('formats generic Error in dev mode', () => {
    const err = new Error('Something broke');
    const { statusCode, body } = formatErrorResponse(err, 'development');

    expect(statusCode).toBe(500);
    expect(body.error).toBe('Something broke');
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.stack).toBeDefined();
  });

  it('formats generic Error in production mode (hides internals)', () => {
    const err = new Error('SQL injection detected in user table xyz');
    const { statusCode, body } = formatErrorResponse(err, 'production');

    expect(statusCode).toBe(500);
    expect(body.error).toBe('Internal Server Error'); // generic, not the real message
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.stack).toBeUndefined();
    expect(body.error).not.toContain('SQL');
  });
});

describe('sendErrorResponse', () => {
  it('sends formatted error through reply', () => {
    const reply = createReply();
    const err = notFound('User not found');

    sendErrorResponse(reply, err, 'development');

    expect(reply._status).toBe(404);
    expect((reply._data as any).code).toBe('NOT_FOUND');
  });

  it('sends generic error in production', () => {
    const reply = createReply();
    const err = new Error('Internal details');

    sendErrorResponse(reply, err, 'production');

    expect(reply._status).toBe(500);
    expect((reply._data as any).error).toBe('Internal Server Error');
  });
});

describe('renderErrorPage', () => {
  it('renders dev error page with details', () => {
    const err = new Error('Component render failed');
    const { html, statusCode } = renderErrorPage(err, {
      mode: 'development',
      route: '/blog/:slug',
    });

    expect(statusCode).toBe(500);
    expect(html).toContain('Component render failed');
    expect(html).toContain('ThenJS Dev Error');
    expect(html).toContain('/blog/:slug');
  });

  it('renders prod error page (minimal)', () => {
    const err = new Error('SQL error details');
    const { html, statusCode } = renderErrorPage(err, {
      mode: 'production',
    });

    expect(statusCode).toBe(500);
    expect(html).toContain('Something went wrong');
    expect(html).not.toContain('SQL error');
  });

  it('renders 404 page with correct message', () => {
    const err = notFound();
    const { html, statusCode } = renderErrorPage(err, { mode: 'production' });

    expect(statusCode).toBe(404);
    expect(html).toContain('404');
    expect(html).toContain('Page Not Found');
  });

  it('uses HttpError statusCode for error pages', () => {
    const err = new HttpError(503, 'SERVICE_UNAVAILABLE', 'Down for maintenance');
    const { statusCode } = renderErrorPage(err, { mode: 'development' });

    expect(statusCode).toBe(503);
  });

  it('uses custom error page handler', () => {
    const err = new Error('Custom error');
    const customHandler = vi.fn(() => '<html><body>Custom Error Page</body></html>');

    const { html } = renderErrorPage(err, {
      mode: 'development',
      customHandler,
    });

    expect(customHandler).toHaveBeenCalledWith(err, 500, undefined);
    expect(html).toContain('Custom Error Page');
  });

  it('falls back to default when custom handler returns null', () => {
    const err = new Error('some error');
    const customHandler = vi.fn(() => null);

    const { html } = renderErrorPage(err, {
      mode: 'development',
      customHandler,
    });

    expect(html).toContain('ThenJS Dev Error');
  });

  it('falls back to default when custom handler throws', () => {
    const err = new Error('original error');
    const customHandler = vi.fn(() => {
      throw new Error('handler error');
    });

    const { html } = renderErrorPage(err, {
      mode: 'development',
      customHandler,
    });

    expect(html).toContain('ThenJS Dev Error');
  });
});

describe('global error handler', () => {
  afterEach(() => {
    setGlobalErrorHandler(null as any);
  });

  it('registers and retrieves handler', () => {
    const handler = vi.fn();
    setGlobalErrorHandler(handler);
    expect(getGlobalErrorHandler()).toBe(handler);
  });

  it('reportError calls global handler', () => {
    const handler = vi.fn();
    setGlobalErrorHandler(handler);

    const err = new Error('test');
    reportError(err, { method: 'GET', path: '/api/test' });

    expect(handler).toHaveBeenCalledWith(err, {
      method: 'GET',
      path: '/api/test',
    });
  });

  it('reportError logs with logger', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      write: (s) => output.push(s),
    });

    const err = new HttpError(404, 'NOT_FOUND', 'Missing');
    reportError(err, { path: '/api/users/99', requestId: 'req-1' }, logger);

    expect(output).toHaveLength(1);
    const entry = JSON.parse(output[0]);
    expect(entry.level).toBe('error');
    expect(entry.code).toBe('NOT_FOUND');
    expect(entry.requestId).toBe('req-1');
  });

  it('reportError is safe with no handler', () => {
    // Should not throw
    reportError(new Error('no handler'));
  });

  it('reportError absorbs handler errors', () => {
    setGlobalErrorHandler(() => {
      throw new Error('handler itself broke');
    });

    // Should not throw
    reportError(new Error('original'));
  });
});

describe('ErrorCode constants', () => {
  it('has all standard HTTP error codes', () => {
    expect(ErrorCode.BAD_REQUEST).toBe('BAD_REQUEST');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE');
  });

  it('has framework-specific codes', () => {
    expect(ErrorCode.RENDER_ERROR).toBe('RENDER_ERROR');
    expect(ErrorCode.HANDLER_ERROR).toBe('HANDLER_ERROR');
    expect(ErrorCode.HOOK_ERROR).toBe('HOOK_ERROR');
    expect(ErrorCode.CONFIG_ERROR).toBe('CONFIG_ERROR');
  });
});
