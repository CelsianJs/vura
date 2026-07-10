/**
 * `/stats` — a second client page.
 */
import { useSignal } from 'what-framework';

export const page = {
  mode: 'client' as const,
  title: 'Pages App — Stats',
};

export default function StatsPage() {
  const online = useSignal(1);
  return (
    <div class="stats">
      <h1>Live Stats</h1>
      <p>{() => `online: ${online()}`}</p>
    </div>
  );
}
