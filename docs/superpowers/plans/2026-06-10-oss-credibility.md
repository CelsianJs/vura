# Vura v0.5 — OSS Credibility Package Implementation Plan (Workstream A3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**

Ship the trust floor that makes Vura "hosting-ready": a vura.dev docs site whose spine is the 7-rung DX ladder, six CI-tested self-host guides, a published forever-MIT license commitment, an automated proof that no primitive is platform-gated, an honest-claims audit with a signed-off checklist, real package READMEs for all `@celsian/vura-*` packages, and a RELEASING.md release gate. This is the v0.5 "hosting-ready" gate from the master plan — the prerequisite for the public push ("the framework for apps that outgrow serverless").

**Architecture**

The docs site lives at `vura/docs-site/` and reuses the whatfw.com SSG pattern verbatim: a single `build.mjs` that renders shared chrome through `what-framework/server`'s `renderToString`, reads the version from the monorepo source of truth at build time, and emits `dist/<clean-route>/index.html` for Vercel static hosting. Page content is authored as markdown in `docs-site/pages/`, compiled to HTML at build time, and wrapped in What chrome. Self-host guides are executable: each guide's commands are mirrored 1:1 by a CI job in `.github/workflows/selfhost.yml` that scaffolds with `create-vura`, builds, boots the artifact (or local emulator for cloud targets), and smoke-tests it. The no-platform-gating audit is a Vitest suite (`tests/self-host-audit/`) that boots a scrubbed-env production build and asserts every rung's primitive works with zero `VURA_*` platform variables.

**Tech Stack**

- Docs site: `what-framework@^0.11` (SSG via `renderToString`), `marked` (md→HTML), `esbuild` (interactive demo bundles), Vercel static hosting at vura.dev
- Self-host CI: GitHub Actions (`depot-ubuntu-latest` to match existing workflows), Docker, `superfly/flyctl-actions/setup-flyctl`, `wrangler@^4` (already a root devDep), AWS SAM CLI (`aws-actions/setup-sam`)
- Audit suite: Vitest 3 (already the repo test runner), `ws` client for websocket assertions, Node `http` sinkhole proxy for the no-phone-home assertion
- Repo tooling: pnpm 10.11.0, Node 20/22 matrix (existing constraints: `engines.node >=20 <23`)

**Master plan:** WhatStack/VURA-MASTER-PLAN-2026-06-10.md §4 A3

**Depends on:** Workstream A1+A2 plan completing (vura 0.4 APIs). All docs in this plan document the **post-rebase** APIs: `revalidateTag`/`revalidatePath` re-exported from `@celsian/vura-core` (backed by what-isr), `src/api/*` running on a CelsianApp, `export const kind = 'hot'` with websocket `upgrade` support, `kind = 'task'` with `schedule` and `vura tasks run <name>`, and `vura build` emitting the Dockerfile/fly.toml hot recipe. **Do not start Tasks 3–8 until A1+A2 is merged and vura 0.4 is tagged** — Tasks 1, 2, 9, and 10 have no API dependency and can start immediately.

---

## File Structure

Every file created (C) or modified (M):

```
vura/
  LICENSE                                      (M) verify MIT text; update copyright line to "Vura contributors" (already MIT — verify only)
  GOVERNANCE.md                                (C) license commitment, decision-making, no-relicense pledge
  RELEASING.md                                 (C) v0.5 release gate checklist
  README.md                                    (M) wedge positioning, license-commitment section, honest-claims fixes, remove stale "ThenJS distribution" framing
  CLAIMS.md                                    (C) honest-claims checklist: every marketing claim + how it is verified
  .github/workflows/selfhost.yml               (C) 6 CI jobs, one per self-host target
  .github/workflows/docs-site.yml              (C) build docs-site on PR; link-check; deploy preview artifact
  tests/self-host-audit/no-platform-gating.test.ts  (C) the platform-gating audit suite
  tests/self-host-audit/helpers.ts             (C) scaffold/build/boot/sinkhole helpers for the audit suite
  docs-site/build.mjs                          (C) SSG build — port of what-fw/docs-site/build.mjs pattern
  docs-site/package.json                       (C) build/preview scripts, what-framework + marked deps
  docs-site/vercel.json                        (C) static deploy config (dist/, trailingSlash)
  docs-site/styles.css                         (C) design system (adapted from sites/landing palette)
  docs-site/theme.js                           (C) dark/light toggle (port from what-fw docs-site)
  docs-site/pages/index.html                   (C) landing page (the wedge) — full content in Task 3
  docs-site/pages/ladder/0-create.md           (C) rung 0: npm create vura@latest
  docs-site/pages/ladder/1-static.md           (C) rung 1: static page
  docs-site/pages/ladder/2-cache.md            (C) rung 2: server mode + revalidateTag
  docs-site/pages/ladder/3-api.md              (C) rung 3: API route
  docs-site/pages/ladder/4-hot.md              (C) rung 4: hot routes (the wedge) — full content in Task 5
  docs-site/pages/ladder/5-tasks.md            (C) rung 5: task routes + schedule
  docs-site/pages/ladder/6-deploy.md           (C) rung 6: deploy (platform or self-host)
  docs-site/pages/reference/config.md          (C) vura.config.* reference
  docs-site/pages/reference/route-kinds.md     (C) serverless | hot | task reference
  docs-site/pages/reference/page-modes.md      (C) static | client | hybrid | server reference
  docs-site/pages/reference/cli.md             (C) vura dev/build/tasks/deploy reference
  docs-site/pages/reference/adapters.md        (C) Node / Lambda / Cloudflare / Vura adapters
  docs-site/pages/self-host/index.md           (C) self-host overview + "CI-tested" badge explanation
  docs-site/pages/self-host/node-vps.md        (C) guide: bare Node / VPS
  docs-site/pages/self-host/docker.md          (C) guide: Docker
  docs-site/pages/self-host/fly.md             (C) guide: Fly.io
  docs-site/pages/self-host/railway.md         (C) guide: Railway
  docs-site/pages/self-host/cloudflare.md      (C) guide: Cloudflare Workers
  docs-site/pages/self-host/lambda.md          (C) guide: AWS Lambda
  sites/landing/index.html                     (M) replace with redirect to docs-site landing (vura.dev root takes over)
  packages/core/README.md                      (M) stub → standard (full content in Task 9)
  packages/cli/README.md                       (M) stub → standard
  packages/create-vura/README.md               (M) stub → standard
  packages/adapter-lambda/README.md            (M) stub → standard
  packages/adapter-cloudflare/README.md        (M) stub → standard
  packages/adapter-vura/README.md              (M) stub → standard
  packages/vite-plugin/README.md               (M) stub → standard
  packages/compiler/README.md                  (M) stub → standard
  packages/compiler-native/README.md           (M) stub → standard (keep "unpublished prototype" honesty)
  package.json                                 (M) add `test:selfhost-audit` and `docs:build` scripts
```

**Stated abbreviation (the one permitted):** this plan includes the landing page and the rung-4 ladder page **verbatim**; the remaining six ladder pages and the reference/self-host overview pages are given as structured outlines with their required code examples specified exactly. All other content in this plan (workflows, tests, governance docs, READMEs, checklists) is full and real — no placeholders.

---

## Task 1 — License commitment: LICENSE verify + GOVERNANCE.md + README section

**Files:** `vura/LICENSE` (verify), `vura/GOVERNANCE.md` (create), `vura/README.md` (modify)

Current state (verified during planning): `vura/LICENSE` exists, is MIT, "Copyright (c) 2026 Vura contributors", root `package.json` has `"license": "MIT"`. The gap is the *commitment* — nothing states it is permanent, and the wedge audience (people burned by platform relicensing) needs that stated in three visible places.

