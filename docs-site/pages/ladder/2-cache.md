# Rung 2 — Server + cache: fresh content without rebuilding

You need fresh content without rebuilding.

## Server mode

A server-mode page renders on every request. The output is never cached by
default — it is always fresh, at the cost of a render on every hit. This is
the right starting point before you add caching:

```tsx
// src/pages/posts.tsx
export const page = { mode: 'server' };

export default async function Posts() {
  const posts = await db.posts.list();
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

export default async function Posts() {
  const posts = await db.posts.list();
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
the next request triggers a fresh render. On a self-hosted Node deployment,
the store is in-process memory. You can configure a Redis-backed store for
multi-instance setups.

Cache-Control headers for CDN integration are emitted automatically when a CDN
adapter is configured. Without an adapter, caching is server-side only.

## Verify it locally

Build and run, then observe the `Age` response header:

```sh
# 1. Build + start
npm run build
PORT=3000 NODE_ENV=production node dist/server/entry.js

# 2. First request — renders fresh (Age: 0 or absent)
curl -s -D - http://localhost:3000/posts | grep -E 'Age:|cache'

# 3. Mutate (triggers revalidateTag)
curl -s -X POST http://localhost:3000/api/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"New post"}'

# 4. Next GET — fresh render because cache was invalidated
curl -s -D - http://localhost:3000/posts | grep -E 'Age:|cache'
```

## Next

**[Rung 3 — API route →](/ladder/3-api/)**
