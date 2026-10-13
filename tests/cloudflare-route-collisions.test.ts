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
    // Each module has a fixed numeric identity, independent of request paths.
    // Only bounded array indices enter source; string inputs remain argv data.
    for (const [marker, name] of names.entries()) {
      writeFileSync(join(root, 'src/api', `${name}.ts`), `export function GET() { return { marker: ${marker} }; }`);
      writeFileSync(join(root, 'src/api/tasks', `${name}.ts`), `export const route = { kind: 'task', schedule: '0 * * * *' }; export function POST() { return ${marker}; }`);
    }
    const manifest = await buildManifest(root);
    const outDir = join(root, 'dist');
    await cloudflareAdapter({ name: 'collisions', compatibilityDate: '2026-05-10' }).buildEnd({ projectRoot: root, outDir, manifest, serverEntry: join(outDir, 'server/entry.js'), clientDir: join(outDir, 'client') });
    const entryPath = join(outDir, 'cloudflare/entry.js');
    expect(existsSync(join(outDir, 'cloudflare/routes/src_api_foo_bar_0.js'))).toBe(true);
    const code = `const { entryUrl, names, control } = JSON.parse(process.argv[1]);
const mod = await import(entryUrl);
const http = [];
for (const name of names) {
  const res = await mod.default.fetch(new Request('https://example.com/api/' + name), {}, {});
  http.push({ status: res.status, body: await res.json() });
}
const tasks = await mod.default.scheduled({ cron: '0 * * * *' }, {}, {});
process.stdout.write(JSON.stringify({ http, tasks, control }));`;
    const control = "quotes:'\" backslash:\\ </script><SCRIPT>throw new Error('injected')</SCRIPT>\n\t\u0000\u2028\u2029";
    const input = JSON.stringify({ entryUrl: pathToFileURL(entryPath).href, names, control });
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, input], { encoding: 'utf8' }));
    expect(result.control).toBe(control);
    expect.soft(result.http).toEqual(names.map((_name, marker) => ({ status: 200, body: { marker } })));
    expect.soft(result.tasks.map((task: { result: number }) => task.result).sort()).toEqual(names.map((_name, marker) => marker));
    expect(result.tasks.every((task: { status: string }) => task.status === 'completed')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