- [ ] Verify the LICENSE is the standard MIT text: `head -3 LICENSE` must print `MIT License` / blank / `Copyright (c) 2026 Vura contributors`. Verify every `packages/*/package.json` declares `"license": "MIT"`: run `grep -L '"license": "MIT"' packages/*/package.json` — expected output: empty (no files missing it). If any package lacks it, add the field.
- [ ] Create `GOVERNANCE.md` with exactly this content:

```markdown
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
   `VURA_*` platform environment variable. This is enforced by an automated
   test suite (`tests/self-host-audit/`) that runs in CI on every commit.
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
```

- [ ] Add this section to `README.md` directly after the first paragraph (before `## Install`):

```markdown
## License: MIT, forever

Vura is MIT-licensed and will stay MIT-licensed — no relicensing, ever, and no
framework feature will ever be gated behind the managed platform. Everything
(websockets, cache revalidation, tasks, cron) works fully self-hosted. This
commitment is written down in [GOVERNANCE.md](./GOVERNANCE.md) and enforced by
a CI test suite that runs every primitive with zero platform credentials.
```

- [ ] Run `pnpm lint` (the hygiene check) — expected: exit 0.
- [ ] Commit: `git add LICENSE GOVERNANCE.md README.md packages/*/package.json && git commit -m "docs: publish MIT-forever license commitment (GOVERNANCE.md + README)"`

---

## Task 2 — Docs site scaffold (`docs-site/`, whatfw.com SSG pattern)

**Files:** `docs-site/build.mjs`, `docs-site/package.json`, `docs-site/vercel.json`, `docs-site/styles.css`, `docs-site/theme.js`, root `package.json` (add `docs:build` script)

