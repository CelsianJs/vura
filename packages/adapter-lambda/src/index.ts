/**
 * @celsian/vura-adapter-lambda
 *
 * Generates AWS Lambda + API Gateway deployment artifacts from Vura build output.
 * Produces a SAM template, per-function handler files, and samconfig.toml.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  vuraCoreRuntimeShimContents,
  serverlessRevalidateStubs,
  pruneStaleOutputs,
  GLOBAL_HOOKS_FILENAMES,
  serverPagesOf,
  pageDegradations,
  generatePagesModuleSource,
  bundlePagesModule,
  collectPageAssets,
  copyPageAssets,
} from '@celsian/vura-core';
import type { ThenAdapter, AdapterBuildContext } from '@celsian/vura-core';
import type { ApiRoute, HttpMethod, PageRoute } from '@celsian/vura-core';


const require = createRequire(import.meta.url);

function resolveCorePackageDir(): string {
  try {
    return dirname(require.resolve('@celsian/vura-core'));
  } catch {
    const localCore = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@celsian', 'vura-core');
    return join(localCore, existsSync(join(localCore, 'src')) ? 'src' : 'dist');
  }
}

const CORE_PACKAGE_DIR = resolveCorePackageDir();

function coreModuleExt(moduleName: string): string {
  return existsSync(join(CORE_PACKAGE_DIR, `${moduleName}.ts`)) ? 'ts' : 'js';
}

function vuraCoreRuntimeShimPlugin() {
  return {
    name: 'vura-core-runtime-shim',
    setup(build: any) {
      build.onResolve({ filter: /^@celsian\/vura-core\/(jsx-runtime|jsx-dev-runtime)$/ }, () => ({
        path: join(CORE_PACKAGE_DIR, `jsx-runtime.${coreModuleExt('jsx-runtime')}`),
      }));
      build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
        path: '@celsian/vura-core',
        namespace: 'vura-core-runtime-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'vura-core-runtime-shim' }, () => ({
        loader: 'js',
        resolveDir: CORE_PACKAGE_DIR,
        contents: vuraCoreRuntimeShimContents({
          packageDir: CORE_PACKAGE_DIR,
          // No Node server inside a Lambda function bundle.
          includeServerRuntime: false,
          extra: serverlessRevalidateStubs('Lambda functions'),
        }),
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
  /** Lambda runtime (default: nodejs22.x) */
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
 * import { createLambdaHandler } from '@celsian/vura-adapter-lambda';
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
 * Convert a route URL pattern from Vura format (:param) to API Gateway format ({param}).
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
 * A CloudFormation-safe event id for a page's HttpApi route.
 *
 * Event ids live in one namespace per function, so `/` and `/posts` must not
 * collapse to the same name. Alphanumerics only, and a stable one for the site
 * root, which has no path characters left after sanitising.
 */
function toPageEventId(page: PageRoute): string {
  const cleaned = page.urlPattern
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `Page${cleaned || 'Root'}`;
}

/**
 * Generate the SAM template.yaml content.
 */
