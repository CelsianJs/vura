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
    { name: 'description', content: 'Live Function and Hot runtime routing, latency, and observability dogfood lab.' },
  ],
  styles: [runtimeLabStyles],
};

type RouteName = 'function' | 'hot' | 'portable';
type LabSample = TimingSample & { source: RouteName; level: 'info' | 'error'; message: string; handlerMs: number };

const samples = signal<LabSample[]>([]);
const running = signal(false);
const sourceFilter = signal('all');
const levelFilter = signal('all');
const routeFilter = signal('all');
const searchFilter = signal('');

const routePath: Record<RouteName, string> = {
  function: '/api/function',
  hot: '/api/hot',
  portable: '/api/portable',
};

const functionCold = computed(() => summarize(samples().filter(isColdFunction)));
const functionWarm = computed(() => summarize(samples().filter((sample) => sample.source === 'function' && !isColdFunction(sample))));
const hotWarm = computed(() => summarize(samples().filter((sample) => sample.source === 'hot')));
const portableSummary = computed(() => summarize(samples().filter((sample) => sample.source === 'portable')));
const latest = computed(() => samples().at(-1) ?? null);
const visibleSamples = computed(() => samples().filter((sample) => {
  const query = searchFilter().trim().toLowerCase();
  return (sourceFilter() === 'all' || sample.source === sourceFilter())
    && (levelFilter() === 'all' || sample.level === levelFilter())
    && (routeFilter() === 'all' || sample.route === routeFilter())
    && (!query || `${sample.message} ${sample.correlationId} ${sample.observedRuntime}`.toLowerCase().includes(query));
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
    timestamp: payload.completedAt || new Date().toISOString(),
    handlerMs: payload.handlerMs,
  };

  if (record) samples.set([...samples(), sample].slice(-160));
  return sample;
}

async function runBenchmark(): Promise<void> {
  if (running()) return;
  running.set(true);
  try {
    const benchmark: LabSample[] = [];
    benchmark.push(await runProbe('function', false, false));
    for (let index = 0; index < 6; index += 1) benchmark.push(await runProbe('function', false, false));
    for (let index = 0; index < 7; index += 1) benchmark.push(await runProbe('hot', false, false));
    for (let index = 0; index < 7; index += 1) benchmark.push(await runProbe('portable', false, false));
    samples.set([...samples(), ...benchmark].slice(-160));
  } finally {
    running.set(false);
  }
}

function formatMs(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}`;
}

function Metric(props: { label: string; summary: () => TimingSummary; tone: string; current?: boolean }) {
  return (
    <section class={`metric ${props.tone}${props.current ? ' current' : ''}`}>
      <div class="metric-label"><span class="metric-signal" />{props.label}</div>
      <div class="metric-value">{() => formatMs(props.summary().latest)} <small>ms</small></div>
      <div class="metric-detail">
        <span>p50 {() => formatMs(props.summary().p50)}</span>
        <span>p95 {() => formatMs(props.summary().p95)}</span>
        <span>n={() => props.summary().count}</span>
      </div>
    </section>
  );
}

function LatencyPanel() {
  const plotSamples = computed(() => samples().slice(-60));
  const colorFor = (sample: LabSample) => sample.source === 'function'
    ? (isColdFunction(sample) ? '#e75939' : '#df8a00')
    : sample.source === 'hot' ? '#008e96' : '#4e6f76';
  return (
    <section class="panel">
      <div class="panel-header"><h2>Latency over time</h2><span class="hint">browser-observed total response time</span></div>
      <div class="latency-plot">
        <div class="plot-grid">
          <Show when={() => plotSamples().length > 0} fallback={<div class="plot-empty">Run the benchmark to capture live timings.</div>}>
            <div class="plot-bars">
              <For each={() => plotSamples()}>{(sample: LabSample) => (
                <span
                  class="plot-bar"
                  title={`${sample.source}: ${Math.round(sample.totalMs)} ms`}
                  style={`--height:${Math.max(3, Math.min(100, sample.totalMs / 12))}%;--color:${colorFor(sample)}`}
                />
              )}</For>
            </div>
          </Show>
        </div>
        <div class="plot-legend">
          <span><i class="legend-line" style="background:#e75939" />Function cold</span>
          <span><i class="legend-line" style="background:#df8a00" />Function warm</span>
          <span><i class="legend-line" style="background:#008e96" />Hot</span>
          <span><i class="legend-line" style="background:#4e6f76" />Portable</span>
        </div>
      </div>
    </section>
  );
}

function PlacementPanel() {
  return (
    <section class="panel">
      <div class="panel-header"><h2>Route placement timeline — /api/portable</h2><span class="hint">same URL, control-plane placement changes</span></div>
      <div class="placement">
        <div class="placement-track">
          <Show when={() => portableSegments().length > 0} fallback={<div class="placement-empty">No portable-route samples yet.</div>}>
            <For each={() => portableSegments()}>{(segment: { runtime: string; first: string; last: string; count: number }) => (
              <div class={`placement-segment ${segment.runtime}`} style={`--count:${segment.count}`}>
                <div><strong>{segment.runtime}</strong><span>{new Date(segment.first).toLocaleTimeString()} · n={segment.count}</span></div>
              </div>
            )}</For>
          </Show>
        </div>
      </div>
    </section>
  );
}

function LatestRequest() {
  return (
    <section class="panel">
      <div class="panel-header"><h2>Latest request</h2><span class="hint">response contract + edge timing evidence</span></div>
      <Show when={() => latest() != null} fallback={<div class="placement"><div class="placement-empty">Waiting for a probe.</div></div>}>
        {() => {
          const sample = latest()!;
          return (
            <dl class="latest-grid">
              <div class="datum"><dt>Status</dt><dd class={sample.status < 400 ? 'good' : 'bad'}>{sample.status}</dd></div>
              <div class="datum"><dt>Runtime</dt><dd>{sample.observedRuntime}</dd></div>
              <div class="datum"><dt>Wake</dt><dd>{sample.wakeMs == null ? '—' : `${Math.round(sample.wakeMs)} ms`}</dd></div>
              <div class="datum"><dt>TTFB</dt><dd>{Math.round(sample.ttfbMs)} ms</dd></div>
              <div class="datum"><dt>Total</dt><dd>{Math.round(sample.totalMs)} ms</dd></div>
              <div class="datum"><dt>Handler</dt><dd>{sample.handlerMs} ms</dd></div>
              <div class="datum correlation"><dt>Correlation ID</dt><dd title={sample.correlationId}>{sample.correlationId}</dd></div>
            </dl>
          );
        }}
      </Show>
    </section>
  );
}

function ProbeStream() {
  return (
    <section class="panel">
      <div class="panel-header observability-toolbar">
        <h2>Probe stream</h2>
        <select class="filter" aria-label="Source" value={sourceFilter()} onChange={(event: Event) => sourceFilter.set((event.target as HTMLSelectElement).value)}>
          <option value="all">Source: All</option><option value="function">Function</option><option value="hot">Hot</option><option value="portable">Portable</option>
        </select>
        <select class="filter" aria-label="Level" value={levelFilter()} onChange={(event: Event) => levelFilter.set((event.target as HTMLSelectElement).value)}>
          <option value="all">Level: All</option><option value="info">Info</option><option value="error">Error</option>
        </select>
        <select class="filter" aria-label="Route" value={routeFilter()} onChange={(event: Event) => routeFilter.set((event.target as HTMLSelectElement).value)}>
          <option value="all">Route: All</option><option value="/api/function">/api/function</option><option value="/api/hot">/api/hot</option><option value="/api/portable">/api/portable</option>
        </select>
        <input class="filter search" aria-label="Correlation or search" placeholder="Correlation ID / search…" value={searchFilter()} onInput={(event: Event) => searchFilter.set((event.target as HTMLInputElement).value)} />
        <span class="event-count">{() => visibleSamples().length} rows</span>
      </div>
      <table class="log-table">
        <thead><tr><th style="width:12%">Time (UTC)</th><th style="width:12%">Source</th><th style="width:9%">Level</th><th style="width:14%">Route</th><th style="width:24%">Message</th><th>Correlation ID</th></tr></thead>
        <tbody>
          <Show when={() => visibleSamples().length > 0} fallback={<tr><td class="empty-row" colSpan={6}>No matching probe events.</td></tr>}>
            <For each={() => visibleSamples()}>{(sample: LabSample) => (
              <tr>
                <td>{new Date(sample.timestamp).toISOString().slice(11, 23)}</td>
                <td>{sample.source}</td>
                <td><span class={`log-level ${sample.level}`}>{sample.level.toUpperCase()}</span></td>
                <td>{sample.route}</td>
                <td>{sample.message}</td>
                <td title={sample.correlationId}>{sample.correlationId}</td>
              </tr>
            )}</For>
          </Show>
        </tbody>
      </table>
    </section>
  );
}

export default function RuntimeLabPage() {
  return (
    <main class="lab-shell">
      <header class="lab-header">
        <span class="brand-mark" aria-hidden="true">V</span>
        <h1>Vura Runtime Lab</h1>
        <span class="connection"><i class="connection-dot" />Live · same-origin probes</span>
        <button class="run-button" disabled={running()} onClick={runBenchmark}>{() => running() ? 'Running…' : 'Run benchmark'}</button>
      </header>

      <div class="metric-rail">
        <Metric label="Function cold" summary={functionCold} tone="function-cold" />
        <Metric label="Function warm" summary={functionWarm} tone="function-warm" />
        <Metric label="Hot warm" summary={hotWarm} tone="hot-warm" />
        <Metric label="Portable now" summary={portableSummary} tone="portable" current />
      </div>

      <LatencyPanel />
      <PlacementPanel />
      <LatestRequest />
      <ProbeStream />
    </main>
  );
}
