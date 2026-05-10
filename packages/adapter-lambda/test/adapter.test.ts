import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  lambdaAdapter,
  createLambdaHandler,
  eventToRequest,
  responseToResult,
} from '../src/index.js';
import type {
  APIGatewayProxyEventV2,
  LambdaContext,
} from '../src/index.js';
import type { RouteManifest, ApiRoute } from '@then/core';
import type { AdapterBuildContext } from '@then/core';

// ─── Helpers ───

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /api/hello',
    rawPath: '/api/hello',
    rawQueryString: '',
    headers: {
      host: 'example.com',
      'content-type': 'application/json',
    },
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc123',
      domainName: 'example.com',
      domainPrefix: 'abc123',
      http: {
        method: 'GET',
        path: '/api/hello',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test-agent',
      },
      requestId: 'req-id-1',
      routeKey: 'GET /api/hello',
      stage: 'prod',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    ...overrides,
  };
}

function makeLambdaContext(): LambdaContext {
  return {
    functionName: 'test-function',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test',
    memoryLimitInMB: '256',
    awsRequestId: 'test-req-id',
    logGroupName: '/aws/lambda/test',
    logStreamName: '2024/01/01/[$LATEST]abc123',
    getRemainingTimeInMillis: () => 30000,
  };
}

function makeManifest(apiRoutes: ApiRoute[]): RouteManifest {
  return {
    api: apiRoutes,
    pages: [],
    layouts: [],
    timestamp: '2024-01-01T00:00:00.000Z',
  };
}

function makeRoute(overrides: Partial<ApiRoute> = {}): ApiRoute {
  return {
    filePath: 'src/api/hello.ts',
    urlPattern: '/api/hello',
    methods: ['GET'],
    kind: 'serverless',
    config: {},
    ...overrides,
  };
}

// ─── eventToRequest ───

