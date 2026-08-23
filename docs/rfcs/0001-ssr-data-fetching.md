# RFC 0001 — Server-side data fetching for pages

- **Status:** **APPROVED** 2026-08-23 by Kirby — accepted as written. Not yet implemented.
- **Author:** wave-2 worker
- **Date:** 2026-07-03 (approved 2026-08-23)
- **Decision:** the recommended API shape is approved: route-level `loader` exports plus a typed `useLoaderData<typeof loader>()`, layered along the existing layout chain, with loader data serialized into the HTML for hydration. `getServerData` is retained as a deprecated alias. Streaming ships as an additive follow-up, not as part of phase 1. The refusal of component-level async "server components" stands, for the reason given below: What Framework's `renderToString` is synchronous, and awaiting inside the component tree would require forking What's renderer.

### Implementation order

1. `loader` export + `LoaderContext` (`params`, `url`, `query`, `request`, `notFound()`, `redirect()`), running before the synchronous render.
2. `useLoaderData<typeof loader>()` reading from context, no prop drilling.
3. Layered loaders across the matched layout chain, run in parallel via `Promise.all`.
4. Serialization into `<script id="__VURA_LOADER__" type="application/json">` so `hybrid` islands hydrate without re-fetching.
5. `getServerData` mapped onto the same machinery as a deprecated alias, spread-into-props behaviour preserved.
6. Docs: make `/reference/data-fetching` name this as the server-side answer, and drop its "not available yet" forward reference.
7. Later, additive: streaming via What's existing `renderToStream`, surfaced as per-segment boundaries.

---

## TL;DR

Vura's top gap vs. Next.js is "fetch on the server at request time, render the page with that data already in place." We **partially** have this today — `getServerData` is a page-level server loader — but it is unnamed, single-level (no co-location in nested layouts/components), not serialized for client hydration, and undocumented as the answer.

**Recommendation: evolve `getServerData` into a first-class, layered `loader` + a typed `useLoaderData<T>()` accessor.** Fetch stays in an async phase *before* a synchronous render, exactly as it works now. **Do not** adopt component-level async "server components." The load-bearing reason is one fact about our stack: **What Framework's `renderToString` is synchronous**, so awaiting data *inside* the component tree would require forking What's renderer — a separate project, enormous blast radius. Route-level loaders keep every `await` outside the render and compose with everything we already ship (ISR, layouts, hydration, hot routes).

---

## Problem

A Vura page that needs request-time server data can only get it through `getServerData`:

```ts
// runtime/pages.ts today
const serverData = await mod.getServerData({ params, url, query });
const vnode = mod.default({ ...serverData, params });   // sync render
renderToString(vnode);
```

That works, but it has real limits:

1. **Page-level only.** A layout and its nested page can't each declare their own server data — everything must funnel through one `getServerData` at the leaf and be prop-drilled down.
2. **No client story.** Server-mode pages don't hydrate, and the loaded data is never serialized into the HTML, so an interactive island on a server-rendered page can't start from the server data — it must re-fetch on the client.
3. **Discoverability.** It isn't named "the way to fetch on the server," isn't typed end-to-end, and isn't in the docs as the answer.
4. **No streaming.** The whole page blocks on the slowest fetch before any bytes flush.

## Constraints (what forces the design)

- **What's `renderToString(vnode)` is synchronous.** (Confirmed in `what-framework/server.d.ts` and in how vura calls it.) There is no per-component `await`/Suspense-data model exposed on the server renderer. What *does* ship `renderToStream(vnode): AsyncGenerator<string>` — progressive flush of a still-synchronous tree — which we can adopt for streaming, but it does **not** give us "await inside a component."
- **What Framework is a separate project.** Vura should not fork What's renderer to add async server components. Our leverage is at the *route/loader* layer, not the render layer.
- **We already have the right shape.** `getServerData` proves the model: do the async work in a loader phase, hand plain data to a synchronous render. The evolution is additive, not a rewrite.
- **It must compose with what exists:** route kinds (`serverless` / `hot` / `task`), page modes (`static` / `server` / `client` / `hybrid`), ISR (`revalidate` + `tags`), layout chains, and the client hooks (`useFetch`/`useQuery`) that already cover the browser side.

---

## Recommendation: route-level loaders + `useLoaderData`

### 1. A named `loader` export (supersedes `getServerData`)

Any page **or layout** may export a `loader`. It runs on the server before render, receives a typed context, and returns plain JSON-serializable data.

```tsx
// src/pages/posts/[id].tsx
import type { LoaderContext } from '@celsian/vura-core';

export const page = { mode: 'server', revalidate: 60, tags: ['posts'] };

export async function loader(ctx: LoaderContext) {
  const post = await db.post.find(ctx.params.id);   // runs on the server only
  if (!post) throw ctx.notFound();                   // typed control-flow throws
  return { post };
}

export default function Post() {
  const { post } = useLoaderData<typeof loader>();   // typed, no prop-drilling
  return <article><h1>{post.title}</h1>{/* … */}</article>;
}
```

