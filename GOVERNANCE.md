# Governance & License Commitment

## License: MIT, forever

Every package in this repository — `@celsian/vura-core`, `@celsian/vura-cli`,
`create-vura`, all adapters, the compiler, and the Vite plugin — is licensed
under the [MIT License](./LICENSE).

**This will not change.** We commit that:

1. The Vura framework (everything in this repository) is MIT-licensed and will
   remain MIT-licensed. No future version will be relicensed under BSL, SSPL,
   FSL, a source-available license, or any other restricted license.
2. No framework capability will ever be moved behind the managed platform.
   Static pages, server rendering, tag-based cache revalidation
   (`revalidateTag`), API routes, websockets/hot routes, background tasks, and
   cron schedules run in the self-hosted Node output, with no account, API key, or
   `VURA_*` platform environment variable. This is enforced by an automated
   test suite (`tests/self-host-audit/`) that runs in CI on every commit.
   This is not a claim that every deployment target has identical capabilities:
   see the [self-host support matrix](https://vura.io/self-host/). In particular,
   the shipped self-hosted task runner uses in-process state and timers. Durable
   queue delivery and step suspend/resume across restarts currently require the
   managed platform's broker; they are not provided by the standalone Node build.
   The no-withheld-framework commitment is a policy, not proof that this
   remaining portability gap is already closed.
3. The managed Vura Platform competes on effort saved (one-command deploys,
   unified logs, preview environments), never on withheld capability.

If a future maintainer violates this, the MIT license already grants you the
permanent right to fork everything published to date.

## Decision making

Vura is maintained by ZVN. Changes land via pull request with CI green
(see RELEASING.md for the release gate). Breaking changes to public APIs
require a minor version bump pre-1.0 and a CHANGELOG entry.

## Reporting

Security: see SECURITY.md. Conduct/contributions: see CONTRIBUTING.md.
