# @celsian/vura-cli

CLI for [Vura](https://vura.io) — develop, build, and run tasks for Vura applications.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-cli)](https://www.npmjs.com/package/@celsian/vura-cli)

## What it does

`@celsian/vura-cli` provides the `vura` command for developing, building, inspecting, and deploying Vura projects. It reports effective Function/Dedicated placement and pending Edge requests, including memory, CPU, timeout, provider recommendation, confidence, and reasons. `create-vura` installs the managed deployment adapter, so `vura deploy` works without a follow-up package install. Self-hosted builds can use the Lambda or Cloudflare adapters. The package was historically named `then`/`thenjs`; the only installed bin is `vura`.

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

Inspect runtime placement without deploying:

```sh
vura routes inspect --json
vura runtime advise --json
```

An Edge declaration is a request, not an override. The CLI reports it as
pending while the route continues on 1 GiB Function compute; only measured
platform eligibility can promote it to the fixed 128 MiB Edge runtime.

(`then` is a shell reserved word — use `vura` in all scripts.)

## Documentation

_vura.io docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Quick start — /ladder/0-create/](https://vura.io/ladder/0-create/)
- [Task routes — /reference/tasks/](https://vura.io/ladder/5-tasks/)
- [Self-host — /self-host/](https://vura.io/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
