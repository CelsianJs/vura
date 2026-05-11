# Contributing

Thanks for helping improve Vura.

## Development

Vura is verified on Node.js 20 and 22 with pnpm 10.11.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Keep changes small and covered by tests. For release-related work, include tarball or production smoke coverage when package contents or generated output changes.

## Pull requests

- Describe the user-visible behavior change.
- Include exact validation commands and results.
- Do not include generated secrets or local absolute paths.
- Do not publish packages from a PR branch.

## Release verification checklist

Release candidates must be checked from a clean tree before any publish attempt:

```sh
pnpm install --frozen-lockfile
pnpm assert:release-private
pnpm lint
pnpm build
pnpm test
pnpm audit
pnpm verify:publish
VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs
```

`pnpm verify:publish` packs the public workspaces, installs the tarballs into a temporary project, verifies all installed CLI bins (`vura`, `thenjs`, `create-then`, and the legacy `then` alias) by executing their installed bin targets directly, checks ESM imports, and dry-runs `create-then` scaffolding. Do not replace this with `npx then ...`; `then` is a shell reserved word, and release checks must avoid shell-dependent command resolution.
