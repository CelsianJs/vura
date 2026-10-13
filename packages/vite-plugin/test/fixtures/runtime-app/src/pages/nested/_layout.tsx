import { useLoaderData } from '@celsian/vura-core';
export const loader = () => ({ name: 'nested-data' });
export default function NestedLayout({ children }: { children: unknown }) {
  const data = useLoaderData<typeof loader>();
  return <section><header>nested-layout:{data.name}</header>{children}</section>;
}
