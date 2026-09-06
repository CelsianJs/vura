# Releasing Vura

Releases are tag-driven (`v*`) through `.depot/workflows/release.yml`
(verify matrix → publish → registry smoke). The manual GitHub fallback is
`.github/workflows/release.yml`, dispatched against the release tag; only that
GitHub-hosted publisher explicitly enables npm provenance. Do not claim
provenance for a Depot publish, or run both publishers concurrently. Use the
configured `NPM_TOKEN` secret and verify its publish authority through the
release tooling rather than assuming a token type or expiry policy.

> **Token hygiene:** rotate the npm token if it has ever appeared in a
> chat transcript, browser session, or screenshot — even in a private
> context. A leaked publish token can authorize malicious new releases or
> other package changes within its permissions. Never print token values in
> release evidence, commands, or screenshots.

## Release evidence and acceptance

Agents own reproducible verification and may check its boxes in the release PR
after inspecting the evidence. Humans are not asked to open CI pages, rerun
commands, check links, or certify factual claims an agent can verify.

Copy the unchecked template below into each release PR. Record the verified
commit, evidence links, limitations, and verifier; an old checked list is not
evidence for a new release. Missing evidence stays an **agent-owned open item**,
not a human approval request. Neither agents nor humans may check an item that
has not actually passed.

A tag may be pushed only after the pre-release evidence and any applicable
human-only acceptance items are complete. Publication is a separate final step;
do not check its box before publication succeeds. This policy does not grant
credentials, waive security findings, or authorize unrelated production changes.

### Agent-owned pre-release evidence

- [ ] `CI / verify (20)` and `CI / verify (22)` — lint, build, test,
      verify-publish, audit (matrix: Node 20 + 22)
- [ ] `CI / selfhost-audit` — assertions A0–A12 (no-platform-gating)
- [ ] `Self-host guides / scaffold` + all six target jobs:
      `Self-host guides / node-vps`,
      `Self-host guides / docker`,
      `Self-host guides / fly`,
      `Self-host guides / railway`,
      `Self-host guides / cloudflare`,
      `Self-host guides / lambda`
- [ ] `Docs site / build` — docs build + link check + version badge matches;
      record exclusions rather than claiming untested external links passed
- [ ] `/smoke-audit` pass on the release candidate (scaffold from the packed
      tarballs, follow the docs as a new user, browser-check the docs site);
      report attached to the release PR, zero CRITICAL/HIGH findings open
- [ ] `CLAIMS.md` factually reviewed against the built docs and executable
      evidence; dated agent sign-off updated for this version with limitations
- [ ] vura.io deploy is live and serving the release version in the nav badge;
      verify the live response, not a cached search result
- [ ] Every package README's docs links resolve; check response status and
      destination content, and record missing anchors or misleading destinations
- [ ] `pnpm release:check` passes on a clean tree (will error if already
      published — that is the correct behavior; bump before tagging)
- [ ] `pnpm package:size` — no package over its limit in
      `scripts/package-size-limits.json`
- [ ] `CHANGELOG.md` entry matches the changes, dependencies, limitations, and
      upgrade requirements; agents verify this against source and tests

### Human-only acceptance — only where human judgment is needed

List concrete URLs, scenarios, and the decision needed, not a generic
"verify features work" gate. Agents still perform browser interaction, functional,
accessibility, and regression tests that they can execute. Human review covers
subjective visual/product fit, business acceptance of disclosed limitations, or
real-world scenarios requiring a person's unavailable access, hardware, or context.
If no such item applies, record that rationale instead of inventing a human gate.

- [ ] Applicable visual/product acceptance: describe the exact judgment here,
      or record why no human-only acceptance is needed for this release

Never check a human-only acceptance item on someone's behalf. A failed or missing
automated test is not a reason to transfer verification to the user.

### Agent-owned publication — after pre-release acceptance

- [ ] Tag `vX.Y.Z`, push, watch `release.yml`, and confirm
      `pnpm verify:registry` succeeds against all published packages;
      attach the workflow and registry evidence before checking this box

If the publish job uploaded all packages but the post-publish registry smoke
fails during npm propagation, do **not** rerun the publisher, move the tag, or
try to overwrite immutable npm packages. Wait for registry propagation, then
run the verification-only recovery workflow against the already-published
version:

```bash
depot ci dispatch --repo CelsianJs/vura --workflow verify-registry.yml --ref main --input version=X.Y.Z
# GitHub-hosted verification-only fallback:
gh workflow run verify-registry.yml --repo CelsianJs/vura --ref main -f version=X.Y.Z
```

The recovery workflow performs only registry consumer verification; it has
`contents: read`, no npm credentials, and no publish step.
Use a reviewed checker ref containing the workflow; older immutable release tags
may predate it. The version input pins the packages being tested independently
of the checker ref. Record both refs in the release evidence.

When the release commit changes, rerun affected checks and CI on the final commit.
Any reused evidence must identify its original commit and explain why the tested
inputs are unchanged. No silent carry-forward of checks from an older candidate.

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