Reference implementation: `/Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/what-fw/docs-site/build.mjs` — chrome rendered through `renderToString` from `what-framework/server`, build-time version stamping (its audit lesson #5: version badge can never drift), output `dist/<clean-route>/index.html`, no `.html` in URLs. Reuse the structure; change: page sources are markdown compiled with `marked` rather than preserved HTML (vura's docs are net-new, there is no legacy HTML to preserve).

- [ ] Create `docs-site/package.json`:

```json
{
  "name": "vura-docs-site",
  "private": true,
  "type": "module",
  "description": "vura.dev — built with What Framework (SSG via renderToString)",
  "scripts": {
    "build": "node build.mjs",
    "preview": "node build.mjs && npx --yes serve dist -l 4179"
  },
  "dependencies": {
    "what-framework": "^0.11.1",
    "marked": "^15.0.0"
  },
  "devDependencies": {
    "esbuild": "^0.27.3"
  }
}
```

- [ ] Create `docs-site/build.mjs`. Core structure (full file is ~250 lines following the what-fw precedent; the load-bearing parts):

```js
// vura.dev static build — rendered through What Framework (renderToString).
// Pages are authored as markdown in pages/; chrome (head/nav/sidebar/footer)
// is What components. Output: dist/<clean-route>/index.html.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'what-framework/server';
import { h } from 'what-framework';
import { marked } from 'marked';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

// Version from the monorepo source of truth at BUILD time (whatfw.com audit
// lesson: the nav badge must never drift from the released package).
function readVersion() {
  for (const p of [
    join(ROOT, '..', 'packages', 'core', 'package.json'),
    join(ROOT, 'node_modules', '@celsian', 'vura-core', 'package.json'),
  ]) {
    try { const { version } = JSON.parse(readFileSync(p, 'utf8')); if (version) return version; }
    catch { /* try next */ }
  }
  throw new Error('docs-site build: could not resolve @celsian/vura-core version');
}
const VERSION = readVersion();

const LADDER = [
  ['/ladder/0-create',  '0 · Create an app'],
  ['/ladder/1-static',  '1 · Static page'],
  ['/ladder/2-cache',   '2 · Server + cache'],
  ['/ladder/3-api',     '3 · API route'],
  ['/ladder/4-hot',     '4 · Hot route'],
  ['/ladder/5-tasks',   '5 · Background task'],
  ['/ladder/6-deploy',  '6 · Deploy'],
];
const REFERENCE = [
  ['/reference/config', 'vura.config'], ['/reference/route-kinds', 'Route kinds'],
  ['/reference/page-modes', 'Page modes'], ['/reference/cli', 'CLI'],
  ['/reference/adapters', 'Adapters'],
];
const SELF_HOST = [
  ['/self-host', 'Overview'], ['/self-host/node-vps', 'Node / VPS'],
  ['/self-host/docker', 'Docker'], ['/self-host/fly', 'Fly.io'],
  ['/self-host/railway', 'Railway'], ['/self-host/cloudflare', 'Cloudflare Workers'],
  ['/self-host/lambda', 'AWS Lambda'],
];
// ... Chrome(props) What component: nav with `Vura v${VERSION}` badge,
// sidebar from the three lists above, footer with the MIT-forever line.
// renderPage(route, bodyHtml, { title, description }) →
//   writeFileSync(join(DIST, route, 'index.html'), renderToString(h(Chrome, ...)))
// Walk pages/**/*.md → marked.parse → renderPage; pages/index.html is the
// landing page and is wrapped in landing chrome (nav + footer only).
```

- [ ] Create `docs-site/vercel.json`:

```json
{ "buildCommand": "npm run build", "outputDirectory": "dist", "trailingSlash": true }
```

- [ ] Create `docs-site/styles.css` by porting the design tokens already in `vura/sites/landing/index.html` (`--bg-deep: #111110`, `--accent: #3ecf8e`, `--accent-orange: #ee5d34`, Inter + JetBrains Mono) into the what-fw docs-site layout classes (nav, sidebar, `.content`, code blocks, theme toggle). Port `theme.js` from `what-fw/docs-site/theme.js` unchanged.
- [ ] Add to root `vura/package.json` scripts: `"docs:build": "npm --prefix docs-site run build"`.
- [ ] Create a placeholder-free smoke: with only Task 3's landing page present, run `node docs-site/build.mjs` — expected output ends with a line like `built 1 page → dist/` and `dist/index.html` exists containing `v0.` (the version badge).
- [ ] Commit: `git commit -m "docs-site: scaffold vura.dev SSG (whatfw.com pattern, renderToString + build-time version)"`

---

## Task 3 — Landing page (the wedge), full content

**Files:** `docs-site/pages/index.html`

This is the body fragment consumed by `build.mjs` (landing chrome adds nav/footer/styles). **Full content, verbatim** — this is the wedge messaging from master plan §1, with the license commitment visible per Task 1's requirement:

```html
<section class="hero">
  <h1>The framework for apps that outgrow serverless.</h1>
  <p class="hero-sub">
    Static pages, cached server rendering, typed API routes — and the moment you
    need websockets, in-memory state, or a 40-second job, it's a one-line change.
    Not a migration.
  </p>
  <div class="hero-cta">
    <code class="install-cmd">npm create vura@latest</code>
    <a class="btn-secondary" href="/ladder/0-create/">Start the ladder →</a>
  </div>
</section>

<section class="the-line">
  <h2>The one-line change</h2>
  <p>
    Every other stack has a cliff: the day your app needs a persistent
    connection, the answer is "go glue a second platform onto your frontend."
    Vura's answer is an export.
  </p>
  <div class="code-compare">
    <div>
      <span class="code-label">Serverless API route (default)</span>
      <pre><code>// src/api/orders.ts
export async function POST(req, reply) {
  const order = await createOrder(req.parsedBody);
  return reply.json(order);
}</code></pre>
    </div>
    <div>
      <span class="code-label">Same project. Now it's a websocket server.</span>
      <pre><code>// src/api/live/room.ts
export const kind = 'hot';   // ← the line

const clients = new Set();
export function ws(socket) {
  clients.add(socket);
  socket.on('message', (m) => {
    for (const c of clients) c.send(m);
  });
  socket.on('close', () => clients.delete(socket));
}</code></pre>
    </div>
  </div>
  <p>
    Same types, same router, same <code>vura dev</code>, same deploy. Hot routes
    run as persistent processes — websockets, presence, streaming AI agent loops,
    long jobs — next to your static pages and serverless functions.
    <a href="/ladder/4-hot/">Read rung 4 →</a>
  </p>
</section>

<section class="ladder-strip">
  <h2>One project. Seven rungs. No eject cliff.</h2>
  <p>You climb by adding a line, never by adopting a new tool.</p>
  <ol class="ladder">
    <li><a href="/ladder/0-create/"><strong>Create</strong> — <code>npm create vura@latest</code>, a running app</a></li>
    <li><a href="/ladder/1-static/"><strong>Static page</strong> — <code>page = { mode: 'static' }</code>, zero JS shipped</a></li>
    <li><a href="/ladder/2-cache/"><strong>Server + cache</strong> — <code>mode: 'server', revalidate: { tags: ['posts'] }</code>, then <code>revalidateTag('posts')</code> for an instant global purge</a></li>
    <li><a href="/ladder/3-api/"><strong>API route</strong> — drop a handler in <code>src/api/</code>, serverless by default, typed client call</a></li>
    <li><a href="/ladder/4-hot/"><strong>Hot route</strong> — <code>export const kind = 'hot'</code>: websockets, state, no timeout</a></li>
    <li><a href="/ladder/5-tasks/"><strong>Task</strong> — <code>kind = 'task', schedule: '0 3 * * *'</code>: off the request path, retried</a></li>
    <li><a href="/ladder/6-deploy/"><strong>Deploy</strong> — <code>vura deploy</code> (platform) or <code>vura build</code> + a recipe (self-host)</a></li>
  </ol>
</section>

<section class="pillars">
  <div class="pillar">
    <h3>Built on shipped engines</h3>
    <p>Pages render through <a href="https://whatfw.com">What Framework</a>
    (SSR/ISR, islands, react-compat). APIs run on
    <a href="https://github.com/zvndev/celsian">CelsianJS</a> (validation,
    hooks, RPC, rate limiting, cron, 8 runtime adapters). Vura is the
    orchestration: route kinds, one manifest, one build, one dev server.</p>
  </div>
  <div class="pillar">
    <h3>Self-hosting is first-class</h3>
    <p>Six self-host guides — Node/VPS, Docker, Fly.io, Railway, Cloudflare
    Workers, AWS Lambda — and every guide's steps are executed in CI on every
    commit. If a guide breaks, the build is red.
    <a href="/self-host/">Self-host guides →</a></p>
  </div>
  <div class="pillar">
    <h3>Nothing is platform-gated</h3>
    <p>Cache revalidation, websockets, tasks, and cron all run in a plain
    self-hosted Node build with zero platform credentials — verified by an
    automated audit suite in CI. The managed platform saves you effort;
    it never withholds capability.</p>
  </div>
</section>

<section class="license-commitment">
  <h2>License: MIT, forever</h2>
  <p>
    Every Vura package is MIT and will stay MIT — no relicensing, no BSL, no
    "open core" capability fence, ever. The commitment is published in
    <a href="https://github.com/zvndev/vura/blob/main/GOVERNANCE.md">GOVERNANCE.md</a>
    and the no-gating promise is enforced by CI. You can always fork everything.
  </p>
</section>

<section class="closing-cta">
  <code class="install-cmd">npm create vura@latest</code>
  <p><a href="/ladder/0-create/">Rung 0: your first app →</a></p>
</section>
```

- [ ] Create `docs-site/pages/index.html` with the content above; head metadata in `build.mjs` for this route: title `Vura — The framework for apps that outgrow serverless`, description `Static pages, cached SSR, typed APIs, websockets, and background tasks in one project. Self-host anywhere or deploy in one command. MIT, forever.`, canonical `https://vura.dev/`.
- [ ] Build and verify: `node docs-site/build.mjs && grep -c "outgrow serverless" docs-site/dist/index.html` — expected: `2` (h1 + meta description).
- [ ] Verify the hot-route code sample on the landing page **compiles against vura 0.4**: copy it into a scratch scaffold's `src/api/live/room.ts` and run `vura build` — expected exit 0. (Landing code samples are claims; this is the honest-claims rule applied at authoring time.)
- [ ] Commit: `git commit -m "docs-site: landing page — the wedge, the ladder, the license commitment"`

---

## Task 4 — Ladder pages, rungs 0–3 and 5–6 (structured outlines + exact code examples)

**Files:** `docs-site/pages/ladder/0-create.md`, `1-static.md`, `2-cache.md`, `3-api.md`, `5-tasks.md`, `6-deploy.md`

Per the stated abbreviation: these six pages are specified as outlines with their code examples given exactly; rung 4 (Task 5) is verbatim. Shared requirements for **every** ladder page: opens with one sentence stating the user need (from the master-plan ladder table), contains one complete runnable example (verified against a real scaffold before commit — see the last step), ends with a "Next rung →" link, and never references the platform except rung 6.

- [ ] Write `0-create.md` — *"You need a working app."*
  - Sections: Prerequisites (Node 20–22) → Create (`npm create vura@latest my-app`, with expected terminal output excerpt showing the scaffold file tree) → What you got (annotated tree: `src/pages/index.tsx`, `src/api/hello.ts`, `vura.config.ts`) → Run it (`npm run dev`, expected: `vura dev → http://localhost:3000`) → Next.
  - Required code example: the full scaffolded `src/pages/index.tsx` and `src/api/hello.ts` exactly as create-vura@0.4 emits them (copy from `packages/create-vura/src` templates at implementation time — do not invent).
- [ ] Write `1-static.md` — *"You need a marketing page."*
  - Sections: The default is static → The example → What `vura build` emits (`dist/static/about/index.html`, zero framework JS — show actual `ls dist/static/about` output) → When to leave static (link rung 2).
  - Required code example:
    ```tsx
    // src/pages/about.tsx
    export const page = { mode: 'static' };
    export default function About() {
      return (
        <main>
          <h1>About us</h1>
          <p>This page is prerendered at build time. No JavaScript is shipped.</p>
        </main>
      );
    }
    ```
- [ ] Write `2-cache.md` — *"You need fresh content without rebuilding."*
  - Sections: Server mode → Tag the page → Purge on mutation → How it works (what-isr stores: memory/filesystem/Redis; CDN purge via Cloudflare cache-tags) → Verify it locally (curl the page twice, mutate, curl again — exact commands with expected before/after timestamps).
  - Required code example (two files, shown together — this is the Capa-pattern retention hook):
    ```tsx
    // src/pages/posts.tsx
    export const page = {
      mode: 'server',
      revalidate: { tags: ['posts'] },
    };
    export default async function Posts() {
      const posts = await db.posts.list();
      return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
    }
    ```
    ```ts
    // src/api/posts.ts
    import { revalidateTag } from '@celsian/vura-core';
    export async function POST(req, reply) {
      const post = await db.posts.create(req.parsedBody);
      await revalidateTag('posts'); // every cached copy, purged now
      return reply.json(post);
    }
    ```
- [ ] Write `3-api.md` — *"You need a backend endpoint."*
  - Sections: Drop in a handler → It's serverless by default → Validation and typed client calls (celsian-backed: schema validation on the handler, calling it from a page with end-to-end types) → Where it runs per adapter.
  - Required code example: `src/api/orders.ts` with a celsian validation schema + a page calling it via the typed client (exact API per vura 0.4 — take the signature from the A1 deliverable, not from memory).
- [ ] Write `5-tasks.md` — *"You need background work."*
  - Sections: A task route → Scheduling (cron syntax) → Running one-offs (`vura tasks run encode`, expected output) → Retries and timeouts config → Where tasks run self-hosted (in the Node entry; no external queue required).
  - Required code example:
    ```ts
    // src/api/tasks/encode.ts
    export const kind = 'task';
    export const schedule = '0 3 * * *'; // nightly at 03:00
    export const retries = 3;
    export default async function encode() {
      const pending = await db.videos.pending();
      for (const v of pending) await transcode(v);
    }
    ```
- [ ] Write `6-deploy.md` — *"You need production."*
  - Sections: Two doors, stated honestly → Self-host (`vura build` → links to all six guides, with the Node three-liner inline: `pnpm build && PORT=3000 NODE_ENV=production node dist/server/entry.js`) → Vura Platform (`vura deploy` — one paragraph; note that in the OSS CLI today this requires platform access and fails closed otherwise, matching current README behavior) → What hot routes need (a persistent host: VPS/Docker/Fly — not Workers/Lambda; table of route-kind × target support).
- [ ] Verification gate for the whole task: scaffold `npx create-vura ladder-check --no-install` in a temp dir, paste each page's code example into it, `pnpm install && pnpm build` — expected exit 0 and `dist/server/entry.js` exists. Every example on these pages must have passed this before commit.
- [ ] Build the site: `node docs-site/build.mjs` — expected: 8 pages built (landing + 7 ladder; rung 4 placeholder allowed until Task 5).
- [ ] Commit: `git commit -m "docs-site: ladder rungs 0-3, 5-6 with build-verified examples"`

---

## Task 5 — Ladder rung 4: hot routes (the wedge page), full content

**Files:** `docs-site/pages/ladder/4-hot.md`

Full verbatim content of the page:

```markdown
# Rung 4 — Hot routes: websockets, state, and no timeout

You need a websocket. Or presence. Or an AI agent loop that streams for four
minutes. Or a 40-second export job a user is waiting on. This is the moment
every serverless platform fails you — and the moment Vura was built for.

## The problem this rung solves

Serverless functions are stateless and time-boxed. The day your app needs a
persistent connection or in-memory state, the conventional answer is: keep
your frontend where it is, stand up a second app on a second platform for the
"real-time part," and glue them together — two deploys, two log streams, two
type boundaries, one new failure mode.

Vura's answer is one line, in the project you already have:

​```ts
export const kind = 'hot';
​```

## A complete hot route

​```ts
// src/api/live/room.ts
export const kind = 'hot';

type Client = { socket: WebSocket; name: string };
const rooms = new Map<string, Set<Client>>();

// ws() receives upgraded websocket connections for this route.
export function ws(socket: WebSocket, req: VuraRequest) {
  const roomId = req.params.room ?? 'lobby';
  const client: Client = { socket, name: req.query.name ?? 'anon' };

  const room = rooms.get(roomId) ?? new Set();
  room.add(client);
  rooms.set(roomId, room);

  broadcast(room, { type: 'join', name: client.name, count: room.size });

  socket.on('message', (data) => {
    broadcast(room, { type: 'message', name: client.name, body: String(data) });
  });

  socket.on('close', () => {
    room.delete(client);
    broadcast(room, { type: 'leave', name: client.name, count: room.size });
  });
}

// Plain HTTP methods still work on the same route.
export function GET(req, reply) {
  return reply.json({
    rooms: [...rooms.entries()].map(([id, c]) => ({ id, clients: c.size })),
  });
}

function broadcast(room: Set<Client>, msg: object) {
  const data = JSON.stringify(msg);
  for (const c of room) c.socket.send(data);
}
​```

Note what did *not* change: the file lives in `src/api/` next to your
serverless routes, the route path comes from the file path, types flow to the
client the same way, and `vura dev` serves it on the same port.

## What `kind: 'hot'` actually means

| | Serverless route (default) | Hot route |
|---|---|---|
| Process | per-invocation, disposable | persistent, long-lived |
| In-memory state | lost between requests | lives as long as the process |
| WebSockets | not possible | first-class (`export function ws()`) |
| Execution time | platform-limited (seconds) | unlimited |
| Scaling model | per-request | per-process (vertical first) |
| Cost at idle | zero | one small always-on process |

Hot routes are real processes. State in module scope (like `rooms` above) is
shared across all connections to that process — which is exactly what you want
for presence, rooms, and live caches, and exactly what you must not assume
once you run more than one instance. Start with one instance; when you need
more, partition by room/tenant at the load balancer.

## Talking to a hot route from a page

​```tsx
// src/pages/chat.tsx
export const page = { mode: 'client' };

export default function Chat() {
  const messages = useSignal<string[]>([]);

  onMount(() => {
    const ws = new WebSocket(`wss://${location.host}/api/live/room?name=kirby`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'message') messages.value = [...messages.value, `${msg.name}: ${msg.body}`];
    };
    return () => ws.close();
  });

  return <ul>{messages.value.map((m, i) => <li key={i}>{m}</li>)}</ul>;
}
​```

## Try it now

​```sh
vura dev
# In one terminal:
npx wscat -c "ws://localhost:3000/api/live/room?name=a"
# In another:
npx wscat -c "ws://localhost:3000/api/live/room?name=b"
# Type in either — both receive {"type":"message",...}
curl -s localhost:3000/api/live/room
# → {"rooms":[{"id":"lobby","clients":2}]}
​```

## Deploying hot routes

`vura build` detects hot routes and emits, alongside the normal output:

- `dist/server/hot-entry.js` — a standalone server for your hot routes
- `Dockerfile` and `fly.toml` — a copy-paste recipe for a persistent host

Hot routes need a persistent host: a VPS, Docker on anything, Fly.io, or
Railway. They cannot run on Cloudflare Workers or AWS Lambda — that is the
structural limitation this rung exists to escape, and Vura will tell you at
build time rather than let you find out in production. See the
[Fly.io guide](/self-host/fly/) for the full path, or
[Node/VPS](/self-host/node-vps/) for the simplest one.

On deploys, hot processes **drain gracefully**: the old process stops
accepting upgrades, open sockets get a configurable drain window, then it
exits. You configure the window in `vura.config`:

​```ts
export default defineConfig({
  hot: { drainTimeoutMs: 30_000 },
});
​```

Everything on this page works fully self-hosted with no platform account —
that's [enforced by CI](/self-host/), not just promised.

## Next

Your app now holds static pages, cached server pages, serverless APIs, and a
websocket server — one project, one type system, one deploy. The last
capability is work that shouldn't block a request at all:
**[Rung 5 — Background tasks →](/ladder/5-tasks/)**
```

