# Changelog

## Unreleased

### Added

- **Streaming SSR: `export const page = { streaming: true }`.** A streamed page
  sends its `<head>` and everything above the first `<Suspense>` boundary before
  the body has finished rendering, so the browser starts fetching stylesheets
  and scripts while the server is still waiting on data.

  ```tsx
  export const page = { mode: 'server', streaming: true };

  export default function Dashboard() {
    return (
      <main>
        <h1>Dashboard</h1>
        <Suspense fallback={<p>Loading...</p>}>
          <Revenue />
        </Suspense>
      </main>
    );
  }
  ```

  The loader chain still runs to completion before the first byte, so
  `throw ctx.notFound()` and `throw ctx.redirect(...)` still choose a real
  status. Layouts, `useLoaderData`, the serialized payload and hydration are
  unchanged. The one exclusion is ISR: a response the server is still producing
  cannot be stored or revalidated, so a streamed page skips the cache.

  `vura dev` serves streamed pages through the same code path as a build.

  Requires `what-framework` 0.13.4 (see Changed).

### Changed

- **`@celsian/core` and `@celsian/jwt` now require `^0.6.1`** (was `^0.5.2`).
  0.6 fixes plugin hooks never running for an un-prefixed `app.register()`,
  adds a durable task queue, and validates a bare `schema.response`. Two of its
  changes reach Vura's own contract and are described below.

- **After a query schema runs, `req.query` holds the validated output.** It used
  to keep the raw strings from the URL, with the coerced values only on
  `req.parsedQuery`. Reading the ergonomic property therefore handed back input
  that had skipped the schema you declared: `req.query.page` was the
  attacker-controlled string even on a route that validated `page` as a positive
  integer. `req.parsedQuery` is unchanged and is still the explicitly-typed
  alias. Routes that declare no query schema are unaffected — `req.query` there
  is the raw strings, as always. This follows Celsian 0.6.0, and Vura's own
  runtimes (the Node server, the Lambda adapter and the Cloudflare adapter) were
  changed to match so every runtime behaves the same way.

- **`what-framework` and `what-isr` now require `^0.13.4`** (was `^0.13.2`).
  0.13.4 fixes a resolve-pass bug that could render one `<Suspense>` boundary's
  data inside another, which streaming depends on.

- **Server pages and layouts are bundled once instead of twice.** The CLI
  bundled every `server` and `hybrid` page and every layout into
  `dist/server/pages/`, and then core's builder ran over the same inputs and
  overwrote every one of those files. The output was byte-identical, so the
  CLI's copy bought nothing but a second esbuild pass per page and per layout on
  every build, and a second copy of the resolve configuration to keep in sync
  with core's. The `useSignal` bug in 0.7.0 shipped through exactly that kind of
  duplicate: one copy was fixed and the other was not.

### Fixed

- **A `throw notFound()` from an API route is a 404 again.** Celsian 0.6 stopped
  reading a bare `error.statusCode` when deciding a status, deliberately: a
  database driver error that happens to carry `statusCode: 400` must not be able
  to pick its own HTTP status and skip the sanitisation that keeps its message
  off the wire. Vura's `HttpError` is a different class from Celsian's, so it
  was landing on that path and every deliberate 404, 403 or 409 thrown from an
  API route was flattened into a 500.

  Vura now decides the status of its own errors instead of relying on the host
  framework to infer one. `HttpError` carries a `Symbol.for('vura.http-error')`
  brand and a new `isHttpError()` recognises it — a brand rather than
  `instanceof`, because each server bundle inlines its own copy of core, so an
  error thrown by `dist/server/api/x.js` is not an instance of the class the
  code formatting it closes over. Errors Vura did not construct are untouched
  and still take Celsian's sanitised 500 path.

  `formatErrorResponse()` gained the same brand check, which fixes the same
  silent flattening on any path that formats an error from another bundle.

- **A library error could pick its own HTTP status in a serverless function.**
  The generated serverless entry, the Lambda adapter and the Cloudflare adapter
  all took any `error.statusCode` at face value. A database driver error that
  carries `statusCode: 400` therefore chose a 400, and because the sanitisation
  in those runtimes only applies to a 500, its message went out with it — a
  connection string on the wire. This is the hole Celsian closed in 0.6 and the
  reason a deliberate `notFound()` needed the brand above; all three runtimes
  now gate on it too, so every runtime agrees on which errors may choose a
  status. Vura's own `HttpError` (and everything from `notFound()`,
  `forbidden()` and the other factories) is unaffected.

- **`vura build` shipped every bundle it had ever built.** Client and hybrid
  page bundles carry a content hash in the filename, so editing a page emits a
  new name and orphans the old one. Nothing removed the orphans, so
  `dist/static/_then/pages` grew with every incremental build and the dead
  copies were deployed along with the live ones. The build now prunes bundles it
  did not emit, after writing the new ones so a failed build still leaves the
  previous ones intact.

- **`vura admin --port 0` refused every request it served.** The dashboard's
  same-origin allowlist was built from the *requested* port, so it held
  `localhost:0` while the browser sent the port the server had actually bound.
  Every API call came back 403 with a valid token in hand, which made the whole
  dashboard non-functional on an OS-assigned port. The allowlist now uses the
  bound port. The origin and token checks themselves are unchanged: a request
  with no token, or with a spoofed `Host`, is still refused.

- **The `vura admin` banner box never lined up.** Its four content lines were
  padded to four different widths inside a 41-wide box, so it only looked square
  when the port happened to be four digits. Every line is now padded to one
  width, and the URL reports the bound port rather than the requested one.

- **`vura dev --port 0` printed a URL nobody could open.** The startup banner
  echoed the requested port rather than the one the server actually bound, so
  `--port 0` ("pick a free port") advertised `http://127.0.0.1:0`. It now reports
  the bound port, which is also what tells you which port you got when the one
  you asked for was taken.

- **A visitor navigating away mid-stream was logged as a render failure.**
  Closing a tab or hitting stop during a streamed response made the enqueue that
  followed throw `ERR_INVALID_STATE`, which was reported as
  "stream render failed mid-document" with a stack trace. The most common
  interruption there is was burying the real render failures the message exists
  to surface. A lost reader is now treated as a disconnect and ends the render
  quietly.

