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

> **These are client-side hooks.** They do not fetch during static prerender or server-mode SSR — on those render passes they return their loading state. For data that must be fetched **on the server at request time** and rendered into the HTML, use `mode: 'server'` with `getServerData` (see [Page modes](/reference/page-modes)). Request-time server-side data fetching *from inside a component* is not available yet; it is being designed (see the SSR data-fetching RFC in the repo).

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
| Data fetched **on the server**, baked into the HTML, cached with ISR | `mode: 'server'` + `getServerData` — see [Page modes](/reference/page-modes) |
| Real-time streaming data | a [hot route](/ladder/4-hot) (WebSocket) + a client hook to render it |

The two families compose: a `server`-mode page can render an initial payload via `getServerData`, and a `client` island inside it can keep that data fresh with `useSWR`.
