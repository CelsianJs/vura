import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildManifest } from '../packages/core/src/manifest.js';
import { cloudflareAdapter } from '../packages/adapter-cloudflare/src/index.js';
import { lambdaAdapter } from '../packages/adapter-lambda/src/index.js';

// Execute emitted modules in Node, as the existing adapter artifact suites do.
// The manifest must come from real files, not hand-written wildcard patterns.
describe('scanner named catch-all deployment parity', () => {
  for (const target of ['cloudflare', 'lambda'] as const) {
    it(`serves scanner-generated page routes through the ${target} artifact`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'vura-catchall-'));
      try {
        mkdirSync(join(root, 'src/pages/docs'), { recursive: true });
        writeFileSync(join(root, 'src/pages/docs/[...rest].tsx'), `
export const page = { mode: 'server' };
export default function Docs({ params }) { return <p>REST:{params.rest}</p>; }
`);
        const manifest = await buildManifest(root);
        expect(manifest.pages[0].urlPattern).toBe('/docs/*rest');
        const outDir = join(root, 'dist');
        const adapter = target === 'cloudflare'
          ? cloudflareAdapter({ name: 'catchall', compatibilityDate: '2026-05-10' })
          : lambdaAdapter();
        await adapter.buildEnd({ projectRoot: root, outDir, manifest, serverEntry: join(outDir, 'server/entry.js'), clientDir: join(outDir, 'client') });
        const entry = target === 'cloudflare'
          ? join(outDir, 'cloudflare/entry.js')
          : join(outDir, 'lambda/__pages/index.js');
        const code = `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)});
const results = [];
for (const path of ['/docs/a/b', '/docs/a/brest', '/docs/hello%20world/a%2Fb']) {
  ${target === 'cloudflare' ? `const res = await mod.default.fetch(new Request('https://example.com' + path), {}, {});
  results.push({ status: res.status, body: await res.text() });` : `const res = await mod.handler({ version: '2.0', rawPath: path, rawQueryString: '', headers: { host: 'example.com' }, requestContext: { http: { method: 'GET' } } });
  results.push({ status: res.statusCode, body: res.body });`}
}
process.stdout.write(JSON.stringify(results));`;
        const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
        for (const [index, rest] of ['a/b', 'a/brest', 'hello world/a/b'].entries()) {
          expect(results[index].status).toBe(200);
          expect(results[index].body).toContain(`REST:${rest}`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
