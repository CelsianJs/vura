# @celsian/vura-adapter-vura

Managed Vura Platform adapter for [Vura](https://vura.io) applications.

> **Beta.** The Vura managed platform is in open beta — sign up at [app.vura.io](https://app.vura.io). Self-hosted deployments can use `@celsian/vura-adapter-lambda` or `@celsian/vura-adapter-cloudflare` instead.

## What it does

`@celsian/vura-adapter-vura` packages your build output and uploads it to the Vura managed deployment platform. No framework capability (websockets, cache revalidation, tasks, cron) is gated on this adapter; everything works fully self-hosted via the other adapters. This adapter is a convenience for teams on the managed platform once access is available.

## Minimal example

**vura.config.ts:**

```ts
import { defineConfig } from '@celsian/vura-core';
import { vuraAdapter } from '@celsian/vura-adapter-vura';

export default defineConfig({
  adapter: vuraAdapter({ team: 'my-team' }),
});
```

## Documentation

_vura.io docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Platform overview — /self-host/](https://vura.io/self-host/)
- [MIT forever commitment — GOVERNANCE.md](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
