import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildManifest } from '../packages/core/src/manifest.js';
import { lambdaAdapter } from '../packages/adapter-lambda/src/index.js';

it('keeps colliding scanner routes as distinct SAM resources and executable handlers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-lambda-collisions-'));
  try {
    mkdirSync(join(root, 'src/api'), { recursive: true });
    const names = ['foo-bar', 'foo_bar', 'v1.0', 'v1-0', 'hello', 'foobar0'];
    // Module identity is fixed at creation, never derived from the request.
    for (const [marker, name] of names.entries()) {
      writeFileSync(join(root, 'src/api', `${name}.ts`), `export function GET() { return { marker: ${marker} }; }`);
    }
    const manifest = await buildManifest(root);
    const outDir = join(root, 'dist');
    await lambdaAdapter().buildEnd({ projectRoot: root, outDir, manifest, serverEntry: join(outDir, 'server/entry.js'), clientDir: join(outDir, 'client') });
    const template = readFileSync(join(outDir, 'template.yaml'), 'utf8');
    // Strictly scan the generator's two-space resource keys without accepting
    // YAML duplicate-key overwrite, which would hide the missing API mapping.
    const resources = template.split(/^  (?=\S)/m).filter(block => /^\S+Function:\n/.test(block)).map(block => ({
      id: block.match(/^(\S+)Function:/)![1],
      path: block.match(/^\s+Path: (\S+)$/m)![1],
      codeUri: block.match(/^\s+CodeUri: (\S+)$/m)![1],
    }));
    expect(resources).toHaveLength(names.length);
    expect.soft(new Set(resources.map(resource => resource.id)).size).toBe(names.length);
    expect.soft(resources.every(resource => /^[A-Za-z0-9]+$/.test(resource.id))).toBe(true);
    expect(resources.find(resource => resource.path === '/api/hello')?.id).toBe('GETApihello');
    expect(resources.find(resource => resource.path === '/api/foobar0')?.id).toBe('GETApifoobar0');
    expect(new Set(resources.map(resource => resource.codeUri)).size).toBe(names.length);
    for (const [marker, name] of names.entries()) {
      const resource = resources.find(resource => resource.path === `/api/${name}`)!;
      const entryPath = join(outDir, resource.codeUri, 'index.js');
      const event = { version: '2.0', rawPath: `/api/${name}`, rawQueryString: '', headers: { host: 'example.com' }, requestContext: { http: { method: 'GET' } } };
      const code = `const { entryUrl, event } = JSON.parse(process.argv[1]);
const mod = await import(entryUrl);
process.stdout.write(JSON.stringify(await mod.handler(event)));`;
      const input = JSON.stringify({ entryUrl: pathToFileURL(entryPath).href, event });
      const response = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, input], { encoding: 'utf8' }));
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ marker });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
