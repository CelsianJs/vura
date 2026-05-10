/**
 * @then/adapter-lambda
 *
 * Generates AWS Lambda + API Gateway deployment artifacts from ThenJS build output.
 * Produces a SAM template, per-function handler files, and samconfig.toml.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThenAdapter, AdapterBuildContext } from '@then/core';
import type { ApiRoute, HttpMethod } from '@then/core';


const require = createRequire(import.meta.url);

function resolveCorePackageDir(): string {
  try {
    return dirname(require.resolve('@then/core'));
  } catch {
    const localCore = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@then', 'core');
    return join(localCore, existsSync(join(localCore, 'src')) ? 'src' : 'dist');
  }
}

const CORE_PACKAGE_DIR = resolveCorePackageDir();

function coreModuleExt(moduleName: string): string {
  return existsSync(join(CORE_PACKAGE_DIR, `${moduleName}.ts`)) ? 'ts' : 'js';
}

function thenCoreRuntimeShimPlugin() {
  return {
    name: 'then-core-runtime-shim',
    setup(build: any) {
      build.onResolve({ filter: /^@then\/core\/(jsx-runtime|jsx-dev-runtime)$/ }, () => ({
        path: join(CORE_PACKAGE_DIR, `jsx-runtime.${coreModuleExt('jsx-runtime')}`),
      }));
      build.onResolve({ filter: /^@then\/core$/ }, () => ({
        path: '@then/core',
        namespace: 'then-core-runtime-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'then-core-runtime-shim' }, () => ({
        loader: 'js',
        resolveDir: CORE_PACKAGE_DIR,
        contents: `
export { defineConfig } from './config.${coreModuleExt('config')}';
export { HttpError, ErrorCode, badRequest, unauthorized, forbidden, notFound, methodNotAllowed, conflict, rateLimited, internalError, serviceUnavailable, formatErrorResponse, sendErrorResponse, renderErrorPage, setGlobalErrorHandler, getGlobalErrorHandler, reportError, getErrorMode } from './errors.${coreModuleExt('errors')}';
export { defineSchema, validate, withValidation, validateRequest } from './validation.${coreModuleExt('validation')}';
export { HookRegistry, createHookRegistry, getHookRegistry, setDefaultHookRegistry, executeWithHooks } from './hooks.${coreModuleExt('hooks')}';
`,
      }));
    },
  };
}

// ─── Public Types ───

export interface CorsOptions {
  allowOrigins?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
}

export interface LambdaAdapterOptions {
  /** AWS region (default: us-east-1) */
  region?: string;
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout in seconds (default: 30) */
  timeout?: number;
  /** CloudFormation stack name (default: then-app) */
  stackName?: string;
  /** Lambda runtime (default: nodejs20.x) */
  runtime?: string;
  /** Lambda architecture (default: arm64) */
  architecture?: 'x86_64' | 'arm64';
  /** CORS configuration (default: restrictive) */
  cors?: CorsOptions;
}

export interface APIGatewayProxyEventV2 {
  version: '2.0';
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    domainPrefix: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  stageVariables?: Record<string, string | undefined>;
  cookies?: string[];
}

export interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

export interface LambdaContext {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis(): number;
}

// ─── Lambda Event <-> Web Standard Conversion ───

/**
 * Convert an APIGatewayProxyEventV2 into a standard Web Request.
 */
export function eventToRequest(event: APIGatewayProxyEventV2): Request {
  const {
    rawPath,
    rawQueryString,
    headers,
    body,
    isBase64Encoded,
    requestContext,
  } = event;

  // Build the full URL
  const protocol = headers['x-forwarded-proto'] ?? 'https';
  const host = headers['host'] ?? requestContext.domainName;
  const queryPart = rawQueryString ? `?${rawQueryString}` : '';
  const url = `${protocol}://${host}${rawPath}${queryPart}`;

  // Build the Headers object
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      requestHeaders.set(key, value);
    }
  }

  // Add cookies as a single Cookie header if present
  if (event.cookies && event.cookies.length > 0) {
    requestHeaders.set('cookie', event.cookies.join('; '));
  }

  const method = requestContext.http.method.toUpperCase();

  // Decode body
  let requestBody: BodyInit | undefined;
  if (body) {
    if (isBase64Encoded) {
      // Convert base64 to Uint8Array
      const binaryStr = atob(body);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      requestBody = bytes;
    } else {
      requestBody = body;
    }
  }

  // GET and HEAD requests must not have a body
  const init: RequestInit = { method, headers: requestHeaders };
  if (method !== 'GET' && method !== 'HEAD' && requestBody !== undefined) {
    init.body = requestBody;
  }

  return new Request(url, init);
}

