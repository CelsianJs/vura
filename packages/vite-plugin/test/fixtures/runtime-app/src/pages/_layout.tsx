import { useLoaderData } from '@celsian/vura-core';
export const loader = () => ({ name: 'root-data' });
export default function RootLayout({ children }: { children: unknown }) {
  const data = useLoaderData<typeof loader>();
  return <main><header>root-layout:{data.name}</header>{children}</main>;
}