function generateSamTemplate(
  functions: SamFunction[],
  options: Required<Pick<LambdaAdapterOptions, 'memory' | 'timeout' | 'runtime' | 'architecture'>> & { cors?: CorsOptions },
  taskRoutes: ApiRoute[] = [],
  /** Every page in the manifest, or [] when the project has none. */
  pages: PageRoute[] = [],
  /**
   * Whether to declare the pages function at all. Not `pages.length > 0`: a
   * project with only public/ files has assets to serve and no page routes.
   */
  emitPages = false,
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
      // Task function with EventBridge cron trigger.
      // Runtime/Architectures/MemorySize/Timeout are inherited from Globals
      // to avoid SAM lint errors about duplicate values (E3032/E3037).
      const taskTimeout = fn.route.config.timeout ? Math.ceil((fn.route.config.timeout as number) / 1000) : undefined;
      resources.push(`  ${fn.name}Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: ${fn.handler}
      CodeUri: ${fn.codeUri}${taskTimeout !== undefined && taskTimeout !== options.timeout ? `\n      Timeout: ${taskTimeout}` : ''}
      Events:
        Schedule:
          Type: Schedule
          Properties:
            Schedule: cron(${cronToAWSCron(schedule)})
            Enabled: true`);
    } else {
      const apiPath = toApiGatewayPath(fn.route.urlPattern);
      // Runtime/Architectures/MemorySize/Timeout are inherited from Globals
      // to avoid SAM lint errors about duplicate values (E3032/E3037).
      resources.push(`  ${fn.name}Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: ${fn.handler}
      CodeUri: ${fn.codeUri}
      Events:
        Api:
          Type: HttpApi
          Properties:
            ApiId: !Ref ThenHttpApi
            Path: ${apiPath}
            Method: ${fn.method}`);
    }
  }

  // The pages function. It was missing entirely: a build with four pages
  // produced a template with none of them, so `/` and every other page path was
  // an unmapped route and API Gateway answered 403 "Missing Authentication
  // Token" — a build that exited 0 and served no site.
  //
  // Two kinds of route are emitted, and both are needed:
  //
  //   - One GET route per page pattern. These are the pages, named, so the
  //     template says what the deployment serves and a reader can check it
  //     against the build's page table.
  //   - A greedy `/{proxy+}` on ANY. This is what serves the client bundles
  //     under /_then/, anything copied from public/, and — because HTTP API
  //     matches the most specific route first, so every route above still wins
  //     — what turns an unknown path into the same 404 page the Node server
  //     returns instead of API Gateway's 403.
  if (emitPages) {
    const events: string[] = [];
    const seen = new Set<string>();

    for (const page of pages) {
      const apiPath = toApiGatewayPath(page.urlPattern);
      const key = `GET ${apiPath}`;
      if (seen.has(key)) {
        console.warn(
          `[vura] two pages map to the same API Gateway route (${apiPath}); ` +
          `only the first is declared: ${page.filePath}`,
        );
        continue;
      }
      seen.add(key);
      events.push(`        ${toPageEventId(page)}:
          Type: HttpApi
          Properties:
            ApiId: !Ref ThenHttpApi
            Path: ${apiPath}
            Method: GET`);
    }

    events.push(`        CatchAll:
          Type: HttpApi
          Properties:
            ApiId: !Ref ThenHttpApi
            Path: /{proxy+}
            Method: ANY`);

    resources.push(`  ${PAGES_LOGICAL_ID}Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
      CodeUri: lambda/${PAGES_DIR}/
      Events:
${events.join('\n')}`);
  }

  return `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Vura Application

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
 *
 * `globalHooksFile` is the project's conventional hooks file (src/api/_hooks.ts
 * or src/hooks.ts) when it exists and this function serves HTTP. buildEnd
 * bundles it into the same function directory as hooks.js; the handler imports
 * it and merges its hooks ahead of the route's own, which is the order the hot
 * server and the generated dist/functions/ entry both use. Passing null emits
 * an empty stand-in so no import is left dangling.
 */
function generateHandlerFile(route: ApiRoute, globalHooksFile?: string | null): string {
  const hooksImport = globalHooksFile
    ? "import * as globalHooksMod from './hooks.js';"
    : 'const globalHooksMod = {};';
  return `// Auto-generated — self-contained Lambda handler
import * as routeMod from './route.js';
${hooksImport}

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

// The hot server and core's dist/functions/ entry both hand a hook a request
// whose headers answer .get(); these two adapters hand it a plain lowercased
// object, so the auth snippet the hooks reference prints —
// req.headers.get('authorization') — threw here. A hooks file is written once
// and deployed to every target, so the accessor is added rather than the object
// replaced: .get/.has are non-enumerable, so Object.keys, spread and
// JSON.stringify over req.headers are unchanged and existing
// req.headers['x-thing'] reads keep working.
function withHeaderAccessors(headers) {
  const read = (name) => {
    const value = headers[String(name).toLowerCase()];
    return value === undefined ? null : value;
  };
  Object.defineProperties(headers, {
    get: { value: read, writable: true, configurable: true, enumerable: false },
    has: { value: (name) => read(name) !== null, writable: true, configurable: true, enumerable: false },
  });
  return headers;
}

