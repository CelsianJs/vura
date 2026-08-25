// @vitest-environment happy-dom
/**
 * Client-mode page mount regression tests.
 *
 * Bug: the production build emitted the raw page module as the browser
 * bundle for mode:'client' pages — nothing ever called what-framework's
 * mount(), so /dashboard stayed at the "Loading..." shell forever.
 *
 * These tests pin the fix at two levels:
 *   1. String-level: generateClientPageEntry() emits an entry that imports
 *      the page module and calls mount() (client) / hydrate() (hybrid).
 *   2. Runtime-level: the esbuild-bundled entry, executed against the real
 *      client shell DOM, replaces the loading div with rendered content
 *      (happy-dom environment).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClientPageEntry } from '../src/static-render.js';
import { vuraBrowserResolvePlugin } from '../src/runtime-shim.js';

const REPO_NODE_MODULES = join(__dirname, '..', '..', '..', 'node_modules');

// Mirrors the scaffold's src/pages/dashboard.tsx (mode: 'client', uses hooks).
const DASHBOARD_FIXTURE = `import { useSignal } from 'what-framework';

export const page = { mode: 'client', title: 'Dashboard' };

export default function DashboardPage() {
  const count = useSignal(0);
  return (
    <div class="dashboard">
      <h1>Dashboard</h1>
      <div class="counter">
        <button onClick={() => count.set(count() - 1)}>-</button>
        <span>{() => count()}</span>
        <button onClick={() => count.set(count() + 1)}>+</button>
      </div>
    </div>
  );
}
`;

// The shell body emitted by renderStaticPages for mode:'client' pages.
const CLIENT_SHELL_BODY = '<div id="app"><div id="loading">Loading...</div></div>';

async function bundleEntry(entrySource: string, resolveDir: string): Promise<string> {
  const { build: esbuild } = await import('esbuild');
  const result = await esbuild({
    stdin: {
      contents: entrySource,
      resolveDir,
      sourcefile: '__vura-client-entry__.js',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    write: false,
    outfile: 'page.js',
    jsx: 'automatic',
    jsxImportSource: 'what-framework',
    // The generated entry imports `@celsian/vura-core/client` for the loader
    // scope. Whoever bundles it supplies this plugin; the CLI does, in both
    // `vura build` and `vura dev`. Bundling the entry without it is what a
    // consumer would hit if that wiring were dropped, so the test carries the
    // same contract rather than a looser one.
    plugins: [vuraBrowserResolvePlugin()],
    nodePaths: [REPO_NODE_MODULES],
  });
  return result.outputFiles[0]!.text;
}

describe('generateClientPageEntry (string-level)', () => {
  it("client mode: imports the page module and calls what-framework's mount()", () => {
    const src = generateClientPageEntry('./dashboard.tsx', 'client');
    expect(src).toContain('"./dashboard.tsx"');
    expect(src).toMatch(/from ['"]what-framework['"]/);
    expect(src).toMatch(/\bmount\(/);
  });

  it('hybrid mode: calls hydrate() against the prerendered DOM', () => {
    const src = generateClientPageEntry('./dashboard.tsx', 'hybrid');
    expect(src).toContain('"./dashboard.tsx"');
    expect(src).toMatch(/from ['"]what-framework['"]/);
    expect(src).toMatch(/\bhydrate\(/);
  });

  it('targets the #app shell container', () => {
    const src = generateClientPageEntry('./dashboard.tsx', 'client');
    expect(src).toContain("'app'");
  });

  it('guards the boot so a render throw does not leave a blank page', () => {
    const src = generateClientPageEntry('./dashboard.tsx', 'client');
    expect(src).toMatch(/try\s*\{/);
    expect(src).toContain('_renderVuraBootError');
    expect(src).toContain("role");
  });

  it('dev mode surfaces the stack; prod mode does not leak it', () => {
    const devSrc = generateClientPageEntry('./dashboard.tsx', 'client', { dev: true });
    const prodSrc = generateClientPageEntry('./dashboard.tsx', 'client');
    expect(devSrc).toContain('_renderVuraBootError(_root, _err, true)');
    // Default (build) is prod: pass false so err.stack is never rendered.
    expect(prodSrc).toContain('_renderVuraBootError(_root, _err, false)');
  });
});

describe('bundled client entry mounts at runtime (happy-dom)', () => {
  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'vura-client-entry-'));
    await writeFile(join(fixtureDir, 'dashboard.tsx'), DASHBOARD_FIXTURE);
    return async () => {
      await rm(fixtureDir, { recursive: true, force: true });
    };
  });

  it('client mode: replaces the loading shell with rendered page content', async () => {
    const entry = generateClientPageEntry('./dashboard.tsx', 'client');
    const bundled = await bundleEntry(entry, fixtureDir);

    document.body.innerHTML = CLIENT_SHELL_BODY;
    expect(document.querySelector('#loading')).not.toBeNull();

    await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`);

    const app = document.querySelector('#app')!;
    expect(document.querySelector('#loading')).toBeNull();
    expect(app.querySelector('h1')?.textContent).toBe('Dashboard');
    expect(app.querySelector('.counter')).not.toBeNull();
  });

  it('hybrid mode: bundled entry executes hydrate against prerendered HTML', async () => {
    const entry = generateClientPageEntry('./dashboard.tsx', 'hybrid');
    const bundled = await bundleEntry(entry, fixtureDir);
    // Hybrid bundles must carry the hydrate runtime, not the mount-and-clear path.
    expect(bundled).toMatch(/\bhydrate/);
  });

  it('renders a readable error panel (not a blank page) when the page throws', async () => {
    const throwingPage = `export const page = { mode: 'client', title: 'Boom' };
export default function BoomPage() {
  throw new Error('Boom: intentional client render crash');
}
`;
    await writeFile(join(fixtureDir, 'boom.tsx'), throwingPage);
    const entry = generateClientPageEntry('./boom.tsx', 'client', { dev: true });
    const bundled = await bundleEntry(entry, fixtureDir);

    document.body.innerHTML = CLIENT_SHELL_BODY;
    await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`);

    const app = document.querySelector('#app')!;
    // The loading shell is gone AND we did not leave the page blank.
    expect(document.querySelector('#loading')).toBeNull();
    const alert = app.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    // Dev panel surfaces the actual error message.
    expect(alert!.textContent).toContain('Boom: intentional client render crash');
  });
});
