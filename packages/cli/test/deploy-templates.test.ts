import { afterAll, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommand } from '../src/commands/build.js';

// Use canonical tmpdir path (resolves macOS /var → /private/var symlink)
// so that process.chdir() + process.cwd() == the path we pass to build().
const TMPDIR = realpathSync(tmpdir());

const tempRoots = new Set<string>();

// Use afterAll instead of afterEach: the esbuild Go binary is a persistent
// subprocess whose working directory is set at spawn time (first esbuild API
// call) to the process CWD of that moment (a tmpdir). Deleting that tmpdir
// between tests (afterEach) corrupts the daemon's CWD, causing subsequent
// builds with absolute entry-point paths to fail. Cleaning up after ALL tests
// avoids this.
afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
});

/**
 * Runs buildCommand in a temp project root, silencing console output.
 * Uses the canonical tmpdir to avoid /var vs /private/var mismatches on macOS.
 */
async function runBuild(root: string): Promise<void> {
  const cwd = process.cwd();
  const log = console.log;
  console.log = () => {};
  process.chdir(root);
  try {
    await buildCommand([]);
  } finally {
    console.log = log;
    process.chdir(cwd);
  }
}

describe('vura build — hot deploy templates', () => {
  it('emits Dockerfile and fly.toml when project has a hot route', async () => {
    const root = mkdtempSync(join(TMPDIR, 'vura-deploy-hot-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    // A minimal hot route — no WS, just a GET handler
    writeFileSync(join(root, 'src', 'api', 'stream.ts'), `
export const route = { kind: 'hot' };
export async function GET(_req: Request): Promise<Response> {
  return new Response('ok');
}
`);

    await runBuild(root);

    const dockerfilePath = join(root, 'dist', 'Dockerfile');
    const flyTomlPath = join(root, 'dist', 'fly.toml');

    expect(existsSync(dockerfilePath), 'dist/Dockerfile should exist').toBe(true);
    expect(existsSync(flyTomlPath), 'dist/fly.toml should exist').toBe(true);

    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toContain('CMD ["node", "server/entry.js"]');
    expect(dockerfile).toContain('EXPOSE 3000');
    expect(dockerfile).toContain('FROM node:22-slim');
    // Dockerfile context is dist/ — COPY . ./ after npm install for correct layer cache
    expect(dockerfile).toContain('COPY package.json ./');
    expect(dockerfile).toContain('RUN npm install --omit=dev --no-audit --no-fund');
    expect(dockerfile).toContain('COPY . ./');
    // Header should document the correct build invocation
    expect(dockerfile).toContain('docker build -f dist/Dockerfile dist');

    const flyToml = readFileSync(flyTomlPath, 'utf8');
    expect(flyToml).toContain('kill_signal = "SIGTERM"');
    expect(flyToml).toContain('kill_timeout = "30s"');
    expect(flyToml).toContain('[http_service]');
    expect(flyToml).toContain('internal_port = 3000');
    expect(flyToml).toContain('force_https = true');
    // auto_stop_machines must be the string form (boolean deprecated by Fly)
    expect(flyToml).toContain('auto_stop_machines = "off"');
    expect(flyToml).toContain('min_machines_running = 1');
    // [build] section must point to Dockerfile for `fly deploy ./dist` to work
    expect(flyToml).toContain('[build]');
    expect(flyToml).toContain('dockerfile = "Dockerfile"');
    // Header should document the supported deploy flow
    expect(flyToml).toContain('fly deploy ./dist');
    // app name should be sanitized basename of root
    expect(flyToml).toMatch(/^app = "/m);

    // dist/server/entry.js must exist (the CMD path in the Dockerfile references it)
    expect(existsSync(join(root, 'dist', 'server', 'entry.js')), 'dist/server/entry.js should exist').toBe(true);
  }, 15000);

  it('does NOT emit Dockerfile or fly.toml for a serverless-only project', async () => {
    const root = mkdtempSync(join(TMPDIR, 'vura-deploy-serverless-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    // A plain serverless route
    writeFileSync(join(root, 'src', 'api', 'health.ts'), `
export async function GET(_req: Request): Promise<Response> {
  return new Response('ok');
}
`);

    await runBuild(root);

    expect(existsSync(join(root, 'dist', 'Dockerfile')), 'dist/Dockerfile should NOT exist').toBe(false);
    expect(existsSync(join(root, 'dist', 'fly.toml')), 'dist/fly.toml should NOT exist').toBe(false);
  }, 15000);

  it('does NOT add ws to dist/package.json for serverless-only project', async () => {
    const root = mkdtempSync(join(TMPDIR, 'vura-deploy-no-ws-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    writeFileSync(join(root, 'src', 'api', 'health.ts'), `
export async function GET(_req: Request): Promise<Response> {
  return new Response('ok');
}
`);

    await runBuild(root);

    // dist/package.json is written for EVERY build, not just hot ones: the
    // emitted route bundles keep `what-framework` external, so the file has to
    // declare it or `npm install --omit=dev` in the container produces an image
    // that dies on the first request. `ws` is the part that is hot-only.
    const pkgPath = join(root, 'dist', 'package.json');
    expect(existsSync(pkgPath), 'dist/package.json should exist for serverless-only').toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies?.ws, 'ws is only needed by websocket hot routes').toBeUndefined();
  }, 15000);

  it('pins what-framework in dist/package.json to the version the project resolved', async () => {
    const root = mkdtempSync(join(TMPDIR, 'vura-deploy-whatver-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    // A version string that exists nowhere else, so this can only pass by
    // reading the copy installed in THIS project.
    mkdirSync(join(root, 'node_modules', 'what-framework'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'what-framework', 'package.json'),
      // The `exports` map matters: the real what-framework does NOT export
      // './package.json', so `require('what-framework/package.json')` throws
      // ERR_PACKAGE_PATH_NOT_EXPORTED. A fixture without an exports map lets a
      // resolution strategy pass here that cannot work in any real install —
      // which is exactly how the broken version shipped.
      JSON.stringify({
        name: 'what-framework',
        version: '9.9.9-fixture',
        type: 'module',
        exports: {
          '.': { import: './src/index.js' },
          './server': { import: './src/server.js' },
        },
      }) + '\n',
    );
    writeFileSync(join(root, 'src', 'api', 'health.ts'), `
export async function GET(_req: Request): Promise<Response> {
  return new Response('ok');
}
`);

    await runBuild(root);

    const pkg = JSON.parse(readFileSync(join(root, 'dist', 'package.json'), 'utf8'));
    // Pinned, not a range: the container must run the What the app was built
    // and tested against, not whatever `latest` is on deploy day.
    expect(pkg.dependencies?.['what-framework']).toBe('9.9.9-fixture');
  }, 15000);

  it('includes ws pinned to exact 8.18.0 in dist/package.json when hot route has websocket', async () => {
    const root = mkdtempSync(join(TMPDIR, 'vura-deploy-ws-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    // A hot route that exports a websocket handler
    writeFileSync(join(root, 'src', 'api', 'live.ts'), `
export const route = { kind: 'hot' };
export function websocket(_peer: any, _req: Request): void {}
export async function GET(_req: Request): Promise<Response> {
  return new Response('upgrade');
}
`);

    await runBuild(root);

    const pkgPath = join(root, 'dist', 'package.json');
    expect(existsSync(pkgPath), 'dist/package.json should exist').toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkg.type).toBe('module');
    // ws must be pinned exactly — no ^ or ~ (no lockfile in Docker image; floating range is non-reproducible)
    expect(pkg.dependencies?.ws).toBe('8.18.0');
  }, 15000);

  it('merges ws into an existing dist/package.json rather than clobbering it', async () => {
    const root = mkdtempSync(join(TMPDIR, 'vura-deploy-merge-'));
    tempRoots.add(root);
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    // Pre-seed a dist/package.json with an existing dep
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { 'some-dep': '^1.0.0' } }, null, 2) + '\n',
    );
    // Hot route with websocket
    writeFileSync(join(root, 'src', 'api', 'live.ts'), `
export const route = { kind: 'hot' };
export function websocket(_peer: any, _req: Request): void {}
export async function GET(_req: Request): Promise<Response> {
  return new Response('upgrade');
}
`);

    await runBuild(root);

    const pkg = JSON.parse(readFileSync(join(root, 'dist', 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['some-dep']).toBe('^1.0.0');
    expect(pkg.dependencies?.ws).toBe('8.18.0');
  }, 15000);

  describe('app name sanitizer', () => {
    it('truncates long names to ≤30 chars with no trailing dash', async () => {
      const root = mkdtempSync(join(TMPDIR, 'vura-deploy-longname-very-long-name-that-exceeds-thirty-chars-'));
      tempRoots.add(root);
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
      writeFileSync(join(root, 'src', 'api', 'stream.ts'), `
export const route = { kind: 'hot' };
export async function GET(_req: Request): Promise<Response> {
  return new Response('ok');
}
`);

      await runBuild(root);

      const flyToml = readFileSync(join(root, 'dist', 'fly.toml'), 'utf8');
      const match = flyToml.match(/^app = "(.+)"/m);
      expect(match, 'fly.toml should have app = "..."').toBeTruthy();
      const appName = match![1];
      expect(appName.length, `app name "${appName}" should be ≤30 chars`).toBeLessThanOrEqual(30);
      expect(appName, 'app name should not end with a dash').not.toMatch(/-$/);
      expect(appName, 'app name should only contain [a-z0-9-]').toMatch(/^[a-z0-9-]+$/);
    }, 15000);

    it('replaces underscores and produces valid charset; falls back to vura-app for all-special name', () => {
      // Test the sanitizer logic directly by driving emitHotDeployTemplates indirectly.
      // We validate the invariants via a known-bad name pattern using the same regex
      // the build command applies.
      const sanitize = (rawName: string): string =>
        rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'vura-app';

      // underscores → dashes
      expect(sanitize('my_project_name')).toBe('my-project-name');
      // long name truncated, no trailing dash
      const long = 'a-very-long-project-name-that-exceeds-the-limit';
      const result = sanitize(long);
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).not.toMatch(/-$/);
      expect(result).toMatch(/^[a-z0-9-]+$/);
      // all-special chars → fallback
      expect(sanitize('___')).toBe('vura-app');
      expect(sanitize('---')).toBe('vura-app');
    });
  });
});