## 0.7.0 - 2026-08-25

Two features and one bug that had been quietly breaking builds.

`src/middleware.ts` runs before a request reaches anything. `src/actions/` holds
functions the browser can call by importing them. And `useSignal()`, a hook
almost every What page reaches for, could not be used in a `static` or `hybrid`
page at all: the build failed outright.

### Added

- **Page middleware: `src/middleware.ts`.** One function, run before static
  files, API routes and pages alike. Return a `Response` and it is the answer;
  return nothing and the request carries on with `ctx.headers` merged onto
  whatever the route produces.

  ```ts
  export const config = { matcher: ['/dashboard/:path*'] };

  export default function middleware(ctx: MiddlewareContext) {
    ctx.headers.set('x-request-id', crypto.randomUUID());
    if (!ctx.cookies.get('session')) return ctx.redirect('/login');
  }
  ```

  `config.matcher` supports exact paths, named segments (`/team/:id`), named
  catch-alls (`/dashboard/:path*`) and anonymous ones (`/assets/*`).
  `/__vura/*` and `/__tasks` are never matched, so a project's auth guard
  cannot 401 its own cache purges.

  Vura had lifecycle hooks before this, and they ran for API routes **only**.
  An `onRequest` in `src/api/_hooks.ts` fires for `/api/hello` and does not fire
  for a page. So the most ordinary requirement there is, keeping an
  unauthenticated visitor away from `/dashboard` before it renders, had nowhere
  to live.

- **Server actions: `src/actions/`.** Every named function a file there exports
  is callable from client code by importing it. No endpoint to write, no fetch
  to hand-roll, and the import is type-checked against the real function.

  ```ts
  // src/actions/todos.ts
  export async function addTodo(text: string) {
    return db.todos.insert({ text });
  }
  ```
  ```tsx
  import { addTodo } from '../actions/todos';
  await addTodo('milk');
  ```

  The browser never receives the module. An import that lands in `src/actions/`
  is answered at the bundler's resolve step, so the file is never opened for a
  browser bundle and nothing inside one (a connection string, an API key, a
  `node:fs` import) can reach the client through any path.

  Ids are derived from the file path and the export name (`todos#addTodo`), so
  they are stable across builds and readable in a network tab. The endpoint is
  same-origin only, requires a JSON content type, and carries a CSRF token
  checked against an `HttpOnly` cookie that uses the `__Host-` prefix over
  HTTPS. Throwing an `HttpError` from an action gives the caller that status;
  any other error is logged server-side and returns a generic 500.

  Not yet available on the Cloudflare or Lambda adapters, which bundle API
  routes only. Same caveat as middleware, and both are documented.

### Fixed

- **`useSignal()` threw in every `static` and `hybrid` page.** The build failed
  with `[what] useSignal() can only be called inside a component function`.

  The CLI's resolve plugin answers `onResolve` for `what-framework`, and an
  `onResolve` that returns a path beats esbuild's `external` list. The
  build-time page loader set both, so the page module inlined its own copy of
  what-core while `renderToString` ran from the installed one, and the two
  disagreed about which component was rendering. Loaders escaped it only
  because `@celsian/vura-core` is not intercepted, which is how 0.6.1 shipped
  working loaders sitting on top of a renderer that could not run a hook.

  Nothing caught it because every hybrid and client fixture in the audit suite
  holds state in a module-level `signal()`, which needs no component context at
  all. There is now a page per rendered mode built around `useSignal`.

- **Loaders did not work in `vura dev`.** Every page with a `loader` returned
  500 in dev, on 0.6.0 and 0.6.1, while the built server ran them correctly.
  The dev server carried its own copy of the page-render logic and it had
  drifted: it knew `getServerData` and not `loader`, and called the component
  directly instead of through `h()`, the exact defect 0.6.0 fixed on the
  server path. Dev now renders through `createVuraRenderRoute()`, the same
  function the server entry uses.

- **Build-time render errors named no page.** A component throwing during
  prerender reported only its own message: no file, no route, no stack, for a
  project that might have fifty pages. Errors are now prefixed with the file
  and the route.

### Changed

- **Layouts now apply to build-time pages.** A `static`, `hybrid` or `client`
  page previously rendered without its layout chain, and its loader payload
  held only the page segment; 0.6.1 documented that as a limitation. It now
  renders the chain exactly as a `server` page does, and a hybrid page's
  browser entry rebuilds the same chain from the serialized payload so
  hydration walks the tree that is actually in the document.

  **This changes the output of an existing project** that has a layout file in
  a build-time page's directory: that page was rendered unwrapped and will now
  be wrapped. That is the behaviour the docs always described.

- Server-side bundles keep `what-framework` external, so a built application
  holds one copy of the framework per process rather than one per page bundle.

- `@celsian/vura-core`'s tracked tarball ceiling moves 158 KB to 182 KB, and
  the CLI's 54 KB to 56 KB.

## 0.6.1 - 2026-08-25

The loaders 0.6.0 introduced did not work in a built application. They worked in
the 25 tests that shipped with them, all of which imported the loader runtime
directly, and in none of the four ways a real project reaches it. This release
is that gap closed, plus the gate that would have caught it: a suite that builds
and boots a real project and drives the whole path through HTTP.

### Added

- **`@celsian/vura-core/client`, a browser-safe export surface.** The package
  root reaches `node:fs`, `node:crypto` and `node:http`, so a `client` or
  `hybrid` page that imported `useLoaderData` from it could not be bundled for a
  browser at all. The new subpath carries the pure exports, and the CLI
  redirects a bare `@celsian/vura-core` import to it when bundling for the
  browser, so the documented import path works in a page that runs on both
  sides.

### Fixed

- **`useLoaderData` was unreachable from a server page.** A bare
  `@celsian/vura-core` import inside a bundled server module resolves to a
  runtime allowlist, and that allowlist was copy-pasted into three files with
  0.6.0 adding the accessor to none of them. Every page using the feature failed
  the build with `No matching export in "vura-core-runtime-shim"`. There is now
  one list, in `packages/core/src/runtime-shim.ts`, imported by core's builder
  and by both adapters.
