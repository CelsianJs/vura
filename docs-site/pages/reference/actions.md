# Server actions

A file under `src/actions/` runs on the server, always. Every function it
exports can be called from client code by importing it.

```ts
// src/actions/todos.ts
import { db } from '../lib/db';

export async function addTodo(text: string) {
  const todo = await db.todos.insert({ text });
  return todo;
}
```

```tsx
// src/pages/index.tsx
import { addTodo } from '../actions/todos';

export const page = { mode: 'hybrid', title: 'Todos' };

export default function Todos() {
  return <button onClick={() => addTodo('milk')}>Add</button>;
}
```

That is the whole feature. No endpoint to write, no fetch to hand-roll, no
route to keep in sync with a client call site. The import is type-checked
against the real function, so renaming an argument is a compile error at the
call site rather than a 400 at runtime.

---

## What the browser actually gets

Not the module. During the build, any import that lands in `src/actions/` is
replaced with a generated stub before the bundler opens the file:

```js
export function addTodo(...args) {
  return callAction('todos#addTodo', args);
}
```

The real module is never read for a browser bundle, so a database URL, an API
key or a `node:fs` import inside an action file cannot reach the client through
any path: not through a constant, not through a transitive import, not by
accident. This is the reason actions live in their own directory rather than
being marked with a directive inside a page file: the boundary is a location,
which is easy to see and impossible to get half-right.

The server bundle imports the real module, and that import is what registers
the action. An action file that nothing builds is not a live endpoint.

---

## Naming

An action's id is its file path plus its export name:

| File | Export | Id |
|---|---|---|
| `src/actions/todos.ts` | `addTodo` | `todos#addTodo` |
| `src/actions/admin/users.ts` | `ban` | `admin/users#ban` |

Ids are derived, not generated, so they are stable across builds and readable
in a network tab. Renaming a file or an export changes the id, which is the
correct behaviour: it is a different function.

Only **named** function exports become actions. A `default` export is not an
action, and a non-function export (a constant, a schema) is skipped rather
than exposed.

---

## Arguments and return values

Arguments and return values cross the wire as JSON, so they must be
JSON-serializable. A `Date` arrives as a string; a `Map`, a `Set` or a `File`
does not survive at all. For file uploads, use an [API route](/reference/route-kinds)
with `multipart/form-data`.

An action returning `undefined` yields `undefined` at the call site.

---

## Errors

Throw an `HttpError` and the caller receives that status and message:

```ts
import { notFound, badRequest } from '@celsian/vura-core';

export async function getTodo(id: string) {
  if (!id) throw badRequest('id is required');
  const todo = await db.todos.find(id);
  if (!todo) throw notFound('No such todo');
  return todo;
}
```

```ts
try {
  await getTodo('');
} catch (err) {
  err.status;   // 400
  err.code;     // 'BAD_REQUEST'
  err.message;  // '[vura] todos#getTodo: id is required'
}
```

Any **other** thrown error is logged on the server and reaches the client as a
generic 500. That is deliberate: an unexpected error's message routinely
contains a connection string or a file path, and an action is called from a
browser. If you want the caller to see it, make it an `HttpError`.

---

## Security

Actions are a browser-to-server call, and the endpoint is guarded accordingly.

**Same-origin only.** A request must carry `Sec-Fetch-Site: same-origin`, or an
`Origin` matching the request host. A request with neither is rejected, because
a browser always sends one: a request without them is a script, and a script
should be calling an API route.

**JSON only.** The endpoint requires `content-type: application/json`, which an
HTML form cannot send cross-site without a preflight.

**CSRF token.** The client fetches a token from `GET /__vura/action`, which also
sets it as an `HttpOnly` cookie; every call sends the token in a header and the
server compares the two. Over HTTPS the cookie uses the `__Host-` prefix, so a
sibling subdomain cannot write it.

Arguments must be a JSON array, are size-capped, and an unknown id returns 404
without echoing what was asked for.

None of this authenticates the *caller*. An action is reachable by anyone who
can load your site, exactly like an API route. Check the session inside the
action, or guard the page with [middleware](/reference/middleware):

```ts
export async function deleteTodo(id: string) {
  const user = await currentUser();
  if (!user) throw unauthorized('Sign in first');
  ...
}
```

---

## Where actions run

| Target | Server actions |
|---|---|
| `vura dev` | Yes |
| `vura build` + `vura start` (Node) | Yes |
| Docker / VPS | Yes |
| Cloudflare adapter | Not yet |
| Lambda adapter | Not yet |

The two adapters bundle API routes as individual functions and serve pages as
CDN assets; the action endpoint is not among them yet. The same is true of
[middleware](/reference/middleware).

---

## Calling an action from an event handler

The stub is an ordinary async function, so anything that awaits works:

```tsx
import { signal } from 'what-framework';
import { addTodo } from '../actions/todos';

const status = signal('');

export default function Form() {
  async function submit(e: Event) {
    e.preventDefault();
    status.set('saving');
    try {
      await addTodo(new FormData(e.target as HTMLFormElement).get('text') as string);
      status.set('saved');
    } catch (err: any) {
      status.set(err.status === 400 ? 'check your input' : 'something broke');
    }
  }

  return (
    <form onSubmit={submit}>
      <input name="text" />
      <button type="submit">Add</button>
      <span>{() => status()}</span>
    </form>
  );
}
```

The first action call in a session costs one extra request to fetch the CSRF
token; it is cached for the rest of the page's life.
