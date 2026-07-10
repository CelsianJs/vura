/**
 * `/app` — client page (SPA; boots in the browser via mount()).
 *
 * Uses useSignal so that SSR'ing this page would run a hook outside a
 * component context and throw — the dev server must serve a shell + bundle,
 * never SSR it.
 */
import { useSignal } from 'what-framework';

export const page = {
  mode: 'client' as const,
  title: 'Pages App — App',
};

export default function AppPage() {
  const count = useSignal(0);
  return (
    <div class="app">
      <h1>Client App</h1>
      <button onClick={() => count(count() + 1)}>{() => `count: ${count()}`}</button>
    </div>
  );
}
