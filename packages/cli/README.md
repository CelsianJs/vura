# @celsian/vura-cli

CLI for [Vura](https://vura.io) — develop, build, and run tasks for Vura applications.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-cli)](https://www.npmjs.com/package/@celsian/vura-cli)

## What it does

`@celsian/vura-cli` provides the `vura` command for developing, building, inspecting, and deploying Vura projects. It reports effective Function/Dedicated placement, including memory, CPU, timeout, provider-neutral runtime recommendations, confidence, and reasons. Dedicated endpoints can select `nano`, `small`, `medium`, `large`, `xlarge`, `2xlarge`, or `4xlarge` capacity profiles. `create-vura` installs the managed deployment adapter, so `vura deploy` works without a follow-up package install. Self-hosted builds can use the Lambda or Cloudflare adapters. The package was historically named `then`/`thenjs`; the only installed bin is `vura`.

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

Without Vite, `vura dev` watches application files under `src/` and automatically
reloads browser pages after a successful rebuild, including changes to imported
modules and added or deleted routes. This is a full-page reload: browser-local
state resets. It is not state-preserving hot module replacement. Broken edits
are reported in the terminal; the previous working generation stays active
until the edit is fixed. Open hot-route WebSocket clients retain their previous
room registry until they reconnect.

Managed routes choose between scale-to-zero Function compute and persistent
Dedicated compute. Function memory defaults to 1 GiB and supports 1, 4, 6, 8,
and 12 GiB profiles.

(`then` is a shell reserved word — use `vura` in all scripts.)

## Documentation

- [Quick start — /ladder/0-create/](https://vura.io/ladder/0-create/)
- [Task routes — /ladder/5-tasks/](https://vura.io/ladder/5-tasks/)
- [Self-host — /self-host/](https://vura.io/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
