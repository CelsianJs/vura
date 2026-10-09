import { echo } from '../actions/parity.js';
import { sharedValue } from '../shared.js';
export const page = { mode: 'client' };
export default function Client() {
  if (typeof window === 'undefined') throw new Error('client component rendered on server');
  return <button onClick={() => echo('clicked')}>browser-only-page:{sharedValue}</button>;
}
