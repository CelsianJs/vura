import type { LoaderContext } from '@celsian/vura-core';
export const page = { mode: 'server' };
export const loader = (ctx: LoaderContext) => { throw ctx.redirect('/login', 303); };
export default function Redirect() { return <p>must-not-render</p>; }
