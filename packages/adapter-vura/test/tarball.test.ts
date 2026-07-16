import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createTarball } from '../src/index.js';

const execFileAsync = promisify(execFile);

describe('adapter-vura tarball packaging', () => {
  it('passes paths to tar as arguments instead of shell text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vura-tarball-'));

    try {
      const sourceDir = join(root, 'source dir; touch should-not-run');
      const nestedDir = join(sourceDir, 'nested folder');
      const outputPath = join(sourceDir, 'artifact; touch shell-injected.tar.gz');
      const injectedMarker = join(sourceDir, 'shell-injected.tar.gz');

      await mkdir(nestedDir, { recursive: true });
      await writeFile(join(sourceDir, 'index.html'), 'hello');
      await writeFile(join(nestedDir, 'data.json'), '{"ok":true}');

      await createTarball(sourceDir, outputPath);

      const listing = await execFileAsync('tar', ['-tzf', outputPath]);

      expect(listing.stdout).toContain('./index.html');
      expect(listing.stdout).toContain('./nested folder/data.json');
      await expect(readFile(injectedMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects option-like and escaping entry names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vura-tarball-entries-'));
    const outputPath = join(root, 'artifact.tar.gz');
    try {
      await expect(createTarball(root, outputPath, ['--checkpoint-action=exec=touch marker']))
        .rejects.toThrow(/unsafe tar entry/);
      await expect(createTarball(root, outputPath, ['../outside']))
        .rejects.toThrow(/unsafe tar entry/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
