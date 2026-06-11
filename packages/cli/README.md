# @celsian/vura-cli

CLI for [Vura](https://vura.dev) — develop, build, and run tasks for Vura applications.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-cli)](https://www.npmjs.com/package/@celsian/vura-cli)

## What it does

`@celsian/vura-cli` provides the `vura` command (and the `thenjs` alias — `then` is a shell reserved word, avoid it in scripts) for developing and building Vura projects. It scans routes, starts the Vite dev server with API middleware, bundles for production, and lets you run task routes by name from the terminal. `vura deploy` is reserved for the managed Vura Platform and intentionally fails closed in the OSS CLI — use an adapter (`adapter-lambda`, `adapter-cloudflare`) to self-host.

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

(`then` is a shell reserved word — new scripts should use `vura` or `thenjs` instead.)

## Documentation

- [Quick start — /ladder/0-create/](https://vura.dev/ladder/0-create/)
- [Task routes — /reference/tasks/](https://vura.dev/reference/tasks/)
- [Self-host — /self-host/](https://vura.dev/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/zvndev/vura/blob/main/GOVERNANCE.md).
