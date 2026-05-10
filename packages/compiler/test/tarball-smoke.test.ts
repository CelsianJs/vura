import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolve(__dirname, '../../..');
const nativeImport = new Function('specifier', 'return import(specifier)') as <T = any>(specifier: string) => Promise<T>;

function packCompiler(destination: string): string {
  execFileSync('pnpm', ['--dir', join(repoRoot, 'packages/compiler'), 'pack', '--pack-destination', destination], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  const tgz = readdirSync(destination).find((name) => name.endsWith('.tgz'));
  if (!tgz) throw new Error('No compiler tarball produced');
  return join(destination, tgz);
}

describe('compiler clean tarball smoke', () => {
  it('packs and imports built dist JavaScript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-compiler-pack-'));
    try {
      const tarball = packCompiler(root);
      const app = join(root, 'app');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'package.json'), '{"type":"module"}\n');
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
        cwd: app,
        stdio: 'pipe',
      });

      const packageRoot = join(app, 'node_modules/@then/compiler');
      expect(existsSync(join(packageRoot, 'dist/index.js'))).toBe(true);
      expect(existsSync(join(packageRoot, 'dist/index.d.ts'))).toBe(true);
      expect(existsSync(join(packageRoot, 'src/index.ts'))).toBe(false);

      const mod = await nativeImport(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
      expect(mod.scanRoute('export function GET() {}', 'ts').methods).toEqual(['GET']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
