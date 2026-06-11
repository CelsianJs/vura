# Releasing Vura

Releases are tag-driven (`v*`) through `.github/workflows/release.yml`
(verify matrix → publish with provenance). Use a classic npm Automation token
in the `NPM_TOKEN` secret (expiring tokens have killed publishes before).

> **Token hygiene:** rotate the npm token if it has ever appeared in a
> chat transcript, browser session, or screenshot — even in a private
> context. A rotated token takes ~30 seconds on npmjs.com; a leaked token
> can be used to overwrite or unpublish releases.

## The v0.5 "hosting-ready" gate

A release tag may not be pushed until every box is checked, by a human,
in the release PR description:

### CI — all green on the release commit

- [ ] `CI / verify (20)` and `CI / verify (22)` — lint, build, test,
      verify-publish, audit (matrix: Node 20 + 22)
- [ ] `CI / selfhost-audit` — assertions A0–A9 (no-platform-gating)
- [ ] `Self-host guides / scaffold` + all five target jobs:
      `Self-host guides / node-vps`,
      `Self-host guides / docker`,
      `Self-host guides / fly`,
      `Self-host guides / cloudflare`,
      `Self-host guides / lambda`
- [ ] `Docs site / build` — docs build + 0 broken links + version badge matches

### Audits

- [ ] `/smoke-audit` pass on the release candidate (scaffold from the packed
      tarballs, follow the docs as a new user, browser-check the docs site);
      report attached to the release PR, zero CRITICAL/HIGH findings open
- [ ] CLAIMS.md signed off against the built docs site (dated sign-off line
      updated for this version)

### Docs

- [ ] vura.io deploy is live and serving the release version in the nav badge
      (build-time version stamp — verify with:
      `curl -s https://vura.io/ | grep -o 'v[0-9.]*' | head -1`)
- [ ] Every package README's docs links resolve (linkinator against vura.io)

### Versioning & publish

- [ ] `pnpm release:check` passes (note: will error if the version is already
      published — that is the correct behavior; bump before tagging)
- [ ] `pnpm package:size` — no package over its limit in
      `scripts/package-size-limits.json`
- [ ] CHANGELOG.md entry for the version
- [ ] Tag `vX.Y.Z`, push, watch `release.yml`, then run
      `pnpm verify:registry` against the published packages

If any box cannot be checked, the release waits. No exceptions for "docs-only"
or "it's just the badge" — those are exactly the drift this gate exists to stop.

---

## Docs site — vura.io

The framework docs live in `docs-site/` and deploy to **vura.io** via the
Vercel project `zvn-dev/vura`. The root `vercel.json` governs the build:

```json
{
  "buildCommand": "npm --prefix docs-site install && npm --prefix docs-site run build",
  "outputDirectory": "docs-site/dist",
  "trailingSlash": true
}
```

The `Docs site` CI workflow (`.github/workflows/docs-site.yml`) runs on every
PR and push that touches `docs-site/**` or `packages/core/package.json`. It
builds the site, checks for broken links (skipping external GitHub URLs whose
target paths only exist post-merge), and asserts that the version badge in
`dist/index.html` matches `packages/core/package.json`.

Preview deployments fire automatically on every PR via the Vercel GitHub
integration — the "Vercel" check in each PR links to the preview URL.

For more detail see `docs-site/DEPLOY.md`.
