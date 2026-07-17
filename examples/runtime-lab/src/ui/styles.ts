export const runtimeLabStyles = String.raw`
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #15191d;
  background: #ffffff;
  font-synthesis: none;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #ffffff; }
button, select, input { font: inherit; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid rgba(0, 145, 153, .24); outline-offset: 2px; }

.lab-shell { min-height: 100vh; padding: 0 20px 32px; }
.lab-header { height: 64px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #d9dfe3; }
.brand-mark { color: #008e96; font-size: 29px; font-weight: 900; letter-spacing: -4px; transform: skew(-7deg); }
.lab-header h1 { margin: 0; font-size: 19px; letter-spacing: -.02em; }
.connection { margin-left: auto; display: flex; align-items: center; gap: 8px; color: #5f686f; font-size: 12px; }
.connection-dot { width: 7px; height: 7px; border-radius: 50%; background: #38a65a; box-shadow: 0 0 0 3px #e7f7eb; }
.run-button { border: 1px solid #007f86; border-radius: 8px; background: #008e96; color: white; padding: 10px 17px; font-size: 12px; font-weight: 750; cursor: pointer; box-shadow: 0 2px 5px rgba(0, 91, 96, .16); }
.run-button:hover { background: #007b82; }
.run-button:disabled { cursor: wait; opacity: .66; }

.metric-rail { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 16px 0; border: 1px solid #d9dfe3; border-radius: 7px; overflow: hidden; }
.metric { min-height: 104px; padding: 14px 16px; border-right: 1px solid #d9dfe3; background: #fff; }
.metric:last-child { border-right: 0; }
.metric.current { box-shadow: inset 0 0 0 2px #008e96; }
.metric-label { display: flex; align-items: center; gap: 8px; color: #22272b; font-size: 12px; font-weight: 760; }
.metric-signal { width: 10px; height: 10px; border: 2px solid currentColor; border-radius: 50%; color: #008e96; }
.metric.function-cold .metric-signal { color: #e75939; border-radius: 2px; transform: rotate(45deg); }
.metric.function-warm .metric-signal { color: #df8a00; }
.metric-value { margin-top: 7px; color: #008e96; font: 700 25px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.metric.function-cold .metric-value { color: #e75939; }
.metric.function-warm .metric-value { color: #cc7c00; }
.metric-value small { font-size: 13px; }
.metric-detail { display: flex; gap: 18px; margin-top: 10px; color: #697178; font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }

.panel { border: 1px solid #d9dfe3; border-radius: 7px; background: #fff; margin-bottom: 14px; }
.panel-header { min-height: 46px; display: flex; align-items: center; gap: 16px; padding: 0 14px; border-bottom: 1px solid #e5eaed; }
.panel-header h2 { margin: 0; font-size: 13px; letter-spacing: -.01em; }
.panel-header .hint { color: #778188; font-size: 11px; }

.latency-plot { padding: 18px 14px 14px; min-height: 228px; }
.plot-grid { position: relative; height: 174px; border-left: 1px solid #cfd6da; border-bottom: 1px solid #cfd6da; background: repeating-linear-gradient(to bottom, transparent 0, transparent 42px, #edf0f2 43px); overflow: hidden; }
.plot-bars { height: 100%; display: flex; align-items: end; gap: 3px; padding: 0 8px; }
.plot-bar { flex: 1 1 0; min-width: 3px; max-width: 18px; height: var(--height); background: var(--color); opacity: .88; border-radius: 2px 2px 0 0; transition: height .2s ease; }
.plot-empty { display: grid; place-items: center; height: 100%; color: #899298; font-size: 12px; }
.plot-legend { display: flex; gap: 18px; margin-top: 10px; color: #656e74; font-size: 11px; }
.legend-line { width: 15px; height: 2px; display: inline-block; margin-right: 5px; vertical-align: middle; }

.placement { padding: 14px; }
.placement-track { display: flex; min-height: 54px; border: 1px solid #e3a43b; border-radius: 5px; overflow: hidden; }
.placement-segment { min-width: 100px; flex: var(--count) 1 0; display: grid; place-items: center; padding: 8px; color: #30363a; background: #fffaf0; border-right: 1px dashed #bf8b35; text-align: center; }
.placement-segment.hot { background: #eefafa; border-color: #008e96; }
.placement-segment:last-child { border-right: 0; }
.placement-segment strong { display: block; font-size: 12px; text-transform: capitalize; }
.placement-segment span { color: #6f777d; font: 10px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; }
.placement-empty { width: 100%; display: grid; place-items: center; color: #899298; font-size: 12px; }

.latest-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 14px; padding: 14px; }
.datum dt { color: #6e777d; font-size: 10px; margin-bottom: 6px; }
.datum dd { margin: 0; min-width: 0; font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.datum .good { color: #168244; }
.datum .bad { color: #c7412a; }

.observability-toolbar { flex-wrap: wrap; padding: 8px 12px; }
.filter { height: 34px; border: 1px solid #d5dce0; border-radius: 6px; background: #fff; color: #32383c; padding: 0 10px; font-size: 11px; }
.search { min-width: 230px; flex: 1; }
.event-count { color: #717b81; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
.log-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.log-table th { height: 34px; color: #5f686e; background: #fafbfb; border-bottom: 1px solid #cfd6da; text-align: left; font-size: 10px; padding: 0 10px; }
.log-table td { height: 39px; border-bottom: 1px solid #e7ebed; padding: 0 10px; font: 10px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-table tr:last-child td { border-bottom: 0; }
.log-level { display: inline-block; min-width: 42px; padding: 3px 5px; border: 1px solid #8fd4d6; color: #007d84; background: #effcfc; text-align: center; border-radius: 3px; }
.log-level.error { border-color: #f1afa4; color: #bd3b28; background: #fff4f2; }
.empty-row { height: 120px !important; text-align: center; color: #899298; }

@media (max-width: 760px) {
  .lab-shell { padding: 0 10px 22px; }
  .lab-header { height: auto; min-height: 62px; flex-wrap: wrap; padding: 10px 0; }
  .lab-header h1 { font-size: 17px; }
  .connection { margin-left: auto; }
  .run-button { order: 3; width: 100%; }
  .metric-rail { overflow-x: auto; grid-template-columns: repeat(4, minmax(132px, 1fr)); }
  .metric { padding: 12px; min-height: 118px; }
  .metric-detail { display: grid; gap: 4px; }
  .latency-plot { min-height: 190px; }
  .plot-grid { height: 138px; }
  .placement-track { overflow-x: auto; }
  .latest-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .datum.correlation { grid-column: 1 / -1; }
  .observability-toolbar { align-items: stretch; }
  .filter { flex: 1 1 calc(50% - 8px); min-width: 0; }
  .search { flex-basis: 100%; min-width: 0; }
  .log-table th:nth-child(1), .log-table td:nth-child(1), .log-table th:nth-child(5), .log-table td:nth-child(5) { display: none; }
  .log-table th, .log-table td { padding: 0 7px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;
