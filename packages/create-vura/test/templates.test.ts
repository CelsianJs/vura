import { describe, expect, it } from 'vitest';
import { getFiles } from '../src/index.js';

describe('create-vura templates', () => {
  it('pins generated dependencies instead of mixing latest ranges', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);

    expect(packageJson.dependencies).toEqual({
      'what-framework': '^0.11.1',
      '@celsian/vura-core': '0.5.2',
      '@celsian/vura-cli': '0.5.2',
      'ws': '^8.18.0',
    });
    expect(JSON.stringify(packageJson.dependencies)).not.toContain('latest');
  });

  it('includes ws dependency for hot-route WebSocket support', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);
    expect(packageJson.dependencies['ws']).toBe('^8.18.0');
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

  it('includes the hot-route chat example', () => {
    const files = getFiles('demo-app');

    expect(files).toHaveProperty('src/api/chat.ts');
    const chatTs = files['src/api/chat.ts'];
    expect(chatTs).toContain("kind: 'hot'");
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
    expect(healthTs).toContain("export const route = { kind: 'serverless' };");
    expect(healthTs).not.toContain("export const route = { kind: 'hot' };");
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

  it('demonstrates the full-stack loop: the client dashboard fetches an API route', () => {
    const files = getFiles('demo-app');

    expect(files).toHaveProperty('src/pages/dashboard.tsx');
    const dashboard = files['src/pages/dashboard.tsx'];
    expect(dashboard).toContain('onMount');
    expect(dashboard).toContain("fetch('/api/hello')");
  });

  it('includes the scheduled cleanup task example', () => {
    const files = getFiles('demo-app');

    expect(files).toHaveProperty('src/api/cleanup.ts');
    const cleanupTs = files['src/api/cleanup.ts'];
    expect(cleanupTs).toContain("kind: 'task'");
    expect(cleanupTs).toContain("export const schedule = '0 3 * * *'");
    expect(cleanupTs).toContain('export async function POST(');
    expect(cleanupTs).toContain('vura tasks run cleanup');
  });

  it('scaffold template files build without TypeScript errors', () => {
    // Structural check: all template files with .ts/.tsx extension are present
    // and contain parseable content (not empty, not placeholder-only).
    const files = getFiles('demo-app');
    const tsFiles = Object.entries(files).filter(([k]) => k.endsWith('.ts') || k.endsWith('.tsx'));

    for (const [path, content] of tsFiles) {
      expect(content.length, `${path} should have content`).toBeGreaterThan(0);
      expect(content, `${path} should not be a bare placeholder`).not.toMatch(/^TODO$/m);
    }
  });
});
