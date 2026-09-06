import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { deriveRequiredFeatures, ManifestValidationError } from '@celsian/vura-contract';
import { build, generateServerEntry } from '../src/build.js';
import { buildManifest, type RouteManifest } from '../src/manifest.js';
import { readNodeManifest } from '../src/node-manifest.js';
import { reservePort } from './reserve-port.js';

const roots: string[] = [];
function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'vura-node-contract-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
function manifest(): RouteManifest {
  return { api: [], pages: [], layouts: [], timestamp: '2026-09-06T00:00:00.000Z' };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Node manifest reader admission', () => {
  const invalid = [
    { name: 'unknown schema', value: () => ({ ...manifest(), schemaVersion: 2, requiredFeatures: [] }), code: 'unsupported_version' },
    { name: 'unknown declared feature', value: () => ({ ...manifest(), schemaVersion: 1, requiredFeatures: ['future-isolation'] }), code: 'unknown_feature' },
    { name: 'unknown legacy feature', value: () => ({ ...manifest(), requiredFeatures: ['future-isolation'] }), code: 'unknown_feature' },
    { name: 'malformed timestamp', value: () => ({ ...manifest(), timestamp: '' }), code: 'invalid_type' },
    { name: 'contradictory placement', value: () => ({ ...manifest(), api: [{ filePath: 'src/api/missing.ts', urlPattern: '/api/missing', methods: ['GET'], kind: 'hot', config: { compute: { class: 'function' } } }] }), code: 'invalid_value' },
    { name: 'missing declared requirement', value: () => ({ ...manifest(), schemaVersion: 1, requiredFeatures: [], middleware: 'src/middleware.ts' }), code: 'missing_feature' },
  ];

  it.each(invalid)('rejects $name before output writes, source bundling, or adapter dispatch', async ({ value, code }) => {
    const files = {
      'dist/server/entry.js': 'previous server',
      'dist/server/obsolete.js': 'previous route',
      'dist/functions/package.json': 'previous functions',
      'dist/manifest.json': 'previous manifest',
    };
    const root = project(files);
    const buildEnd = vi.fn();
    await expect(build(value() as RouteManifest, { adapter: { name: 'test', buildEnd } }, root))
      .rejects.toMatchObject({ name: 'ManifestValidationError', issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    for (const [path, content] of Object.entries(files)) expect(readFileSync(join(root, path), 'utf8')).toBe(content);
    expect(readdirSync(join(root, 'dist/server')).sort()).toEqual(['entry.js', 'obsolete.js']);
    expect(readdirSync(join(root, 'dist/functions'))).toEqual(['package.json']);
    expect(buildEnd).not.toHaveBeenCalled();
  });

  it.each(invalid)('guards direct generateServerEntry against $name', ({ value }) => {
    expect(() => generateServerEntry(value() as RouteManifest, '/unused')).toThrow(ManifestValidationError);
  });

  it('does not even create dist for an invalid first build', async () => {
    const root = project();
    await expect(build({ ...manifest(), schemaVersion: 99 } as RouteManifest, {}, root)).rejects.toThrow(ManifestValidationError);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['legacy', 'v1'])('retains the complete %s DTO without normalizing raw metadata', format => {
    const legacy: RouteManifest = {
      ...manifest(),
      api: [{ filePath: 'src/api/task.ts', urlPattern: '/api/task', methods: ['POST'], kind: 'task',
        config: { schedule: '0 3 * * *', compute: { class: 'dedicated', size: 'small', profileExtension: 'keep' }, extra: [null, 1] } }],
      pages: [{ filePath: 'src/pages/account.tsx', urlPattern: '/account', mode: 'server',
        layout: 'src/pages/_layout.tsx', layouts: ['src/pages/_layout.tsx', 'src/pages/account/_layout.tsx'],
        hasLoader: true, hasGetServerData: true, config: { streaming: true, tags: ['account'], extra: { preserve: true } } }],
      layouts: [{ filePath: 'src/pages/_layout.tsx', dirPattern: '' }, { filePath: 'src/pages/account/_layout.tsx', dirPattern: 'account' }],
      middleware: 'src/middleware.ts',
      actions: [{ filePath: 'src/actions/account.ts', moduleId: 'account', exports: ['save', 'remove'] }],
    };
    const input = { ...legacy, extension: { revision: 42 },
      ...(format === 'v1' ? { schemaVersion: 1, requiredFeatures: deriveRequiredFeatures(legacy) } : {}) };
    const before = JSON.stringify(input);
    expect(readNodeManifest(input)).toBe(input);
    expect(JSON.stringify(readNodeManifest(before))).toBe(before);
    expect(generateServerEntry(input, '/unused')).toContain('"streaming":true');
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(['legacy', 'v1'])('preserves full %s metadata through build output and adapter context', async (format) => {
    const root = project({ 'src/api/hello.ts': 'export function GET(_req, reply) { return reply.json({ hello: true }); }' });
    const scanned = await buildManifest(root);
    expect(scanned).not.toHaveProperty('schemaVersion');
    expect(scanned).not.toHaveProperty('requiredFeatures');
    const input = {
      ...scanned,
      ...(format === 'v1' ? { schemaVersion: 1, requiredFeatures: deriveRequiredFeatures(scanned) } : {}),
      extension: { rollout: 'reader-first', values: [1, null, 'keep'] },
    };
    input.api[0].config.extension = { placementHint: 'preserve' };
    const before = JSON.stringify(input);
    const buildEnd = vi.fn();
    const result = await build(input, { adapter: { name: 'test', buildEnd } }, root);
    expect(result.manifest).toBe(input);
    expect(buildEnd.mock.calls[0][0].manifest).toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'))).toEqual(input);
    expect(readFileSync(result.serverEntry, 'utf8')).toContain('startVuraServer');
    const port = await reservePort();
    const child = fork(result.serverEntry, [], {
      cwd: root, stdio: 'pipe', env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Node entry did not start')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Node entry exited: ${code}`)); });
        child.stdout?.on('data', data => {
          if (String(data).includes('listening')) { clearTimeout(timer); resolve(); }
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/hello`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ hello: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        });
      }
    }
  });
});
