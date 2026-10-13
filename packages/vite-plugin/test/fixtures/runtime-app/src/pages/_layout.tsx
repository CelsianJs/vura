import { useLoaderData } from '@celsian/vura-core';
export const loader = () => ({ name: 'root-data' });
export default function RootLayout({ children }: { children: unknown }) {
  const data = useLoaderData<typeof loader>();
  // Client mode intentionally runs no server loaders; this shared layout also
  // needs a client-only fallback rather than assuming an SSR payload exists.
  return <main><header>root-layout:{data?.name ?? 'client-no-loader'}</header>{children}</main>;
}
