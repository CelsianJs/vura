/**
 * `cookieSession` in a Lambda artifact.
 *
 * Same gap and same fix as the Cloudflare adapter's sibling test. Lambda runs
 * Node, so the `node:crypto` import was never the runtime problem here — it was
 * the build problem, because this adapter bundles a function with the same
 * runtime-shim allowlist, and `cookieSession` was not on it. Then the same
 * second problem underneath: the hand-rolled reply had no `headers` record, so
 * the hook threw on `new Proxy(undefined, ...)` before any handler ran.
 *
 * The cross-runtime assertion is the one worth having twice. A signed session
 * has to survive the same app being served from more than one place at once —
 * a Worker at the edge, a Lambda behind it, `vura dev` on a laptop — so the
 * cookie this artifact issues is checked against the digest `node:crypto`
 * produces, which is the same check the Cloudflare test makes. Two artifacts
 * agreeing with one reference agree with each other.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { lambdaAdapter } from '../src/index.js';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@celsian/vura-core';

const SECRET = 'a-very-long-test-secret-32chars!!';

const ROUTES: ApiRoute[] = [
  { filePath: 'src/api/session.ts', urlPattern: '/api/session', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/whoami.ts', urlPattern: '/api/whoami', methods: ['GET'], kind: 'serverless', config: {} },
];

/** One API Gateway v2 invocation of an emitted function. */
function invoke(funcDir: string, path: string, cookie?: string): any {
  const entry = join(funcDir, 'index.js');
  const event = {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: cookie ? { cookie } : {},
    requestContext: { http: { method: 'GET', path } },
    queryStringParameters: {},
    isBase64Encoded: false,
  };
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)});
const res = await mod.handler(${JSON.stringify(event)}, { awsRequestId: 'test' });
console.log(JSON.stringify({
  statusCode: res.statusCode,
  setCookie: res.headers?.['set-cookie'] ?? null,
  body: JSON.parse(res.body),
}));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0]!;
}

function manifest(api: ApiRoute[]): RouteManifest {
  return { api, pages: [], layouts: [], timestamp: new Date().toISOString() };
}

async function buildFunctions(root: string): Promise<string> {
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `import { cookieSession } from '@celsian/vura-core';
export const onRequest = cookieSession({ secret: ${JSON.stringify(SECRET)}, cookie: { secure: false } });
`);
  writeFileSync(join(root, 'src', 'api', 'session.ts'), `export function GET(req: any) {
  const count = (req.session.count ?? 0) + 1;
  req.session.count = count;
  req.session.user = 'kirby';
  return { count, user: req.session.user };
}
`);
  writeFileSync(join(root, 'src', 'api', 'whoami.ts'), `export function GET(req: any, reply: any) {
  return reply.json({ user: req.session.user ?? null, count: req.session.count ?? null });
}
`);
  const outDir = join(root, 'dist');
  const ctx: AdapterBuildContext = {
    serverEntry: join(outDir, 'server', 'entry.js'),
    clientDir: join(outDir, 'client'),
    manifest: manifest(ROUTES),
    projectRoot: root,
    outDir,
  };
  await lambdaAdapter().buildEnd(ctx);
  return join(outDir, 'lambda');
}

describe('cookieSession in a Lambda artifact', () => {
  it('builds, signs compatibly, round-trips and stays quiet when unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-cookiesession-'));
    try {
      const lambdaDir = await buildFunctions(root);

      const first = invoke(join(lambdaDir, 'api_session_get'), '/api/session');
      expect(first.statusCode).toBe(200);
      expect(first.body).toEqual({ count: 1, user: 'kirby' });
      expect(first.setCookie, 'a plain-object return must still commit the session').toMatch(/^vura_session=/);

      // The same digest node:crypto produces, which is what makes a session
      // portable between this artifact and a Worker built from the same source.
      const value = decodeURIComponent(cookiePair(first.setCookie).slice('vura_session='.length));
      const dot = value.lastIndexOf('.');
      expect(createHmac('sha256', SECRET).update(value.slice(0, dot)).digest('base64url'))
        .toBe(value.slice(dot + 1));

      const second = invoke(join(lambdaDir, 'api_session_get'), '/api/session', cookiePair(first.setCookie));
      expect(second.body).toEqual({ count: 2, user: 'kirby' });

      const read = invoke(join(lambdaDir, 'api_whoami_get'), '/api/whoami', cookiePair(second.setCookie));
      expect(read.body).toEqual({ user: 'kirby', count: 2 });
      expect(read.setCookie).toBeNull();

      const tampered = cookiePair(first.setCookie).replace(/.$/, m => (m === 'A' ? 'B' : 'A'));
      expect(invoke(join(lambdaDir, 'api_whoami_get'), '/api/whoami', tampered).body)
        .toEqual({ user: null, count: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
