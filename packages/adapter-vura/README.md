# @celsian/vura-adapter-vura

Managed Vura Platform adapter for [Vura](https://vura.dev) applications.

## What it does

`@celsian/vura-adapter-vura` packages your build output and uploads it to the Vura managed deployment platform. The platform is currently in closed alpha — access is not publicly available yet. No framework capability (websockets, cache revalidation, tasks, cron) is gated on this adapter; everything works fully self-hosted via the other adapters. This adapter is a convenience for teams on the managed platform.

## Install

```sh
npm install @celsian/vura-adapter-vura
```

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

- [Platform overview — /self-host/](https://vura.dev/self-host/)
- [MIT forever commitment — GOVERNANCE.md](https://github.com/zvndev/vura/blob/main/GOVERNANCE.md)

## License

MIT — and [it will stay MIT](https://github.com/zvndev/vura/blob/main/GOVERNANCE.md).
