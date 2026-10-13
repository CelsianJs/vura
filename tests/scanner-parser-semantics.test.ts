import { expect, it } from 'vitest';
import { hasLegacyServerImport, scanRoute } from '../packages/compiler/src/index.js';
import { extractPageConfig, fileToUrlPattern } from '../packages/core/src/manifest.js';
import { generateWorkerEntry } from '../packages/adapter-cloudflare/src/index.js';

it('preserves legacy raw import inference, including historical malformed and non-code matches', () => {
  const cases: [string, boolean][] = [
    ["import x from 'then/server'", true],
    ['import x from "then/server"', true],
    ["// import x from 'then/server'", true],
    ['const example = "import x from \'then/server\'";', true],
    ["someimport x from 'then/server'", true],
    ["import x from 'then/server\"", true],
    ["import\n x from 'then/server'", true],
    ["import x from\n 'then/server'", true],
    ["import\r\n\tfrom 'then/server'", true],
    ["import x\nfrom 'then/server'", false],
    ["import x\rfrom 'then/server'", false],
    ["import x\u2028from 'then/server'", false],
    ["import x\u2029from 'then/server'", false],
    ["importx from 'then/server'", false],
    ["import x from 'then/server-extra'", false],
    ["import x from '@celsian/server'", false],
    ["const x = require('then/server');", false],
    ['import \n\t', false],
  ];
  for (const [source, expected] of cases) {
    expect(hasLegacyServerImport(source), source).toBe(expected);
    expect(scanRoute(source, 'tsx').pageMode, source).toBe(expected ? 'server' : null);
    expect(extractPageConfig(source).mode, source).toBe(expected ? 'server' : 'static');
  }
  const explicit = "import x from 'then/server'; export const page = { mode: 'static' };";
  expect(scanRoute(explicit, 'tsx').pageMode).toBe('static');
  expect(extractPageConfig(explicit).mode).toBe('static');
});

it('preserves malformed, nested, empty, grouped, dotted, and named catch-all path conversion', () => {
  const cases = [
    ['[[id]].tsx', '/:[id]'], ['[].tsx', '/[]'], ['[id.tsx', '/[id'],
    ['[[]].tsx', '/:[]'], ['[a][b].tsx', '/:a:b'], ['[...rest].tsx', '/*rest'],
    ['(auth)/(nested)/guide.v1.tsx', '/guide.v1'], ['(bad/guide.tsx', '/(bad/guide'],
    ['()/guide.tsx', '/()/guide'], ['[a[b]c].tsx', '/:a[bc]'],
    ['(outer(inner))/x.tsx', ')/x'],
  ];
  for (const [file, expected] of cases) expect(fileToUrlPattern(file, ''), file).toBe(expected);
});

it('retains generated module basename edge trimming and interior underscores', () => {
  for (const [filePath, basename] of [
    ['___src/api/hello___.ts', 'src_api_hello.js'],
    ['___x____y___.ts', 'x____y.js'], ['___.ts', '.js'], ['hello.ts', 'hello.js'],
  ]) {
    const entry = generateWorkerEntry([{ filePath, urlPattern: '/api/test', methods: ['GET'], kind: 'serverless', config: {} }], '/', '/');
    expect(entry).toContain(`from './routes/${basename}'`);
  }
});