- **`useLoaderData()` inside a layout found no data in a built app.** Every page
  and layout is bundled separately, each bundle inlines its own copy of the
  loader runtime, and the server entry inlines all of them, so a module-scoped
  context object meant the provider and the consumer were reading two different
  contexts. The context is now a process singleton, so copy count stops
  mattering.
- **A hybrid page lost its loader data on hydrate.** The server rendered with the
  data and serialized the payload, and the generated client entry then booted
  the component with no provider around it. It now re-opens the same scope from
  that payload, and still boots the bare component when a page has no loader so
  the missing-loader error keeps naming the real problem.
- **`dist/package.json` never declared `what-framework` in a real install.** The
  version was read with `require('what-framework/package.json')`; that package's
  `exports` map does not list `./package.json`, so Node refused the subpath, the
  version came back null, and a container built from that manifest could not
  resolve `what-framework/server`. It now reads the installed manifest off disk.
- **Build-time page modules inlined their own copy of the framework.** A
  `static`, `hybrid` or `client` page is imported into the CLI's own process and
  rendered by core's `renderToString`; a second inlined copy gives it a second
  "currently rendering component" and its own context registry, so every hook
  the page calls reads a registry the renderer never wrote to. These bundles now
  keep `what-framework` and `@celsian/vura-core` external, and are written to a
  real file rather than imported as a `data:` URL, which cannot resolve bare
  specifiers.

### Documentation

- `/reference/data-fetching` now states that **layouts apply to `server`-mode
  pages**. A page rendered at build time is rendered without its layout chain
  today, and a layout sitting in a directory of build-time pages is silently
  skipped. Documented rather than changed, because making build-time pages
  render their layouts also changes what a hybrid page must hydrate.

### Internal

- **`tests/self-host-audit/loaders.test.ts`.** Scaffolds a project, installs the
  packed tarballs, runs `vura build`, boots `dist/server/entry.js` and asserts
  the loader path over HTTP: a three-segment chain rendering every segment,
  start stamps within 60 ms across three 120 ms loaders (parallel, not
  sequential), `notFound` producing a 404 and `redirect` a 302 with a `Location`,
  a build-time loader in the prerendered HTML, the hydration payload and its
  client bundle, no `node:` imports in that bundle, and the pinned container
  dependency. Every assertion in it fails against 0.6.0.
- Two unit tests pin the process-singleton invariant without a build, by
  importing the loader module twice under different specifiers.
- The what-framework version-pin test used a fixture package with no `exports`
  map, so it passed on a resolution strategy that cannot work in any real
  install. The fixture now carries a realistic one.
- Tracked tarball limits move: `@celsian/vura-core` 150 KB to 158 KB,
  `@celsian/vura-cli` 50 KB to 54 KB.

## 0.6.0 - 2026-08-25

### Added

- **Server-side data fetching for pages: `loader` + `useLoaderData` (RFC 0001).** A page or layout exports a `loader`; it runs on the server before the component renders, and the component reads the result with `useLoaderData<typeof loader>()`. The data is already in the HTML the browser receives, so there is no loading state, no request waterfall, and no client round trip. This closes Vura's top gap against Next.js.

  ```tsx
  export const page = { mode: 'server' };

  export async function loader(ctx: LoaderContext) {
    const post = await db.post.find(ctx.params.id);
    if (!post) throw ctx.notFound();
    return { post };
  }

  export default function Post() {
    const { post } = useLoaderData<typeof loader>();
    return <article><h1>{post.title}</h1></article>;
  }
  ```

  - **Layered loaders.** Every segment of the matched layout chain can have its own loader, and each component reads its own segment's data with nothing prop-drilled. Loaders in a chain run in parallel, so nesting costs no latency.
  - **`ctx.notFound()` and `ctx.redirect()`** return the error for you to throw, so the throw is visible at the call site. A 404 or a redirect is control flow and never looks like a 500.
  - **The result is serialized** into `<script id="__VURA_LOADER__" type="application/json">`, written outside `<div id="app">` so it never participates in hydration. A hybrid page's islands start from the server's data instead of re-fetching it.
  - **Build-time loaders** for `static` and `hybrid` pages: same code, resolved once during `vura build`. `ctx.request` is absent there.

  Loaders are route-level rather than component-level because What's `renderToString` is synchronous: there is nowhere inside the component tree to await. Streaming is the RFC's phase 2 and is not in this release.

### Changed

- **`getServerData` is deprecated in favour of `loader`.** It keeps working, still spreads its result into the component's props, and is now an alias for the same machinery, so its data is also readable through `useLoaderData()`. A page can migrate one line at a time. When a page exports both, `loader` wins. `getServerData` will start printing a deprecation notice in a later minor and will not be removed before the next major.
- **Requires what-framework 0.13.2 or newer.** 0.13.2 fixed a revalidation registry that was not process-wide, which made every ISR purge from an API route a silent no-op in a Vura build.

### Fixed

- **Page components were invoked outside a component context.** `mod.default(props)` was called directly, so every What hook inside a Vura page had nothing to read. Components now go through `h()`.
- **Vura's JSX runtime built vnodes What could not read.** It emitted `{ type, ... }` where What's vnode is `{ tag, ... }`, so every page built through it server-rendered `<undefined>…</undefined>` with no error and no warning. It now re-exports What's runtime, with a parity test asserting node-for-node equality.
- **`dist/package.json` was only written for projects with hot routes.** Route bundles keep `what-framework` external, so a serverless-or-static project produced a container image that started and died on the first API request with `ERR_MODULE_NOT_FOUND`. It is now written on every build, with `what-framework` pinned to the version the project resolved rather than a range.
- **Page mode inference overrode an explicit `mode: 'static'`.** It could not tell "defaulted to static" from "the author wrote static", so a deliberately static page with a server-data export was silently promoted to server rendering and lost its prerendered HTML.
- **`buildProject()` resolved paths against the caller's cwd.** The three esbuild invocations now anchor to `projectRoot`, which is the whole reason the function takes it.

### Internal

- `@celsian/vura-core`'s tracked tarball limit moves from 138 KB to 150 KB. The loader runtime is about 8 KB packed, and the gate exists to catch drift, not to block a feature that is the reason for the release.
- The self-host audit scaffold pinned `what-framework: ^0.11.1` as a literal, so it spent the 0.12 and 0.13 cycles proving Vura works on a version Vura had stopped shipping against. It now reads the range `@celsian/vura-core` declares.

