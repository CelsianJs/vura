import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const [modulePath, body] of [
  ['packages/core/dist/manifest.js', `mod.extractPageConfig('import' + ' '.repeat(100_000) + 'x');`],
  ['packages/compiler/dist/index.js', `mod.scanRoute('import' + ' '.repeat(100_000) + 'x', 'tsx');`],
  ['packages/core/dist/manifest.js', `mod.fileToUrlPattern('['.repeat(100_000) + 'x.ts', '');`],
  ['packages/core/dist/manifest.js', `mod.fileToUrlPattern('/('.repeat(50_000) + 'x.ts', '');`],
  ['packages/adapter-cloudflare/dist/index.js', `mod.generateWorkerEntry([{ filePath: 'x' + '_'.repeat(100_000) + 'y.ts', urlPattern: '/api/test', methods: ['GET'], kind: 'serverless', config: {} }], '/', '/');`],
]) {
  it(`bounds adversarial parser input: ${modulePath} ${body.split('(')[0]}`, () => {
    const script = `const mod = await import(${JSON.stringify(pathToFileURL(resolve(modulePath)).href)}); ${body} process.stdout.write('ok');`;
    // One second is the process deadline, not a speed benchmark. A failing
    // implementation is killed so quadratic regressions cannot wedge the suite.
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 1_000 })).toBe('ok');
  });
}
