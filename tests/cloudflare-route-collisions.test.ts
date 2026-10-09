import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildManifest } from '../packages/core/src/manifest.js';
import { cloudflareAdapter } from '../packages/adapter-cloudflare/src/index.js';

it('keeps colliding scanner filenames on distinct HTTP and scheduled handlers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-collisions-'));
  try {
    mkdirSync(join(root, 'src/api/tasks'), { recursive: true });
    const names = ['foo-bar', 'foo_bar', 'foo_bar_0', 'v1.0', 'v1-0'];
    for (const name of names) {
      writeFileSync(join(root, 'src/api', `${name}.ts`), `export function GET() { return { name: ${JSON.stringify(name)} }; }`);
      writeFileSync(join(root, 'src/api/tasks', `${name}.ts`), `export const route = { kind: 'task', schedule: '0 * * * *' }; export function POST() { return ${JSON.stringify(name)}; }`);
    }
    const manifest = await buildManifest(root);
    const outDir = join(root, 'dist');
    await cloudflareAdapter({ name: 'collisions', compatibilityDate: '2026-05-10' }).buildEnd({ projectRoot: root, outDir, manifest, serverEntry: join(outDir, 'server/entry.js'), clientDir: join(outDir, 'client') });
    const entryPath = join(outDir, 'cloudflare/entry.js');
    expect(existsSync(join(outDir, 'cloudflare/routes/src_api_foo_bar_0.js'))).toBe(true);
    const code = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
const http = [];
for (const name of ${JSON.stringify(names)}) {
  const res = await mod.default.fetch(new Request('https://example.com/api/' + name), {}, {});
  http.push({ status: res.status, body: await res.json() });
}
const tasks = await mod.default.scheduled({ cron: '0 * * * *' }, {}, {});
process.stdout.write(JSON.stringify({ http, tasks }));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
    expect.soft(result.http).toEqual(names.map(name => ({ status: 200, body: { name } })));
    expect.soft(result.tasks.map((task: { result: string }) => task.result).sort()).toEqual([...names].sort());
    expect(result.tasks.every((task: { status: string }) => task.status === 'completed')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