## 0.5.14 - 2026-07-16

- Fail closed before upload when `dist/manifest.json` is missing, malformed, or structurally invalid.
- Package full project context for canonical Dedicated routes and tasks, WebSockets, and legacy persistent-runtime markers while keeping 1–12 GB Function deploys lean.
- Keep managed-provider implementation details out of streamed logs, upload failures, and terminal deployment errors.
- Report explicitly selected Function memory accurately in `vura routes inspect` and document that managed server/hybrid pages use Dedicated compute.
- Raise the managed adapter tarball ceiling from 12 KB to 15 KB for the new fail-closed validation and redaction paths.

## 0.5.13 - 2026-07-16

- Preserve dynamic route parameters in generated Function bundles.
- Keep schema validation plus global and route lifecycle hooks on Function compute.
- Make subcommand help side-effect free, including `vura deploy --help`.
- Extend deploy monitoring to about 20 minutes, honor API retry windows, and keep provider internals out of streamed logs.

## 0.5.12 - 2026-07-16

### Two-tier managed compute

- Removes the 128 MiB Edge endpoint class from route configuration and runtime guidance; historical Edge manifests safely fall back to a 1 GiB Function.
- Keeps scale-to-zero Functions at provider-neutral 1/4/6/8/12 GiB profiles and persistent Dedicated compute for WebSockets, stateful work, and latency-sensitive endpoints.
- Adds provider-neutral Dedicated `nano`, `small`, `medium`, `large`, `xlarge`, `2xlarge`, and `4xlarge` profiles while preserving explicit memory/CPU sizing.
- Keeps the JavaScript and native Rust scanners aligned on validation and normalization.

## 0.5.11 - 2026-07-16

### Function task execution

- Adds an opt-in synchronous task-admin mode for scale-to-zero Function runtimes, returning the canonical task result envelope on the invocation request.
- Preserves Dedicated task execution as an asynchronous `202` job with authenticated status polling.
- Covers synchronous success and failure plus the unchanged Dedicated contract with runtime integration tests.

## 0.5.10 - 2026-07-16

### Managed Dedicated deploys

- Packages `dist/`, `package.json`, and `node_modules/` as the managed runtime context when a manifest contains Dedicated API routes or server/hybrid pages.
- Keeps static and Function-only deploy artifacts dist-only, avoiding unnecessary dependency uploads.
- Adds CLI preflight errors for missing project context or dependencies, materializes safe in-project dependency links for npm/pnpm/Yarn portability, and rejects links outside the project.

## 0.5.9 - 2026-07-16

### Release reliability

- Ships the 0.5.8 compute-placement and compiler-safety release after making the HTTP middleware regression suite independent of Fetch's forbidden-port policy.
- Keeps Node 20 and Node 22 package verification deterministic when the OS assigns any available loopback port.

## 0.5.8 - 2026-07-16

### Compute placement and compiler safety

- **Explicit Function and Dedicated intent.** Route manifests preserve the requested compute class and memory profile so the platform can route stateless endpoints to 1–12 GB Function compute and persistent/WebSocket endpoints to Dedicated machines.
- **Fail-closed route configuration.** Identifier-valued `mode`, `revalidate`, and `tags`, bare modes, regex lookalikes, unknown route kinds/classes, and invalid CPU values are rejected instead of being guessed into a deployable manifest.
- **JavaScript/native parity.** Shared hostile fixtures keep the TypeScript and Rust scanners aligned on accepted and rejected syntax.
- **CLI placement guidance.** Runtime inspection explains Function, Dedicated, and Edge-request intent before deployment, including why Edge remains a platform-reviewed admission request.

### Verified

- Node 20 and 22: 782 tests plus packed package/scaffold/CLI/adapter smokes.
- Native packed smoke on Node 20 and 22, strict Clippy, docs build, lint, size gates, and publish verification.

## 0.5.7 - 2026-07-11

### Fixes

