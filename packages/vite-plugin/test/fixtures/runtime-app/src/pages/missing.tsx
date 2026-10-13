import type { LoaderContext } from '@celsian/vura-core';
export const page = { mode: 'server' };
export const loader = (ctx: LoaderContext) => { throw ctx.notFound(); };
export default function Missing() { return <p>must-not-render</p>; }
