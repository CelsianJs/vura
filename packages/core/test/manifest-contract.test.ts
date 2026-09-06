import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildManifest } from '../src/manifest.js';
import { deriveRequiredFeatures, evaluateCapabilities, parseManifest } from '../../contract/src/index.js';
import { validPageConfigFixtures, validRouteConfigFixtures } from '../../../test/fixtures/static-route-config.js';

const roots: string[] = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'vura-scanner-contract-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('manifest contract against actual scanner output', () => {
  it.each(validRouteConfigFixtures)('preserves supported API config: $name', async ({ source }) => {
    const root = fixture({ 'src/api/example.ts': source + '\nexport function GET() {}' });
    const manifest = await buildManifest(root);
    expect(manifest.api).toHaveLength(1);
    expect(parseManifest(JSON.stringify(manifest), { allowLegacy: true })).toEqual(manifest);
    expect(parseManifest(manifest, { allowLegacy: true })).toEqual(manifest);
  });

  it.each(validPageConfigFixtures)('preserves supported page config: $name', async ({ source }) => {
    const root = fixture({ 'src/pages/index.tsx': source + '\nexport default function Page() { return null; }' });
    const manifest = await buildManifest(root);
    expect(manifest.pages).toHaveLength(1);
    expect(parseManifest(JSON.stringify(manifest), { allowLegacy: true })).toEqual(manifest);
    expect(parseManifest(manifest, { allowLegacy: true })).toEqual(manifest);
  });

  it('keeps middleware, nested layouts, loaders, actions and WebSocket requirements', async () => {
    const root = fixture({
      'src/middleware.ts': 'export default function middleware() {}',
      'src/pages/_layout.tsx': 'export default function RootLayout() {}',
      'src/pages/account/_layout.tsx': 'export default function AccountLayout() {}',
      'src/pages/account/index.tsx': 'export const page = { mode: "server", streaming: true }; export function loader() {} export default function Account() {}',
      'src/api/live.ts': 'export const route = { kind: "hot" }; export function websocket() {}',
      'src/actions/account.ts': 'export async function save() {}',
    });
    const manifest = await buildManifest(root);
    const requiredFeatures = deriveRequiredFeatures(manifest);
    expect(requiredFeatures).toEqual(expect.arrayContaining(['api', 'server-pages', 'layouts', 'actions', 'middleware', 'loaders', 'websocket', 'streaming', 'dedicated-compute']));
    const parsed = parseManifest(JSON.stringify({ ...manifest, schemaVersion: 1, requiredFeatures }));
    expect(parsed).toMatchObject(manifest);
    expect(evaluateCapabilities(parsed, { name: 'static-only fixture', supportedFeatures: ['static-pages'] })).toMatchObject({
      compatible: false, unsupportedFeatures: expect.arrayContaining(['middleware', 'actions']),
    });
  });
});
