/**
 * The argument to `create-vura` is a target path, not a bare name.
 *
 * It used to be sanitized as if it were only a package name:
 * `.replace(/[^a-z0-9\-_]/g, '')` deletes slashes and dots along with
 * everything else illegal in a package name, so `create-vura /tmp/my-app`
 * created a directory called `tmpmy-app` in the current directory. The project
 * appeared, in the wrong place, under a name nobody typed. This is also how
 * running CLAIMS.md row 21's own verification command littered the repo root.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

const repoRoot = resolve(__dirname, '../../..');
const createVuraBin = join(repoRoot, 'packages/create-vura/dist/index.js');
const TMPDIR = realpathSync(tmpdir());
const roots: string[] = [];

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(TMPDIR, `create-vura-${label}-`));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scaffold(arg: string, cwd: string) {
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'packages/create-vura')],
    { cwd: repoRoot, stdio: 'pipe' },
  );
  return spawnSync(process.execPath, [createVuraBin, arg, '--no-install'], {
    cwd,
    encoding: 'utf8',
  });
}

describe('create-vura target path', () => {
  it('writes to an absolute path instead of a mangled name in the cwd', () => {
    const cwd = tempRoot('abs-cwd');
    const target = join(tempRoot('abs-target'), 'my-app');

    const res = scaffold(target, cwd);

    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    // Nothing invented in the working directory.
    expect(existsSync(join(cwd, 'my-app'))).toBe(false);
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name).toBe('my-app');
  });

  it('writes to a nested relative path', () => {
    const cwd = tempRoot('nested');

    const res = scaffold('apps/shop', cwd);

    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(cwd, 'apps', 'shop', 'package.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, 'apps', 'shop', 'package.json'), 'utf8')).name).toBe('shop');
  });

  it('scaffolds into the current directory for `.`', () => {
    const cwd = tempRoot('dot');
    mkdirSync(join(cwd, 'storefront'));

    const res = scaffold('.', join(cwd, 'storefront'));

    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(cwd, 'storefront', 'package.json'))).toBe(true);
    // The package takes the directory's own name, and no `cd` line is printed
    // because the user is already there.
    expect(JSON.parse(readFileSync(join(cwd, 'storefront', 'package.json'), 'utf8')).name).toBe('storefront');
    expect(res.stdout).not.toMatch(/cd /);
  });

  it('refuses an argument that leaves no usable package name', () => {
    const cwd = tempRoot('bad');

    const res = scaffold('///', cwd);

    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('leaves no usable package name');
  });

  it('still sanitizes the package name it derives from the path', () => {
    const cwd = tempRoot('sanitize');

    // A directory name is allowed to contain characters a package name is not.
    const res = scaffold('My App!', cwd);

    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(cwd, 'My App!', 'package.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, 'My App!', 'package.json'), 'utf8')).name).toBe('my-app');
  });

  it('prints a shell-safe cd step for paths with spaces and apostrophes', () => {
    const cwd = tempRoot('quoted-cwd');
    const targetArg = "My App's Demo";
    const target = join(cwd, targetArg);

    const res = scaffold(targetArg, cwd);

    expect(res.status, res.stderr).toBe(0);
    const cdLine = res.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('cd '));
    expect(cdLine).toBe(`cd 'My App'\\''s Demo'`);

    const pwd = spawnSync('/bin/sh', ['-c', `${cdLine} && pwd`], {
      cwd,
      encoding: 'utf8',
    });
    expect(pwd.status, pwd.stderr).toBe(0);
    expect(pwd.stdout.trim()).toBe(target);
  });
});