/**
 * Convert a Web Standard Response into an APIGatewayProxyResultV2.
 */
export async function responseToResult(response: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  response.headers.forEach((value, key) => {
    // Set-Cookie must be returned via the cookies array in v2 format
    if (key.toLowerCase() === 'set-cookie') {
      cookies.push(value);
    } else {
      headers[key] = value;
    }
  });

  // Read body — check if it's binary
  const contentType = response.headers.get('content-type') ?? '';
  const isBinary = isBinaryContentType(contentType);

  let body: string | undefined;
  let isBase64Encoded = false;

  if (response.body) {
    if (isBinary) {
      const buffer = await response.arrayBuffer();
      body = arrayBufferToBase64(buffer);
      isBase64Encoded = true;
    } else {
      body = await response.text();
    }
  }

  const result: APIGatewayProxyResultV2 = {
    statusCode: response.status,
    headers,
    body,
    isBase64Encoded,
  };

  if (cookies.length > 0) {
    result.cookies = cookies;
  }

  return result;
}

// ─── createLambdaHandler ───

/**
 * Wraps a CelsianJS app (or any object with a `.handle(request: Request)` method)
 * into an AWS Lambda handler function.
 *
 * @example
 * ```ts
 * import { createApp } from '@celsian/core';
 * import { createLambdaHandler } from '@then/adapter-lambda';
 *
 * const app = createApp();
 * app.get('/api/hello', (req, reply) => reply.json({ hello: 'world' }));
 *
 * export const handler = createLambdaHandler(app);
 * ```
 */
