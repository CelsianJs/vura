import { useLoaderData, type LoaderContext } from '@celsian/vura-core';
import { useSignal } from 'what-framework';
import { echo } from '../../actions/parity.js';
export const page = { mode: 'hybrid' };
export const loader = (ctx: LoaderContext) => ({ name: 'page-data', tags: ctx.query.tag });
export default function LoaderPage() {
  const data = useLoaderData<typeof loader>();
  const count = useSignal(7);
  return <button onClick={() => echo('clicked')}>{data.name}:{Array.isArray(data.tags) ? data.tags.join(',') : data.tags}:{count()}</button>;
}
