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
   cron schedules all work fully self-hosted, with no account, API key, or
   `VURA_*` platform environment variable. This will be enforced by an automated
   test suite (`tests/self-host-audit/`, landing this release cycle) that runs
   in CI on every commit.
3. The managed Vura Platform competes on effort saved (one-command deploys,
   unified logs, preview environments), never on withheld capability.

If a future maintainer violates this, the MIT license already grants you the
permanent right to fork everything published to date.

## Decision making

Vura is maintained by ZVN. Changes land via pull request with CI green
(see RELEASING.md, landing this release cycle, for the release gate). Breaking changes to public APIs
require a minor version bump pre-1.0 and a CHANGELOG entry.

## Reporting

Security: see SECURITY.md. Conduct/contributions: see CONTRIBUTING.md.
