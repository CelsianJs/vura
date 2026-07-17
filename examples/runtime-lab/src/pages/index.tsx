import { computed, For, Show, signal } from 'what-framework';
import {
  isColdFunction,
  normalizeRuntime,
  summarize,
  type TimingSample,
  type TimingSummary,
} from '../lib/metrics.js';
import type { ProbePayload } from '../lib/probe-contract.js';
import { runtimeLabStyles } from '../ui/styles.js';

export const page = {
  mode: 'client' as const,
  title: 'Vura Runtime Lab',
  meta: [
    { name: 'description', content: 'Live Function and Dedicated runtime routing, latency, and observability dogfood lab.' },
  ],
  styles: [runtimeLabStyles],
};

type RouteName = 'function' | 'hot' | 'portable';
type LabSample = TimingSample & { source: RouteName; level: 'info' | 'error'; message: string; handlerMs: number };

const samples = signal<LabSample[]>([]);
const running = signal(false);
const progress = signal({ label: 'Ready', current: 0, total: 21 });
const notice = signal('');
const sourceFilter = signal('all');
const levelFilter = signal('all');
const routeFilter = signal('all');
const searchFilter = signal('');

const routePath: Record<RouteName, string> = {
  function: '/api/function',
  hot: '/api/hot',
  portable: '/api/portable',
};

const routeLabel: Record<RouteName, string> = {
  function: 'Function',
  hot: 'Dedicated',
  portable: 'Portable',
};

const functionCold = computed(() => summarize(samples().filter(isColdFunction)));
const functionWarm = computed(() => summarize(samples().filter((sample) => sample.source === 'function' && !isColdFunction(sample))));
const hotWarm = computed(() => summarize(samples().filter((sample) => sample.source === 'hot')));
const portableSummary = computed(() => summarize(samples().filter((sample) => sample.source === 'portable')));
const latest = computed(() => samples().at(-1) ?? null);
const portableLatest = computed(() => samples().filter((sample) => sample.source === 'portable').at(-1) ?? null);
const activeFilterCount = computed(() => [sourceFilter(), levelFilter(), routeFilter()].filter((value) => value !== 'all').length);
const visibleSamples = computed(() => samples().filter((sample) => {
  const query = searchFilter().trim().toLowerCase();
  return (sourceFilter() === 'all' || sample.source === sourceFilter())
    && (levelFilter() === 'all' || sample.level === levelFilter())
    && (routeFilter() === 'all' || sample.route === routeFilter())
    && (!query || `${sample.message} ${sample.correlationId} ${sample.requestId} ${sample.observedRuntime}`.toLowerCase().includes(query));
}).slice().reverse());

const portableSegments = computed(() => {
  const portable = samples().filter((sample) => sample.source === 'portable');
  return portable.reduce<Array<{ runtime: string; first: string; last: string; count: number }>>((segments, sample) => {
    const previous = segments.at(-1);
    if (previous?.runtime === sample.observedRuntime) {
      previous.last = sample.timestamp;
      previous.count += 1;
    } else {
      segments.push({ runtime: sample.observedRuntime, first: sample.timestamp, last: sample.timestamp, count: 1 });
    }
    return segments;
  }, []);
});

function makeCorrelationId(source: RouteName): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `lab-${source}-${suffix}`;
}

