import { useSignal } from 'what-framework';
export const page = { mode: 'static' };
export const getServerData = () => ({ label: 'legacy' });
export default function Hooks({ label }: { label: string }) {
  const count = useSignal(9);
  return <p>{label}:{count()}</p>;
}