- [ ] Create `docs-site/pages/ladder/4-hot.md` with the content above, then **reconcile every API signature against the shipped vura 0.4** (`ws()` export name, `VuraRequest`, `drainTimeoutMs`, hot-entry filename, the `useSignal`/`onMount` page imports): each code block must build/run in a real scaffold. Where 0.4 differs from this draft, **the page changes, not the claim of verification** — update the prose and the landing-page sample (Task 3) to match.
- [ ] Run the "Try it now" block literally against a scaffold and check the outputs match (wscat echo both directions, `curl` shows 2 clients). This page is the wedge; it must be true.
- [ ] Build site; verify `/ladder/4-hot/index.html` renders the comparison table.
- [ ] Commit: `git commit -m "docs-site: rung 4 hot routes — the wedge page, runtime-verified examples"`

---

## Task 6 — Reference and self-host doc pages

**Files:** `docs-site/pages/reference/{config,route-kinds,page-modes,cli,adapters}.md`, `docs-site/pages/self-host/{index,node-vps,docker,fly,railway,cloudflare,lambda}.md`

Reference pages (outlines per the stated abbreviation; content is extracted from vura 0.4 source, never invented):

- [ ] `config.md` — every `vura.config` key with type, default, and one-line effect. Source of truth: the config schema in `packages/core` (post-A1). Table format. Opening line: *"Complete reference for `vura.config.ts`. Defaults shown are what you get with no config file at all."*
- [ ] `route-kinds.md` — `serverless` (default) / `hot` / `task`: lifecycle, exports each kind recognizes (`GET/POST/...`, `ws`, `default`+`schedule`+`retries`), per-adapter support matrix (the same table as rung 6).
- [ ] `page-modes.md` — `static` / `client` / `hybrid` / `server`: what `vura build` emits for each (lifted from the current README's accurate "Page modes and build output" section, updated for 0.4 paths), hydration behavior, when to pick which.
- [ ] `cli.md` — `vura dev`, `vura build`, `vura tasks run <name>`, `vura deploy` (state plainly: requires Vura Platform access, fails closed in OSS — current README wording is honest, keep it), `create-vura` flags including `--no-install`. Each command: synopsis, flags, one expected-output excerpt.
- [ ] `adapters.md` — Node (built-in), `@celsian/vura-adapter-lambda`, `@celsian/vura-adapter-cloudflare`, `@celsian/vura-adapter-vura`: install, config snippet, emitted artifacts, route-kind support, escape hatches (`req.__cf_env`/`req.__cf_ctx` documented as intentionally narrow, per existing README).

Self-host guides — **each guide is the literal script of its CI job** (Task 7). Structure for all six: *What you'll have at the end* → *Steps* (numbered, copy-paste commands) → *Smoke test* (exact curl/wscat with expected output) → *"This guide is CI-tested"* box naming the workflow job and what it does/doesn't verify → *Route-kind support note*.

- [ ] `index.md` — overview: the support matrix (target × route kind), the CI-tested promise (*"Every guide below runs in CI on every commit — the exact commands you'll paste. The job names link to the workflow."*), link to GOVERNANCE.md no-gating commitment.
- [ ] `node-vps.md` — steps: scaffold → `pnpm build` → `PORT=3000 NODE_ENV=production node dist/server/entry.js` → systemd unit file (full, real) → reverse-proxy note (Caddyfile 3-liner with websocket passthrough). Supports all route kinds.
- [ ] `docker.md` — the full Dockerfile (start from `examples/hot-server/Dockerfile`, generalize), `docker build -t my-app . && docker run -p 3000:3000 my-app`, healthcheck instruction. All route kinds.
- [ ] `fly.md` — full `fly.toml` (from `examples/hot-server/fly.toml`), `fly launch --no-deploy && fly deploy`, drain-on-deploy note tying to `drainTimeoutMs`. All route kinds; the recommended hot-route host.
- [ ] `railway.md` — Dockerfile-based deploy (reuses docker.md's Dockerfile), `railway.json` with `"build": { "builder": "DOCKERFILE" }`, PORT env note (Railway injects `PORT`). All route kinds.
- [ ] `cloudflare.md` — `pnpm add @celsian/vura-adapter-cloudflare`, config snippet, full `wrangler.toml`, `wrangler deploy`; **explicit limitation box**: hot routes are not supported on Workers — `vura build` errors with the route name; static/server/api/task(cron-trigger) support stated per the 0.4 adapter reality.
- [ ] `lambda.md` — adapter install, config, full SAM `template.yaml`, `sam build && sam deploy --guided`; same limitation box for hot routes; cold-start honesty note (measured, see Task 9 claims rules).
- [ ] Build site: `node docs-site/build.mjs` — expected: 20 pages. Run a link check: `npx --yes linkinator docs-site/dist --recurse --silent` — expected: 0 broken links.
- [ ] Commit: `git commit -m "docs-site: reference section + six self-host guides (CI-script parity)"`

---

## Task 7 — Self-host CI: every guide executed per commit

**Files:** `.github/workflows/selfhost.yml`

One workflow, six jobs, each mirroring its guide's commands. Shared prelude builds the workspace and packs the local packages so the scaffold tests **today's code**, not npm latest. What each job verifies (and explicitly does not) is stated in the guide's CI box (Task 6).

- [ ] Create `.github/workflows/selfhost.yml`:

```yaml
name: Self-host guides

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  scaffold:
    # Builds the workspace, scaffolds an app with local packages, uploads it
    # as the shared artifact every target job consumes.
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.11.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Scaffold app against local packages
        run: |
          node packages/create-vura/dist/bin.js /tmp/app --no-install
          node scripts/link-local-packages.mjs /tmp/app   # rewrites @celsian/vura-* deps to file: tarballs (pnpm pack)
          cd /tmp/app && npm install && npm run build
      - name: Assert build output shape
        run: |
          test -f /tmp/app/dist/server/entry.js
          test -d /tmp/app/dist/static
      - uses: actions/upload-artifact@v4
        with: { name: scaffold-app, path: /tmp/app, include-hidden-files: true }

  node-vps:
    # Verifies: the node-vps guide verbatim — prod server boots, serves a
    # static page, an API route, and a websocket upgrade on one port.
    needs: scaffold
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: scaffold-app, path: app }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Boot and smoke
        run: |
          cd app
          PORT=3000 NODE_ENV=production node dist/server/entry.js &
          npx --yes wait-on -t 30000 http://localhost:3000
          curl -fsS localhost:3000/ | grep -q '<h1'
          curl -fsS localhost:3000/api/hello | grep -q '"'
          node -e '
            const ws = new (require("ws"))("ws://localhost:3000/api/live/room");
            ws.on("open", () => ws.send("ping"));
            ws.on("message", () => process.exit(0));
            setTimeout(() => { console.error("no ws echo"); process.exit(1); }, 5000);
          '

  docker:
    # Verifies: the docker guide's Dockerfile builds and the container serves
    # the same smoke surface. Also the base image for fly/railway claims.
    needs: scaffold
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/checkout@v4            # for the guide Dockerfile source
      - uses: actions/download-artifact@v4
        with: { name: scaffold-app, path: app }
      - name: Build image from the guide's Dockerfile
        run: |
          node scripts/extract-guide-dockerfile.mjs docs-site/pages/self-host/docker.md > app/Dockerfile
          docker build -t vura-selfhost-test app
      - name: Run and smoke
        run: |
          docker run -d -p 3000:3000 --name app vura-selfhost-test
          npx --yes wait-on -t 30000 http://localhost:3000
          curl -fsS localhost:3000/api/hello
          docker logs app

  fly:
    # Verifies: fly.toml from the guide validates with flyctl, and the exact
    # image Fly would run (the same Dockerfile) boots. Does NOT deploy to Fly —
    # no cloud creds in CI; Fly networking/anycast is out of scope.
    needs: scaffold
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: scaffold-app, path: app }
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - name: Validate guide fly.toml
        run: |
          node scripts/extract-guide-block.mjs docs-site/pages/self-host/fly.md toml > app/fly.toml
          cd app && flyctl config validate --config fly.toml
      - name: Boot the image Fly would run
        run: |
          node scripts/extract-guide-dockerfile.mjs docs-site/pages/self-host/docker.md > app/Dockerfile
          docker build -t vura-fly-test app
          docker run -d -p 8080:3000 vura-fly-test
          npx --yes wait-on -t 30000 http://localhost:8080
          curl -fsS localhost:8080/api/hello

  cloudflare:
    # Verifies: adapter-cloudflare build artifacts are valid and serve under
    # wrangler dev (workerd, local). Does NOT verify Cloudflare's edge.
    needs: scaffold
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: scaffold-app, path: app }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Build with Cloudflare adapter and smoke under workerd
        run: |
          cd app
          node scripts/use-adapter.mjs cloudflare    # flips vura.config to the CF adapter (script shipped in scaffold)
          npm run build
          npx wrangler dev --local --port 8787 &
          npx --yes wait-on -t 60000 http://localhost:8787
          curl -fsS localhost:8787/api/hello
          curl -fsS localhost:8787/ | grep -q '<h1'

  lambda:
    # Verifies: adapter-lambda emits a SAM-valid template and the handler
    # answers under sam local (Docker-backed Lambda emulation). Does NOT
    # verify API Gateway/IAM in real AWS.
    needs: scaffold
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: scaffold-app, path: app }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: aws-actions/setup-sam@v2
        with: { use-installer: true }
      - name: Build with Lambda adapter and smoke under sam local
        run: |
          cd app
          node scripts/use-adapter.mjs lambda
          npm run build
          sam validate --template dist/lambda/template.yaml --lint
          sam local start-api --template dist/lambda/template.yaml --port 3001 &
          npx --yes wait-on -t 120000 http://localhost:3001/api/hello
          curl -fsS localhost:3001/api/hello
```

(Railway has no local emulator; its guide is Dockerfile-based, so the `docker` job **is** its CI coverage — state that in `railway.md`'s CI box and in a YAML comment. Add `scripts/link-local-packages.mjs`, `scripts/extract-guide-dockerfile.mjs`, `scripts/extract-guide-block.mjs`, and the scaffold's `scripts/use-adapter.mjs` as part of this task — the extract scripts pull fenced code blocks out of the guide markdown so **the guide text itself is what CI executes**; guides can't silently drift from CI.)

- [ ] Write the three repo scripts (`link-local-packages.mjs`, `extract-guide-dockerfile.mjs`, `extract-guide-block.mjs`) with unit tests beside them (pattern: `scripts/*.test.mjs`, like the existing `publish-packages.test.mjs`).
- [ ] Add `use-adapter.mjs` to the create-vura template (or, if A2 already added adapter switching to the CLI, call that instead and delete this step — check `packages/cli` first).
- [ ] Confirm the scaffold's default template includes the smoke surface the jobs curl: `/` page, `/api/hello`, and a hot route `/api/live/room`. If the 0.4 template lacks the hot route, add it to the template (it doubles as rung-4 teaching material).
- [ ] Run the workflow on a branch (`git push` + check `gh run watch`) — expected: all 6 jobs green. Iterate until true.
- [ ] Update each guide's "CI-tested" box with the final job name and the verifies/doesn't-verify list exactly as in the YAML comments above.
- [ ] Commit: `git commit -m "ci: selfhost.yml — six guide-parity jobs (node, docker, fly, railway-via-docker, cloudflare workerd, lambda sam-local)"`

---

## Task 8 — No-platform-gated-primitives audit suite

**Files:** `tests/self-host-audit/no-platform-gating.test.ts`, `tests/self-host-audit/helpers.ts`, root `package.json` (script), `.github/workflows/ci.yml` (add step)

The exact assertions, as a real Vitest file. The suite scaffolds, builds, scrubs the environment of every platform variable, routes all outbound HTTP through a local sinkhole proxy, boots the production Node entry, and proves each rung's primitive:

- [ ] Create `tests/self-host-audit/helpers.ts`: `scaffoldAndBuild()` (create-vura + local-pack link + build into a tmpdir, cached per run), `startSinkhole()` (an `http.createServer` acting as HTTP/HTTPS proxy that records every CONNECT/request host and returns 502), `bootServer(env)` (spawns `node dist/server/entry.js` with the given env, waits on the port, returns `{ port, kill, stdout }`).
- [ ] Create `tests/self-host-audit/no-platform-gating.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { scaffoldAndBuild, startSinkhole, bootServer } from './helpers';

// The GOVERNANCE.md promise, executable: every primitive works in a pure
// self-hosted Node build with NO platform credentials and NO network access
// to anything but localhost.

const SCRUBBED_VARS = [
  'VURA_PLATFORM_TOKEN', 'VURA_API_KEY', 'VURA_API_URL', 'VURA_PROJECT_ID',
  'VURA_DEPLOY_TOKEN', 'VURA_TELEMETRY',
]; // plus a dynamic sweep: anything matching /^VURA_/

let app: Awaited<ReturnType<typeof scaffoldAndBuild>>;
let sinkhole: Awaited<ReturnType<typeof startSinkhole>>;
let server: Awaited<ReturnType<typeof bootServer>>;

beforeAll(async () => {
  app = await scaffoldAndBuild();          // create-vura template + rung fixtures below
  sinkhole = await startSinkhole();
  const env: Record<string, string> = {
    NODE_ENV: 'production', PORT: '0',
    HTTP_PROXY: sinkhole.url, HTTPS_PROXY: sinkhole.url, NO_PROXY: '',
  };
  for (const k of Object.keys(process.env)) if (/^VURA_/.test(k)) env[k] = '';
  server = await bootServer(env);
}, 240_000);

afterAll(async () => { await server?.kill(); await sinkhole?.close(); });

describe('boot', () => {
  it('A0: production server boots with zero VURA_* env vars set', async () => {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
  });
});

describe('rung 2 — revalidateTag (what-isr, self-hosted store)', () => {
  it('A1: server page with a tag is cached between requests', async () => {
    const a = await (await fetch(`http://localhost:${server.port}/posts`)).text();
    const b = await (await fetch(`http://localhost:${server.port}/posts`)).text();
    // fixture page embeds a render timestamp; identical body ⇒ cache hit
    expect(b).toBe(a);
  });
  it('A2: revalidateTag() purges the cache — next request re-renders', async () => {
    const before = await (await fetch(`http://localhost:${server.port}/posts`)).text();
    const mut = await fetch(`http://localhost:${server.port}/api/posts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'audit' }),
    });
    expect(mut.status).toBe(200);          // handler calls revalidateTag('posts')
    const after = await (await fetch(`http://localhost:${server.port}/posts`)).text();
    expect(after).not.toBe(before);        // fresh render: new timestamp + new post
    expect(after).toContain('audit');
  });
});

