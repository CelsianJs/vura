import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest } from '../packages/core/src/manifest.js';
import { cloudflareAdapter } from '../packages/adapter-cloudflare/src/index.js';
import { lambdaAdapter } from '../packages/adapter-lambda/src/index.js';

for (const target of ['cloudflare', 'lambda'] as const) {
  for (const surfaces of [['middleware'], ['actions'], ['middleware', 'actions']]) {
    it(`${target} rejects scanned ${surfaces.join(' and ')} before emitting a deployment`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'vura-adapter-preflight-'));
      try {
        mkdirSync(join(root, 'src/actions'), { recursive: true });
        if (surfaces.includes('middleware')) {
          writeFileSync(join(root, 'src/middleware.ts'), 'export function middleware() { return undefined; }');
        }
        if (surfaces.includes('actions')) {
          writeFileSync(join(root, 'src/actions/save.ts'), 'export async function save() { return "saved"; }');
        }
        const manifest = await buildManifest(root);
        expect(!!manifest.middleware).toBe(surfaces.includes('middleware'));
        expect(!!manifest.actions?.length).toBe(surfaces.includes('actions'));
        const outDir = join(root, 'dist');
        const adapter = target === 'cloudflare'
          ? cloudflareAdapter({ name: 'preflight', compatibilityDate: '2026-05-10' })
          : lambdaAdapter();
        const build = adapter.buildEnd({ projectRoot: root, outDir, manifest, serverEntry: join(outDir, 'server/entry.js'), clientDir: join(outDir, 'client') });
        await expect(build).rejects.toThrow(new RegExp(`${target}.*${surfaces.join('.*')}.*Node.*Vura`, 'i'));
        expect(existsSync(outDir)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
