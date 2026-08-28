# Data fetching

Vura pages are What Framework components, so they get What's data-fetching hooks for free. These hooks run **in the browser** — they fetch after the page mounts or hydrates. They are the right tool for `client` and `hybrid` pages that talk to your `/api/*` routes or any HTTP endpoint.

```tsx
import { useFetch } from 'what-framework';

export const page = { mode: 'client' };

export default function Dashboard() {
  const hello = useFetch('/api/hello');
  return (
    <p>
      {() =>
        hello.isLoading()
          ? 'Loading…'
          : hello.error()
            ? 'Failed to load'
            : hello.data()?.message}
    </p>
  );
}
```

> **These are client-side hooks.** They do not fetch during static prerender or server-mode SSR: on those render passes they return their loading state. For data that must be fetched **on the server** and rendered into the HTML, export a [`loader`](#loader-server-side-data-fetching).

---

## The hooks at a glance

| Hook | Reach for it when | Returns |
|---|---|---|
| `useFetch(url, options?)` | You just need to GET a URL and render the result | `{ data, error, isLoading, refetch, mutate }` |
| `createResource(fetcher, options?)` | The fetch depends on a reactive **source** (an id, a search term) and should re-run when it changes | `[data, { loading, error, refetch, mutate }]` |
| `useSWR(key, fetcher, options?)` | You want stale-while-revalidate caching keyed by a string | `{ data, error, isLoading, isValidating, mutate, revalidate }` |
| `useQuery(options)` | You want a query cache with background refetch, shared across components | `{ data, error, status, isLoading, isFetching, isError, isSuccess, refetch }` |
| `useInfiniteQuery(options)` | Paginated / "load more" lists | `{ data, hasNextPage, fetchNextPage, isFetchingNextPage, … }` |

All of the returned fields are **getters** — call them (`hello.data()`, `hello.isLoading()`) inside a reactive expression so the UI updates as the request resolves.

---

## `useFetch` — the simple case

Give it a URL. It fetches on mount and exposes reactive `data`, `error`, and `isLoading`, plus a `refetch()` to run it again.

```tsx
import { useFetch } from 'what-framework';

const user = useFetch('/api/users/me');

// data() is undefined until the request resolves — guard it
user.data()?.name;
user.isLoading();     // true while in flight
user.error();         // the thrown error, or undefined
await user.refetch(); // re-run the request
user.mutate(next);    // set data locally without refetching
```

Pass fetch options as the second argument (`useFetch('/api/thing', { headers: { … } })`).

## `createResource` — fetch that tracks a source

When the request depends on reactive state, `createResource` re-runs the fetcher whenever the source changes and cancels the in-flight request with an `AbortSignal`.

```tsx
import { useSignal, createResource } from 'what-framework';

const userId = useSignal(1);

const [user, { loading, error, refetch }] = createResource(
  async (id, { signal }) => {
    const res = await fetch(`/api/users/${id}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  { source: () => userId() },
);

// Changing the source re-fetches automatically:
userId.set(2);

// Render:
() => (loading() ? 'Loading…' : error() ? 'Error' : user()?.name);
```

## `useSWR` — stale-while-revalidate

Keyed caching: the first render fetches, subsequent renders serve the cached value and revalidate in the background. A `null`/`false` key skips the request (useful for dependent fetches).

```tsx
import { useSWR } from 'what-framework';

const { data, error, isValidating, mutate, revalidate } = useSWR(
  '/api/profile',
  (url, { signal }) => fetch(url, { signal }).then((r) => r.json()),
);

await revalidate();        // force a refresh
mutate(optimisticValue);   // optimistic update; revalidates by default
```

## `useQuery` — a shared query cache

`useQuery` maintains a cache shared across components, with background refetching and imperative cache control. Reach for it when the same data is used in several places or needs to be invalidated after a mutation.

```tsx
import { useQuery, invalidateQueries, setQueryData } from 'what-framework';

const posts = useQuery({
  queryKey: 'posts',
  queryFn: ({ signal }) => fetch('/api/posts', { signal }).then((r) => r.json()),
});

posts.status();   // 'pending' | 'success' | 'error'
posts.isFetching();

// After creating a post, refetch every query under this key:
await invalidateQueries('posts');

// …or write the cache directly for an optimistic update:
setQueryData('posts', (prev) => [newPost, ...(prev ?? [])]);
```

`useInfiniteQuery` extends this with `fetchNextPage()` / `hasNextPage()` for pagination. `prefetchQuery(key, fetcher)` warms the cache ahead of navigation.

---

## `loader`: server-side data fetching

A page or layout can export a `loader`. It runs **on the server, before the component renders**, and the component reads its result with `useLoaderData()`. The data is already in the HTML the browser receives, so there is no loading state, no request waterfall, and no client round trip.

```tsx
// src/pages/posts/[id].tsx
import { useLoaderData, type LoaderContext } from '@celsian/vura-core';

export const page = { mode: 'server', title: 'Post' };

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

`useLoaderData<typeof loader>()` is typed from the loader's return type, so renaming a field is a compile error rather than an `undefined` at runtime.

### What the loader receives

```ts
interface LoaderContext {
  params: Record<string, string>;              // matched dynamic segments
  url: string;                                 // the pathname
  query: Record<string, string | string[]>;    // parsed query string
  request?: Request;                           // absent at build time (see below)
  notFound(message?): LoaderNotFoundError;     // throw it
  redirect(to, status?): LoaderRedirectError;  // throw it
}
```

`notFound()` and `redirect()` **return** an error for you to throw, so the throw is visible at the call site and TypeScript narrows the code after it:

```ts
if (!session) throw ctx.redirect('/login');   // 302 by default
if (!post) throw ctx.notFound();              // renders the 404 page
```

