# @celsian/vura-adapter-vura

Managed Vura Platform adapter for [Vura](https://vura.io) applications.

> **Private beta.** [Signup](https://app.vura.io/signup) requires an access code. Installing this package does not grant managed-service access. Self-hosted deployments can use the built-in Node output, `@celsian/vura-adapter-lambda`, or `@celsian/vura-adapter-cloudflare` instead.

## What it does

`@celsian/vura-adapter-vura` packages your build output and uploads it to the Vura managed deployment platform. Self-hosted Node supports websockets, cache revalidation, ordinary tasks, and cron. Durable task delivery and restart-safe waits currently require the managed broker; the standalone runner uses in-process state and timers. Other targets have additional limitations listed in the [support matrix](https://vura.io/self-host/).

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

- [Self-host alternatives — /self-host/](https://vura.io/self-host/)
- [MIT forever commitment — GOVERNANCE.md](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
