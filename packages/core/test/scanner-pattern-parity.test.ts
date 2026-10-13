import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest } from '../src/manifest.js';

it('preserves named catch-alls and distinct dotted API/page file names in the real scanner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-scanner-patterns-'));
  try {
    mkdirSync(join(root, 'src/api'), { recursive: true });
    mkdirSync(join(root, 'src/pages'), { recursive: true });
    for (const name of ['[...rest].ts', 'feed.json.ts', 'feed.xml.js', 'feed.ts']) {
      writeFileSync(join(root, 'src/api', name), 'export function GET() { return {}; }');
    }
    for (const name of ['[...rest].tsx', 'guide.v1.tsx', 'guide.v2.js', 'guide.tsx']) {
      writeFileSync(join(root, 'src/pages', name), "export const page = { mode: 'server' }; export default function Page() { return null; }");
    }
    const manifest = await buildManifest(root);
    expect(manifest.api.map(route => route.urlPattern).sort()).toEqual(['/api/*rest', '/api/feed', '/api/feed.json', '/api/feed.xml'].sort());
    expect(manifest.pages.map(page => page.urlPattern).sort()).toEqual(['/*rest', '/guide', '/guide.v1', '/guide.v2'].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
