import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HookRegistry,
  createHookRegistry,
  getHookRegistry,
  setDefaultHookRegistry,
  executeWithHooks,
} from '../src/hooks.js';
import type {
  OnRequestHook,
  OnErrorHook,
  OnResponseHook,
  RouteHooks,
} from '../src/hooks.js';
import { createLogger } from '../src/logger.js';
import { HttpError } from '../src/errors.js';
import type { ThenRequest, ThenReply } from '../src/handler.js';

// ─── Test Helpers ───

function createRequest(overrides: Partial<ThenRequest> = {}): ThenRequest {
  return {
    method: 'GET',
    url: '/api/test',
    headers: {},
    params: {},
    query: {},
    parsedBody: null,
    ...overrides,
  };
}

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

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = createHookRegistry();
  });

  describe('registration', () => {
    it('registers onRequest hooks', () => {
      registry.onRequest(() => {});
      registry.onRequest(() => {});
      expect(registry.getStats().request).toBe(2);
    });

    it('registers onError hooks', () => {
      registry.onError(() => {});
      expect(registry.getStats().error).toBe(1);
    });

    it('registers onResponse hooks', () => {
      registry.onResponse(() => {});
      registry.onResponse(() => {});
      registry.onResponse(() => {});
      expect(registry.getStats().response).toBe(3);
    });

    it('clears all hooks', () => {
      registry.onRequest(() => {});
      registry.onError(() => {});
      registry.onResponse(() => {});
      registry.clear();
      expect(registry.getStats()).toEqual({ request: 0, error: 0, response: 0 });
    });
  });

  describe('onRequest execution', () => {
    it('runs global hooks in order', async () => {
      const order: number[] = [];
      registry.onRequest(async () => { order.push(1); });
      registry.onRequest(async () => { order.push(2); });
      registry.onRequest(async () => { order.push(3); });

      const req = createRequest();
      const reply = createReply();
      await registry.runOnRequest(req, reply);

      expect(order).toEqual([1, 2, 3]);
    });

    it('runs route-level hooks after global hooks', async () => {
      const order: string[] = [];
      registry.onRequest(async () => { order.push('global'); });

      const routeHooks: OnRequestHook[] = [
        async () => { order.push('route'); },
      ];

      const req = createRequest();
      const reply = createReply();
      await registry.runOnRequest(req, reply, routeHooks);

      expect(order).toEqual(['global', 'route']);
    });

    it('can modify the request', async () => {
      registry.onRequest(async (req) => {
        (req as any).userId = 'user-123';
      });

      const req = createRequest();
      const reply = createReply();
      await registry.runOnRequest(req, reply);

      expect((req as any).userId).toBe('user-123');
    });

    it('propagates errors from hooks', async () => {
      registry.onRequest(async () => {
        throw new Error('Auth failed');
      });

      const req = createRequest();
      const reply = createReply();

      await expect(
        registry.runOnRequest(req, reply),
      ).rejects.toThrow('Auth failed');
    });

    it('stops execution on first error', async () => {
      const order: number[] = [];
      registry.onRequest(async () => { order.push(1); });
      registry.onRequest(async () => { throw new Error('fail'); });
      registry.onRequest(async () => { order.push(3); });

      const req = createRequest();
      const reply = createReply();

      await expect(registry.runOnRequest(req, reply)).rejects.toThrow('fail');
      expect(order).toEqual([1]); // 3 never ran
    });

    it('supports sync hooks', async () => {
      const order: number[] = [];
      registry.onRequest(() => { order.push(1); });
      registry.onRequest(() => { order.push(2); });

      const req = createRequest();
      const reply = createReply();
      await registry.runOnRequest(req, reply);

      expect(order).toEqual([1, 2]);
    });
  });

  describe('onError execution', () => {
    it('runs error hooks with the error and request', async () => {
      const capturedError = vi.fn();
      registry.onError(async (error, req) => {
        capturedError(error.message, req.url);
      });

      const req = createRequest({ url: '/api/fail' });
      const reply = createReply();
      const error = new Error('Something broke');

      await registry.runOnError(error, req, reply);

      expect(capturedError).toHaveBeenCalledWith('Something broke', '/api/fail');
    });

    it('marks error as handled when hook runs', async () => {
      registry.onError(async (_error, _req, reply) => {
        reply.status(503).json({ error: 'Service Unavailable' });
      });

      const req = createRequest();
      const reply = createReply();
      const error = new Error('DB down');

      const result = await registry.runOnError(error, req, reply);
      expect(result.handled).toBe(true);
    });

    it('returns unhandled when no hooks registered', async () => {
      const req = createRequest();
      const reply = createReply();
      const error = new Error('unhandled');

      const result = await registry.runOnError(error, req, reply);
      expect(result.handled).toBe(false);
    });

    it('captures return values from error hooks', async () => {
      registry.onError(async () => {
        return { error: 'Custom error response' };
      });

      const req = createRequest();
      const reply = createReply();
      const error = new Error('fail');

      const result = await registry.runOnError(error, req, reply);
      expect(result.handled).toBe(true);
      expect(result.result).toEqual({ error: 'Custom error response' });
    });

    it('runs route-level error hooks after global', async () => {
      const order: string[] = [];
      registry.onError(async () => { order.push('global'); });

      const routeHooks: OnErrorHook[] = [
        async () => { order.push('route'); },
      ];

      const req = createRequest();
      const reply = createReply();
      const error = new Error('fail');

      await registry.runOnError(error, req, reply, routeHooks);
      expect(order).toEqual(['global', 'route']);
    });

    it('continues to next hook if current hook throws', async () => {
      const order: string[] = [];
      registry.onError(async () => {
        order.push('first');
        throw new Error('hook error');
      });
      registry.onError(async () => {
        order.push('second');
      });

      const req = createRequest();
      const reply = createReply();
      const error = new Error('original');

      await registry.runOnError(error, req, reply);
      expect(order).toEqual(['first', 'second']);
    });
  });

  describe('onResponse execution', () => {
    it('runs response hooks with info', async () => {
      const captured = vi.fn();
      registry.onResponse(async (_req, _reply, info) => {
        captured(info);
      });

      const req = createRequest();
      const reply = createReply();
      await registry.runOnResponse(req, reply, {
        statusCode: 200,
        durationMs: 42.5,
        hadError: false,
      });

      expect(captured).toHaveBeenCalledWith({
        statusCode: 200,
        durationMs: 42.5,
        hadError: false,
      });
    });

    it('catches and logs errors in response hooks', async () => {
      const logOutput: string[] = [];
      const logger = createLogger({
        format: 'json',
        write: (s) => logOutput.push(s),
      });
      registry.setLogger(logger);

      registry.onResponse(async () => {
        throw new Error('cleanup failed');
      });

      const req = createRequest();
      const reply = createReply();

      // Should not throw
      await registry.runOnResponse(req, reply, {
        statusCode: 200,
        durationMs: 10,
        hadError: false,
      });

      expect(logOutput.length).toBe(1);
      const entry = JSON.parse(logOutput[0]);
      expect(entry.level).toBe('error');
      expect(entry.msg).toBe('onResponse hook error');
      expect(entry.error).toBe('cleanup failed');
    });

    it('continues running hooks even when one fails', async () => {
      const logOutput: string[] = [];
      const logger = createLogger({
        format: 'json',
        write: (s) => logOutput.push(s),
      });
      registry.setLogger(logger);

      const order: number[] = [];
      registry.onResponse(async () => { order.push(1); });
      registry.onResponse(async () => { throw new Error('fail'); });
      registry.onResponse(async () => { order.push(3); });

      const req = createRequest();
      const reply = createReply();
      await registry.runOnResponse(req, reply, {
        statusCode: 200,
        durationMs: 10,
        hadError: false,
      });

      expect(order).toEqual([1, 3]);
    });

    it('runs route-level hooks after global', async () => {
      const order: string[] = [];
      registry.onResponse(async () => { order.push('global'); });

      const routeHooks: OnResponseHook[] = [
        async () => { order.push('route'); },
      ];

      const req = createRequest();
      const reply = createReply();
      await registry.runOnResponse(
        req,
        reply,
        { statusCode: 200, durationMs: 5, hadError: false },
        routeHooks,
      );

      expect(order).toEqual(['global', 'route']);
    });
  });
});

