export const runtimeLabStyles = String.raw`
:root {
  color-scheme: light;
  font-family: "Avenir Next", Avenir, "Segoe UI", ui-sans-serif, sans-serif;
  color: #101514;
  background: #f4f5f2;
  font-synthesis: none;
  --canvas: #f4f5f2;
  --surface: #fcfcfa;
  --ink: #101514;
  --muted: #68716e;
  --border: #d9deda;
  --teal: #087f78;
  --amber: #c87916;
  --coral: #d9583b;
  --slate: #526b69;
  --mono: "SFMono-Regular", "Roboto Mono", Consolas, monospace;
}

* { box-sizing: border-box; }
html { background: var(--canvas); }
body { margin: 0; min-width: 320px; background: var(--canvas); }
button, select, input { font: inherit; }
button, summary, a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible, a:focus-visible { outline: 3px solid rgba(8, 127, 120, .24); outline-offset: 3px; }
button { color: inherit; }
.sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.lab-shell { width: min(1440px, 100%); min-height: 100vh; margin: 0 auto; padding: 0 32px 56px; }
.topbar { height: 66px; display: flex; align-items: center; gap: 14px; border-bottom: 1px solid var(--border); }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font-weight: 750; letter-spacing: -.03em; text-decoration: none; }
.brand > span { width: 29px; height: 29px; display: grid; place-items: center; border-radius: 8px; color: white; background: var(--teal); font-weight: 850; box-shadow: 0 5px 16px rgba(8, 127, 120, .2); }
.crumb { padding-left: 14px; border-left: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.environment { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; font-weight: 650; }
.environment i, .live-pin { width: 7px; height: 7px; border-radius: 50%; background: var(--teal); box-shadow: 0 0 0 4px rgba(8, 127, 120, .1); }

.page-lead { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 36px; align-items: end; padding: 52px 0 40px; overflow: visible; }
.page-lead::before { content: ""; position: absolute; inset: 0 -32px; z-index: -1; opacity: .42; background-image: linear-gradient(rgba(16, 21, 20, .045) 1px, transparent 1px), linear-gradient(90deg, rgba(16, 21, 20, .045) 1px, transparent 1px); background-size: 28px 28px; mask-image: linear-gradient(to bottom, black, transparent 92%); }
.eyebrow { display: block; color: var(--muted); font: 650 11px/1.2 var(--mono); letter-spacing: .105em; text-transform: uppercase; }
.lead-copy h1 { max-width: 760px; margin: 13px 0 14px; font-size: clamp(38px, 5.2vw, 72px); line-height: .98; letter-spacing: -.062em; font-weight: 680; }
.lead-copy h1 em { color: var(--teal); font-style: normal; font-weight: 620; }
.lead-copy p { max-width: 680px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.65; }
.lead-actions { min-width: 232px; display: grid; gap: 10px; justify-items: stretch; }
.freshness { display: flex; align-items: center; justify-content: flex-end; gap: 9px; min-height: 28px; color: var(--muted); font: 12px var(--mono); }
.status-orb { flex: 0 0 auto; width: 8px; height: 8px; display: inline-block; border-radius: 50%; }
.status-orb.good { background: #178259; box-shadow: 0 0 0 4px #e4f2ea; }
.status-orb.bad { background: var(--coral); box-shadow: 0 0 0 4px #fae9e4; }
.run-button { min-height: 44px; border: 1px solid #076d68; border-radius: 10px; padding: 0 18px; background: var(--teal); color: white; font-size: 13px; font-weight: 760; cursor: pointer; box-shadow: 0 8px 22px rgba(8, 127, 120, .18); transition: transform .16s ease, background .16s ease, box-shadow .16s ease; }
.run-button:hover { transform: translateY(-1px); background: #066f69; box-shadow: 0 12px 28px rgba(8, 127, 120, .22); }
.run-button:disabled { cursor: progress; opacity: .72; transform: none; }
.probe-menu { position: relative; }
.probe-menu > summary { min-height: 40px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 10px; background: rgba(252, 252, 250, .88); font-size: 12px; font-weight: 700; cursor: pointer; list-style: none; }
.probe-menu > summary::-webkit-details-marker { display: none; }
.probe-menu[open] > summary { border-color: #aebbb5; }
.probe-menu > div { position: absolute; z-index: 20; top: calc(100% + 7px); right: 0; width: 226px; display: grid; padding: 8px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: 0 18px 50px rgba(20, 31, 28, .14); }
.probe-menu button { border: 0; border-radius: 7px; padding: 9px 10px; background: transparent; text-align: left; font-size: 12px; cursor: pointer; }
.probe-menu button:hover { background: #eef2ef; }
.probe-menu span { margin: 6px 2px 3px; padding-top: 8px; border-top: 1px solid #e6eae7; color: var(--muted); font: 10px var(--mono); text-transform: uppercase; }
.probe-menu .danger-action { color: #b74732; }
.progress-rail { position: absolute; inset: auto 0 20px; height: 2px; overflow: hidden; border-radius: 2px; background: #dde3df; opacity: 0; transition: opacity .16s ease; }
.progress-rail[aria-hidden="false"] { opacity: 1; }
.progress-rail span { display: block; width: var(--progress); height: 100%; background: linear-gradient(90deg, var(--amber), var(--teal)); transition: width .18s ease; }

.notice { margin: -18px 0 24px; padding: 11px 14px; border: 1px solid #edb7ab; border-radius: 9px; background: #fff5f2; color: #9e3624; font-size: 13px; }
.route-grid { display: grid; grid-template-columns: 1.15fr .925fr .925fr; gap: 14px; margin-bottom: 14px; }
.route-card { min-width: 0; min-height: 202px; display: block; padding: 18px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); text-align: left; cursor: pointer; box-shadow: 0 1px 0 rgba(16, 21, 20, .02); transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
.route-card:hover { transform: translateY(-2px); border-color: #b8c5bf; box-shadow: 0 14px 32px rgba(25, 36, 32, .07); }
.function-card { background: linear-gradient(145deg, #fffdf8, var(--surface) 70%); }
.portable-card { border-color: #a9beb9; box-shadow: inset 0 0 0 1px rgba(8, 127, 120, .07); }
.route-card-heading { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
.route-card-heading h2 { margin: 3px 0 0; font-size: 17px; letter-spacing: -.025em; }
.route-icon { width: 35px; height: 35px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 10px; background: white; font: 700 16px var(--mono); }
.route-icon.lambda { color: var(--amber); }
.route-icon.pulse { color: var(--teal); }
.route-icon.portable { color: var(--slate); }
.route-path { min-width: 0; max-width: 120px; padding: 5px 7px; border-radius: 6px; color: var(--muted); background: #f0f2ef; font: 10px var(--mono); overflow: hidden; text-overflow: ellipsis; }
.function-states { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin-top: 24px; border: 1px solid #e2e5df; border-radius: 11px; overflow: hidden; background: #e2e5df; }
.function-states > div { min-width: 0; padding: 13px; background: rgba(255, 255, 255, .76); }
.function-states strong { display: block; margin-top: 8px; font: 700 19px var(--mono); letter-spacing: -.04em; }
.function-states small { display: block; margin-top: 5px; color: var(--muted); font-size: 10px; line-height: 1.35; }
.state-label { display: inline-flex; align-items: center; gap: 6px; font: 650 10px var(--mono); text-transform: uppercase; }
.state-label::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: currentColor; }
.state-label.cold { color: var(--coral); }
.state-label.warm { color: var(--amber); }
.compact-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 25px; }
.compact-stats span { min-width: 0; font: 650 12px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.compact-stats small { display: block; margin-bottom: 7px; color: var(--muted); font: 9px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.route-note { display: flex; align-items: center; gap: 9px; margin: 25px 0 0; color: var(--muted); font-size: 11px; }
.portable-state { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 24px; padding-bottom: 13px; border-bottom: 1px solid #e4e8e5; }
.portable-state span { color: var(--muted); font-size: 11px; }
.portable-state strong { color: var(--teal); font: 700 15px var(--mono); }
.portable-card .compact-stats { margin-top: 14px; }

.empty-workbench { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 26px 42px; align-items: center; padding: 38px; border: 1px dashed #bfc9c4; border-radius: 16px; background: rgba(252, 252, 250, .62); }
.empty-workbench h2 { max-width: 620px; margin: 8px 0 10px; font-size: clamp(25px, 3vw, 40px); letter-spacing: -.045em; }
.empty-workbench p { max-width: 600px; margin: 0; color: var(--muted); line-height: 1.6; }
.empty-workbench ol { display: flex; gap: 28px; margin: 0; padding: 0; list-style: none; }
.empty-workbench li { min-width: 110px; display: grid; gap: 4px; }
.empty-workbench li > span { color: var(--teal); font: 700 10px var(--mono); }
.empty-workbench li strong { font-size: 13px; }
.empty-workbench li small { color: var(--muted); font-size: 10px; line-height: 1.4; }
.empty-workbench .run-button { width: fit-content; }

.workbench { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
.panel { min-width: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); overflow: hidden; box-shadow: 0 1px 0 rgba(16, 21, 20, .025); }
.panel-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 18px; border-bottom: 1px solid #e4e8e5; }
.panel-header h2, .stream-toolbar h2 { margin: 4px 0 0; font-size: 15px; letter-spacing: -.022em; }
.panel-header .hint { color: var(--muted); font-size: 10px; text-align: right; }
.panel-header code { padding: 5px 8px; border-radius: 6px; background: #eff2ef; color: var(--slate); font: 10px var(--mono); }
.latency-panel { grid-column: span 8; }
.latest-panel { grid-column: span 4; }
.placement-panel, .stream-panel { grid-column: 1 / -1; }

.latency-plot { padding: 20px 18px 16px; }
.plot-grid { position: relative; height: 232px; overflow: hidden; border-bottom: 1px solid #cbd3ce; background: repeating-linear-gradient(to bottom, transparent 0, transparent 56px, #e9edea 57px, #e9edea 58px); }
.plot-y-axis { position: absolute; inset: 0 auto 0 0; z-index: 2; width: 42px; display: flex; flex-direction: column; justify-content: space-between; padding-bottom: 2px; color: var(--muted); font: 9px var(--mono); }
.plot-bars { height: 100%; display: flex; align-items: end; gap: 4px; padding: 0 8px 0 48px; }
.plot-bar { flex: 1 1 0; min-width: 4px; max-width: 18px; height: var(--height); border: 0; border-radius: 4px 4px 1px 1px; background: var(--color); opacity: .9; cursor: pointer; transition: height .2s ease, opacity .16s ease, transform .16s ease; }
.plot-bar:hover, .plot-bar:focus-visible { opacity: 1; transform: scaleX(1.12); }
.plot-empty { height: 100%; display: grid; place-items: center; padding-left: 42px; color: var(--muted); font-size: 12px; }
.plot-legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 14px; color: var(--muted); font-size: 10px; }
.plot-legend span { display: inline-flex; align-items: center; gap: 6px; }
.plot-legend i { width: 14px; height: 3px; border-radius: 2px; }

.request-empty { min-height: 294px; display: grid; place-items: center; color: var(--muted); font-size: 12px; }
.request-body { padding: 18px; }
.request-headline { display: flex; align-items: center; gap: 10px; padding-bottom: 17px; border-bottom: 1px solid #e5e9e6; }
.request-headline strong { font: 750 18px var(--mono); }
.request-headline > span:last-child { min-width: 0; margin-left: auto; color: var(--muted); font: 10px var(--mono); overflow: hidden; text-overflow: ellipsis; }
.request-primary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 18px 0; }
.request-primary dt, .request-evidence dt, .log-evidence dt { color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
.request-primary dt small { display: block; margin-top: 2px; color: #8c9591; font-size: 8px; }
.request-primary dd { margin: 7px 0 0; font: 700 12px var(--mono); }
.request-evidence { border-top: 1px solid #e5e9e6; padding-top: 13px; }
.request-evidence summary, .log-evidence summary { color: var(--slate); font-size: 11px; font-weight: 700; cursor: pointer; }
.request-evidence dl { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin: 14px 0 0; }
.request-evidence dd { margin: 4px 0 0; font: 10px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-evidence .wide { grid-column: 1 / -1; }

.placement { position: relative; padding: 20px 18px 17px; background-image: linear-gradient(rgba(16, 21, 20, .028) 1px, transparent 1px), linear-gradient(90deg, rgba(16, 21, 20, .028) 1px, transparent 1px); background-size: 24px 24px; }
.placement-track { min-height: 74px; display: flex; overflow: hidden; border: 1px solid #cfd8d3; border-radius: 11px; background: rgba(255, 255, 255, .74); }
.placement-segment { position: relative; min-width: 132px; flex: var(--count) 1 0; display: grid; place-items: center; padding: 13px; border-right: 1px dashed #d0a75f; background: rgba(255, 249, 237, .9); text-align: center; }
.placement-segment.hot { border-color: #72aaa5; background: rgba(235, 248, 246, .92); }
.placement-segment:last-child { border-right: 0; }
.segment-knot { position: absolute; top: 12px; left: 12px; width: 7px; height: 7px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 4px rgba(200, 121, 22, .12); }
.placement-segment.hot .segment-knot { background: var(--teal); box-shadow: 0 0 0 4px rgba(8, 127, 120, .12); }
.placement-segment strong { display: block; font-size: 12px; }
.placement-segment div > span { display: block; margin-top: 5px; color: var(--muted); font: 9px var(--mono); }
.placement-empty { width: 100%; display: grid; place-items: center; color: var(--muted); font-size: 12px; }
.placement-caption { margin: 10px 0 0; color: var(--muted); font-size: 10px; }

.stream-toolbar { position: relative; min-height: 76px; display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid #e4e8e5; }
.stream-toolbar > div:first-child { margin-right: auto; }
.search { width: min(330px, 32vw); height: 38px; border: 1px solid var(--border); border-radius: 9px; background: white; padding: 0 12px; color: var(--ink); font-size: 11px; }
.search::placeholder { color: #929a96; }
.filters-popover { position: relative; }
.filters-popover > summary { height: 38px; display: grid; place-items: center; padding: 0 13px; border: 1px solid var(--border); border-radius: 9px; background: white; font-size: 11px; font-weight: 700; cursor: pointer; list-style: none; }
.filters-popover > summary::-webkit-details-marker { display: none; }
.filter-sheet { position: absolute; z-index: 18; top: 45px; right: 0; width: 250px; display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: 0 18px 50px rgba(20, 31, 28, .14); }
.filter-sheet label { display: grid; gap: 5px; color: var(--muted); font: 10px var(--mono); }
.filter-sheet select { height: 36px; border: 1px solid var(--border); border-radius: 8px; background: white; padding: 0 9px; color: var(--ink); font-size: 11px; }
.filter-sheet button { border: 0; border-radius: 8px; padding: 9px; background: #edf2ef; color: var(--teal); font-size: 11px; font-weight: 700; cursor: pointer; }
.event-count { min-width: 62px; color: var(--muted); font: 10px var(--mono); text-align: right; }
.log-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.log-table th { height: 38px; border-bottom: 1px solid #dce2de; background: #f7f8f5; color: var(--muted); padding: 0 13px; text-align: left; font: 650 9px var(--mono); letter-spacing: .07em; text-transform: uppercase; }
.log-table th:nth-child(1) { width: 12%; }
.log-table th:nth-child(2) { width: 11%; }
.log-table th:nth-child(3) { width: 9%; }
.log-table th:nth-child(4) { width: 16%; }
.log-table td { min-height: 48px; border-bottom: 1px solid #e7ebe8; padding: 12px 13px; font: 11px/1.35 var(--mono); vertical-align: top; overflow: hidden; text-overflow: ellipsis; }
.log-table tr:last-child td { border-bottom: 0; }
.log-table code { color: var(--slate); font: inherit; }
.log-level { display: inline-block; min-width: 43px; padding: 3px 6px; border: 1px solid #98d0cb; border-radius: 999px; background: #edf9f7; color: #08746e; text-align: center; font-size: 9px; text-transform: uppercase; }
.log-level.error { border-color: #e5a798; background: #fff2ee; color: #b6412c; }
.log-evidence summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-evidence dl { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 18px; margin: 12px 0 2px; padding: 11px; border-radius: 8px; background: #f4f6f3; }
.log-evidence dd { margin: 3px 0 0; overflow: hidden; color: var(--ink); text-overflow: ellipsis; white-space: nowrap; }
.empty-row { height: 120px !important; color: var(--muted); text-align: center; vertical-align: middle !important; }

@media (max-width: 980px) {
  .lab-shell { padding-inline: 20px; }
  .page-lead::before { inset-inline: -20px; }
  .page-lead { grid-template-columns: 1fr; align-items: start; }
  .lead-actions { width: min(420px, 100%); grid-template-columns: 1fr 1fr; }
  .freshness { grid-column: 1 / -1; justify-content: flex-start; }
  .route-grid { grid-template-columns: 1fr 1fr; }
  .function-card { grid-column: 1 / -1; }
  .latency-panel, .latest-panel { grid-column: 1 / -1; }
  .empty-workbench { grid-template-columns: 1fr; }
}

@media (max-width: 700px) {
  .lab-shell { padding: 0 12px 32px; }
  .topbar { height: 58px; }
  .crumb { display: none; }
  .page-lead { gap: 26px; padding: 36px 0 34px; }
  .page-lead::before { inset-inline: -12px; }
  .lead-copy h1 { font-size: clamp(38px, 12vw, 56px); }
  .lead-actions { grid-template-columns: 1fr; }
  .freshness { grid-column: auto; }
  .route-grid { grid-template-columns: 1fr; }
  .function-card { grid-column: auto; }
  .route-card { min-height: 0; padding: 15px; }
  .route-card-heading { grid-template-columns: auto 1fr; }
  .route-path { grid-column: 2; }
  .compact-stats { grid-template-columns: 1fr 1fr; }
  .empty-workbench { padding: 25px 18px; }
  .empty-workbench ol { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .empty-workbench li { min-width: 0; }
  .plot-grid { height: 190px; }
  .request-primary { grid-template-columns: 1fr 1fr; }
  .placement-track { overflow-x: auto; }
  .stream-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .stream-toolbar > div:first-child { width: 100%; }
  .search { width: 100%; order: 3; }
  .filters-popover { margin-left: auto; }
  .log-table, .log-table tbody, .log-table tr, .log-table td { display: block; width: 100%; }
  .log-table thead { display: none; }
  .log-table tr { padding: 12px 14px; border-bottom: 1px solid #e2e7e3; }
  .log-table td { min-height: 0; display: grid; grid-template-columns: 76px 1fr; gap: 10px; padding: 5px 0; border: 0; font-size: 11px; }
  .log-table td::before { content: attr(data-label); color: var(--muted); font: 9px var(--mono); text-transform: uppercase; }
  .log-evidence summary { white-space: normal; }
  .log-evidence dl { grid-column: 1 / -1; grid-template-columns: 1fr; }
  .empty-row { display: block !important; height: auto !important; padding: 40px 0 !important; }
  .empty-row::before { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}
`;