function normalizeHooks(hooks) {
  if (!hooks) return undefined;
  return {
    onRequest: hooks.onRequest ? (Array.isArray(hooks.onRequest) ? hooks.onRequest : [hooks.onRequest]) : undefined,
    onError: hooks.onError ? (Array.isArray(hooks.onError) ? hooks.onError : [hooks.onError]) : undefined,
    onResponse: hooks.onResponse ? (Array.isArray(hooks.onResponse) ? hooks.onResponse : [hooks.onResponse]) : undefined,
  };
}

function validationIssues(target, error) {
  const issues = (error && Array.isArray(error.issues)) ? error.issues : [{ path: [], message: error?.message || 'Invalid value' }];
  return { target, issues: issues.map(i => ({ path: Array.isArray(i.path) ? i.path.join('.') : String(i.path || ''), message: i.message || 'Invalid value', ...(i.code ? { code: i.code } : {}) })) };
}

function validateRequest(req, schema) {
  const errors = [];
  if (schema.body) {
    const r = schema.body.safeParse(req.parsedBody);
    if (!r.success) errors.push(validationIssues('body', r.error));
    else { req.parsedBody = r.data; req.body = r.data; }
  }
  if (schema.query) {
    const r = schema.query.safeParse(req.query);
    if (!r.success) errors.push(validationIssues('query', r.error));
    // Match the celsian runtime: the validated+coerced output replaces
    // req.query, so reading it never hands back input that skipped the schema.
    // req.parsedQuery is the explicitly-typed alias.
    else { req.parsedQuery = r.data; req.query = r.data; }
  }
  if (schema.params) {
    const r = schema.params.safeParse(req.params);
    if (!r.success) errors.push(validationIssues('params', r.error));
    else req.params = r.data;
  }
  if (errors.length > 0) {
    const issueCount = errors.reduce((acc, e) => acc + e.issues.length, 0);
    const message = 'Validation failed: ' + issueCount + ' issue' + (issueCount > 1 ? 's' : '') + ' in ' + errors.map(e => e.target).join(', ');
    return { statusCode: 400, body: { error: message, code: 'VALIDATION_ERROR', details: errors } };
  }
  req.validated = { body: req.parsedBody, query: schema.query ? req.parsedQuery : req.query, params: req.params };
  return null;
}

// Global hooks run before the route's own, in each phase. Same merge the
// generated dist/functions/ entry does: an app-wide auth or audit hook has to
// see a request before anything a single route registered.
function mergeHooks(globalHooks, routeHooks) {
  const merged = (name) => [...(globalHooks?.[name] || []), ...(routeHooks?.[name] || [])];
  return { onRequest: merged('onRequest'), onError: merged('onError'), onResponse: merged('onResponse') };
}

async function runHooks(hooks, ...args) {
  if (!hooks) return;
  for (const hook of hooks) await hook(...args);
}

async function runOnError(err, req, reply, lifecycleHooks) {
  if (!lifecycleHooks?.onError?.length) return { handled: false, error: err };
  let handled = false;
  for (const hook of lifecycleHooks.onError) {
    try { await hook(err, req, reply); handled = true; }
    catch (hookErr) { err = hookErr; }
  }
  return { handled, error: err };
}