describe('rung 4 — hot routes (websockets + in-memory state)', () => {
  it('A3: websocket upgrade succeeds and echoes within 2s', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/api/live/room?name=audit`);
    const msg = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no echo in 2s')), 2000);
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (d) => { clearTimeout(t); resolve(String(d)); });
      ws.on('error', reject);
    });
    expect(msg).toContain('ping');
    ws.close();
  });
  it('A4: two clients on one hot route share broadcast state', async () => {
    const a = new WebSocket(`ws://localhost:${server.port}/api/live/room?name=a`);
    const b = new WebSocket(`ws://localhost:${server.port}/api/live/room?name=b`);
    await Promise.all([a, b].map((s) => new Promise((r) => s.on('open', r))));
    const received = new Promise<string>((r) => b.on('message', (d) => r(String(d))));
    a.send('cross-client');
    expect(await received).toContain('cross-client');
    a.close(); b.close();
  });
  it('A5: in-memory state persists across sequential HTTP requests', async () => {
    const base = `http://localhost:${server.port}/api/counter`;
    const n0 = (await (await fetch(base)).json()).count;
    await fetch(base, { method: 'POST' });
    await fetch(base, { method: 'POST' });
    const n1 = (await (await fetch(base)).json()).count;
    expect(n1).toBe(n0 + 2);               // same process served all four requests
  });
});

