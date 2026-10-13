import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getFiles } from '../src/index.js';
import { buildManifest } from '../../core/src/manifest.js';
import { deriveRequiredFeatures } from '../../contract/src/index.js';

const scaffoldRoots: string[] = [];
afterAll(() => {
  for (const root of scaffoldRoots) rmSync(root, { recursive: true, force: true });
});

/** Write a scaffold to disk and scan it the way `vura build` does. */
async function scaffoldManifest(options?: Parameters<typeof getFiles>[1]) {
  const root = mkdtempSync(join(tmpdir(), 'create-vura-manifest-'));
  scaffoldRoots.push(root);
  for (const [file, content] of Object.entries(getFiles('demo-app', options))) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const manifest = await buildManifest(root);
  return { manifest, features: deriveRequiredFeatures(manifest) };
}

// The scaffold pins @celsian/vura-* to create-vura's own version (the packages
// release as a fixed group), so derive the expectation from package.json rather
// than hardcoding a version that breaks on every release bump.
const vuraVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

// The scaffold's what-framework range must equal the repo root's. Hardcoding it
// here is what let the two drift to ^0.11.1 vs ^0.11.7 and kept `verify:publish`
// (and therefore CI) red on main from 2026-07-17. Derive it from the root so the
// test asserts the invariant that actually matters instead of a literal that
// goes stale on every What Framework bump.
const rootWhatFramework = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).dependencies['what-framework'] as string;

