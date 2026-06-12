# @celsian/vura-compiler

Pure-JS compiler for [Vura](https://vura.io) — regex-based route scanning and JSX transforms.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-compiler)](https://www.npmjs.com/package/@celsian/vura-compiler)

## What it does

`@celsian/vura-compiler` scans route and page source files to extract HTTP methods, route config (`kind`, `schedule`, etc.), and page modes without a full AST parse. It also handles the JSX transform step. This package is the pure-JS path used internally by `@celsian/vura-cli` and `@celsian/vura-vite-plugin` — you do not need to install it directly unless building custom tooling. For projects that need faster scanning, `@celsian/vura-compiler-native` (unpublished prototype) exposes the same API surface using AST-based analysis.

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

## Documentation

_vura.io docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Compiler internals — /reference/compiler/](https://vura.io/reference/cli/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
