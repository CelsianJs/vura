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
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm release:check
```

If your local Corepack/global pnpm is not the pinned release toolchain, use Node 22 plus pnpm 10.11.0 directly:

```sh
npx -p node@22 -p pnpm@10.11.0 pnpm install --frozen-lockfile
npx -p node@22 -p pnpm@10.11.0 pnpm release:check
```

`pnpm release:check` is the required manual pre-release gate. It includes the local tarball smoke, tracked package-size limits, and npm dry-run publish, but it does not perform a real publish. Only run a non-dry-run `node scripts/publish-packages.mjs` after the `@celsian` npm scope authority blocker is resolved and the full gate has just passed.

`pnpm verify:publish` packs the public workspaces, installs the tarballs into a temporary project, verifies all installed CLI bins (`vura` and `create-vura`) by executing their installed bin targets directly, checks ESM imports, and dry-runs `create-vura` scaffolding.
