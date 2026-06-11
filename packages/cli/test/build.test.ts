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
  return { type: 'main', props: {}, children: ['Dashboard app'] };
}
`);
    writeFileSync(join(root, 'src', 'pages', 'blog.ts'), `
export const page = { mode: 'hybrid', title: 'Blog' };
export default function Blog() {
  return { type: 'article', props: {}, children: ['Hybrid blog'] };
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
    expect(dashboardHtml).toContain('/_then/pages/dashboard.js');
    expect(existsSync(join(root, 'dist', 'static', '_then', 'pages', 'dashboard.js'))).toBe(true);

    expect(blogHtml).toContain('<title>Blog</title>');
    expect(blogHtml).toContain('Hybrid blog');
    expect(blogHtml).toContain('/_then/pages/blog.js');
    expect(existsSync(join(root, 'dist', 'static', '_then', 'pages', 'blog.js'))).toBe(true);

    // Regression: the emitted browser bundles must actually BOOT the page.
    // A bundle that only does `export default Component` leaves the client
    // shell at "Loading..." forever — nothing ever calls mount/hydrate.
    const dashboardJs = readFileSync(join(root, 'dist', 'static', '_then', 'pages', 'dashboard.js'), 'utf8');
    const blogJs = readFileSync(join(root, 'dist', 'static', '_then', 'pages', 'blog.js'), 'utf8');
    expect(dashboardJs).toContain('__vura-client-entry__');
    expect(dashboardJs).toMatch(/\bmount\(/);
    expect(blogJs).toContain('__vura-client-entry__');
    expect(blogJs).toMatch(/\bhydrate\(/);
  }, 10000);
});