describe('executeWithHooks', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = createHookRegistry();
  });

  it('runs the handler when no hooks registered', async () => {
    const handler = vi.fn();
    const req = createRequest();
    const reply = createReply();

    const result = await executeWithHooks(registry, req, reply, handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(result.statusCode).toBe(200);
    expect(result.hadError).toBe(false);
  });

  it('runs onRequest before handler', async () => {
    const order: string[] = [];
    registry.onRequest(async () => { order.push('hook'); });

    const handler = () => { order.push('handler'); };
    const req = createRequest();
    const reply = createReply();

    await executeWithHooks(registry, req, reply, handler);
    expect(order).toEqual(['hook', 'handler']);
  });

  it('runs onResponse after handler', async () => {
    const order: string[] = [];
    registry.onResponse(async () => { order.push('response'); });

    const handler = () => { order.push('handler'); };
    const req = createRequest();
    const reply = createReply();

    await executeWithHooks(registry, req, reply, handler);
    expect(order).toEqual(['handler', 'response']);
  });

  it('calls onError when handler throws', async () => {
    const capturedError = vi.fn();
    registry.onError(async (error) => {
      capturedError(error.message);
    });

    const handler = () => { throw new Error('handler error'); };
    const req = createRequest();
    const reply = createReply();

    const result = await executeWithHooks(registry, req, reply, handler);
    expect(capturedError).toHaveBeenCalledWith('handler error');
    expect(result.hadError).toBe(true);
  });

  it('calls onError when onRequest throws', async () => {
    const capturedError = vi.fn();
    registry.onRequest(async () => { throw new Error('auth failed'); });
    registry.onError(async (error) => { capturedError(error.message); });

    const handler = vi.fn();
    const req = createRequest();
    const reply = createReply();

    const result = await executeWithHooks(registry, req, reply, handler);
    expect(handler).not.toHaveBeenCalled(); // handler should not run
    expect(capturedError).toHaveBeenCalledWith('auth failed');
    expect(result.hadError).toBe(true);
  });

  it('always runs onResponse even on error', async () => {
    const responseCalled = vi.fn();
    registry.onResponse(async (_req, _reply, info) => {
      responseCalled(info.hadError);
    });

    const handler = () => { throw new Error('fail'); };
    const req = createRequest();
    const reply = createReply();

    await executeWithHooks(registry, req, reply, handler);
    expect(responseCalled).toHaveBeenCalledWith(true);
  });

  it('includes route-level hooks', async () => {
    const order: string[] = [];
    registry.onRequest(async () => { order.push('global-req'); });
    registry.onResponse(async () => { order.push('global-res'); });

    const routeHooks: RouteHooks = {
      onRequest: [async () => { order.push('route-req'); }],
      onResponse: [async () => { order.push('route-res'); }],
    };

    const handler = () => { order.push('handler'); };
    const req = createRequest();
    const reply = createReply();

    await executeWithHooks(registry, req, reply, handler, routeHooks);
    expect(order).toEqual(['global-req', 'route-req', 'handler', 'global-res', 'route-res']);
  });

  it('provides accurate duration in onResponse', async () => {
    let capturedDuration = 0;
    registry.onResponse(async (_req, _reply, info) => {
      capturedDuration = info.durationMs;
    });

    const handler = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    };
    const req = createRequest();
    const reply = createReply();

    await executeWithHooks(registry, req, reply, handler);
    expect(capturedDuration).toBeGreaterThanOrEqual(40); // allow some jitter
  });

  it('returns statusCode 500 when error is unhandled', async () => {
    const handler = () => { throw new Error('unhandled'); };
    const req = createRequest();
    const reply = createReply();

    const result = await executeWithHooks(registry, req, reply, handler);
    expect(result.statusCode).toBe(500);
  });

  it('extracts statusCode from HttpError for onResponse info', async () => {
    let capturedStatusCode = 0;
    registry.onError(async (error, _req, reply) => {
      if (error instanceof HttpError) {
        reply.status(error.statusCode).json({ error: error.message });
      }
    });
    registry.onResponse(async (_req, _reply, info) => {
      capturedStatusCode = info.statusCode;
    });

    const handler = () => { throw new HttpError(403, 'FORBIDDEN', 'Not allowed'); };
    const req = createRequest();
    const reply = createReply();

    const result = await executeWithHooks(registry, req, reply, handler);
    expect(result.statusCode).toBe(403);
    expect(capturedStatusCode).toBe(403);
  });

  it('extracts statusCode from an HttpError thrown by another copy of core', async () => {
    // Latent rather than live: nothing in a generated server routes through
    // executeWithHooks today, so this is the programmatic-custom-server path.
    // There each route module is still its own bundle with its own copy of
    // core, and an `instanceof` read flattened every deliberate status into a
    // 500. Structurally an HttpError, not an instance of this module's class.
    const foreign = Object.assign(new Error('Not allowed'), {
      [Symbol.for('vura.http-error')]: true,
      name: 'HttpError',
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(foreign instanceof HttpError).toBe(false);

    let capturedStatusCode = 0;
    registry.onResponse(async (_req, _reply, info) => { capturedStatusCode = info.statusCode; });

    const result = await executeWithHooks(
      registry, createRequest(), createReply(), () => { throw foreign; },
    );
    expect(result.statusCode).toBe(403);
    expect(capturedStatusCode).toBe(403);
  });

  it('converts non-Error throws to Error objects', async () => {
    const capturedError = vi.fn();
    registry.onError(async (error) => { capturedError(error); });

    const handler = () => { throw 'string error'; };
    const req = createRequest();
    const reply = createReply();

    await executeWithHooks(registry, req, reply, handler);
    expect(capturedError).toHaveBeenCalled();
    const err = capturedError.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('string error');
  });
});

describe('getHookRegistry / setDefaultHookRegistry', () => {
  it('returns a singleton', () => {
    const a = getHookRegistry();
    const b = getHookRegistry();
    expect(a).toBe(b);
  });

  it('can be replaced', () => {
    const original = getHookRegistry();
    try {
      const custom = createHookRegistry();
      setDefaultHookRegistry(custom);
      expect(getHookRegistry()).toBe(custom);
    } finally {
      setDefaultHookRegistry(original);
    }
  });
});
