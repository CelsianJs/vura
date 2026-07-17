# Runtime Lab fidelity ledger

Accepted concept: `runtime-lab-concept.png`

| Comparison point | Concept evidence | Render evidence | Resolution |
| --- | --- | --- | --- |
| Information hierarchy | Compact identity/header, four metrics, timing chart, placement timeline, request detail, then log stream | Desktop render preserves the same top-to-bottom scan order | Matched |
| Runtime color language | Function cold is red, Function warm amber, Dedicated teal, portable slate/teal | Metric accents, plot bars, legend, and placement segments use the same semantic palette | Matched; the product-neutral label “Hot” replaces provider branding |
| Density and typography | Operational dashboard with small labels, tabular numerals, and narrow metadata rows | Render uses the same compact rhythm and monospace data treatment without sacrificing legibility | Matched |
| Same-route evidence | Portable timeline visibly changes placement without changing `/api/portable` | Render reserves a full-width timeline and groups consecutive observed runtime samples | Matched; live production promotion/demotion supplies the multi-segment proof |
| Observability controls | Source, level, route, and search controls sit directly above a correlated log table | Render exposes all four controls and verifies source filtering from 21 rows to 7 | Matched |
| Responsive behavior | Mobile concept stacks panels, keeps primary action prominent, and condenses the log table | 390 px QA has no document overflow; controls stack and metrics remain horizontally inspectable | Matched with intentional horizontal metric rail and reduced log columns |
| Live measurements | Concept shows real cold/warm values rather than placeholder marketing data | Render begins empty and populates only from same-origin responses | Improved: no fabricated values are shown before measurement |

Browser QA artifacts are intentionally kept outside the repository under
`/tmp`; the accepted concept remains in source as the durable design reference.
