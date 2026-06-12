# @celsian/vura-compiler-native

Rust compiler prototype for [Vura](https://vura.io) (NAPI-RS) — unpublished prototype, source-only.

## What it does

`@celsian/vura-compiler-native` is an AST-based route scanner and JSX transformer written in Rust via NAPI-RS. It exposes the same API surface as `@celsian/vura-compiler` (`scanRoute`, `transformJsx`, `watchDirectory`), allowing `@celsian/vura-cli` to swap in the native implementation when a prebuilt binary is available. This package is private and not published to npm — no platform binaries have been released yet. Use `@celsian/vura-compiler` (the pure-JS path) in all current projects.

## Status

Private (`"private": true` in package.json). Source is included in the monorepo for development and benchmarking. Not available on npm.

## API (for reference)

```ts
import { scanRoute, transformJsx } from '@celsian/vura-compiler-native';

const result = scanRoute(source, 'ts');
const { code } = transformJsx(source, 'what-framework', false);
```

## Documentation

_vura.io docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Compiler reference — /reference/compiler/](https://vura.io/reference/cli/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