describe('eventToRequest', () => {
  it('converts a simple GET event to a Request', () => {
    const event = makeEvent();
    const req = eventToRequest(event);

    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://example.com/api/hello');
    expect(req.headers.get('content-type')).toBe('application/json');
    expect(req.headers.get('host')).toBe('example.com');
  });

  it('includes query string parameters', () => {
    const event = makeEvent({
      rawPath: '/api/users',
      rawQueryString: 'page=1&limit=10',
      queryStringParameters: { page: '1', limit: '10' },
    });
    const req = eventToRequest(event);

    expect(req.url).toBe('https://example.com/api/users?page=1&limit=10');
    const url = new URL(req.url);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('handles POST with JSON body', async () => {
    const body = JSON.stringify({ name: 'Alice' });
    const event = makeEvent({
      routeKey: 'POST /api/users',
      rawPath: '/api/users',
      requestContext: {
        ...makeEvent().requestContext,
        http: {
          ...makeEvent().requestContext.http,
          method: 'POST',
          path: '/api/users',
        },
        routeKey: 'POST /api/users',
      },
      body,
      isBase64Encoded: false,
    });
    const req = eventToRequest(event);

    expect(req.method).toBe('POST');
    const parsed = await req.json();
    expect(parsed).toEqual({ name: 'Alice' });
  });

  it('handles base64-encoded body', async () => {
    const originalBody = 'Hello, binary world!';
    const base64Body = btoa(originalBody);

    const event = makeEvent({
      routeKey: 'POST /api/upload',
      rawPath: '/api/upload',
      requestContext: {
        ...makeEvent().requestContext,
        http: {
          ...makeEvent().requestContext.http,
          method: 'POST',
          path: '/api/upload',
        },
        routeKey: 'POST /api/upload',
      },
      body: base64Body,
      isBase64Encoded: true,
    });
    const req = eventToRequest(event);

    const text = await req.text();
    expect(text).toBe(originalBody);
  });

  it('merges cookies into Cookie header', () => {
    const event = makeEvent({
      cookies: ['session=abc123', 'theme=dark'],
    });
    const req = eventToRequest(event);

    expect(req.headers.get('cookie')).toBe('session=abc123; theme=dark');
  });

  it('uses x-forwarded-proto for protocol', () => {
    const event = makeEvent({
      headers: {
        host: 'example.com',
        'x-forwarded-proto': 'http',
      },
    });
    const req = eventToRequest(event);

    expect(req.url).toMatch(/^http:\/\//);
  });

  it('does not attach body to GET request', () => {
    const event = makeEvent({ body: 'ignored' });
    const req = eventToRequest(event);

    expect(req.method).toBe('GET');
    expect(req.body).toBeNull();
  });
});

// ─── responseToResult ───

describe('responseToResult', () => {
  it('converts a JSON response', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await responseToResult(response);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-type']).toBe('application/json');
    expect(result.body).toBe('{"ok":true}');
    expect(result.isBase64Encoded).toBe(false);
  });

  it('converts a plain text response', async () => {
    const response = new Response('Hello!', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    const result = await responseToResult(response);

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('Hello!');
    expect(result.isBase64Encoded).toBe(false);
  });

  it('handles 404 status', async () => {
    const response = new Response('Not Found', { status: 404 });
    const result = await responseToResult(response);

    expect(result.statusCode).toBe(404);
  });

  it('handles empty body (204 No Content)', async () => {
    const response = new Response(null, { status: 204 });
    const result = await responseToResult(response);

    expect(result.statusCode).toBe(204);
    expect(result.body).toBeUndefined();
  });

  it('extracts Set-Cookie into cookies array', async () => {
    const response = new Response('ok', {
      status: 200,
      headers: {
        'set-cookie': 'session=abc; HttpOnly',
        'content-type': 'text/plain',
      },
    });
    const result = await responseToResult(response);

    expect(result.cookies).toContain('session=abc; HttpOnly');
    // set-cookie should NOT appear in headers
    expect(result.headers?.['set-cookie']).toBeUndefined();
  });

  it('base64-encodes binary responses', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    const result = await responseToResult(response);

    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBeTruthy();
    // Decode and verify
    const decoded = atob(result.body!);
    expect(decoded.charCodeAt(0)).toBe(0x89);
    expect(decoded.charCodeAt(1)).toBe(0x50);
  });
});

// ─── createLambdaHandler ───

describe('createLambdaHandler', () => {
  it('converts event through app.handle and returns result', async () => {
    const mockApp = {
      handle: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        return new Response(
          JSON.stringify({ path: url.pathname, method: request.method }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    };

    const handler = createLambdaHandler(mockApp);
    const event = makeEvent();
    const result = await handler(event, makeLambdaContext());

    expect(result.statusCode).toBe(200);
    expect(mockApp.handle).toHaveBeenCalledTimes(1);

    const body = JSON.parse(result.body!);
    expect(body.path).toBe('/api/hello');
    expect(body.method).toBe('GET');
  });

  it('passes POST body through to the app', async () => {
    const mockApp = {
      handle: vi.fn(async (request: Request) => {
        const data = await request.json();
        return new Response(JSON.stringify({ received: data }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const handler = createLambdaHandler(mockApp);
    const event = makeEvent({
      routeKey: 'POST /api/users',
      rawPath: '/api/users',
      requestContext: {
        ...makeEvent().requestContext,
        http: {
          ...makeEvent().requestContext.http,
          method: 'POST',
          path: '/api/users',
        },
        routeKey: 'POST /api/users',
      },
      body: JSON.stringify({ name: 'Bob' }),
    });

    const result = await handler(event, makeLambdaContext());

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body!);
    expect(body.received).toEqual({ name: 'Bob' });
  });

  it('handles app errors gracefully when app returns error response', async () => {
    const mockApp = {
      handle: vi.fn(async () => {
        return new Response('Internal Server Error', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        });
      }),
    };

    const handler = createLambdaHandler(mockApp);
    const result = await handler(makeEvent(), makeLambdaContext());

    expect(result.statusCode).toBe(500);
    expect(result.body).toBe('Internal Server Error');
  });
});

// ─── lambdaAdapter — SAM template generation ───

// Module-level map so the hoisted vi.mock factory can access it
const writtenFiles = new Map<string, string>();

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    }),
    mkdir: vi.fn(async () => undefined),
  };
});

describe('lambdaAdapter', () => {
  beforeEach(() => {
    writtenFiles.clear();
  });

  function makeBuildContext(manifest: RouteManifest): AdapterBuildContext {
    return {
      serverEntry: '/project/dist/server/entry.js',
      clientDir: '/project/dist/client',
      manifest,
      projectRoot: '/project',
      outDir: '/project/dist',
    };
  }

  it('generates SAM template with correct routes', async () => {
    const routes: ApiRoute[] = [
      makeRoute({ urlPattern: '/api/hello', methods: ['GET'], kind: 'serverless' }),
      makeRoute({ urlPattern: '/api/users', methods: ['GET', 'POST'], kind: 'serverless' }),
    ];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter({ region: 'us-west-2' });

    await adapter.buildEnd(makeBuildContext(manifest));

    const templatePath = '/project/dist/template.yaml';
    const template = writtenFiles.get(templatePath);

    expect(template).toBeDefined();
    expect(template).toContain('AWS::Serverless-2016-10-31');
    expect(template).toContain('AWS::Serverless::HttpApi');
    expect(template).toContain('AWS::Serverless::Function');
    // Should have the routes mapped
    expect(template).toContain('/api/hello');
    expect(template).toContain('/api/users');
    // Should have both GET and POST for /api/users
    expect(template).toContain('Method: GET');
    expect(template).toContain('Method: POST');
  });

  it('applies custom memory and timeout config', async () => {
    const routes = [makeRoute({ kind: 'serverless' })];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter({ memory: 512, timeout: 15 });

    await adapter.buildEnd(makeBuildContext(manifest));

    const template = writtenFiles.get('/project/dist/template.yaml')!;
    expect(template).toContain('MemorySize: 512');
    expect(template).toContain('Timeout: 15');
  });

  it('uses default memory (256) and timeout (30)', async () => {
    const routes = [makeRoute({ kind: 'serverless' })];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter();

    await adapter.buildEnd(makeBuildContext(manifest));

    const template = writtenFiles.get('/project/dist/template.yaml')!;
    expect(template).toContain('MemorySize: 256');
    expect(template).toContain('Timeout: 30');
  });

  it('generates samconfig.toml with stack name and region', async () => {
    const routes = [makeRoute({ kind: 'serverless' })];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter({ region: 'eu-west-1', stackName: 'my-app' });

    await adapter.buildEnd(makeBuildContext(manifest));

    const samconfig = writtenFiles.get('/project/dist/samconfig.toml')!;
    expect(samconfig).toContain('stack_name = "my-app"');
    expect(samconfig).toContain('region = "eu-west-1"');
  });

  it('filters out non-serverless routes', async () => {
    const routes: ApiRoute[] = [
      makeRoute({ urlPattern: '/api/serverless', methods: ['GET'], kind: 'serverless' }),
      makeRoute({ urlPattern: '/api/hot', methods: ['GET'], kind: 'hot' }),
      makeRoute({ urlPattern: '/api/task', methods: ['POST'], kind: 'task' }),
    ];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter();

    await adapter.buildEnd(makeBuildContext(manifest));

    const template = writtenFiles.get('/project/dist/template.yaml')!;
    expect(template).toContain('/api/serverless');
    expect(template).not.toContain('/api/hot');
    expect(template).not.toContain('/api/task');
  });

  it('creates separate functions for multi-method routes', async () => {
    const routes: ApiRoute[] = [
      makeRoute({
        urlPattern: '/api/items',
        methods: ['GET', 'POST', 'DELETE'],
        kind: 'serverless',
      }),
    ];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter();

    await adapter.buildEnd(makeBuildContext(manifest));

    const template = writtenFiles.get('/project/dist/template.yaml')!;

    // Should have 3 separate function resources
    const functionCount = (template.match(/Type: AWS::Serverless::Function/g) || []).length;
    expect(functionCount).toBe(3);

    // Each method should appear
    expect(template).toContain('Method: GET');
    expect(template).toContain('Method: POST');
    expect(template).toContain('Method: DELETE');
  });

  it('converts path params from :id to {id} in SAM template', async () => {
    const routes: ApiRoute[] = [
      makeRoute({
        urlPattern: '/api/users/:id',
        methods: ['GET'],
        kind: 'serverless',
      }),
    ];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter();

    await adapter.buildEnd(makeBuildContext(manifest));

    const template = writtenFiles.get('/project/dist/template.yaml')!;
    expect(template).toContain('/api/users/{id}');
    expect(template).not.toContain('/api/users/:id');
  });

  it('generates handler files for each function', async () => {
    const routes: ApiRoute[] = [
      makeRoute({ urlPattern: '/api/hello', methods: ['GET'], kind: 'serverless' }),
    ];
    const manifest = makeManifest(routes);
    const adapter = lambdaAdapter();

    await adapter.buildEnd(makeBuildContext(manifest));

    // Find the handler file
    const handlerPath = Array.from(writtenFiles.keys()).find((k) =>
      k.includes('lambda') && k.endsWith('index.js'),
    );
    expect(handlerPath).toBeDefined();

    const handlerCode = writtenFiles.get(handlerPath!)!;
    // Self-contained — no @celsian/core or @then/adapter-lambda dependency
    expect(handlerCode).not.toContain('@celsian/core');
    expect(handlerCode).not.toContain('@then/adapter-lambda');
    // Has inline event conversion and req/reply shim
    expect(handlerCode).toContain('function eventToRequest');
    expect(handlerCode).toContain('function parseBody');
    expect(handlerCode).toContain('export async function handler');
  });

  it('has correct adapter name', () => {
    const adapter = lambdaAdapter();
    expect(adapter.name).toBe('adapter-lambda');
  });
});
