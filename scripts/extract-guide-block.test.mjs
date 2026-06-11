import { describe, it, expect } from 'vitest';
import { extractFencedBlock } from './extract-guide-dockerfile.mjs';

// ─── Unit tests for the shared extractFencedBlock helper ─────────────────────
// (used by both extract-guide-dockerfile.mjs and extract-guide-block.mjs)

describe('extractFencedBlock', () => {
  it('extracts a dockerfile block', () => {
    const md = `
Some prose.

\`\`\`dockerfile
FROM node:22-slim
WORKDIR /app
CMD ["node", "server/entry.js"]
\`\`\`

More prose.
`;
    const result = extractFencedBlock(md, 'dockerfile');
    expect(result).toBe('FROM node:22-slim\nWORKDIR /app\nCMD ["node", "server/entry.js"]\n');
  });

  it('extracts a toml block', () => {
    const md = `
# fly.toml

\`\`\`toml
app = "my-app"
kill_signal = "SIGTERM"
\`\`\`
`;
    const result = extractFencedBlock(md, 'toml');
    expect(result).toBe('app = "my-app"\nkill_signal = "SIGTERM"\n');
  });

  it('is case-insensitive on the language tag', () => {
    const md = `\`\`\`Dockerfile\nFROM alpine\n\`\`\``;
    expect(extractFencedBlock(md, 'dockerfile')).toBe('FROM alpine\n');
  });

  it('returns null when the block is not present', () => {
    const md = '# no fenced blocks here';
    expect(extractFencedBlock(md, 'dockerfile')).toBeNull();
  });

  it('returns the first matching block when there are multiple', () => {
    const md = `
\`\`\`dockerfile
FROM node:22-slim
\`\`\`

\`\`\`dockerfile
FROM node:20-slim
\`\`\`
`;
    const result = extractFencedBlock(md, 'dockerfile');
    expect(result).toBe('FROM node:22-slim\n');
  });

  it('handles content with blank lines inside the block', () => {
    const md = `\`\`\`toml
app = "my-app"

[http_service]
  internal_port = 3000
\`\`\``;
    const result = extractFencedBlock(md, 'toml');
    expect(result).toBe('app = "my-app"\n\n[http_service]\n  internal_port = 3000\n');
  });

  it('extracts the real fly.toml from the actual guide file', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const source = await readFile(
      resolve('docs-site/pages/self-host/fly.md'),
      'utf8'
    );
    const result = extractFencedBlock(source, 'toml');
    expect(result).not.toBeNull();
    expect(result).toContain('app = "my-app"');
    expect(result).toContain('auto_stop_machines = "off"');
  });

  it('extracts the real Dockerfile from the actual docker guide file', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const source = await readFile(
      resolve('docs-site/pages/self-host/docker.md'),
      'utf8'
    );
    const result = extractFencedBlock(source, 'dockerfile');
    expect(result).not.toBeNull();
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('CMD ["node", "server/entry.js"]');
  });
});

// ─── CLI integration tests ────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const dockerfireScript = pathResolve('scripts/extract-guide-dockerfile.mjs');
const blockScript = pathResolve('scripts/extract-guide-block.mjs');

async function makeTempGuide(content) {
  const dir = await mkdtemp(join(tmpdir(), 'vura-guide-test-'));
  const file = join(dir, 'guide.md');
  await writeFile(file, content, 'utf8');
  return file;
}

describe('extract-guide-dockerfile.mjs CLI', () => {
  it('prints dockerfile content to stdout', async () => {
    const guide = await makeTempGuide(`\`\`\`dockerfile\nFROM node:22-slim\n\`\`\``);
    const { stdout } = await execFileAsync(process.execPath, [dockerfireScript, guide]);
    expect(stdout).toBe('FROM node:22-slim\n');
  });

  it('exits non-zero when no dockerfile block present', async () => {
    const guide = await makeTempGuide('# no dockerfile here');
    await expect(
      execFileAsync(process.execPath, [dockerfireScript, guide])
    ).rejects.toMatchObject({ code: 1 });
  });

  it('exits non-zero when no args given', async () => {
    await expect(
      execFileAsync(process.execPath, [dockerfireScript])
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe('extract-guide-block.mjs CLI', () => {
  it('extracts a toml block', async () => {
    const guide = await makeTempGuide('```toml\napp = "x"\n```');
    const { stdout } = await execFileAsync(process.execPath, [blockScript, guide, 'toml']);
    expect(stdout).toBe('app = "x"\n');
  });

  it('exits non-zero when no matching block', async () => {
    const guide = await makeTempGuide('# no toml here');
    await expect(
      execFileAsync(process.execPath, [blockScript, guide, 'toml'])
    ).rejects.toMatchObject({ code: 1 });
  });

  it('exits non-zero when no args given', async () => {
    await expect(
      execFileAsync(process.execPath, [blockScript])
    ).rejects.toMatchObject({ code: 1 });
  });
});