- `useLoaderData<typeof loader>()` returns the awaited return type of the nearest matching `loader` — fully typed, read from context, so no manual prop threading.
- `ctx` = `{ params, url, query, request, notFound(), redirect(to, status?) }`. `notFound`/`redirect` are typed throws the runtime turns into the right HTTP response.
- **`getServerData` stays working** as a deprecated alias (its `{ ...data }` spread-into-props behavior is preserved) so nothing breaks on day one.

### 2. Layered loaders (the co-location answer)

Loaders compose along the existing layout chain. Each segment's loader runs, and each level reads *its own* data via `useLoaderData`. This is how a nested component gets server data without the page having to fetch on its behalf.

```
src/pages/dashboard/_layout.tsx   loader → { user }
src/pages/dashboard/billing.tsx   loader → { invoices }
```

`_layout` renders `useLoaderData<typeof layoutLoader>().user`; `billing` renders its own invoices. Loaders at sibling levels run **in parallel** (`Promise.all` across the matched chain) so nesting doesn't serialize latency.

### 3. Hydration: serialize once, no client re-fetch

On render, the runtime serializes the collected loader data into the HTML:

```html
<script id="__VURA_LOADER__" type="application/json">{"…":"…"}</script>
```

On `hybrid` pages, `hydrate()` reads that payload so islands start from the server data instead of re-fetching. This is the piece that makes server data usable by client interactivity — and it's why the recommendation leans on `hybrid` for "server data + interactivity," reserving pure `server` mode for zero-JS pages.

### 4. Streaming (phase 2, not blocking)

Ship buffered SSR first (await all loaders, then `renderToString`). Streaming is a **follow-up** that swaps in What's existing `renderToStream` and lets a slow segment's loader resolve after the shell has flushed — surfaced as a `<Suspense>`-style boundary per route segment. Gated on validating What's `renderToStream` drives our layout tree cleanly; no new render-layer invention required.

---

## How it composes

| Surface | Behavior |
|---|---|
| `mode: 'server'` | loaders run per request; buffered SSR; `Cache-Control: private, no-store` unless `revalidate` |
| `mode: 'server'` + `revalidate`/`tags` | loader result is part of the ISR-cached render; `revalidateTag` re-runs it (what-isr, unchanged) |
| `mode: 'static'` | loader runs **at build time** (params from the generated path set); becomes a static loader — same code, no request context beyond params |
| `mode: 'hybrid'` | loader runs server-side; data serialized + rehydrated so islands skip the first fetch |
| `mode: 'client'` | no loader; use the client hooks (`useFetch`/`useQuery`) — documented boundary, unchanged |
| route kind `hot` | orthogonal — hot routes are WebSocket handlers, not pages; a page may `useLoaderData` for the initial snapshot and a hot route for the live stream |
| route kind `serverless` / `task` | unaffected — loaders are a *page* concept, API routes keep their own handlers |

---

## Migration path

1. Land `loader` + `useLoaderData` + serialization; keep `getServerData` as a documented deprecated alias mapped onto the same machinery (spread-into-props preserved).
2. Update the scaffold's example + the Data-fetching docs page to show `loader`/`useLoaderData` as the server-side answer (the docs page already forward-references this RFC).
3. A later minor prints a deprecation note for `getServerData`; remove it no earlier than the next major.
4. Streaming ships as an additive opt-in after buffered SSR is proven.

No changes required to What Framework. All new surface is in `@celsian/vura-core` (loader execution, context, serialization) and the CLI/runtime page handlers.

---

## Alternatives considered

**A. Component-level async "server components" (Next.js App Router / RSC).**
Any component is `async` and awaits data inline. Best co-location and the model people ask for by name. **Rejected:** requires an async-aware server renderer with per-component Suspense-data. What's `renderToString` is synchronous and What is a separate project — we'd be forking someone else's renderer, the single biggest, most fragile change we could pick. Route-level loaders deliver ~90% of the co-location benefit (via layered loaders) at a fraction of the risk, entirely within Vura's own code.

**B. Client-only (do nothing new).**
Tell everyone to use `useFetch`/`useQuery` and render a loading state. Cheapest. **Rejected:** it's the exact gap — no server-rendered data means worse TTFB, SEO, and waterfalls; it doesn't answer "render the page with data already there."

**C. A `use()`-style server data hook read during render.**
A hook that suspends the sync renderer on a promise. **Rejected:** suspending a *synchronous* renderer is the async-server-component problem in disguise; same What-renderer constraint, same reason.

---

## Recommendation, restated

Adopt **route-level layered loaders + typed `useLoaderData`**, buffered SSR first, streaming via What's `renderToStream` as a fast-follow. It is the evolution of the model we already ship (`getServerData`), it stays inside Vura's own code, and it composes with ISR, layouts, hydration, and hot routes without touching What Framework.

## Open questions for Kirby

1. **Name:** `loader` (Remix) vs. keep/upgrade `getServerData`? Recommendation: `loader`, alias the old name.
2. **Accessor:** `useLoaderData<typeof loader>()` (typed via the loader's return) — good enough, or do you want an explicit generated route-types file?
3. **Scope of v1:** ship buffered-SSR loaders alone and defer streaming + layered/parallel loaders to v2, or land layered loaders in v1?
4. **`hybrid` as the default for "server data + interactivity"** — comfortable steering people there, or should `server` mode gain optional hydration too?