const handlers = routeMod;
const routeHooks = normalizeHooks(routeMod.hooks || { onRequest: routeMod.onRequest, onError: routeMod.onError, onResponse: routeMod.onResponse });
const lifecycleHooks = mergeHooks(normalizeHooks(globalHooksMod), routeHooks);
const routeSchema = routeMod.schema;

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
    headers: withHeaderAccessors(Object.fromEntries(request.headers.entries())),
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
    redirect(url, status) { statusCode = status || 302; responseHeaders.location = url; responseBody = 'Redirecting to ' + url; return null; },
  };

  const startedAt = performance.now();
  let result;
  let hadError = false;
  try {
    await runHooks(lifecycleHooks.onRequest, req, reply);
    // Validation moved behind the onRequest hooks and inside the try, which is
    // where the generated dist/functions/ entry has always had it. It was in
    // front, and returning early: an unauthenticated caller got the route's 400
    // schema report instead of the hooks file's 401, and onResponse —
    // documented as running once per request whatever the outcome — never saw a
    // rejected request at all.
    if (routeSchema && responseBody === null) {
      const validationError = validateRequest(req, routeSchema);
      if (validationError) {
        statusCode = validationError.statusCode;
        responseBody = JSON.stringify(validationError.body);
      }
    }
    // A hook that answered (reply.json/send/redirect) short-circuits the
    // handler. Without this the handler still ran behind a hook's 401: the
    // caller saw the 401, and the handler had already charged the API call,
    // written the row, or read the record it was being denied.
    if (responseBody === null) result = await handlerFn(req, reply);
  } catch (err) {
    hadError = true;
    // Only an error Vura constructed may choose its own status — see the note
    // in core's generateFunctionEntry. Brand-keyed rather than an instanceof
    // check because each bundle inlines its own copy of core.
    statusCode = err && err[Symbol.for('vura.http-error')] === true && err.statusCode ? err.statusCode : 500;
    const errorResult = await runOnError(err, req, reply, lifecycleHooks);
    if (!errorResult.handled && responseBody === null) {
      responseBody = JSON.stringify({ error: statusCode === 500 ? 'Internal Server Error' : (errorResult.error?.message || 'Request failed') });
    }
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    try { await runHooks(lifecycleHooks.onResponse, req, reply, { statusCode, durationMs, hadError }); } catch {}
  }

  if (result instanceof Response) return responseToResult(result);
  if (responseBody !== null) return { statusCode, headers: responseHeaders, body: responseBody };
  if (result && typeof result === 'object') return { statusCode, headers: responseHeaders, body: JSON.stringify(result) };
  return { statusCode: 204 };
}
`;
}

// ─── Pages Function ───

/** Directory name, logical id and CodeUri of the single pages function. */
const PAGES_DIR = '__pages';
const PAGES_LOGICAL_ID = 'VuraPages';

/**
 * Generate the handler for the pages function.
 *
 * One function serves everything that is not an API route, which is the same
 * split the Node server makes: prerendered files first (its `staticDirs`), then
 * the server-mode page renderer, then a 404. Here the prerendered files are
 * read from `./assets` inside the function's own read-only bundle at
 * /var/task, because that is the only storage a Lambda has without a second
 * service.
 *
 * That choice is deliberate and has a cost. S3 + CloudFront is the right answer
 * for a large site and is *not* what this does: `sam deploy` uploads code, not
 * site content, so an S3 story needs a bucket, a distribution and an
 * `aws s3 sync` the user runs themselves — a deploy step this adapter cannot
 * perform and must not pretend to. Serving from the bundle keeps `sam deploy`
 * as the whole deploy, and buildEnd warns by name when the tree gets big enough
 * for that trade to stop being the right one.
 *
 * The 404 body is byte-identical to what-fw's unmatched-route 404, which is
 * what the Node server answers with, so a missing page reads the same on both.
 */
function generatePagesHandlerFile(hasServerPages: boolean): string {
  const pagesImport = hasServerPages
    ? "import { matchesPage, handlePage } from './pages.js';"
    : 'const matchesPage = () => false;\nconst handlePage = null;';
  return `// Auto-generated — Vura pages function (prerendered assets + server-mode pages)
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
${pagesImport}

const ASSET_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'assets');

const NOT_FOUND_HTML = '<!DOCTYPE html><html><body><h1>404 — Not Found</h1></body></html>';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
};