describe('rung 5 — tasks and cron', () => {
  it('A6: `vura tasks run <name>` executes a task to completion, exit 0', () => {
    const out = execFileSync('node', [app.cliBin, 'tasks', 'run', 'encode'], {
      cwd: app.dir, encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    expect(out).toContain('task encode: done'); // fixture task prints this marker
  });
  it('A7: scheduled task is registered in the build manifest with its cron expression', () => {
    const manifest = app.readManifest();        // dist manifest JSON
    const task = manifest.tasks.find((t: any) => t.name === 'encode');
    expect(task).toBeDefined();
    expect(task.schedule).toBe('*/1 * * * *');
  });
  it('A8: cron scheduler fires a due task in the running server', async () => {
    // fixture task `tick` (schedule: every minute) appends to tick.log;
    // server booted with VURA_TEST_CRON_ACCELERATE=1 (test-only clock, 1min→1s)
    await new Promise((r) => setTimeout(r, 3000));
    expect(server.stdout()).toContain('task tick: ran');
  });
});

describe('the no-phone-home guarantee', () => {
  it('A9: zero outbound requests left localhost during this entire suite', () => {
    // Runs last (file order). Every assertion above exercised every primitive;
    // the sinkhole proxy recorded any attempt to reach a non-local host.
    expect(sinkhole.externalHosts()).toEqual([]);
  });
});
```

- [ ] Add the fixture routes the suite needs to the audit scaffold (in `helpers.ts`, written into the tmpdir after scaffolding): `src/pages/posts.tsx` + `src/api/posts.ts` (rung-2 pair from Task 4, with a render timestamp), `src/api/counter.ts` (hot counter, from `examples/full-stack`'s existing counter), `src/api/live/room.ts` (rung-4 page example), `src/api/tasks/encode.ts` and `src/api/tasks/tick.ts` (marker-printing tasks).
- [ ] If `VURA_TEST_CRON_ACCELERATE` doesn't exist in 0.4's task executor, add it in `packages/core` as a test-only accelerated clock (guarded: only honored when `NODE_ENV !== 'production'`... note the suite boots with `NODE_ENV=production` — so instead guard on the explicit var alone and document it in `reference/cli.md` as internal). If adding it is contentious, replace A8 with a unit-level scheduler test inside `packages/core` and keep A6/A7 as the e2e cron coverage — decide at implementation, record the choice in the test file header.
- [ ] Add root script: `"test:selfhost-audit": "vitest run tests/self-host-audit"`. Add a step to `.github/workflows/ci.yml` verify job after `pnpm test`: `- run: pnpm test:selfhost-audit`.
- [ ] Run locally: `pnpm build && pnpm test:selfhost-audit` — expected: `Tests  10 passed (10)`.
- [ ] Link it: GOVERNANCE.md already cites this suite (Task 1); add a one-liner to `docs-site/pages/self-host/index.md` linking the workflow run badge.
- [ ] Commit: `git commit -m "test: self-host audit — A0-A9 prove no primitive is platform-gated (scrubbed env + outbound sinkhole)"`

---

## Task 9 — Honest-claims pass + CLAIMS.md checklist

**Files:** `CLAIMS.md` (create), `README.md` (modify), `docs-site/pages/index.html` (modify if needed), `sites/landing/index.html` (modify)

The recurring WhatStack lesson (every What/Celsian audit): claims must be measured or removed. Known offenders found during planning: `sites/landing/index.html` says `og:url https://vura.io` (domain is vura.dev), titles Vura "Full-Stack TypeScript Framework" (pre-wedge positioning), and `README.md` opens with "Vura is the OSS distribution of the ThenJS full-stack framework" (stale internal naming that means nothing publicly).

- [ ] Inventory every claim: `grep -rniE "fast|faster|tiny|small|kb|ms|zero|instant|only|best|simple|seconds|production-ready" README.md packages/*/README.md docs-site/pages sites/landing/index.html` and read the full landing page. List each hit in CLAIMS.md.
- [ ] Create `CLAIMS.md` with this structure and these starting rows (extend with the inventory):

```markdown
# Marketing Claims Register

Every public claim about Vura, with how it is verified. Rule: a claim ships
only with a row here; a row needs a command someone else can run, or it's cut.
"Faster than X" without a reproducible benchmark is banned outright.

| # | Claim | Where it appears | Verification | Status |
|---|-------|------------------|--------------|--------|
| 1 | "MIT, forever — no relicensing" | README, GOVERNANCE.md, landing | LICENSE file + GOVERNANCE.md commitment; grep -L '"license": "MIT"' packages/*/package.json is empty | verified |
| 2 | "Every self-host guide is executed in CI on every commit" | landing, /self-host | .github/workflows/selfhost.yml — 6 jobs extract and run the guides' own code blocks | verified |
| 3 | "Nothing is platform-gated: revalidateTag, websockets, tasks, cron all work self-hosted with zero VURA_* vars" | landing, GOVERNANCE.md, /self-host | tests/self-host-audit assertions A0–A9 (incl. outbound sinkhole) | verified |
| 4 | "Static pages ship zero framework JavaScript" | /ladder/1-static | CI: selfhost node-vps job asserts no <script src> tag referencing _then/ in dist/static/about/index.html | verified |
| 5 | "revalidateTag('posts') → instant global purge" | landing, /ladder/2-cache | Self-hosted: assertion A2 (next request re-renders). "Global/CDN" wording allowed ONLY on pages describing the Cloudflare cache-tag adapter, measured purge propagation stated as measured | qualified — wording must match adapter context |
| 6 | "Hot routes: no timeout, in-memory state, websockets" | landing, /ladder/4-hot | Assertions A3–A5; "no timeout" means no framework-imposed limit — guide notes host limits still apply | verified |
| 7 | "One-line change" (kind = 'hot') | landing hero | Literally one export added to an existing route file; rung-4 page shows the diff | verified |
| 8 | Any bundle-size number (e.g. "page JS: N KB gzip") | wherever stated | scripts/check-package-size.mjs output committed to artifacts/; number stated as "measured at vX.Y.Z, see artifacts/package-sizes.json" | each number needs its own row |
| 9 | "Built on What Framework + CelsianJS" | README, landing | True only post-A1: package.json deps what-framework ^0.11 + celsian runtime in src/api path; A1 merge is the gate for this wording | gated on A1 |
```

- [ ] Apply the fixes the register demands:
  - `README.md`: replace the "OSS distribution of ThenJS" opener with the wedge positioning ("Vura is an MIT full-stack meta-framework built on What Framework and CelsianJS — static pages, cached SSR, typed API routes, websocket hot routes, and background tasks in one project, self-hostable anywhere."); keep the accurate page-modes/deploy sections; keep the honest `vura deploy` fails-closed paragraph as-is.
  - `sites/landing/index.html`: replace the whole file with a meta-refresh + canonical redirect to `https://vura.dev/` (the docs-site landing supersedes it).
  - Sweep docs-site pages: no unverifiable comparative ("faster than", "simpler than X") survives; every number cites its measurement.
- [ ] Sign-off step (this is the gate item RELEASING.md references): a second agent or Kirby reads CLAIMS.md against the live built site (`npm --prefix docs-site run preview`) and checks every row; record sign-off as a dated line at the bottom of CLAIMS.md: `Signed off: <name>, 2026-MM-DD, vura vX.Y.Z, docs-site commit <sha>`.
- [ ] Commit: `git commit -m "docs: honest-claims pass — CLAIMS.md register, README repositioning, landing redirect"`

---

## Task 10 — Package READMEs: stub → standard

**Files:** all 9 `packages/*/README.md`

Standard shape (every package): H1 with package name · one-line what-it-is · npm version badge · **What it does** (2–4 sentences, honest scope) · **Install** · **Minimal example** (runnable) · **Documentation** (deep link into vura.dev) · **License** ("MIT — and [it will stay MIT](https://github.com/zvndev/vura/blob/main/GOVERNANCE.md)").

Full content for the anchor package, `packages/core/README.md` (the other eight follow the same shape; their "minimal example" requirements are listed after):

```markdown
# @celsian/vura-core

Core runtime and build pipeline for [Vura](https://vura.dev) — the MIT
full-stack meta-framework for apps that outgrow serverless.

[![npm](https://img.shields.io/npm/v/@celsian/vura-core)](https://www.npmjs.com/package/@celsian/vura-core)

## What it does

`vura-core` is the orchestration layer of a Vura app: it scans `src/pages` and
`src/api` into a route manifest, drives the build (static prerender, client
bundles, the production Node server, adapter artifacts), and provides the
runtime helpers your code imports — including `revalidateTag`/`revalidatePath`
(backed by what-isr) and `defineConfig`. Pages render through What Framework;
API routes run on CelsianJS. You normally get this package via
`npm create vura@latest` rather than installing it directly.

## Install

​```sh
pnpm add @celsian/vura-core
​```

## Minimal example

​```ts
// src/api/posts.ts
import { revalidateTag } from '@celsian/vura-core';

export async function POST(req, reply) {
  const post = await savePost(req.parsedBody);
  await revalidateTag('posts'); // purge every page tagged 'posts'
  return reply.json(post);
}
​```

​```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';

export default defineConfig({
  hot: { drainTimeoutMs: 30_000 },
});
​```

## Documentation

- [The DX ladder](https://vura.dev/ladder/0-create/) — learn Vura in 7 rungs
- [vura.config reference](https://vura.dev/reference/config/)
- [Self-host guides (CI-tested)](https://vura.dev/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/zvndev/vura/blob/main/GOVERNANCE.md).
```

- [ ] Write `packages/core/README.md` as above (reconcile helper names against 0.4 exports).
- [ ] Write the other eight, each with its specific minimal example:
  - `cli`: example = `package.json` scripts block (`vura dev`/`vura build`) + `vura tasks run encode`; keep the existing honest note that `then` is a reserved word and `vura deploy` fails closed in OSS.
  - `create-vura`: example = `npm create vura@latest my-app` with the expected scaffold tree; document `--no-install` and the install-failure-is-nonzero behavior (already accurately described in the root README — copy it).
  - `adapter-lambda`: example = `vura.config.ts` with the adapter + `sam local start-api` smoke; link to `/self-host/lambda/`.
  - `adapter-cloudflare`: example = adapter config + `wrangler dev`; include the hot-route limitation sentence; keep the `__cf_env`/`__cf_ctx` escape-hatch note; link `/self-host/cloudflare/`.
  - `adapter-vura`: state plainly this targets the managed Vura Platform, that the platform is not required for any framework capability (link GOVERNANCE.md), and current availability status.
  - `vite-plugin`: example = `vite.config.ts` registering the plugin.
  - `compiler`: example = what it transforms (one in/out snippet from its tests); state it's the pure-JS path.
  - `compiler-native`: keep the existing honest "unpublished prototype, source-only" framing; bring shape to standard.
- [ ] Verify every README example against a scaffold (same gate as Task 4). Verify all docs links resolve against the built docs-site routes.
- [ ] Commit: `git commit -m "docs: bring all 9 package READMEs to standard (what/install/example/docs-link/license)"`

---

## Task 11 — RELEASING.md (the v0.5 gate) + docs deploy + final gate run

**Files:** `RELEASING.md` (create), `.github/workflows/docs-site.yml` (create), Vercel project config (manual, documented)

- [ ] Create `RELEASING.md`:

```markdown
# Releasing Vura

Releases are tag-driven (`v*`) through `.github/workflows/release.yml`
(verify matrix → publish with provenance). Use a classic npm Automation token
in the NPM_TOKEN secret (expiring tokens have killed publishes before).

## The v0.5 "hosting-ready" gate

A release tag may not be pushed until every box is checked, by a human,
in the release PR description:

### CI — all green on the release commit
- [ ] `CI / verify` (node 20 + 22): lint, build, test, verify-publish, audit
- [ ] `Self-host guides` — all 6 jobs (node-vps, docker, fly, cloudflare,
      lambda; railway covered by docker)
- [ ] `pnpm test:selfhost-audit` — assertions A0–A9 (no-platform-gating)
- [ ] `Docs site` workflow — build + 0 broken links

### Audits
- [ ] `/smoke-audit` pass on the release candidate (scaffold from the packed
      tarballs, follow the docs as a new user, browser-check the docs site);
      report attached to the release PR, zero CRITICAL/HIGH findings open
- [ ] CLAIMS.md signed off against the built docs site (dated sign-off line
      updated for this version)

### Docs
- [ ] vura.dev deploy is live and serving the release version in the nav badge
      (build-time version stamp — verify with:
      `curl -s https://vura.dev/ | grep -o 'v[0-9.]*' | head -1`)
- [ ] Every package README's docs links resolve (linkinator against vura.dev)

### Versioning & publish
- [ ] `pnpm release:check` passes
- [ ] `pnpm package:size` — no package over its limit in
      scripts/package-size-limits.json
- [ ] CHANGELOG.md entry for the version
- [ ] Tag `vX.Y.Z`, push, watch `release.yml`, then run
      `pnpm verify:registry` against the published packages

If any box cannot be checked, the release waits. No exceptions for "docs-only"
or "it's just the badge" — those are exactly the drift this gate exists to stop.
```

- [ ] Create `.github/workflows/docs-site.yml`:

```yaml
name: Docs site

on:
  pull_request:
    paths: ['docs-site/**', 'packages/core/package.json']
  push:
    branches: [main]
    paths: ['docs-site/**', 'packages/core/package.json']

permissions:
  contents: read

jobs:
  build:
    runs-on: depot-ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm --prefix docs-site install
      - run: npm --prefix docs-site run build
      - name: Link check
        run: npx --yes linkinator docs-site/dist --recurse --silent
      - name: Version badge matches monorepo
        run: |
          V=$(node -p "require('./packages/core/package.json').version")
          grep -q "v$V" docs-site/dist/index.html
      - uses: actions/upload-artifact@v4
        with: { name: docs-site-dist, path: docs-site/dist }
```

- [ ] Configure the Vercel project for vura.dev: root directory `docs-site`, the `docs-site/vercel.json` from Task 2 governs build/output. Document the exact Vercel settings (project name, domain attachment) in `DEPLOYMENTS.md`-style notes inside `docs-site/README` section of `RELEASING.md` or a short `docs-site/DEPLOY.md`. (Needs `VERCEL_TOKEN`/dashboard access — flag to Kirby if absent, same blocker as the what-fw site redeploy.)
- [ ] Dry-run the full gate on a release-candidate branch: run every checklist item top to bottom and fix whatever fails. Expected end state: all CI workflows green, docs preview built, audit suite 10/10, claims signed off.
- [ ] Run `/smoke-audit` on the RC (per the gate) and attach the report.
- [ ] Commit: `git commit -m "release: RELEASING.md v0.5 hosting-ready gate + docs-site CI/deploy"`
- [ ] Hand off to Kirby for the v0.5 tag decision (per master plan §7, this gates the public push).

---

## Task sequencing

- **Now (no A1/A2 dependency):** Task 1 (license), Task 2 (docs scaffold), Task 10 (package READMEs minus API-specific examples), Task 11's RELEASING.md draft.
- **After vura 0.4 tags:** Tasks 3–8 (all docs content, self-host CI, audit suite — they document and test the 0.4 APIs), Task 9 (claims pass must run against final wording), Task 11 gate run last.
- Tasks 4, 6, and 10's example-verification all share the same "paste into a real scaffold and build" gate — build that harness once (Task 7's `scaffold` job logic, runnable locally) and reuse it.

### Critical Files for Implementation

- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/what-fw/docs-site/build.mjs — the SSG pattern to port (renderToString chrome, build-time version stamping, dist/<route>/index.html)
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/README.md — positioning rewrite, license commitment section, honest-claims fixes
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/.github/workflows/ci.yml — existing CI shape to extend (runner, pnpm/node setup) and where the audit-suite step lands
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/hot-server/Dockerfile (and fly.toml beside it) — seed for the docker/fly guides and the guide-extraction CI jobs
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/create-vura — the scaffold every CI job and audit test builds from; its template must include the smoke surface (page + api + hot route + task)