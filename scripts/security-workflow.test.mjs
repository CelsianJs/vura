import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function permissions(block, indent) {
  const entries = block.match(new RegExp(`^${' '.repeat(indent)}permissions:\\n((?:${' '.repeat(indent + 2)}[^\\n]+\\n)+)`, 'm'))?.[1];
  return Object.fromEntries((entries ?? '').trim().split('\n').filter(Boolean).map((entry) => {
    const [scope, access] = entry.trim().split(': ');
    return [scope, access];
  }));
}

function job(workflow, name) {
  const block = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[0];
  expect(block, `${name} job must remain present`).toBeDefined();
  return block;
}

describe.each(['.depot/workflows/security.yml', '.github/workflows/security.yml'])('%s least-privilege scanning', (file) => {
  const source = () => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

  it('does not request CodeQL permissions for every scanner', async () => {
    expect(permissions(await source(), 0)).toEqual({ contents: 'read' });
  });

  it('retains CodeQL permissions and analysis steps', async () => {
    const block = job(await source(), 'codeql');
    expect(permissions(block, 4)).toEqual({ contents: 'read', actions: 'read', 'security-events': 'write' });
    expect(block).toContain('uses: github/codeql-action/init@v4');
    expect(block).toContain('uses: github/codeql-action/analyze@v4');
  });

  it('runs the redacted secret scan with only repository read access', async () => {
    const block = job(await source(), 'secrets');
    expect(permissions(block, 4)).toEqual({ contents: 'read' });
    expect(block).toContain('fetch-depth: 0');
    expect(block).toContain('detect --source=/repo --redact --verbose');
    expect(block).not.toContain('continue-on-error:');
    expect(block).not.toMatch(/^\s+if:/m);
  });
});