function mimeFor(path) {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? null : MIME[path.slice(dot).toLowerCase()]) || 'application/octet-stream';
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

/**
 * Resolve a URL path to a file inside ASSET_ROOT, or null.
 *
 * The containment check is not decoration: API Gateway forwards the raw path,
 * so \`/../../etc/passwd\` reaches this function verbatim, and this handler is
 * mapped to a catch-all route. A resolved path that escapes the asset root is
 * refused before anything is read.
 *
 * Candidates mirror what the Node server serves and what the Cloudflare
 * assets binding does with html_handling = drop-trailing-slash: the exact
 * file, then \`<path>/index.html\` for a directory, then \`/index.html\` for the
 * site root.
 */
async function findAsset(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }

  const clean = decoded.replace(/\\/+$/, '') || '/';
  const candidates = clean === '/'
    ? ['index.html']
    : [clean.slice(1), join(clean.slice(1), 'index.html')];

  for (const candidate of candidates) {
    const full = normalize(join(ASSET_ROOT, candidate));
    if (full !== ASSET_ROOT && !full.startsWith(ASSET_ROOT + sep)) continue;
    try {
      const info = await stat(full);
      if (info.isFile()) return full;
    } catch { /* next candidate */ }
  }
  return null;
}

function eventToRequest(event) {
  const { rawPath, rawQueryString, headers, requestContext } = event;
  const protocol = headers['x-forwarded-proto'] || 'https';
  const host = headers['host'] || requestContext.domainName;
  const queryPart = rawQueryString ? '?' + rawQueryString : '';
  const reqHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) reqHeaders.set(key, value);
  }
  if (event.cookies && event.cookies.length > 0) reqHeaders.set('cookie', event.cookies.join('; '));
  const method = requestContext.http.method.toUpperCase();
  const init = { method, headers: reqHeaders };
  // A page render never reads a body, and GET/HEAD must not carry one.
  if (method !== 'GET' && method !== 'HEAD' && event.body) {
    init.body = event.isBase64Encoded ? Uint8Array.from(atob(event.body), c => c.charCodeAt(0)) : event.body;
  }
  return new Request(protocol + '://' + host + rawPath + queryPart, init);
}

async function responseToResult(response) {
  const headers = {};
  const cookies = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
    else headers[key] = value;
  });
  const isBinary = isBinaryContentType(response.headers.get('content-type') || '');
  let body;
  let isBase64Encoded = false;
  if (response.body) {
    if (isBinary) {
      body = arrayBufferToBase64(await response.arrayBuffer());
      isBase64Encoded = true;
    } else {
      body = await response.text();
    }
  }
  const result = { statusCode: response.status, headers, body, isBase64Encoded };
  if (cookies.length > 0) result.cookies = cookies;
  return result;
}