- **Docs-site landing restyled** — the landing rewrite had shipped without CSS
  for its sections (hero, one-line-change compare, ladder, pillars, license);
  vura.io and platform deploys of the docs site rendered unstyled. (#71)
- **Build warning for HTML-string pages** — `renderStaticPages` now warns when
  a page component returns a raw HTML string, which `renderToString` escapes
  to literal text. Return JSX / `h()` nodes instead. (#71)
- **`vura deploy` URL print** — the adapter and CLI prepended `https://` to a
  deployment URL that already includes it, printing `https://https://…`.
  Normalized once in `deployToVura`. (#72)

## 0.5.6 - 2026-07-11

### Tasks: `ctx.step` durable execution — memoized steps, waitpoints, suspend/resume

Phase 2 of Vura Tasks adds durable execution over HTTP re-invocation
(Inngest-shaped: step memoization + suspend/resume, no CRIU). Task handlers now
receive a `step` object on their context (additive — handlers that only read
`{ attempt, input }` are unchanged):

- **`step.run(key, fn)`** — runs `fn` exactly once per run, memoized under
  `key`. On a replay dispatch the recorded output is returned without re-running
  `fn`, so side effects belong inside `step.run` (the bare handler body re-runs
  top-to-bottom on every replay).
- **`step.enqueue(key, task, payload?, opts?)`** — memoized enqueue via the
  Phase-1 `enqueue()` client; returns `{ runId }`.
- **`step.waitForTask(key, task, payload?, opts?)`** — "triggerAndWait":
  suspends the run on a `RUN` waitpoint (the platform enqueues and links the
  child — never enqueued framework-side, so replays don't double-enqueue); on
  resume returns the child's `{ ok, result?, error? }` (a child failure is
  returned, never thrown).
- **`step.sleep(key, seconds)` / `step.sleepUntil(key, date)`** — `DATETIME`
  waitpoint.
- **`step.waitForToken(key, { timeoutSeconds? })`** — `TOKEN` waitpoint; resolves
  to the completion `{ payload }` or `{ timedOut: true }`.
- **Determinism guard.** Reusing a step key within one invocation throws a clear
  error naming the key.
- **Suspension mechanics.** A wait throws an internal `SuspendSignal` caught by
  the executor: it consumes **no** retry attempt and is **not** a failure. The
  run envelope gains `suspended: { stepKey, waitpoint }` and `steps` (only the
  steps newly completed this invocation); `ok` stays `true` when suspended so
  the platform never records failure.
- **Dispatch protocol v2.** The `/__tasks/<name>` trigger unwraps `runId` +
  `steps` from the control-plane wrapper (both tolerated-absent; missing steps =
  `{}`) and threads them through the executor for replay. The `/__tasks/<id>`
  job object carries the suspended waitpoint + completed steps.
- **Local dev (no platform).** Waits resolve best-effort in-process — `sleep`
  is a real timer, `waitForTask` directly dispatches the child (`vura dev`, the
  standalone server, and `vura tasks run` all resolve children in-process), and
  `waitForToken` resolves `{ timedOut: true }` after its timeout (capped at 60s)
  — with a one-time note that durable semantics require the platform.

Package-size limit for `@celsian/vura-core` raised 128000 → 138000 bytes to
accommodate the new (heavily-documented) `runtime/steps.ts` module.

### Fixed

- **Serverless task entries now run the real executor.** The generated
  Workers task wrapper (`dist/functions/task_*/index.js`) previously hand-rolled
  its own executor: handlers received no `step`/`runId`/`steps` (any `step.*`
  task crashed on serverless), input schemas were never validated, and
  framework retries didn't run there. The entry is now a thin source that
  applies the platform dispatch header protocol and delegates to the same
  `runTaskOnce` executor as the hot server, bundled self-contained for Workers.
  Found by the Phase-2 production E2E.
- The task run envelope now carries a top-level `error` on failure (mirrors the
  last attempt's error) so platforms can propagate child-task failure messages.

## 0.5.5 - 2026-07-10

### Tasks: typed input schemas, attempt metadata, `enqueue()`

- **Typed task payloads.** A task file may `export const input = defineSchema({...})`
  (or a bare Zod-like schema). The executor validates the payload before the
  first attempt on every payload-bearing path (direct route, `/__tasks` admin
  run, dev servers, CLI `vura tasks run`); a mismatch returns `400` with the
  validation kit's error shape, the handler never runs, and no retries are
  consumed. Scheduled (cron) runs use synthetic input and are exempt.
- **Per-attempt run metadata.** Task executions now report
  `{ ok, taskName, attempts: [{ index, startedAt, durationMs, error? }], result? }`
  — the retry history that was previously invisible to callers. Additive:
  existing response fields are unchanged. The `/__tasks/<id>` job object carries
  `ok` + `attempts`; errors are message-only (never a stack in production).
- **`enqueue(taskName, payload?, { delaySeconds?, idempotencyKey? })`** — new
  public export for on-demand task runs. On a platform deployment it POSTs to
  the injected `VURA_TASK_ENQUEUE_URL` with the deployment-scoped
  `VURA_TASK_ENQUEUE_TOKEN` (durable queue, per-team concurrency, run history);
  locally it falls back to direct `/__tasks` dispatch with best-effort delay.
- **Platform dispatch header protocol.** The `/__tasks/<name>` trigger unwraps
  the control-plane wrapper body (`X-Vura-Task-Id` present → payload is
  `body.input`) and skips input validation for synthetic cron dispatches
  (`X-Vura-Cron: true`). Raw local triggers are validated as-is.

### `vura dev` serves all four page modes (Vite path)

- **`vura dev` now renders `static` and `client` pages, not just `server` and
  `hybrid`.** The Vite plugin's page middleware only matched
  `mode: 'server' | 'hybrid'`, so an app made of static pages plus a client SPA
  404'd on every page in dev (API routes worked) — the full app was only
  runnable from the built server entry. The middleware now matches all four
  modes and mirrors the production build and the standalone dev server:
  `static` pages are SSR'd fresh per request (giving live reload), and `client`
  pages are served as the SPA shell plus their browser bundle.
- **Client and hybrid browser bundles are served on demand at
  `/_then/pages/*.js`** — the same layout `vura build` emits — via esbuild with
  the `generateClientPageEntry` wrapper, so the page actually boots (`mount()`
  for client, `hydrate()` for hybrid). Previously the Vite path never emitted a
  browser bundle for hybrid pages either, so they rendered but never hydrated;
  that is fixed too.
- **New test fixture** `packages/vite-plugin/test/fixtures/pages-app` (static +
  client pages, serverless + hot API routes) and a dev-server test that boots a
  real Vite dev server and asserts all four modes plus the API surface.

## 0.5.4 - 2026-07-06

### Vura Platform adapter goes public

- **`@celsian/vura-adapter-vura` is now published to npm.** The Vura Platform
  live smoke passed (real production deploy through the public API + CLI), so
  the adapter leaves closed alpha: `private` removed, added to the publish
  package list, and the release guard in `scripts/assert-release-private.mjs`
  retired. `vura deploy`'s missing-adapter fallback now points at
  `npm install @celsian/vura-adapter-vura` instead of the closed-alpha notice.

### Cache tags

- **ISR cache tags are sanitised and capped before they hit the wire.** A
  tagged ISR response's `x-vura-cache-tag` and `Cache-Tag` headers are now built
  from a single hardened path (`buildVuraCacheTagHeader`): tags are trimmed,
  de-duplicated, stripped of control characters (no header-injection surface),
  each capped at 128 characters, with at most 64 tags per response, and any
  comma inside a tag is treated as a separator. Previously the raw declared tags
  were passed straight onto the response, uncapped and unsanitised. The
  sanitised value now authoritatively replaces the underlying ISR engine's raw
  `cache-tag`. `buildVuraCacheTagHeader`, `MAX_VURA_CACHE_TAGS`, and
  `MAX_VURA_CACHE_TAG_LENGTH` are exported from `@celsian/vura-core`.
- **The full-stack example's `/stats` ISR page now declares `tags: ['stats']`,**
  demonstrating end-to-end cache-tag emission and `revalidateTag` invalidation.
- **Docs:** the caching guide now documents the `x-vura-cache-tag` / `Cache-Tag`
  response headers, the sanitisation caps, and how project-scoped purge-by-tag
  works on Vura Platform.

## 0.5.3 - 2026-07-04

Scaffold and developer-experience release — makes a freshly created app
deploy, render styled, and demonstrate the full-stack data loop out of the box;
adds a readable client-crash error panel; migrates the toolchain to TypeScript
6 / Vite 8 / Vitest 4; and finishes the hot-placement CLI truth alignment.

### create-vura scaffold

- **Health route ships as `kind: 'serverless'`, not `hot`.** The starter's
  `src/api/health.ts` was a hot route, and hot routes are excluded from the
  serverless adapter bundles — so `vura build` for Cloudflare/Lambda silently
  dropped the health endpoint. It now ships as a serverless route so it deploys
  on every adapter, with a comment explaining when `hot` is the right choice.
- **The starter now demonstrates the full-stack data loop.** The dashboard page
  fetches an API route on mount and renders the response, so the framework's
  core client↔API loop is shown in the default app instead of being invisible.
- **Styled baseline stylesheet.** A small, dependency-free base stylesheet
  (`src/styles.ts`) is imported by every page — system font stack, sensible
  spacing/typography, and styled buttons, inputs, links, and code, with light
  and dark themes via `prefers-color-scheme`. A freshly scaffolded app renders
  styled instead of unstyled black-on-white.
- **Dashboard uses the idiomatic `useFetch` hook.** The scaffold dashboard was
  upgraded from hand-rolled `onMount` + `fetch` + signal to What-FW's `useFetch`,
  now handling loading and error states, not just the happy path (kept
  `mode: 'client'` to avoid the `useSWR`/`useQuery` server-mode heuristic).

### Data-fetching docs

- Added a **Data fetching** reference page documenting What-FW's
  `useFetch`/`createResource`/`useSWR`/`useQuery`/`useInfiniteQuery` hooks —
  real signatures, when to reach for each, the client-vs-server boundary (these
  hooks fetch in the browser; request-time server data uses server mode +
  `getServerData`), and the `useSWR`/`useQuery` server-mode auto-detection
  gotcha.

### core

- **Readable error panel instead of a blank page on client render crash.** When
  a client- or hybrid-mode page throws during its initial render,
  `mount()`/`hydrate()` used to leave the `#app` shell empty — a blank white page
  with the error only in the browser console. The generated client entry now
  wraps the boot in try/catch and renders a `role="alert"` panel: message + stack
  in dev, a generic message in prod (stack traces are not leaked to end users).

### Toolchain

- Migrated to **TypeScript 6** (`^5.7` → `^6.0.0`), **Vite 8** (`^6.4` →
  `^8.0.0`), and **Vitest 4**. The `@celsian/vura-vite-plugin` vite peer range
  widened to `^6.0.0 || ^7.0.0 || ^8.0.0` to support the new major. No runtime
  source changes were required; `@types/node` was bumped for TS6 compatibility.

### CLI — hot-placement truth alignment

- `vura routes inspect` and `vura runtime advise` now report richer runtime
  profiles: WebSocket hot routes surface as `streaming-hot`, tasks pinned to a
  hot runtime (`runtime`/`placement`/`target: 'hot'` or `hot: true`) surface as
  `task-hot`, and their scheduled dispatch surfaces as `cron-hot` instead of
  being flattened to `cron-cold`. CLI truth-alignment only — this does not claim
  live `task-hot`/`cron-hot` execution is deployed.
- Added `VURA_DISABLE_IN_PROCESS_CRON` so a hosting control plane can own cron
  dispatch for platform-placed workloads. When set to `1`/`true`/`yes`, the
  standalone runtime skips starting its in-process scheduler even when
  scheduled tasks are registered. Unset (the default) preserves the existing
  self-hosted behavior where the runtime runs its own cron. Prevents duplicate
  cron execution when an external scheduler is already dispatching.

## 0.5.2 - 2026-06-23

Runtime placement release — makes Vura route bundles deployable on hosted
hot/cold targets and aligns the framework with the current What runtime
contract.

- Runtime route bundles are now built with Vura's automatic JSX runtime and
  ship a Workers-safe `process.env` fallback for neutral (edge) bundles, so the
  same route module runs across the Node runtime, the Cloudflare adapter, and
  hosted platform hot/cold targets without a broken `process` reference.
- Production hot servers now bind to a reachable host (`0.0.0.0`) by default so
  platform-deployed hot routes are actually reachable, matching the Node
  runtime's production host behavior.
- Aligned Vura with the current What Framework runtime contract
  (`what-core`/`what-framework` `0.11.x`), replacing the older `0.8.x` pin.
- Added `vura routes inspect` and `vura runtime advise` — read-only commands
  that surface each route's effective runtime placement (static / cold / hot /
  task / cron) before any deploy or control-plane mutation.
- Excluded generated source maps from the published CLI tarball to keep it
  inside its tracked package-size budget.

## 0.5.1 - 2026-06-19

Public install and release hardening.

- `@celsian/vura-cli` no longer installs the private closed-alpha
  `@celsian/vura-adapter-vura` package as a transitive dependency. Self-hosted
  installs and the self-host audit can now resolve from public npm packages
  without pulling the managed-platform adapter.
- `vura deploy` now reports a clear closed-alpha adapter message when the
  managed-platform adapter is not installed, instead of failing during package
  resolution.
- Release private-package assertions now reject publishable packages that ship
  install-time dependencies on private workspace packages.
- Bumped production `esbuild` ranges to `^0.28.1` to clear the current
  production audit advisory.

## 0.5.0 - 2026-06-12

WebSocket origin allowlists, WebSockets in `vura dev`, cache config wiring,
`req.parsedQuery`, and Lambda nodejs22.x.

### BEHAVIOR CHANGE — query coercion no longer overwrites `req.query` (Cloudflare/Lambda adapters + `validateRequest`)

- On the Cloudflare and Lambda adapters, and in the exported `validateRequest`
  helper, validated query coercion no longer overwrites `req.query`. The raw
  string values stay on `req.query`; the validated+coerced result is surfaced
  on `req.parsedQuery` instead. This matches what the Node/celsian runtime has
  always done — previously the same handler saw coerced values on `req.query`
  on those targets but raw strings on Node.
- `req.validated.query` still carries the coerced data, unchanged.
- **Migration:** if your handlers read coerced query values off `req.query` on
  Cloudflare or Lambda (e.g. `req.query.page` as a number), switch them to
  `req.parsedQuery` or `req.validated.query`.

### `req.parsedQuery`

- When a route declares `schema.query`, the request type now includes
  `parsedQuery` carrying the validated+coerced query object — typed on the
  request across the Node runtime, both adapters, and the compat `ThenRequest`.

### Hot routes — opt-in Origin allowlist

- Hot routes can now declare an Origin allowlist:
  `export const route = { kind: 'hot', origins: ['https://app.example.com'] }`.
  Cross-site browser WebSocket handshakes whose `Origin` is not on the list are
  rejected with a 403 before upgrade.
- Opt-in only: routes that don't set `origins` keep the existing accept-all
  behavior. An empty list (`[]`) denies all browser origins. Entries must be
  literal strings in the route export (they are read from the route's static
  config at scan time).

### WebSockets in `vura dev`

- Hot routes now accept WebSocket connections in dev — both the Vite dev path
  (`@celsian/vura-vite-plugin`, coexisting with Vite's own HMR socket) and the
  standalone `vura dev` server.
- The module instance is shared between WebSocket and HTTP handling per route,
  so module-level state (rooms, counters) is consistent across both.
- Route edits apply on the next connection; already-open sockets keep their
  existing handler. On route rescan, a notice reminds you that open clients
  keep the old room registry — reconnect to rejoin.
- Rescans are atomic in the standalone dev server: adding or deleting a route
  file takes effect on the first rescan, and a broken edit (syntax error)
  fails the rescan loudly while the last good routes keep serving — the dev
  server never crashes or wedges. On the Vite path, a route module that fails
  to load at connection time rejects the WebSocket handshake with a 500.

### Cache config wired into the generated server entry

- `VuraCacheConfig` from `vura.config` is now wired into the entry generated by
  `vura build`: `store`, `dir`, `maxEntries`, and CDN ids are emitted as
  literals.
- Secrets are **never** serialized into the entry — `revalidateSecret` and the
  CDN `apiToken` are always read from env at runtime
  (`VURA_REVALIDATE_SECRET` / `VURA_CDN_API_TOKEN`).
- `store: 'redis'` is a build-time error: a redis store needs a live client
  instance, which is not serializable at build time. Use the programmatic path
  (`createVuraCache({ store: 'redis', redisClient })`) instead.

### Self-host audit extended A0–A9 → A0–A12

- The self-host audit now proves static (A10), client (A11), and hybrid (A12)
  pages are served correctly from one generated entry, with the serving layer
  asserted per mode.
- The hybrid build warning was narrowed to the true limitation (dynamic
  param-pattern hybrid pages only) instead of warning on every hybrid page.

### adapter-lambda

- Default runtime bumped `nodejs20.x` → `nodejs22.x`.
- SAM template dedup: `Runtime`/`Architectures`/`MemorySize`/`Timeout` are
  inherited from `Globals` instead of repeated per function (fixes cfn-lint
  E3032/E3037).
- Per-function `package.json` with `{"type":"module"}` is emitted so Lambda's
  Node runtime accepts the ESM handler.
- These shipped on main since 0.4.0 and are first released here.

### Deprecations

- `ThenRequest`/`ThenReply`/`ThenHandler` removal is **deferred to 0.6** (the
  0.4.0 deprecation notices said v0.5). The aliases keep working in 0.5.x;
  deprecation strings updated accordingly.

## 0.4.0 - 2026-06-11

Hot routes, background tasks, and auth helpers.

### Hot routes (`kind: 'hot'`)

- Routes with `export const kind = 'hot'` (shorthand) or
  `export const route = { kind: 'hot' }` now enable a real WebSocket upgrade
  path backed by the Celsian `WSRegistry`. The route object wins when both are
  present; the shorthand also works for `'task'`.
- WebSocket messages are capped at 1 MB per frame (`maxPayload`) — ws's 100 MB
  default is too permissive for a public server.
- Export `websocket(peer: HotPeer, req: HotRequest)` in the route file to handle
  connections. Called once per open connection.
- `peer.send(data)` — fire-and-forget string or `ArrayBuffer` to this peer; no-op
  after close.
- `peer.broadcast(data, excludeSelf?)` — keyed by **concrete pathname** (e.g.
  `/api/chat/lobby`), not the route pattern — natural "room" semantics. Cross-room
  broadcast requires iterating peers manually.
- Binary frames are delivered as `ArrayBuffer` (correctly detected via `isBinary` —
  fixes prior version that stringified all frames including binary payloads).
- `req.params` carries path params extracted from the route pattern.
- SIGTERM drain: on shutdown the server sends close code `1001` (going away) to all
  open hot-route connections and waits for the drain to complete before exiting.
- New deploy templates (`dist/Dockerfile`, `dist/fly.toml`) emitted by `vura build`
  enable `fly deploy ./dist` without manual configuration.
- **Per-process state caveat**: `WSRegistry` is in-process; multi-instance
  deployments require an external message bus (e.g. Redis pub/sub) for cross-instance
  fan-out. See Celsian ws-redis docs.

### Background tasks on celsian cron

- Routes with `export const route = { kind: 'task' }` are now wired to the Celsian
  cron engine. Export `schedule = '0 3 * * *'` (cron expression) for automatic
  scheduling; omit for manual-trigger-only tasks.
- `runTaskOnce` — the canonical task executor: retry + per-attempt timeout +
  exponential backoff (100 × 2^attempt ms, capped at 30 s). Sync handlers work.
  Exported from `@celsian/vura-core` for use in custom wiring.
- `/__tasks` admin endpoint: `GET /__tasks` lists registered tasks + last run status;
  `POST /__tasks/:name` triggers a task manually with optional JSON body input.
  Auth: timing-safe bearer compare via sha256 (`THEN_TASK_SECRET` env), falls back
  to localhost-only in dev/test.
- Overlap guard: cron tick is skipped if the same task is still running from the
  previous tick (logs a warning). Manual POST triggers bypass this guard.
- Bounded result store: up to 10 000 jobs retained; evicted forward (no full sort).

### `vura tasks` CLI

- `vura tasks list` — print all registered tasks and their schedules.
- `vura tasks run <name>` — trigger a named task immediately (local dev / CI).

### Auth helpers

- `cookieSession(opts)` — returns a celsian `onRequest` hook that populates
  `req.session` with a signed, auto-persisted cookie session. Uses synchronous
  HMAC-SHA-256 via `node:crypto` — no external deps. Set-Cookie emitted
  automatically on session change across all celsian response paths (plain-object
  return, `reply.json`, `reply.html`, `reply.send`).
  **Limitation**: handlers that return a raw `new Response(...)` bypass celsian's
  header-merging path; Set-Cookie is NOT emitted in that case.
- `jwt` + `createJWTGuard` — re-exported from `@celsian/jwt`; no separate install
  needed.

### `ws` optional peer dependency

- `ws ^8.0.0` is listed as an optional peer dependency of `@celsian/vura-core`.
  Install it (`npm install ws`) only when deploying hot routes to a Node.js server.
  Serverless and Cloudflare Workers adapters do not require it.

### Breaking changes — removed legacy task exports

The following symbols were removed from `@celsian/vura-core`'s public API in 0.4.0
(they existed in 0.2.x but were never re-exported in 0.3.0):

- `TaskRunner` — replaced by `runTaskOnce` + `registerTaskCrons`
- `MemoryQueue` — replaced by `createTaskResultStore`
- `CronScheduler` — replaced by the Celsian cron integration in `registerTaskCrons`
- `parseCron` — replaced by cron strings passed directly to `@celsian/core`'s
  `app.cron()`

**Migration**: replace `new TaskRunner(...)` / `new MemoryQueue()` / `new CronScheduler()`
usages with `runTaskOnce` + `createTaskResultStore` + `registerTaskCrons` as shown in
the `packages/core/src/runtime/tasks.ts` source.

### create-vura scaffold additions

- Default scaffold now includes `src/api/chat.ts` — a hot-route WebSocket echo/broadcast
  example with inline documentation of the full peer contract.
- Default scaffold now includes `src/api/cleanup.ts` — a scheduled task example
  (`0 3 * * *`) with `vura tasks run cleanup` documented in a comment.
- Scaffold declares `ws` as a dependency (the chat example needs it) and
  ignores `.env` files by default.

### Fixes

- **Client-mode pages now actually mount in production builds.** Previous
  versions bundled the raw page module and never called `mount()` — the page
  sat on its loading placeholder forever. The build now generates a
  mount/hydrate entry per client/hybrid page, and `vura dev` serves client
  pages with the same contract instead of SSR-ing them (which crashed hook
  components).
- Array values in route/page config are parsed (`tags: ['posts']` no longer
  silently dropped; string form also works).
- Schema `query` keys now validate the querystring (mapped to celsian's
  `querystring`). Validated values are NOT coerced back into `req.query` yet —
  read raw strings; coercion write-back is planned.
- Building with the Cloudflare or Lambda adapter warns when hot routes are
  skipped (they need a persistent host) instead of dropping them silently.
- `revalidateTag`/`revalidatePath` imported inside Lambda function bundles are
  warn-only stubs (build parity with Cloudflare; real revalidation must reach
  the cache host's `/__vura/revalidate` webhook).

## 0.3.0 - 2026-06-11

Rebased on what-framework 0.11 + what-isr ISR engine + Celsian API layer.

### What-Framework 0.11 rebase

- Removed the built-in SSR renderer; Vura now delegates directly to what-framework's `renderToString` and `createRequestHandler` exports.
- Server entry is generated as a thin wiring file and bundled self-contained by esbuild — no framework internals leak into userland.

### ISR engine via what-isr

- `revalidateTag` and `revalidatePath` are now first-class exports from `@celsian/vura-core`.
- Page config supports `revalidate` (TTL in seconds) and `tags` (string array) fields.
- `/__vura/revalidate` webhook endpoint activates on-demand ISR via tag/path.
- Cloudflare and Fastly CDN purge config available on `createVuraCache` for
  custom `startVuraServer` setups (wiring it through `vura.config` is planned;
  the generated entry currently configures `revalidateSecret` only).

### API layer on @celsian/core

- API routes now run on a `CelsianApp` instance (from `@celsian/core ^0.5.2`).
- Route handlers support both schema-first (Celsian options object) and plain function form.
- Global hooks (`onRequest`, `onResponse`, `onError`) are mapped to Celsian lifecycle hooks.
- Dev mode, standalone dev server, and production all use the same CelsianApp — dev/prod parity.

### Breaking changes / deprecations

- **`ThenRequest` / `ThenReply` deprecated** — use `CelsianRequest` / `CelsianReply`. A compat alias keeps existing code working during migration:
  - `req.body` still works via compat alias of `parsedBody`.
  - `req.headers['x']` → `req.headers.get('x')` (Headers object, not plain record).
  - `req.url` is now a full URL string — use `new URL(req.url).pathname` to get the path.
- `onResponse` hooks receive a synthesized `responseInfo` object; `hadError` is always `false` on the success path.
- Intentional API 404s are now honoured in dev mode (previously swallowed by the dev middleware).

### Migration snippet

```ts
// Before (0.2.x)
import type { ThenRequest, ThenReply } from '@celsian/vura-core';
export function GET(req: ThenRequest, reply: ThenReply) {
  const path = req.url;               // was already a path string
  const ct   = req.headers['content-type'];
  return reply.json({ ok: true });
}

// After (0.3.0)
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';
export function GET(req: CelsianRequest, reply: CelsianReply) {
  const path = new URL(req.url).pathname;   // req.url is now a full URL
  const ct   = req.headers.get('content-type');
  return reply.json({ ok: true });
}
```

## 0.1.0 - 2026-05-10

Initial Vura/ThenJS public package release candidate.

- Ships the core runtime, compiler, CLI, Vite plugin, create app scaffold, and deployment adapters.
- Includes production static serving, API/task hardening, CLI `vura`/`thenjs` aliases, and clean tarball smoke coverage.
- Excludes the native compiler prototype from npm publishing until platform-specific native artifacts are released.
