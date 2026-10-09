import type { MiddlewareContext } from '@celsian/vura-core';
export default function middleware(ctx: MiddlewareContext) {
  ctx.headers.set('x-runtime-middleware', 'active');
  if (ctx.query.broken) throw new Error('fixture middleware failure');
  if (ctx.pathname === '/guard' && !ctx.cookies.has('session')) return ctx.redirect('/login', 302);
}