export async function handler(event) {
  const pathname = event.rawPath || '/';
  const method = (event.requestContext?.http?.method || 'GET').toUpperCase();

  // Prerendered pages, client shells, client bundles and public/ files. First,
  // for the same reason the Node server serves its static dirs first: these are
  // the cheapest responses and the most common ones.
  if (method === 'GET' || method === 'HEAD') {
    const file = await findAsset(pathname);
    if (file) {
      const contentType = mimeFor(file);
      const bytes = await readFile(file);
      const binary = isBinaryContentType(contentType);
      return {
        statusCode: 200,
        headers: { 'content-type': contentType },
        body: method === 'HEAD' ? '' : (binary ? bytes.toString('base64') : bytes.toString('utf8')),
        isBase64Encoded: method !== 'HEAD' && binary,
      };
    }
  }

  if (matchesPage(pathname)) {
    return responseToResult(await handlePage(eventToRequest(event)));
  }

  // The Node server splits its 404 by prefix: /api/ and /__vura/ answer from
  // the API app in JSON, everything else answers with the 404 page. This
  // function is on the catch-all route, so it is the only place that split can
  // be made — without it a mistyped API path would come back as HTML.
  if (pathname.startsWith('/api/') || pathname.startsWith('/__vura/')) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Not Found', path: pathname }),
      isBase64Encoded: false,
    };
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: NOT_FOUND_HTML,
    isBase64Encoded: false,
  };
}
`;
}

// ─── Adapter Factory ───

/**
 * Create a Vura adapter for AWS Lambda + API Gateway (SAM).
 *
 * @example
 * ```ts
 * // vura.config.ts
 * import { defineConfig } from '@celsian/vura-core';
 * import { lambdaAdapter } from '@celsian/vura-adapter-lambda';
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
  const runtime = options.runtime ?? 'nodejs22.x';
  const architecture = options.architecture ?? 'arm64';

  return {
    name: 'adapter-lambda',

    async buildEnd(ctx: AdapterBuildContext): Promise<void> {
      const { manifest, outDir } = ctx;
      const lambdaDir = join(outDir, 'lambda');
      await mkdir(lambdaDir, { recursive: true });

      // Filter for serverless routes only
      const serverlessRoutes = manifest.api.filter((r) => r.kind === 'serverless');

      const hotRoutes = manifest.api.filter(r => r.kind === 'hot');
      if (hotRoutes.length > 0) {
        const routeList = hotRoutes.map(r => r.urlPattern).join(', ');
        console.warn(
          `[vura] ${hotRoutes.length} hot route(s) cannot run on lambda and were not bundled: ${routeList} — deploy them to a persistent host (see /self-host/)`,
        );
      }

      const globalHooksFile = findGlobalHooksFile(ctx.projectRoot);

      // Build function descriptors — one per route+method combination
      const samFunctions: SamFunction[] = [];
      // Every file this build writes under dist/lambda. Anything else there
      // belongs to a route deleted since an earlier build: template.yaml no
      // longer points at it, but `sam deploy` still uploads the directory.
      const emitted = new Set<string>();

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
          // The package.json marks the directory as an ES module so that
          // Lambda's Node.js runtime accepts the 'import' syntax in index.js.
          const handlerCode = generateHandlerFile(route, globalHooksFile);
          await writeFile(join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
          await writeFile(join(funcDir, 'index.js'), handlerCode);
          await bundleRouteModule(route, ctx.projectRoot, join(funcDir, 'route.js'));
          if (globalHooksFile) {
            // One copy per function directory: a Lambda function is deployed
            // from its own CodeUri and cannot reach a sibling's files. Core
            // does the same for dist/functions/.
            await bundleGlobalHooksModule(globalHooksFile, ctx.projectRoot, join(funcDir, 'hooks.js'));
          }
          // hooks.js has to be declared kept or the sweep at the end of
          // buildEnd deletes the file this build just wrote, which would look
          // from the outside exactly like the hooks never being bundled at all.
          for (const f of ['package.json', 'index.js', 'route.js']) emitted.add(join(funcDir, f));
          if (globalHooksFile) emitted.add(join(funcDir, 'hooks.js'));

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

        // A task function is invoked by EventBridge, never through the HTTP
        // lifecycle, so it gets no global hooks — the same rule core applies
        // when it emits dist/functions/ (hooks.js goes to serverless routes only).
        const handlerCode = generateHandlerFile(route, null);
        await writeFile(join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
        await writeFile(join(funcDir, 'index.js'), handlerCode);
        await bundleRouteModule(route, ctx.projectRoot, join(funcDir, 'route.js'));
        for (const f of ['package.json', 'index.js', 'route.js']) emitted.add(join(funcDir, f));

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

      // Pages. Prerendered HTML and client bundles come from dist/static and
      // dist/public; server-mode pages render inside the function. Both were
      // dropped entirely until now.
      const pageFunctionEmitted = await emitPagesFunction(ctx, lambdaDir, emitted);

      // Write SAM template (with cron schedules for task routes)
      const templateContent = generateSamTemplate(samFunctions, {
        memory,
        timeout,
        runtime,
        architecture,
        cors: options.cors,
      }, taskRoutes, manifest.pages, pageFunctionEmitted);
      await writeFile(join(outDir, 'template.yaml'), templateContent);

      // Write samconfig.toml
      const samConfig = generateSamConfig(stackName, region);
      await writeFile(join(outDir, 'samconfig.toml'), samConfig);

      // Sweep last, so a build that failed partway keeps its previous output.
      await pruneStaleOutputs(lambdaDir, emitted);
    },
  };
}

/**
 * Bytes of prerendered assets past which serving them through Lambda stops
 * being the right trade.
 *
 * Not a hard limit — the code package limit is 250 MB unzipped and this is far
 * under it. It is the point where the per-request cost of proxying bytes
 * through a function, and the cold-start cost of a fat package, are worth
 * telling someone about while they can still act on it.
 */
const ASSET_WARN_BYTES = 25 * 1024 * 1024;

/**
 * API Gateway caps a response payload at 6 MB, and a binary asset is
 * base64-encoded on the way out, which costs about a third. A file past this
 * cannot be returned at all, so it is named at build time rather than
 * discovered as a 500 in production.
 */
const ASSET_MAX_FILE_BYTES = Math.floor(6 * 1024 * 1024 * 0.74);

/**
 * Emit `dist/lambda/__pages/`: the prerendered tree, the server-page renderer
 * when the project has one, and the handler that serves both.
 *
 * Returns whether anything was emitted, which is what decides if the SAM
 * template gets the page routes. A project with no pages gets no function and
 * no route, so an API-only deployment is unchanged.
 */
async function emitPagesFunction(
  ctx: AdapterBuildContext,
  lambdaDir: string,
  emitted: Set<string>,
): Promise<boolean> {
  const { manifest, projectRoot, outDir } = ctx;

  // Emitted when the deployment has a site surface, which is not the same as
  // having pages: the Node server serves dist/public whether or not a project
  // has any, so an API-only project with a public/ directory has files to
  // serve here too. A project with neither gets no function and no route, and
  // its template is byte-for-byte what it was.
  const assets = await collectPageAssets(outDir);
  if (manifest.pages.length === 0 && assets.length === 0) return false;

  for (const warning of pageDegradations(manifest, 'AWS Lambda')) {
    console.warn(warning);
  }

  const serverPages = serverPagesOf(manifest);

  // Streaming is a real capability on the Node server and on Workers, and it
  // is not one here: API Gateway's proxy integration buffers the whole body
  // before it answers, so the shell cannot go out early. The page still
  // renders correctly, so this is a warning and not an error — but it is a
  // named one, because a page opted into streaming and did not get it.
  const streaming = serverPages.filter(p => p.config.streaming === true);
  if (streaming.length > 0) {
    console.warn(
      `[vura] ${streaming.length} streaming page(s) are buffered on AWS Lambda — API Gateway's proxy ` +
      `integration has no early flush, so the shell cannot go out before the body: ` +
      `${streaming.map(p => p.urlPattern).join(', ')}. They still render correctly.`,
    );
  }

  const funcDir = join(lambdaDir, PAGES_DIR);
  await mkdir(funcDir, { recursive: true });

  await writeFile(join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  await writeFile(join(funcDir, 'index.js'), generatePagesHandlerFile(serverPages.length > 0));
  emitted.add(join(funcDir, 'package.json'));
  emitted.add(join(funcDir, 'index.js'));

  if (serverPages.length > 0) {
    const sourcePath = join(funcDir, 'pages.source.mjs');
    await writeFile(sourcePath, generatePagesModuleSource(serverPages, projectRoot, funcDir));
    await bundleServerPagesModule(sourcePath, join(funcDir, 'pages.js'), projectRoot, serverPages);
    emitted.add(sourcePath);
    emitted.add(join(funcDir, 'pages.js'));
  }

  const assetDir = join(funcDir, 'assets');
  for (const written of await copyPageAssets(assets, assetDir)) emitted.add(written);

  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  if (totalBytes > ASSET_WARN_BYTES) {
    console.warn(
      `[vura] ${(totalBytes / 1024 / 1024).toFixed(1)} MB of prerendered assets are bundled into the ` +
      `pages Lambda and served through it. That works, but every byte is billed as function time and ` +
      'inflates cold starts — put the files in S3 behind CloudFront and route only server-mode pages here.',
    );
  }
  const oversized = assets.filter(a => a.bytes > ASSET_MAX_FILE_BYTES);
  if (oversized.length > 0) {
    console.warn(
      `[vura] ${oversized.length} asset(s) exceed what API Gateway can return (6 MB, less base64 overhead) ` +
      `and will fail with a 500 when requested: ${oversized.map(a => a.urlPath).join(', ')}. ` +
      'Serve them from S3/CloudFront instead.',
    );
  }

  return true;
}

/**
 * Bundle the generated pages module for the pages function.
 *
 * A page that cannot be bundled fails the build, by name. Same rule as the
 * hooks file, for the same reason: a build that reports success and serves 404
 * for every page is the exact defect this wiring exists to close, and
 * degrading quietly would reintroduce it with a different cause.
 */
async function bundleServerPagesModule(
  sourcePath: string,
  outfile: string,
  projectRoot: string,
  pages: PageRoute[],
): Promise<void> {
  try {
    await bundlePagesModule({ sourcePath, outfile, projectRoot, corePackageDir: CORE_PACKAGE_DIR });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vura] server-mode page(s) could not be bundled for AWS Lambda: ${pages.map(p => p.filePath).join(', ')}.\n` +
      'The pages bundle is built runtime-neutral so the same artifact runs on every serverless target, ' +
      'which means a page, layout or loader importing a Node built-in cannot be deployed through it. ' +
      'Move that work into an API route the page fetches. It cannot be dropped: a build that ships ' +
      'without its pages serves 404 for every one of them.\n' +
      detail,
    );
  }
}

// ─── Utilities ───

/**
 * Find the project's conventional global hooks file, if it has one.
 *
 * Same list core, the CLI's dev server and the Vite plugin all read, so a file
 * the dev server picks up is the file the deployment artifact gets.
 */
function findGlobalHooksFile(projectRoot: string): string | null {
  for (const filename of GLOBAL_HOOKS_FILENAMES) {
    if (existsSync(join(projectRoot, filename))) return filename;
  }
  return null;
}

/**
 * Bundle the global hooks file into a function directory, next to the handler
 * that imports it. Same esbuild settings as a route module, so the same
 * runtime-shim allowlist decides what a hooks file may import.
 *
 * A hooks file that cannot be bundled fails the build. It is not skipped and
 * not warned over. The headline use of this file is an app-wide authorization
 * check — the docs hand `cookieSession()` and `createJWTGuard()` straight into
 * it — so degrading would ship functions whose auth layer is missing while the
 * build reports success. That is exactly the failure this wiring exists to
 * close, reintroduced with a different cause. An unbuildable hooks file is a
 * fixable mistake; a deploy that silently lost its authorization is not.
 */
async function bundleGlobalHooksModule(
  hooksFile: string,
  projectRoot: string,
  outfile: string,
): Promise<void> {
  try {
    await bundleRouteModule({ filePath: hooksFile }, projectRoot, outfile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vura] global hooks file ${hooksFile} could not be bundled for AWS Lambda.\n` +
      'Only the @celsian/vura-core exports on the runtime-shim allowlist are available inside a ' +
      'function bundle, so a hooks file importing outside that set cannot be deployed. ' +
      'Fix the import, or move the code into the routes that need it. It cannot be dropped: ' +
      'a hooks file is where an app-wide authorization check lives.\n' +
      detail,
    );
  }
}

async function bundleRouteModule(route: Pick<ApiRoute, 'filePath'>, projectRoot: string, outfile: string): Promise<void> {
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
    plugins: [vuraCoreRuntimeShimPlugin()],
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
