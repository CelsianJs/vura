# @celsian/vura-compiler

Pure-JS compiler for [Vura](https://vura.io) — safe static route scanning and JSX transforms.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-compiler)](https://www.npmjs.com/package/@celsian/vura-compiler)

## What it does

`@celsian/vura-compiler` scans route and page source files to extract HTTP methods, nested route config, and page modes without importing or executing application code. Its restricted route-literal parser supports strings, finite numbers (including numeric separators), booleans, null, arrays, nested objects, and TypeScript `as const`; calls, identifiers, spreads, computed properties, and templates fail with a source-located error. Deployment-affecting page values such as `mode`, `revalidate`, and `tags` must be static literals; page modes must be quoted strings. Explicit presentation references such as `styles: [baseStyles]` are omitted from the manifest and evaluated only when the renderer loads the page module. This package is the pure-JS path used by `@celsian/vura-core` — you do not need to install it directly unless building custom tooling.

## Install

```sh
npm install @celsian/vura-compiler
```

## Minimal example

```ts
import { scanRoute } from '@celsian/vura-compiler';

const source = `
  export const route = { kind: 'hot' };
  export function websocket(peer, req) {}
`;

const result = scanRoute(source, 'ts');
// result.kind === 'hot'
// result.methods === []  (websocket handler, not HTTP methods)
```

Managed compute has two public classes: scale-to-zero `function` endpoints with
1/4/6/8/12 GB memory, and persistent `dedicated` endpoints. Dedicated routes can
use provider-neutral capacity profiles:

```ts
export const route = {
  compute: { class: 'dedicated', size: 'large' }, // 2 vCPU / 2 GB
};
```

## Documentation

- [CLI build reference — /reference/cli/](https://vura.io/reference/cli/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
