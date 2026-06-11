# Page modes

Pages live in `src/pages/`. The `mode` field of the `page` export controls when rendering happens, what the browser receives, and how Vura's build splits the work.

```ts
export const page = { mode: 'static' };
```

If no `page` export is present, `mode` defaults to `'static'` (or whatever `pages.defaultMode` is set to in `vura.config.ts`).

---

## `static`

Rendered at build time to a plain HTML file. No JavaScript is shipped to the browser unless the page imports it explicitly.

**When `vura build` runs:**
```
dist/static/about/index.html    ← self-contained HTML
```
No `_then/` script bundle. The file can be served by any static host with no Node process.

**Hydration:** none. The browser receives HTML and CSS only.

**When to use:** marketing pages, documentation, pricing tables, blog posts from a CMS snapshot — any page whose content does not change between deploys.

```ts
export const page = { mode: 'static' };

export default function About() {
  return <main><h1>About us</h1></main>;
}
```

---

## `server`

Rendered on each request by the Node server (or equivalent). Fresh data on every request.

**When `vura build` runs:**
```
dist/server/entry.js    ← the unified server handles this route at request time
```
No prerendered HTML file for server-mode pages. The server calls What Framework's `createRequestHandler` to render on demand.

**With `revalidate`:** when a `revalidate` value (seconds) is set on the `page` config, what-isr caches the response and stale-while-revalidate serves it. This is ISR.

```ts
export const page = {
  mode: 'server',
  revalidate: 60,          // seconds; omit for pure server-mode (no cache)
  tags: ['posts'],         // array of cache tags; revalidateTag('posts') purges
};

export async function getServerData({ params, url, query }) {
  const data = await fetchSomething(params.id);
  return { data };
}

export default function Post({ data }) {
  return <article>{data.title}</article>;
}
```

**`getServerData` contract:** exported async function called before rendering on each request (or on cache miss for ISR). Receives `{ params, url, query }`. Its return value is spread as props into the page component. Absent on static/client pages — they have no server context.

**`revalidate` and `tags`:**
- `revalidate: 60` — cache the rendered HTML for 60 seconds, then revalidate in the background (stale-while-revalidate)
- `tags: ['posts', 'featured']` — tag this entry so `revalidateTag('posts')` or `revalidateTag('featured')` purges it on demand. Tags may be an array of strings or a comma-separated string; both are normalized to an array at runtime.
- Combined: `revalidate` controls the background revalidation interval; `tags` enable on-demand purge at any time.

**Without `revalidate`:** the page renders fresh on every request. `Cache-Control: private, no-store` is set by What Framework's request handler — Vura does not override it.

**Hydration:** none. Server-rendered HTML arrives complete. If you need client-side interactivity on a server-rendered page, use `hybrid` instead.

**When to use:** pages that need data from a database or API, pages with per-user content, any page where content changes between deploys.

---

## `client`

A client-only shell. The server emits a minimal HTML page with an `#app` div; the page component is bundled for the browser and mounts client-side.

**When `vura build` runs:**
```
dist/static/dashboard/index.html        ← shell HTML with #app and <script>
dist/static/_then/pages/dashboard.js    ← bundled client entry
```

The HTML file contains `<div id="app">Loading...</div>` until the browser boots the component and calls `mount()`. The generated client entry (from `generateClientPageEntry`) does this automatically — no manual mount call needed.

**Hydration:** client mounts fresh (no prerendered content to attach to).

**When to use:** fully interactive dashboards, authenticated pages, canvas/WebGL apps, anything that cannot be server-rendered. Every route under this page loads the framework JS.

```ts
export const page = { mode: 'client' };

export default function Dashboard() {
  // useState, useEffect, event handlers all work here
  return <main>...</main>;
}
```

---

## `hybrid`

Prerendered at build time _and_ hydrated in the browser. The server emits a fully-rendered HTML file; the browser then attaches the component to that DOM and makes it interactive.

**When `vura build` runs:**
```
dist/static/landing/index.html          ← prerendered HTML (same content as static)
dist/static/_then/pages/landing.js      ← hydration entry
```

The generated client entry calls `hydrate()` instead of `mount()`, attaching to the existing DOM without discarding it.

**Known limitation — hooks in SSR (v0.4):** `hybrid` pages are prerendered at build time and hydrated at runtime, but at v0.4 the SSR render for hybrid pages is not yet served at request time by the production server. If a hybrid page is present, `vura build` emits:

```
[vura] hybrid pages are not yet served at runtime (v0.4): src/pages/landing.tsx
```

The build still emits the prerendered HTML and the hydration bundle, so the page works correctly in the browser. The warning means: if you update the component, the HTML is re-generated on the next build, not on each request. For pages that need per-request rendering with hydration, use `server` mode today; full hybrid server-rendering is planned.

**When to use:** pages that benefit from both prerendered HTML (SEO, initial paint) and client-side interactivity (animations, reactive state). Good for landing pages with interactive sections.

---

## Choosing a mode

| Need | Mode |
|---|---|
| No JavaScript, pure content | `static` |
| Data from a database or API at request time | `server` |
| ISR (stale content is fine, purge on mutation) | `server` + `revalidate` + `tags` |
| Fully interactive, authenticated | `client` |
| Prerendered for SEO + client-side interactivity | `hybrid` |

## Build output summary (v0.4)

```
dist/
  static/           ← static, client, and hybrid pages
    about/index.html
    dashboard/index.html   (client — shell only)
    landing/index.html     (hybrid — prerendered + hydration bundle)
    _then/pages/
      dashboard.js          (client bundle)
      landing.js            (hybrid hydration bundle)
  server/
    entry.js         ← unified server handles server-mode pages at request time
  manifest.json
  Dockerfile         ← emitted only when hot routes are present
  fly.toml           ← emitted only when hot routes are present
```
