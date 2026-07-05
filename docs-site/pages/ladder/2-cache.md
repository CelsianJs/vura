# Rung 2 — Server + cache: fresh content without rebuilding

You need fresh content without rebuilding.

## Server mode

A server-mode page renders on every request. The output is never cached by
default — it is always fresh, at the cost of a render on every hit. Use
`getServerData` to fetch data server-side and receive it as props:

```tsx
// src/pages/posts.tsx
export const page = { mode: 'server' };

export async function getServerData() {
  const posts = await db.posts.list();
  return { posts };
}

export default function Posts({ posts }) {
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

## Adding ISR caching

Add `revalidate` (seconds) and `tags` to the page config. Vura will cache the
rendered HTML and serve the stale copy while revalidating in the background.
`revalidate: 60` means: serve the cached version, re-render if the cache is
older than 60 seconds.

```tsx
// src/pages/posts.tsx
export const page = {
  mode: 'server',
  revalidate: 60,      // seconds until stale; re-renders in background
  tags: ['posts'],     // cache tags — used for on-demand invalidation
};

export async function getServerData() {
  const posts = await db.posts.list();
  return { posts };
}

export default function Posts({ posts }) {
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

The `revalidate` and `tags` fields are flat properties on the page config
object — they are not nested inside a `revalidate` object.

## On-demand invalidation

When a post is created or updated, call `revalidateTag` to immediately
invalidate every cached copy tagged `'posts'`:

```ts
// src/api/posts.ts
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';
import { revalidateTag } from '@celsian/vura-core';

export async function POST(req: CelsianRequest, reply: CelsianReply) {
  const post = await db.posts.create(req.parsedBody);
  await revalidateTag('posts'); // every cached copy tagged 'posts', purged now
  return reply.json(post);
}
```

`revalidatePath` is also available for path-based invalidation.

## How it works

The cache engine (`what-isr`) stores rendered HTML in memory by default. When
`revalidateTag` is called, what-isr evicts all entries carrying that tag so
the next request triggers a fresh render. To persist the cache across server
restarts, set `cache: { store: 'filesystem' }` in `vura.config` — `vura build`
wires it into the generated entry (a relative `dir` resolves from the server
process cwd). Redis needs a live client and so cannot be wired through the
generated entry; use `createVuraCache({ store: 'redis', redisClient })` with
`startVuraServer()` in your own server entry.

Cache-Control headers for CDN integration are emitted automatically when a CDN
adapter is configured. Without an adapter, caching is server-side only.

## Cache-tag response headers

Every tagged ISR response carries its tags on two headers:

- **`x-vura-cache-tag`** — a comma-separated list of the page's tags. This is
  the header Vura Platform reads.
- **`Cache-Tag`** — the same value, for a self-hosted Cloudflare/Fastly zone
  that purges by tag directly (no Vura edge in front).

```sh
curl -sI http://localhost:3000/posts | grep -i 'cache-tag'
# cache-tag: posts
# x-vura-cache-tag: posts
```

Tags are sanitised before they hit the wire: trimmed, de-duplicated, stripped
of control characters, each capped at **128 characters**, and at most **64
tags** per response (commas inside a tag are treated as separators). Declare a
sensible handful of stable tags — not one per row.

Only **ISR** responses (a page with `revalidate` **and** `tags`) emit these
headers. `mode: 'server'` without `revalidate` is never cached, `mode: 'static'`
pages are prebuilt at deploy time, and `mode: 'client'` pages ship no
server-rendered HTML — none of them carry a cache tag.

## Purge by tag on Vura Platform

When you deploy to Vura Platform, the edge router reads `x-vura-cache-tag` off
each response and:

1. **Namespaces** every tag under your project as `project:{id}:{tag}` before
   stamping Cloudflare's `Cache-Tag`, so one tenant's `posts` can never purge or
   collide with another's on the shared zone.
2. **Records** each tagged response as a cache event, lighting up per-tag
   cache-hit analytics in the dashboard.

Purge-by-tag from the dashboard (or `revalidateTag` from your code) then evicts
exactly the responses carrying that tag — project-scoped, never zone-wide. No
configuration is required: the headers flow automatically for any app built with
a Vura version that emits them.

## Verify it locally

Build and run, then observe the `x-what-cache` response header:

```sh
# 1. Build + start
npm run build
PORT=3000 NODE_ENV=production node dist/server/entry.js

# 2. First request — renders fresh (x-what-cache: MISS)
curl -s -D - http://localhost:3000/posts | grep -E 'x-what-cache|cache-tag'

# 3. Mutate (triggers revalidateTag)
curl -s -X POST http://localhost:3000/api/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"New post"}'

# 4. Next GET — fresh render because cache was invalidated (x-what-cache: MISS again)
curl -s -D - http://localhost:3000/posts | grep -E 'x-what-cache|cache-tag'
```

## Next

**[Rung 3 — API route →](/ladder/3-api/)**