function readWakeMs(response: Response): number | null {
  const value = response.headers.get('x-vura-function-wake-ms');
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runProbe(source: RouteName, fail = false, record = true): Promise<LabSample> {
  const correlationId = makeCorrelationId(source);
  const start = performance.now();
  const response = await fetch(`${routePath[source]}${fail ? '?fail=1' : ''}`, {
    cache: 'no-store',
    headers: { 'x-lab-correlation-id': correlationId },
  });
  const ttfbMs = performance.now() - start;
  const payload = await response.json() as ProbePayload;
  const totalMs = performance.now() - start;
  const observedRuntime = normalizeRuntime(
    response.headers.get('x-vura-route-kind')
      || response.headers.get('x-vura-runtime')
      || payload.runtimeIntent,
  );

  const sample: LabSample = {
    source,
    route: payload.route || routePath[source],
    level: response.ok ? 'info' : 'error',
    message: `${response.status} via ${observedRuntime} in ${Math.round(totalMs)} ms`,
    observedRuntime,
    totalMs,
    ttfbMs,
    wakeMs: readWakeMs(response),
    bootAgeMs: payload.bootAgeMs,
    requestOrdinal: payload.requestOrdinal,
    status: response.status,
    correlationId: payload.correlationId || correlationId,
    requestId: response.headers.get('x-vura-request-id') || payload.requestId || correlationId,
    timestamp: payload.completedAt || new Date().toISOString(),
    handlerMs: payload.handlerMs,
  };

  if (record) samples.set([...samples(), sample].slice(-160));
  return sample;
}

async function runSingle(source: RouteName, fail = false): Promise<void> {
  if (running()) return;
  running.set(true);
  notice.set('');
  progress.set({ label: `${fail ? 'Failure test' : 'Probe'} · ${routeLabel[source]}`, current: 0, total: 1 });
  try {
    await runProbe(source, fail);
    progress.set({ label: 'Complete', current: 1, total: 1 });
  } catch (error) {
    notice.set(error instanceof Error ? error.message : 'The probe could not be completed.');
  } finally {
    running.set(false);
  }
}

async function runBenchmark(): Promise<void> {
  if (running()) return;
  running.set(true);
  notice.set('');
  let completed = 0;
  const plan: Array<{ source: RouteName; count: number }> = [
    { source: 'function', count: 7 },
    { source: 'hot', count: 7 },
    { source: 'portable', count: 7 },
  ];

  try {
    for (const stage of plan) {
      for (let index = 0; index < stage.count; index += 1) {
        progress.set({ label: `${routeLabel[stage.source]} ${index + 1} of ${stage.count}`, current: completed, total: 21 });
        await runProbe(stage.source);
        completed += 1;
        progress.set({ label: `${routeLabel[stage.source]} ${index + 1} of ${stage.count}`, current: completed, total: 21 });
      }
    }
    progress.set({ label: 'Benchmark complete', current: 21, total: 21 });
  } catch (error) {
    notice.set(error instanceof Error ? error.message : 'The benchmark could not be completed.');
  } finally {
    running.set(false);
  }
}

function formatMs(value: number | null): string {
  return value == null ? 'Not measured' : `${Math.round(value)} ms`;
}

function CompactStats(props: { summary: () => TimingSummary }) {
  return (
    <div class="compact-stats">
      <span><small>Latest</small>{() => formatMs(props.summary().latest)}</span>
      <span><small>p50</small>{() => formatMs(props.summary().p50)}</span>
      <span><small>p95</small>{() => formatMs(props.summary().p95)}</span>
      <span><small>Samples</small>{() => `${props.summary().count}`}</span>
    </div>
  );
}

function RouteCards() {
  return (
    <section class="route-grid" aria-label="Route health summary">
      <button class="route-card function-card" onClick={() => { sourceFilter.set('function'); routeFilter.set('/api/function'); }}>
        <div class="route-card-heading"><span class="route-icon lambda">λ</span><div><span class="eyebrow">Elastic compute</span><h2>Function</h2></div><span class="route-path">/api/function</span></div>
        <div class="function-states">
          <div><span class="state-label cold">Cold evidence</span><strong>{() => formatMs(functionCold().latest)}</strong><small>{() => functionCold().count ? `${functionCold().count} proven wake sample${functionCold().count === 1 ? '' : 's'}` : 'No cold wake observed'}</small></div>
          <div><span class="state-label warm">Warm path</span><strong>{() => formatMs(functionWarm().latest)}</strong><small>Browser total · Function 1 GB</small></div>
        </div>
      </button>

      <button class="route-card dedicated-card" onClick={() => { sourceFilter.set('hot'); routeFilter.set('/api/hot'); }}>
        <div class="route-card-heading"><span class="route-icon pulse">●</span><div><span class="eyebrow">Always available</span><h2>Dedicated</h2></div><span class="route-path">/api/hot</span></div>
        <CompactStats summary={hotWarm} />
        <p class="route-note"><span class="live-pin" />Persistent process · no Function wake phase</p>
      </button>

      <button class="route-card portable-card" onClick={() => { sourceFilter.set('portable'); routeFilter.set('/api/portable'); }}>
        <div class="route-card-heading"><span class="route-icon portable">↔</span><div><span class="eyebrow">Same handler contract</span><h2>Portable route</h2></div><span class="route-path">/api/portable</span></div>
        <div class="portable-state"><span>Observed placement</span><strong>{() => portableLatest()?.observedRuntime === 'hot' ? 'Dedicated' : portableLatest()?.observedRuntime === 'function' ? 'Function' : 'Awaiting sample'}</strong></div>
        <CompactStats summary={portableSummary} />
      </button>
    </section>
  );
}

function LatencyPanel() {
  const plotSamples = computed(() => samples().slice(-60));
  const plotMax = computed(() => {
    const maximum = Math.max(0, ...plotSamples().map((sample) => sample.totalMs));
    return Math.max(100, Math.ceil(maximum / 100) * 100);
  });
  const colorFor = (sample: LabSample) => sample.source === 'function'
    ? (isColdFunction(sample) ? '#d9583b' : '#c87916')
    : sample.source === 'hot' ? '#087f78' : '#526b69';
  return (
    <section class="panel latency-panel">
      <div class="panel-header"><div><span class="eyebrow">Browser measured</span><h2>Latency explorer</h2></div><span class="hint">Latest 60 responses · scaled to observed maximum</span></div>
      <div class="latency-plot">
        <div class="plot-grid">
          <div class="plot-y-axis"><span>{() => `${plotMax()} ms`}</span><span>{() => `${Math.round(plotMax() / 2)} ms`}</span><span>0 ms</span></div>
          <Show when={() => plotSamples().length > 0} fallback={<div class="plot-empty">Run the benchmark to capture live timings.</div>}>
            <div class="plot-bars">
              <For each={() => plotSamples()}>{(sample: LabSample) => (
                <button
                  key={sample.requestId}
                  class="plot-bar"
                  aria-label={`${routeLabel[sample.source]} ${Math.round(sample.totalMs)} milliseconds, ${sample.observedRuntime} runtime`}
                  title={`${routeLabel[sample.source]} · ${Math.round(sample.totalMs)} ms · ${sample.observedRuntime}`}
                  style={`--height:${Math.max(3, (sample.totalMs / plotMax()) * 100)}%;--color:${colorFor(sample)}`}
                  onClick={() => { routeFilter.set(sample.route); searchFilter.set(sample.requestId); }}
                />
              )}</For>
            </div>
          </Show>
        </div>
        <div class="plot-legend">
          <span><i style="background:#d9583b" />Function cold</span>
          <span><i style="background:#c87916" />Function warm</span>
          <span><i style="background:#087f78" />Dedicated</span>
          <span><i style="background:#526b69" />Portable</span>
        </div>
      </div>
    </section>
  );
}

function PlacementPanel() {
  return (
    <section class="panel placement-panel">
      <div class="panel-header"><div><span class="eyebrow">Control-plane evidence</span><h2>Portable route placement</h2></div><code>/api/portable</code></div>
      <div class="placement">
        <div class="placement-track">
          <Show when={() => portableSegments().length > 0} fallback={<div class="placement-empty">No placement observations yet.</div>}>
            <For each={() => portableSegments()}>{(segment: { runtime: string; first: string; last: string; count: number }) => (
              <div key={`${segment.runtime}:${segment.first}`} class={`placement-segment ${segment.runtime}`} style={`--count:${segment.count}`}>
                <span class="segment-knot" />
                <div><strong>{segment.runtime === 'hot' ? 'Dedicated' : 'Function'}</strong><span>{new Date(segment.first).toLocaleTimeString()} · {segment.count} sample{segment.count === 1 ? '' : 's'}</span></div>
              </div>
            )}</For>
          </Show>
        </div>
        <p class="placement-caption">The ribbon reports observed request placement. It does not imply a transition unless samples change runtime.</p>
      </div>
    </section>
  );
}

function LatestRequest() {
  return (
    <section class="panel latest-panel">
      <div class="panel-header"><div><span class="eyebrow">Trace anchor</span><h2>Latest request</h2></div></div>
      <Show when={() => latest() != null} fallback={<div class="request-empty">Waiting for a probe.</div>}>
        {() => {
          const sample = latest()!;
          return (
            <div class="request-body">
              <div class="request-headline"><span class={`status-orb ${sample.status < 400 ? 'good' : 'bad'}`} /> <strong>{sample.status}</strong><span>{sample.route}</span></div>
              <dl class="request-primary">
                <div><dt>Runtime</dt><dd>{sample.observedRuntime === 'hot' ? 'Dedicated' : 'Function'}</dd></div>
                <div><dt>Total <small>browser</small></dt><dd>{Math.round(sample.totalMs)} ms</dd></div>
                <div><dt>Wake <small>platform</small></dt><dd>{sample.wakeMs == null ? 'No wake header' : `${Math.round(sample.wakeMs)} ms`}</dd></div>
              </dl>
              <details class="request-evidence">
                <summary>Request evidence</summary>
                <dl>
                  <div><dt>TTFB · browser</dt><dd>{Math.round(sample.ttfbMs)} ms</dd></div>
                  <div><dt>Handler · runtime</dt><dd>{sample.handlerMs} ms</dd></div>
                  <div><dt>Boot age</dt><dd>{sample.bootAgeMs} ms</dd></div>
                  <div><dt>Ordinal</dt><dd>{sample.requestOrdinal}</dd></div>
                  <div class="wide"><dt>Request ID</dt><dd title={sample.requestId}>{sample.requestId}</dd></div>
                  <div class="wide"><dt>Correlation ID</dt><dd title={sample.correlationId}>{sample.correlationId}</dd></div>
                </dl>
              </details>
            </div>
          );
        }}
      </Show>
    </section>
  );
}

function ProbeStream() {
  return (
    <section class="panel stream-panel">
      <div class="stream-toolbar">
        <div><span class="eyebrow">Correlated evidence</span><h2>Observability stream</h2></div>
        <input class="search" aria-label="Search request ID, correlation ID, or message" placeholder="Search requests or correlations" value={searchFilter()} onInput={(event: Event) => searchFilter.set((event.target as HTMLInputElement).value)} />
        <details class="filters-popover">
          <summary>Filters{() => activeFilterCount() ? ` · ${activeFilterCount()}` : ''}</summary>
          <div class="filter-sheet">
            <label>Source<select aria-label="Source" value={sourceFilter()} onChange={(event: Event) => sourceFilter.set((event.target as HTMLSelectElement).value)}>
              <option value="all">All sources</option><option value="function">Function</option><option value="hot">Dedicated</option><option value="portable">Portable</option>
            </select></label>
            <label>Level<select aria-label="Level" value={levelFilter()} onChange={(event: Event) => levelFilter.set((event.target as HTMLSelectElement).value)}>
              <option value="all">All levels</option><option value="info">Info</option><option value="error">Error</option>
            </select></label>
            <label>Route<select aria-label="Route" value={routeFilter()} onChange={(event: Event) => routeFilter.set((event.target as HTMLSelectElement).value)}>
              <option value="all">All routes</option><option value="/api/function">/api/function</option><option value="/api/hot">/api/hot</option><option value="/api/portable">/api/portable</option>
            </select></label>
            <button onClick={() => { sourceFilter.set('all'); levelFilter.set('all'); routeFilter.set('all'); }}>Clear filters</button>
          </div>
        </details>
        <span class="event-count">{() => `${visibleSamples().length} event${visibleSamples().length === 1 ? '' : 's'}`}</span>
      </div>
      <table class="log-table">
        <thead><tr><th>Time (UTC)</th><th>Source</th><th>Level</th><th>Route</th><th>Evidence</th></tr></thead>
        <tbody>
          <Show when={() => visibleSamples().length > 0} fallback={<tr><td class="empty-row" colSpan={5}>No matching probe events.</td></tr>}>
            <For each={() => visibleSamples()}>{(sample: LabSample) => (
              <tr key={sample.requestId}>
                <td data-label="Time">{new Date(sample.timestamp).toISOString().slice(11, 23)}</td>
                <td data-label="Source">{routeLabel[sample.source]}</td>
                <td data-label="Level"><span class={`log-level ${sample.level}`}>{sample.level}</span></td>
                <td data-label="Route"><code>{sample.route}</code></td>
                <td data-label="Evidence">
                  <details class="log-evidence">
                    <summary>{sample.message}</summary>
                    <dl>
                      <div><dt>Request</dt><dd>{sample.requestId}</dd></div>
                      <div><dt>Correlation</dt><dd>{sample.correlationId}</dd></div>
                      <div><dt>TTFB</dt><dd>{Math.round(sample.ttfbMs)} ms</dd></div>
                      <div><dt>Wake</dt><dd>{sample.wakeMs == null ? 'No wake' : `${Math.round(sample.wakeMs)} ms`}</dd></div>
                    </dl>
                  </details>
                </td>
              </tr>
            )}</For>
          </Show>
        </tbody>
      </table>
    </section>
  );
}

function EmptyWorkbench() {
  return (
    <section class="empty-workbench">
      <div><span class="eyebrow">Live test sequence</span><h2>Trace one contract across two compute modes.</h2><p>The benchmark gathers Function, Dedicated, and portable-route evidence from this deployed project.</p></div>
      <ol>
        <li><span>01</span><strong>Measure</strong><small>Browser total and TTFB</small></li>
        <li><span>02</span><strong>Verify</strong><small>Runtime and wake headers</small></li>
        <li><span>03</span><strong>Correlate</strong><small>Request IDs and logs</small></li>
      </ol>
      <button class="run-button" disabled={running()} onClick={runBenchmark}>Run the live benchmark</button>
    </section>
  );
}

export default function RuntimeLabPage() {
  return (
    <main class="lab-shell">
      <nav class="topbar" aria-label="Runtime lab navigation">
        <a class="brand" href="/"><span aria-hidden="true">V</span> Vura</a>
        <span class="crumb">Runtime Lab</span>
        <span class="environment"><i />Production</span>
      </nav>

      <header class="page-lead">
        <div class="lead-copy">
          <span class="eyebrow">Runtime Lab / Live project</span>
          <h1>One route contract.<br /><em>Two compute modes.</em></h1>
          <p>Measure Function wakes, Dedicated response time, and portable routing with request-level evidence from the real Vura platform.</p>
        </div>
        <div class="lead-actions">
          <div class="freshness">
            <span class={`status-orb ${latest() == null || latest()!.status < 400 ? 'good' : 'bad'}`} />
            <span>{() => latest() ? `Last response ${new Date(latest()!.timestamp).toISOString().slice(11, 19)} UTC` : 'Ready for live probes'}</span>
          </div>
          <button class="run-button" disabled={running()} onClick={runBenchmark}>{() => running() ? `${progress().label} · ${progress().current}/${progress().total}` : 'Run benchmark'}</button>
          <details class="probe-menu">
            <summary>Probe endpoint</summary>
            <div>
              <button onClick={() => runSingle('function')}>Function</button>
              <button onClick={() => runSingle('hot')}>Dedicated</button>
              <button onClick={() => runSingle('portable')}>Portable</button>
              <span>Advanced test</span>
              <button class="danger-action" onClick={() => runSingle('portable', true)}>Inject portable failure</button>
            </div>
          </details>
        </div>
        <div class="progress-rail" aria-hidden={!running()}>
          <span style={`--progress:${(progress().current / progress().total) * 100}%`} />
        </div>
        <p class="sr-only" aria-live="polite">{() => running() ? `${progress().label}, ${progress().current} of ${progress().total}` : progress().label}</p>
      </header>

      <Show when={() => notice().length > 0}><div class="notice" role="alert">{notice()}</div></Show>
      <RouteCards />

      <Show when={() => samples().length > 0} fallback={<EmptyWorkbench />}>
        <div class="workbench" aria-busy={running()}>
          <LatencyPanel />
          <LatestRequest />
          <PlacementPanel />
          <ProbeStream />
        </div>
      </Show>
    </main>
  );
}
