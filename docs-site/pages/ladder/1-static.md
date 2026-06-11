# Rung 1 — Static page: zero JavaScript shipped

You need a marketing page.

## The default is static

When a page file does not export a `page` config at all, Vura defaults to
`mode: 'static'`. Static pages are rendered to HTML at build time. No
framework JavaScript is shipped to the browser — the output is a plain `.html`
file.

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

## What `vura build` emits

After `npm run build`, the about page lands at:

```
dist/static/about/index.html
```

There is no `_then/` script bundle next to it. The HTML file is self-contained
and can be served by any static host — Cloudflare Pages, S3, Nginx, or a
plain CDN — with no Node process required.

If you need a page that reads fresh data from a database or an external API
without a full rebuild, move to server mode with optional caching:

**[Rung 2 — Server + cache →](/ladder/2-cache/)**

## When to stay static

Static is the right choice for any page whose content does not change between
deploys: landing pages, documentation, about pages, pricing tables, blog posts
built from a CMS snapshot. When the content changes on a schedule or on
mutation, rung 2 gives you that without rebuilding.

## Next

**[Rung 2 — Server + cache →](/ladder/2-cache/)**