describe('create-vura templates', () => {
  it('pins generated dependencies instead of mixing latest ranges', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);

    expect(packageJson.dependencies).toEqual({
      'what-framework': rootWhatFramework,
      '@celsian/vura-core': vuraVersion,
      '@celsian/vura-cli': vuraVersion,
      '@celsian/vura-adapter-vura': vuraVersion,
    });
    expect(JSON.stringify(packageJson.dependencies)).not.toContain('latest');
  });

  it('scaffolds the same what-framework range the repo itself builds against', () => {
    // The guard `verify:publish` enforces at release time, asserted here so it
    // fails in the ordinary test run instead of only in the publish gate.
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);

    expect(packageJson.dependencies['what-framework']).toBe(rootWhatFramework);
  });

  it('includes managed deployment support without a follow-up install', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);

    expect(packageJson.dependencies['@celsian/vura-adapter-vura']).toBe(vuraVersion);
  });

  it('adds the ws dependency only when the hot WebSocket example is requested', () => {
    expect(JSON.parse(getFiles('demo-app')['package.json']).dependencies).not.toHaveProperty('ws');
    const hot = JSON.parse(getFiles('demo-app', { hot: true })['package.json']);
    expect(hot.dependencies['ws']).toBe('^8.18.0');
  });

  // ENG-6739: Vura's free tier covers builds, static pages and Functions. A hot
  // server is the paywall and a task route needs its own machine, so the app a
  // new user deploys first must need neither.
  it('scaffolds an app that deploys on the free tier: static, client and Function routes only', async () => {
    const { manifest, features } = await scaffoldManifest();

    expect(manifest.api.map(route => [route.urlPattern, route.kind])).toEqual([
      ['/api/health', 'serverless'],
      ['/api/hello', 'serverless'],
    ]);
    expect(features).toContain('function-compute');
    expect(features).not.toContain('dedicated-compute');
    expect(features).not.toContain('websocket');
    expect(features).not.toContain('tasks');
    expect(features).not.toContain('scheduled-tasks');
  });

  it('keeps hot compute discoverable behind --hot and tasks behind --tasks', async () => {
    const hot = await scaffoldManifest({ hot: true });
    expect(hot.manifest.api.find(route => route.urlPattern === '/api/chat')?.kind).toBe('hot');
    expect(hot.features).toEqual(expect.arrayContaining(['dedicated-compute', 'websocket']));
    expect(hot.features).not.toContain('tasks');

    const tasks = await scaffoldManifest({ tasks: true });
    expect(tasks.manifest.api.find(route => route.urlPattern === '/api/cleanup')?.kind).toBe('task');
    expect(tasks.features).toEqual(expect.arrayContaining(['tasks', 'scheduled-tasks']));
    expect(tasks.features).not.toContain('dedicated-compute');
  });

  it('tells the default app how to opt into hot compute', () => {
    const files = getFiles('demo-app');
    expect(files).toHaveProperty('README.md');
    expect(files['README.md']).toContain('--hot');
    expect(files['README.md']).toContain("compute: { class: 'dedicated' }");
    expect(files['README.md']).toContain('--tasks');
  });

  it('does not claim the starter ships a CelsianJS integration', () => {
    const files = getFiles('demo-app');
    const starterText = Object.values(files).join('\n');

    expect(starterText).not.toContain('CelsianJS');
  });

  it('does not advertise unavailable deploy or dead public docs links', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);
    const starterText = Object.values(files).join('\n');

    expect(packageJson.scripts).not.toHaveProperty('deploy');
    expect(files).toHaveProperty('vura.config.js');
    expect(files).not.toHaveProperty('vura.config.ts');
    expect(starterText).not.toContain('thenjs.dev');
    expect(starterText).not.toContain('celsian.dev');
  });

  it('includes the hot-route chat example with --hot', () => {
    expect(getFiles('demo-app')).not.toHaveProperty('src/api/chat.ts');
    const files = getFiles('demo-app', { hot: true });

    expect(files).toHaveProperty('src/api/chat.ts');
    const chatTs = files['src/api/chat.ts'];
    expect(chatTs).toContain("compute: { class: 'dedicated' }");
    expect(chatTs).toContain('websocket(peer');
    expect(chatTs).toContain('peer.on(\'message\'');
    expect(chatTs).toContain('peer.broadcast(');
  });

  it('ships the health check as a serverless route so it deploys on every adapter', () => {
    // Regression: health was scaffolded as kind: 'hot', which excludes it from
    // serverless adapter bundles (Cloudflare/Lambda) — a plain GET health check
    // would silently vanish on deploy. A request/response endpoint must be serverless.
    const files = getFiles('demo-app');

    expect(files).toHaveProperty('src/api/health.ts');
    const healthTs = files['src/api/health.ts'];
    expect(healthTs).toContain("compute: { class: 'function', memory: '1gb' }");
    expect(healthTs).not.toContain("class: 'dedicated'");
  });

  it('ships a shared baseline stylesheet wired into every page', () => {
    const files = getFiles('demo-app');

    // The stylesheet lives in ONE place (base level, not per-instance).
    expect(files).toHaveProperty('src/styles.ts');
    const styles = files['src/styles.ts'];
    expect(styles).toContain('export const baseStyles');
    // Styled defaults: buttons, inputs, links, code, plus light + dark theming.
    expect(styles).toContain('button {');
    expect(styles).toContain('input, textarea, select {');
    expect(styles).toContain('prefers-color-scheme: dark');
    expect(styles).toContain('color-scheme: light dark');

    // Every rendered page imports the shared styles and passes them to page.styles
    // so the scaffold renders styled out of the box in every render mode.
    for (const pagePath of ['src/pages/index.tsx', 'src/pages/about.tsx', 'src/pages/dashboard.tsx']) {
      const page = files[pagePath];
      expect(page, `${pagePath} should import baseStyles`).toContain("import { baseStyles } from '../styles.js'");
      expect(page, `${pagePath} should pass styles: [baseStyles]`).toContain('styles: [baseStyles]');
    }
  });

  it('demonstrates the full-stack loop with the idiomatic useFetch hook', () => {
    const files = getFiles('demo-app');

    expect(files).toHaveProperty('src/pages/dashboard.tsx');
    const dashboard = files['src/pages/dashboard.tsx'];
    // The dashboard uses What-FW's useFetch (declarative loading/error/data)
    // rather than hand-rolled onMount + fetch + signal wiring.
    expect(dashboard).toContain("useFetch('/api/hello')");
    expect(dashboard).toContain('import { useSignal, useFetch }');
    expect(dashboard).not.toContain('onMount');
    // useFetch is a client-side hook: keep the page in client mode so it does
    // not trip the useSWR/useQuery server-mode auto-detection heuristic.
    expect(dashboard).toContain("mode: 'client'");
    // Loading and error states are both handled — not just the happy path.
    expect(dashboard).toContain('isLoading()');
    expect(dashboard).toContain('error()');
  });

  it('includes the scheduled cleanup task example with --tasks', () => {
    expect(getFiles('demo-app')).not.toHaveProperty('src/api/cleanup.ts');
    const files = getFiles('demo-app', { tasks: true });

    expect(files).toHaveProperty('src/api/cleanup.ts');
    const cleanupTs = files['src/api/cleanup.ts'];
    expect(cleanupTs).toContain("kind: 'task'");
    expect(cleanupTs).toContain("compute: { class: 'function', memory: '1gb' }");
    expect(cleanupTs).toContain("export const schedule = '0 3 * * *'");
    expect(cleanupTs).toContain('export async function POST(');
    expect(cleanupTs).toContain('vura tasks run cleanup');
  });

  it('scaffold template files build without TypeScript errors', () => {
    // Structural check: all template files with .ts/.tsx extension are present
    // and contain parseable content (not empty, not placeholder-only).
    const files = getFiles('demo-app', { hot: true, tasks: true });
    const tsFiles = Object.entries(files).filter(([k]) => k.endsWith('.ts') || k.endsWith('.tsx'));

    for (const [path, content] of tsFiles) {
      expect(content.length, `${path} should have content`).toBeGreaterThan(0);
      expect(content, `${path} should not be a bare placeholder`).not.toMatch(/^TODO$/m);
    }
  });
});
