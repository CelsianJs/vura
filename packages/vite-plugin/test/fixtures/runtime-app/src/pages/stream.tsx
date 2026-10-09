import { useLoaderData } from '@celsian/vura-core';
import { Suspense, createResource } from 'what-framework';
export const page = { mode: 'server', streaming: true };
export const loader = () => ({ message: 'stream-data' });
function Slow() {
  const [data] = createResource(
    () => new Promise(resolve => setTimeout(() => resolve('slow-stream-resource'), 150)),
    { key: 'vite-parity-slow' },
  );
  return <p>{data()}</p>;
}
export default function Stream() {
  return <div><p>{useLoaderData<typeof loader>().message}</p><Suspense fallback={<p>loading</p>}><Slow /></Suspense></div>;
}
