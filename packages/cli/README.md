# @celsian/vura-cli

CLI for [Vura](https://vura.dev) — develop, build, and run tasks for Vura applications.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-cli)](https://www.npmjs.com/package/@celsian/vura-cli)

## What it does

`@celsian/vura-cli` provides the `vura` command for developing and building Vura projects. It scans routes, starts the Vite dev server with API middleware, bundles for production, and lets you run task routes by name from the terminal. `vura deploy` is reserved for the managed Vura Platform and intentionally fails closed in the OSS CLI — use an adapter (`adapter-lambda`, `adapter-cloudflare`) to self-host. The package was historically named `then`/`thenjs`; the only installed bin is `vura`.

## Install

Installed automatically by `npm create vura@latest`. For manual use:

```sh
npm install @celsian/vura-cli
```

## Minimal example

**package.json** scripts:

```json
{
  "scripts": {
    "dev": "vura dev",
    "build": "vura build"
  }
}
```

Run a task route by name without a live server:

```sh
vura tasks run cleanup
# with input JSON:
vura tasks run cleanup --input '{"dryRun":true}'
```

(`then` is a shell reserved word — use `vura` in all scripts.)

## Documentation

_vura.dev docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Quick start — /ladder/0-create/](https://vura.dev/ladder/0-create/)
- [Task routes — /reference/tasks/](https://vura.dev/reference/tasks/)
- [Self-host — /self-host/](https://vura.dev/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
