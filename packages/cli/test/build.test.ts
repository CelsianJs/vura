import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommand } from '../src/commands/build.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
});

describe('CLI build page-mode outputs', () => {
  it('emits deployable static HTML and browser modules for client and hybrid pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cli-build-modes-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    writeFileSync(join(root, 'src', 'pages', 'dashboard.ts'), `
export const page = { mode: 'client', title: 'Dashboard' };
export default function Dashboard() {
  return { tag: 'main', props: {}, children: ['Dashboard app'], key: null, _vnode: true };
}
`);
    writeFileSync(join(root, 'src', 'pages', 'blog.ts'), `
export const page = { mode: 'hybrid', title: 'Blog' };
export default function Blog() {
  return { tag: 'article', props: {}, children: ['Hybrid blog'], key: null, _vnode: true };
}
`);

    const cwd = process.cwd();
    process.chdir(root);
    const log = console.log;
    console.log = () => {};
    try {
      await buildCommand([]);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }

    const dashboardHtml = readFileSync(join(root, 'dist', 'static', 'dashboard', 'index.html'), 'utf8');
    const blogHtml = readFileSync(join(root, 'dist', 'static', 'blog', 'index.html'), 'utf8');

    expect(dashboardHtml).toContain('<title>Dashboard</title>');
    expect(dashboardHtml).toContain('<div id="loading">Loading...</div>');
    const dashboardScript = dashboardHtml.match(/\/_then\/pages\/dashboard\.([a-f0-9]{12})\.js/)?.[0];
    expect(dashboardScript).toBeTruthy();
    expect(existsSync(join(root, 'dist', 'static', dashboardScript!.slice(1)))).toBe(true);

    expect(blogHtml).toContain('<title>Blog</title>');
    // `toContain('Hybrid blog')` alone passed for years while the page actually
    // rendered `<undefined>Hybrid blog</undefined>`, because the fixture used a
    // `type` key and What's vnode is keyed by `tag`. Assert the element too.
    expect(blogHtml).toContain('<article>Hybrid blog</article>');
    const blogScript = blogHtml.match(/\/_then\/pages\/blog\.([a-f0-9]{12})\.js/)?.[0];
    expect(blogScript).toBeTruthy();
    expect(existsSync(join(root, 'dist', 'static', blogScript!.slice(1)))).toBe(true);

    // Regression: the emitted browser bundles must actually BOOT the page.
    // A bundle that only does `export default Component` leaves the client
    // shell at "Loading..." forever — nothing ever calls mount/hydrate.
    const dashboardJs = readFileSync(join(root, 'dist', 'static', dashboardScript!.slice(1)), 'utf8');
    const blogJs = readFileSync(join(root, 'dist', 'static', blogScript!.slice(1)), 'utf8');
    expect(dashboardJs).toContain('__vura-client-entry__');
    expect(dashboardJs).toMatch(/\bmount\(/);
    expect(blogJs).toContain('__vura-client-entry__');
    expect(blogJs).toMatch(/\bhydrate\(/);
  }, 10000);
});