A loader that throws anything else is a 500, logged like any other server error. `notFound` and `redirect` are not: they are ordinary control flow and never look like an outage.

### Loaders compose along the layout chain

Each segment in the matched chain gets its own loader, and each component reads its own segment's data. Nothing is prop-drilled.

```
src/pages/dashboard/_layout.tsx   loader → { user }
src/pages/dashboard/billing.tsx   loader → { invoices }
```

The layout renders `useLoaderData<typeof loader>().user`; the page renders its own invoices. A component nested three levels inside the page still reads the page's data, because the scope follows the component tree.

**Loaders in a chain run in parallel.** A layout's loader and its page's loader have no data dependency on each other, so nesting costs no extra latency.

Layouts apply in every page mode. A `static` or `hybrid` page is wrapped in its layout chain at build time, with each layout's loader running then too, and a hybrid page's browser bundle rebuilds the same chain during hydration so the tree the browser walks is the tree the server rendered.

### Reading loader data in a page that also runs in the browser

`useLoaderData` imports from `@celsian/vura-core` in any page:

```tsx
import { useLoaderData } from '@celsian/vura-core';
```

For a `client` or `hybrid` page this import is redirected at build time to `@celsian/vura-core/client`, the browser-safe half of the package, so the page bundles for a browser without dragging in the build system. You can write that subpath explicitly if you prefer; the two are the same module. What you cannot do is reach a server-only export (`createApiApp`, `revalidateTag`, anything touching the filesystem) from a page that runs in the browser: the build stops with esbuild naming the symbol.

On a `hybrid` page the accessor works on both sides. The server renders with the loader's data, serializes it into the document, and the client re-opens the same scope from that payload during hydration, so the component reads the same object in the browser that it read on the server, with no second request.

### It works with every page mode

| Mode | When the loader runs |
|---|---|
| `server` | On every request. `ctx.request` is available for headers and cookies. |
| `server` + `revalidate` / `tags` | On cache miss. The result is part of the ISR-cached render, and `revalidateTag()` re-runs it. |
| `static` | Once, at build time. There is no request, so `ctx.request` is `undefined` and `notFound()` / `redirect()` are build errors. |
| `hybrid` | Once, at build time, like `static`. The result is serialized into the page, and the browser hydrates from it, layout chain included, instead of re-fetching. |
| `client` | Not at all. Use the client hooks above. |

### The serialized payload

Every render writes the loader data into the document:

```html
<script id="__VURA_LOADER__" type="application/json">{"page":{"post":{…}}}</script>
```

It sits outside `<div id="app">` so it never participates in hydration, and it is `application/json` rather than executable JavaScript.

Loader data must survive a JSON round-trip unchanged, because the server renders from your object and the browser hydrates from `JSON.parse` of this payload. Anything that would come back different fails the render with a message naming the exact path, for example ``loader data is not JSON-serializable: `page.post` is a Post instance``. That covers functions, class instances (including `Map`, `Set` and `Error`), circular references, symbols, bigints, and `NaN` / `Infinity`.

Two things are deliberately allowed:

- **`Date`** is the one exception. It arrives in the browser as an ISO string, not a `Date`, so parse it if you need date methods on the client.
- **`undefined` as an object property.** JSON drops the key, and a missing key and a key holding `undefined` both read as `undefined`, so the two renders cannot disagree. Inside an **array** `undefined` would come back as `null`, which is a different value, so that is refused.

### Migrating from `getServerData`

`getServerData` still works and still spreads its result into the component's props. It is now an alias for the same machinery, so its data is *also* readable through `useLoaderData()`, which means a page can migrate one line at a time:

```tsx
// Before
export async function getServerData({ params }) { return { post: await find(params.id) }; }
export default function Post({ post }) { … }

// After
export async function loader(ctx: LoaderContext) { return { post: await find(ctx.params.id) }; }
export default function Post() { const { post } = useLoaderData<typeof loader>(); … }
```

If a page exports both, `loader` wins and `getServerData` is ignored. `getServerData` will start printing a deprecation notice in a later minor and will not be removed before the next major.

---

## Gotcha: `useSWR` / `useQuery` auto-select server mode

If a page has **no explicit `mode`**, Vura's manifest scanner treats an import of `useSWR`, `useQuery`, or `useServerData` as a signal that the page needs server rendering and defaults it to `mode: 'server'`. Since these hooks fetch client-side, a server-mode page renders their loading state and never hydrates — the request never runs.

**Always set `mode` explicitly when you use these hooks on an interactive page:**

```tsx
// Do this — the hook runs in the browser as intended
export const page = { mode: 'client' };
```

`useFetch` and `createResource` do **not** trigger this heuristic, so they are the safest choice for client pages that don't set a mode.

---

## Client hooks vs. server data — which do I want?

| You want… | Use |
|---|---|
| Fetch after the page loads, interactive dashboard | `useFetch` / `createResource` on a `client` (or `hybrid`) page |
| Cached, revalidating, or shared-across-components data | `useSWR` / `useQuery` (set `mode` explicitly) |
| Data fetched **on the server**, baked into the HTML, cached with ISR | a [`loader`](#loader-server-side-data-fetching) + `useLoaderData()` |
| Real-time streaming data | a [hot route](/ladder/4-hot) (WebSocket) + a client hook to render it |
| **Write** something on the server from a click | a [server action](/reference/actions) |

The two families compose: a `hybrid` page renders its `loader` data into the HTML *and* serializes it, so an island inside it starts from the server's data and keeps it fresh with `useSWR` from there.

Everything on this page reads. To **change** something on the server, call a [server action](/reference/actions): a function in `src/actions/` that you import and call directly, with no endpoint to write.
