import { echo } from '../actions/parity.js';
import { sharedValue } from '../shared.js';
import { useSignal } from 'what-framework';
export const page = { mode: 'client' };
export default function Client() {
  if (typeof window === 'undefined') throw new Error('client component rendered on server');
  const clicks = useSignal(0);
  return <button onClick={() => { clicks(clicks() + 1); return echo('clicked'); }}>browser-only-page:{sharedValue}:{() => clicks()}</button>;
}