export function createLambdaHandler(
  app: { handle(request: Request): Promise<Response> | Response },
): (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyResultV2> {
  return async (event: APIGatewayProxyEventV2, _context: LambdaContext): Promise<APIGatewayProxyResultV2> => {
    const request = eventToRequest(event);
    const response = await app.handle(request);
    return responseToResult(response);
  };
}

// ─── SAM Template Generation ───

interface SamFunction {
  name: string;
  handler: string;
  codeUri: string;
  route: ApiRoute;
  method: HttpMethod;
}

/**
 * Convert a route URL pattern from ThenJS format (:param) to API Gateway format ({param}).
 */
function toApiGatewayPath(urlPattern: string): string {
  return urlPattern.replace(/:(\w+)/g, '{$1}').replace(/\*(\w+)/g, '{$1+}');
}

/**
 * Generate a safe CloudFormation logical ID from a route + method.
 */
function toLogicalId(route: ApiRoute, method: HttpMethod): string {
  const pathPart = route.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
  const id = `${method}${pathPart.charAt(0).toUpperCase()}${pathPart.slice(1)}`;
  // CloudFormation logical IDs must be alphanumeric
  return id.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Generate the SAM template.yaml content.
 */
function generateSamTemplate(
  functions: SamFunction[],
  options: Required<Pick<LambdaAdapterOptions, 'memory' | 'timeout' | 'runtime' | 'architecture'>> & { cors?: CorsOptions },
  taskRoutes: ApiRoute[] = [],
): string {
  const resources: string[] = [];

  // API Gateway
  const corsOrigins = (options.cors?.allowOrigins ?? []).map(o => `          - "${o}"`).join('\n');
  const corsMethods = (options.cors?.allowMethods ?? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).map(m => `          - "${m}"`).join('\n');
  const corsHeaders = (options.cors?.allowHeaders ?? ['Content-Type', 'Authorization']).map(h => `          - "${h}"`).join('\n');

  const corsBlock = corsOrigins ? `
      CorsConfiguration:
        AllowOrigins:
${corsOrigins}
        AllowMethods:
${corsMethods}
        AllowHeaders:
${corsHeaders}` : '';

  resources.push(`  ThenHttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: prod${corsBlock}`);

  // Lambda functions
  for (const fn of functions) {
    // Check if this is a task route with a schedule
    const isTask = fn.route.kind === 'task';
    const schedule = fn.route.config.schedule as string | undefined;

    if (isTask && schedule) {
      // Task function with EventBridge cron trigger
      resources.push(`  ${fn.name}Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: ${fn.handler}
      CodeUri: ${fn.codeUri}
      Runtime: ${options.runtime}
      Architectures:
        - ${options.architecture}
      MemorySize: ${options.memory}
      Timeout: ${fn.route.config.timeout ? Math.ceil((fn.route.config.timeout as number) / 1000) : options.timeout}
      Events:
        Schedule:
          Type: Schedule
          Properties:
            Schedule: cron(${cronToAWSCron(schedule)})
            Enabled: true`);
    } else {
      const apiPath = toApiGatewayPath(fn.route.urlPattern);
      resources.push(`  ${fn.name}Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: ${fn.handler}
      CodeUri: ${fn.codeUri}
      Runtime: ${options.runtime}
      Architectures:
        - ${options.architecture}
      MemorySize: ${options.memory}
      Timeout: ${options.timeout}
      Events:
        Api:
          Type: HttpApi
          Properties:
            ApiId: !Ref ThenHttpApi
            Path: ${apiPath}
            Method: ${fn.method}`);
    }
  }

  return `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: ThenJS Application

Globals:
  Function:
    Runtime: ${options.runtime}
    Architectures:
      - ${options.architecture}
    MemorySize: ${options.memory}
    Timeout: ${options.timeout}
    Environment:
      Variables:
        NODE_ENV: production

Resources:
${resources.join('\n\n')}

Outputs:
  ApiUrl:
    Description: API Gateway endpoint URL
    Value: !Sub "https://\${ThenHttpApi}.execute-api.\${AWS::Region}.amazonaws.com/prod"
`;
}

/**
 * Generate samconfig.toml content.
 */
function generateSamConfig(stackName: string, region: string): string {
  return `version = 0.1

[default.deploy.parameters]
stack_name = "${stackName}"
resolve_s3 = true
s3_prefix = "${stackName}"
region = "${region}"
capabilities = "CAPABILITY_IAM"
confirm_changeset = true
`;
}

/**
 * Generate a self-contained Lambda handler file for a specific route.
 * No @celsian/core dependency — includes inline event conversion and req/reply shim.
 */
function generateHandlerFile(route: ApiRoute): string {
  const imports = route.methods
    .map((m) => m)
    .join(', ');

  return `// Auto-generated — self-contained Lambda handler
import { ${imports} } from './route.js';

function eventToRequest(event) {
  const { rawPath, rawQueryString, headers, body, isBase64Encoded, requestContext } = event;
  const protocol = headers['x-forwarded-proto'] || 'https';
  const host = headers['host'] || requestContext.domainName;
  const queryPart = rawQueryString ? '?' + rawQueryString : '';
  const url = protocol + '://' + host + rawPath + queryPart;

  const reqHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) reqHeaders.set(key, value);
  }
  if (event.cookies && event.cookies.length > 0) {
    reqHeaders.set('cookie', event.cookies.join('; '));
  }

  const method = requestContext.http.method.toUpperCase();
  let requestBody;
  if (body) {
    if (isBase64Encoded) {
      const binaryStr = atob(body);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      requestBody = bytes;
    } else {
      requestBody = body;
    }
  }

  const init = { method, headers: reqHeaders };
  if (method !== 'GET' && method !== 'HEAD' && requestBody !== undefined) {
    init.body = requestBody;
  }
  return new Request(url, init);
}

function parseBody(request) {
  const ct = (request.headers && request.headers.get ? request.headers.get('content-type') : '') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  if (ct.includes('application/x-www-form-urlencoded')) return request.text().then(t => Object.fromEntries(new URLSearchParams(t)));
  return request.text();
}

function isBinaryContentType(ct) {
  if (!ct) return false;
  return ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/') ||
    ct.startsWith('application/octet-stream') || ct.startsWith('application/pdf') ||
    ct.startsWith('application/zip') || ct.startsWith('font/');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function responseToResult(response) {
  const headers = {};
  const cookies = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
    else headers[key] = value;
  });

  const contentType = response.headers.get('content-type') || '';
  const isBinary = isBinaryContentType(contentType);
  let body;
  let isBase64Encoded = false;

  if (response.body) {
    if (isBinary) {
      const buffer = await response.arrayBuffer();
      body = arrayBufferToBase64(buffer);
      isBase64Encoded = true;
    } else {
      body = await response.text();
    }
  }

  const result = { statusCode: response.status, headers, body, isBase64Encoded };
  if (cookies.length > 0) result.cookies = cookies;
  return result;
}

const handlers = { ${route.methods.map(m => `${m}`).join(', ')} };

export async function handler(event, context) {
  // Detect EventBridge scheduled event (cron trigger)
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
    const taskHandler = handlers.POST;
    if (typeof taskHandler !== 'function') {
      return { statusCode: 500, body: JSON.stringify({ error: 'No POST handler for scheduled task' }) };
    }
    const result = await taskHandler({
      taskId: event.id || String(Date.now()),
      input: { _cron: true, _schedule: event.resources?.[0] || 'scheduled' },
      attempt: 1,
    });
    return { statusCode: 200, body: JSON.stringify({ status: 'completed', result }) };
  }

  const request = eventToRequest(event);
  const method = request.method.toUpperCase();

  const handlerFn = handlers[method];
  if (typeof handlerFn !== 'function') {
    return { statusCode: 405, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const url = new URL(request.url);
  const body = await parseBody(request);
  const req = {
    method,
    url: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    params: event.pathParameters || {},
    query: event.queryStringParameters || {},
    body,
    parsedBody: body,
    __lambda_context: context,
  };

  let statusCode = 200;
  const responseHeaders = { 'content-type': 'application/json' };
  let responseBody = null;
  const reply = {
    status(code) { statusCode = code; return reply; },
    header(name, value) { responseHeaders[name] = value; return reply; },
    json(data) { responseBody = JSON.stringify(data); return null; },
    send(data) { responseBody = data; return null; },
  };

  const result = await handlerFn(req, reply);
  if (result instanceof Response) return responseToResult(result);
  if (responseBody !== null) return { statusCode, headers: responseHeaders, body: responseBody };
  if (result && typeof result === 'object') return { statusCode, headers: responseHeaders, body: JSON.stringify(result) };
  return { statusCode: 204 };
}
`;
}

// ─── Adapter Factory ───

/**
 * Create a ThenJS adapter for AWS Lambda + API Gateway (SAM).
 *
 * @example
 * ```ts
 * // then.config.ts
 * import { defineConfig } from '@then/core';
 * import { lambdaAdapter } from '@then/adapter-lambda';
 *
 * export default defineConfig({
 *   adapter: lambdaAdapter({
 *     region: 'us-east-1',
 *     memory: 512,
 *     timeout: 15,
 *   }),
 * });
 * ```
 */
export function lambdaAdapter(options: LambdaAdapterOptions = {}): ThenAdapter {
  const region = options.region ?? 'us-east-1';
  const memory = options.memory ?? 256;
  const timeout = options.timeout ?? 30;
  const stackName = options.stackName ?? 'then-app';
  const runtime = options.runtime ?? 'nodejs20.x';
  const architecture = options.architecture ?? 'arm64';

  return {
    name: 'adapter-lambda',

    async buildEnd(ctx: AdapterBuildContext): Promise<void> {
      const { manifest, outDir } = ctx;
      const lambdaDir = join(outDir, 'lambda');
      await mkdir(lambdaDir, { recursive: true });

      // Filter for serverless routes only
      const serverlessRoutes = manifest.api.filter((r) => r.kind === 'serverless');

      // Build function descriptors — one per route+method combination
      const samFunctions: SamFunction[] = [];

      for (const route of serverlessRoutes) {
        const routeDirName = route.urlPattern
          .replace(/^\//, '')
          .replace(/[/:*]/g, '_')
          .replace(/_+/g, '_')
          .replace(/_$/, '');

        for (const method of route.methods) {
          const funcName = toLogicalId(route, method);
          const funcDir = join(lambdaDir, `${routeDirName}_${method.toLowerCase()}`);
          await mkdir(funcDir, { recursive: true });

          // Write the handler file and bundled route module.
          const handlerCode = generateHandlerFile(route);
          await writeFile(join(funcDir, 'index.js'), handlerCode);
          await bundleRouteModule(route, ctx.projectRoot, join(funcDir, 'route.js'));

          samFunctions.push({
            name: funcName,
            handler: 'index.handler',
            codeUri: `lambda/${routeDirName}_${method.toLowerCase()}/`,
            route,
            method,
          });
        }
      }

      // Process task routes — add EventBridge scheduled triggers
      const taskRoutes = manifest.api.filter(r => r.kind === 'task');
      for (const route of taskRoutes) {
        const schedule = route.config.schedule as string | undefined;
        if (!schedule) continue;

        const routeDirName = 'task_' + route.urlPattern
          .replace(/^\//, '')
          .replace(/[/:*]/g, '_')
          .replace(/_+/g, '_')
          .replace(/_$/, '');

        const funcDir = join(lambdaDir, routeDirName);
        await mkdir(funcDir, { recursive: true });

        const handlerCode = generateHandlerFile(route);
        await writeFile(join(funcDir, 'index.js'), handlerCode);
        await bundleRouteModule(route, ctx.projectRoot, join(funcDir, 'route.js'));

        const funcName = 'Task' + route.urlPattern
          .replace(/^\/api\//, '')
          .replace(/[/:*\-]/g, '_')
          .replace(/_+/g, '_')
          .replace(/(^|_)(\w)/g, (_: string, __: string, c: string) => c.toUpperCase());

        samFunctions.push({
          name: funcName,
          handler: 'index.handler',
          codeUri: `lambda/${routeDirName}/`,
          route,
          method: 'POST',
        });
      }

      // Write SAM template (with cron schedules for task routes)
      const templateContent = generateSamTemplate(samFunctions, {
        memory,
        timeout,
        runtime,
        architecture,
        cors: options.cors,
      }, taskRoutes);
      await writeFile(join(outDir, 'template.yaml'), templateContent);

      // Write samconfig.toml
      const samConfig = generateSamConfig(stackName, region);
      await writeFile(join(outDir, 'samconfig.toml'), samConfig);
    },
  };
}

// ─── Utilities ───

async function bundleRouteModule(route: ApiRoute, projectRoot: string, outfile: string): Promise<void> {
  const absPath = join(projectRoot, route.filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Route source not found for ${route.filePath}: ${absPath}`);
  }

  const { build: esbuild } = await import('esbuild');
  await mkdir(dirname(outfile), { recursive: true });
  await esbuild({
    entryPoints: [absPath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    outfile,
    nodePaths: [
      join(projectRoot, 'node_modules'),
      join(process.cwd(), 'node_modules'),
      join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'),
    ],
    plugins: [thenCoreRuntimeShimPlugin()],
    external: ['what-framework', 'what-framework/*'],
  });
}

/**
 * Convert a standard 5-field cron expression to AWS 6-field format.
 * Standard: minute hour dayOfMonth month dayOfWeek
 * AWS:      minute hour dayOfMonth month dayOfWeek year
 */
function cronToAWSCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) {
    let [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Convert day-of-week: standard cron uses 0-6 (Sun=0), AWS uses 1-7 (Sun=1)
    if (dayOfWeek !== '*' && dayOfWeek !== '?') {
      dayOfWeek = dayOfWeek.replace(/\d+/g, (d) => String(parseInt(d, 10) + 1));
    }

    // AWS requires: if dayOfWeek is specified, dayOfMonth must be ? (or vice versa)
    if (dayOfWeek === '*' && dayOfMonth !== '?') dayOfWeek = '?';
    else if (dayOfMonth === '*' && dayOfWeek !== '?') dayOfMonth = '?';
    else if (dayOfWeek !== '*' && dayOfWeek !== '?' && dayOfMonth !== '*' && dayOfMonth !== '?') {
      // Both specified — AWS doesn't support this, default dayOfMonth to ?
      dayOfMonth = '?';
    }
    return `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek} *`;
  }
  return expr;
}

function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false;
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('application/octet-stream') ||
    contentType.startsWith('application/pdf') ||
    contentType.startsWith('application/zip') ||
    contentType.startsWith('font/')
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
