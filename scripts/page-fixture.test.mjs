import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fixtureScript = resolve('scripts/add-page-fixture.mjs');
const assertScript = resolve('scripts/assert-served-pages.mjs');

describe('add-page-fixture.mjs', () => {
  it('writes a server-mode page with a loader into the scaffold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vura-page-fixture-'));
    await execFileAsync(process.execPath, [fixtureScript, dir]);
    const page = await readFile(join(dir, 'src', 'pages', 'posts.tsx'), 'utf8');
    expect(page).toContain("mode: 'server'");
    expect(page).toContain('export async function loader()');
    expect(page).toContain('useLoaderData');
  });

  it('exits non-zero when the target does not exist', async () => {
    await expect(
      execFileAsync(process.execPath, [fixtureScript, join(tmpdir(), 'vura-does-not-exist-9f3a')]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('agrees with the assertion script on every marker it looks for', async () => {
    // The two files are read as text on purpose. Renaming the loader's
    // message in one of them and not the other would not break either script:
    // the page would still render and the assertion would still run, and it
    // would simply stop asserting anything, which is the exact shape of the
    // hole this pair exists to close.
    const dir = await mkdtemp(join(tmpdir(), 'vura-page-fixture-'));
    await execFileAsync(process.execPath, [fixtureScript, dir]);
    const page = await readFile(join(dir, 'src', 'pages', 'posts.tsx'), 'utf8');
    const assertions = await readFile(assertScript, 'utf8');

    const message = page.match(/message: '([^']+)'/)?.[1];
    expect(message).toBeTruthy();
    expect(assertions).toContain(`LOADED:${message}`);

    // The per-request check reads the rendered timestamp back out with
    // /AT:([^<]+)</, so the page has to print it with that exact prefix.
    expect(page).toContain('AT:');
    expect(assertions).toContain('AT:');
  });
});

describe('assert-served-pages.mjs', () => {
  it('exits non-zero when nothing is listening', async () => {
    // A smoke script that exits 0 on failure is worse than no smoke script:
    // it is a green check over a broken deployment.
    await expect(
      execFileAsync(process.execPath, [assertScript, 'http://127.0.0.1:1']),
    ).rejects.toBeTruthy();
  });

  it('exits non-zero without a base URL', async () => {
    await expect(execFileAsync(process.execPath, [assertScript])).rejects.toMatchObject({ code: 1 });
  });
});
