# CLAUDE.md — Mermaid2Visio Architecture

## Project Overview

Converts Mermaid diagram source (`.mmd` / `.md`) into native editable Microsoft Visio (`.vsdx`) files. No Visio installation required. Runs on Windows, macOS, Linux.

Entry points:
- **Fully-browser app**: `src/browser/app.ts` + `src/browser/index.html` → `dist/browser/` (bundled by esbuild via `npm run build:browser`). Runs the entire pipeline client-side — no Node, no Puppeteer, nothing leaves the user's machine.
- **CLI**: `src/index.ts` → `dist/index.js`
- **Web GUI** (Node-backed): `src/gui.ts` → `dist/gui.js`
- **MCP server**: `src/server.ts` → `dist/server.js`

All four share:
- **`src/core/`** — pure, environment-agnostic logic (`mermaidConfig`, `normalize`, `detect`, `types`).
- **`src/extract/`** — the in-page pipeline (DOM code). `index.ts` owns initialise → render → extract → normalise and picks an extractor by diagram kind (`src/core/detect.ts` registry): `unified.ts` for everything on Mermaid's unified renderer (flowchart, class, state, ER, requirement, mindmap, kanban, usecase, swimlane, agentflow), `sequence.ts` for sequence diagrams, and `primitives.ts` as the generic fallback that turns every rendered SVG element into a free-form shape or text box (chart-like types). `model.ts` reads Mermaid's parsed model. `scripts/build-extractor.mjs` bundles `page.ts` into `dist/extractor.iife.js`, which the Node renderer injects into its headless page; the browser app imports the same modules directly. Both paths therefore run identical code.
- `src/vsdx.ts` and `src/validate.ts` (browser-safe).

**`src/render/renderer.ts`** (`MermaidRenderer`) is the only Node-side browser code: it owns Chromium, opens a page per render, loads `mermaid.min.js` + the extractor bundle, and calls the pipeline. `src/parser.ts` is a thin `parseMermaid()` wrapper over it.

**Mermaid version policy.** Mermaid is pinned to an exact version (currently 12.3.0) because extraction depends on the structure of its rendered SVG and on its internal parsed model. `buildMermaidConfig()` (`src/core/mermaidConfig.ts`) is the single place that decides what reaches `mermaid.initialize()`; it pins `look: 'classic'` (Mermaid 12's default `neo` look uses gradients and dash-array tricks that don't convert) and defaults `layout` to `dagre` (Mermaid 12 defaults to ELK, which is bundled and available on request). When upgrading Mermaid: bump the pin, run `node scripts/probe-render.mjs`, and read `git diff tests/fixtures/svg` to see exactly what changed in the output the extractors depend on.

Pipeline:
1. **Render**: Mermaid SVG into a DOM (Puppeteer page for Node; `document` directly in browser).
2. **Extract**: `extractGraph(svg, diagramType)` (`src/extract/index.ts`) → raw `GraphData` (DOM-only, env-agnostic).
3. **Normalize**: `normalizeContentBounds(graph)` shifts content to origin (pure).
4. **Generate**: `VsdxGenerator.generate(graph, source?)` → `Uint8Array` VSDX (JSZip + xmlbuilder2).
5. **Validate** (optional): `validateVsdx(bytes)` — structural oracle.

---

## Data Flow

```
.mmd / .md source
       │
       ▼
  parseMermaid()          src/parser.ts -> src/render/renderer.ts
  (Puppeteer page running src/extract/* + Mermaid.js)
       │
       ▼
  GraphData (IR)          src/parser.ts interfaces
  { nodes[], edges[], clusters[], labels[], width, height }
       │
       ▼
  VsdxGenerator.generate()  src/vsdx.ts
       │
       ▼
  .vsdx Buffer (JSZip)
```

---

## Key Source Files

### `src/render/renderer.ts` + `src/extract/`
Headless Chromium (Puppeteer) renders the Mermaid diagram and extracts geometry via DOM APIs. The notes below describe the extractors in `src/extract/`.

**Coordinate extraction** uses SVG CTM (`getCTM()`/`getScreenCTM()`) rather than parsing `transform` attributes. This correctly accumulates all ancestor transforms, which is essential for nodes inside nested subgraphs.

**One coordinate system.** Everything is mapped into the root SVG's user space with `svg.getScreenCTM().inverse() × el.getScreenCTM()` (`toRootPoint`, `rootMatrix`). That includes edge paths, whose `d` is in the coordinates of whatever nested group Mermaid put them in (composite states, subgraphs with outside connections). An earlier version mixed `getCTM()` with `getScreenCTM()`, which offset every shape from its connectors by the page margin, and by far more when a wide diagram was scaled to fit the window.

**Meaning from the model, geometry from the DOM** (`unified.ts`): node identity, edge endpoints, edge-end kinds, line pattern and shape names come from `db.getData()`, joined by id (`data-id` for edges; DOM ids with their scaffolding peeled for nodes). Shapes with a parametric Visio geometry get a `type`; any other shape is `type: 'path'` carrying the outline Mermaid drew (`paths`) and where it put the text. A node holding several texts (class, ER entity, requirement) becomes a `path` outline plus `children` text boxes, written as a Visio group. Composite states (`.statediagram-cluster`) are clusters.

**Fallback** (`primitives.ts`): for non-graph diagrams, every rendered `path/rect/circle/ellipse/polygon/polyline/line` becomes a `path` node with its own fill and line, and every `text`/`foreignObject` a label (rotation kept). Elements outside the viewBox are dropped; gradients become their first stop; inherited opacity is folded into the colour.

**Node IDs**: Mermaid wraps node IDs as `<svgId>-flowchart-<USERID>-<N>` (the `<svgId>-` prefix on every internal id arrived in 11.14). The extractor strips both the prefix and the scaffold so IDs match what edge paths carry (plain user IDs like `A`, `B`).

**Edge endpoints**: Each `.edgePaths path` element carries `data-id="L_<src>_<dst>_<idx>"` (and the same value, svg-id-prefixed, as its `id`). The extractor reads `startId`/`endId` from `data-id`. Legacy fallback reads `LS-<id>`/`LE-<id>` classes on the parent `<g>`.

**Edge labels**: each `g.edgeLabel` holds a `g.label[data-id]` naming its edge; labels are joined to edges by that id (DOM order is only a fallback) and their box is recorded on the edge.

**Content normalization**: After extraction, all coordinates are translated by `(-minX, -minY)` so the top-left of actual content is at origin. Edge `d` strings are also translated via `translatePathD()`. This prevents off-page shapes when Mermaid/ELK places content with negative SVG coords.

**ELK layout**: bundled with Mermaid 12 — no separate package or registration. Requested via `config.layout`, the GUI picker, or `layout: elk` in the diagram's YAML frontmatter (which Mermaid applies over `initialize()`, so it wins).

**Sequence diagrams** (`sequence.ts`): participant boxes (`rect.actor-top`/`rect.actor-bottom`), activations and notes become rectangle nodes; lifelines and messages become unglued lines, with arrowheads read from their markers and captions placed where Mermaid drew them. Not yet handled: loop/alt/opt frames, stick-figure actors.

**Empty-output warning**: if nothing at all is extracted (an empty diagram), the renderer emits a `console.warn` to stderr naming the detected diagram type, and the MCP tool repeats it in its result. stderr is safe for CLI, GUI, and the MCP server (whose JSON-RPC channel is stdout).

**GraphData interfaces** (the Intermediate Representation):
```typescript
GraphNode   { id, x, y, width, height, text, type, rounding, url, style }
GraphEdge   { d, startId, endId, arrowStart, arrowEnd, text, style }
GraphCluster { id, x, y, width, height, text, style }
GraphLabel  { x, y, width, height, text, style }  // standalone (rare)
```
All `x`, `y` are **top-left** corners in SVG pixels. `width`/`height` are in SVG pixels.

### `src/vsdx.ts`
Generates the VSDX ZIP package from `GraphData`. The XML follows what Visio itself writes (checked against Visio-authored files), and every fill/line/text property is written explicitly on each shape rather than left to style-sheet inheritance. `src/core/color.ts` (any CSS colour -> `#rrggbb` + alpha) and `src/core/svgPath.ts` (path `d` -> polylines) are its pure helpers.

**Coordinate system**: Visio uses inches, left-origin X, **bottom-origin** Y. `toVisioX(px) = margin + px/dpi`, `toVisioY(px) = pageHeight - margin - px/dpi`, with `margin = 0.5"`, `dpi = 96`. Page size is `max(8.5x11, content + 2*margin)`.

**Every 2-D shape** carries `PinX/PinY/Width/Height` plus `LocPinX = Width*0.5`, `LocPinY = Height*0.5`. Without the LocPin cells a shape's pin is its bottom-left corner and everything lands half a shape away from its connectors (the old output did this).

**Emission order = Z order**: subgraphs (outermost first), nodes, connectors, free-standing labels. Shape ids are assigned in that order.

**Subgraphs** are Visio containers: a plain shape with `User.msvStructureType = "Container"` and a `Relationships` cell listing its members (`DEPENDSON(1, ...)`); each member lists its containers (`DEPENDSON(4, ...)`), through every level of nesting. Membership comes from the extractor's `parentId`, or from geometry when absent. `VerticalAlign = 0` (a shape-level cell) puts the title at the top.

**Node geometry** by `node.type`: rectangle (+`Rounding`), circle/ellipse (double circle adds an inner ring), diamond, hexagon, parallelogram (leaning the way `node.shape` says), trapezoid, inv_trapezoid, stadium and cylinder (`EllipticalArcTo` rows), subroutine. Rows carry `F` formulas in `Width`/`Height` so shapes resize sensibly.

**Connectors**: every edge is a 1-D shape. `BeginX/Y` and `EndX/Y` are the two ends of Mermaid's route, and the geometry is that route (curves flattened, then simplified) relative to the begin point, so the file opens looking like the Mermaid diagram. `Width = EndX-BeginX` and `Height = EndY-BeginY` are signed, as in Visio's own connectors.
- If both ends resolve to different shapes the edge is **glued with dynamic glue**: `_WALKGLUE(...)` formulas on the endpoint cells, `BegTrigger`/`EndTrigger` = `_XFTRIGGER(Sheet.N!EventXFMod)`, `ObjType = 2`, and `<Connect FromPart="9|12" ToCell="PinX" ToPart="3">`. Visio re-routes it when a shape moves.
- Otherwise (unresolvable end, or a self-loop) it is a plain line with the same geometry, unglued.
- **Captions** are the connector's own text, placed with `TxtPinX/TxtPinY` at the position Mermaid chose (`edge.labelX...`), with a white `TextBkgnd`; glued connectors also get the `Controls.TextPosition` handle.
- **Line ends** map Mermaid's end kinds (`arrow_point`, `arrow_circle`, `extension`, `aggregation`, `only_one`, ...) to Visio line-end codes; **line patterns** are 1 solid, 2 dashed, 3 dotted.

**Colours**: `none`, `transparent` and zero-alpha paints produce `FillPattern = 0` / `LinePattern = 0` (they used to become black); partial alpha goes to `FillForegndTrans` / `LineColorTrans`.

**Fonts** are opt-in (`new VsdxGenerator({ fonts: true })`, CLI `--fonts`): `Character.Font` is the first family in the CSS stack that Visio knows by name, with a matching `<FaceName>` entry. Off by default until the font table has been confirmed against desktop Visio (see `docs/VISIO_CALIBRATION.md`).

**Visio schema order** within each `<Shape>`: Cells → Sections → Text. Only `Geometry` sections are indexed (`IX`).

**Mermaid source round-trip**: If `mermaidSource` is passed to `generate()`, it is stored as `mermaid/source.mmd` inside the VSDX ZIP.

**`VsdxGenerator.normalizeColor`** is `public static` only as a testing seam.

### `src/validate.ts`
`validateVsdx(buffer)` — a structural validator used as a regression oracle. Checks OPC package integrity (required parts present, every part has a content type, every relationship `Target` resolves, root `.rels` declares a document relationship) plus rules for mistakes Visio accepts silently and then renders wrongly: colours are `#RRGGBB` (on the shape and inside section rows); no formula token in a `V=` without `F=`; `Character.Size` is a plain inch number; every shape with `PinX` also states `LocPinX/LocPinY`; section names are ones MS-VSDX defines (`TextBlock` and `ShapeLayout` are not); only `Geometry` sections need `IX`; a 1-D shape has all four endpoint cells; `Sheet.N` references and `<Connects>` point at real shapes and each `<Connect>` states `FromPart`/`ToPart`; `<Connects>` is a sibling of `<Shapes>`; shape child order is `Cells→Sections→Text`. Passing it does not mean Visio accepts the file.

### `src/index.ts`
CLI using `commander`. Handles `.md` file Markdown extraction (strips the ` ```mermaid ``` ` fence). Passes source string to `generate()` for round-trip storage. Options: `-o/--output`, `-l/--layout` (dagre, elk, elk.*), `-t/--theme`, `--validate` (refuses to write an invalid package), `--fonts`, `-v/--verbose`.

### `src/gui.ts`
Express server with a single-page HTML editor. Accepts Mermaid source + config (layout, theme, spacing, curve type) via JSON POST, returns the VSDX as a download.

### `src/server.ts`
MCP server exposing a `mermaid_to_visio` tool that AI agents can call.

---

## Testing

Tests live in `tests/`. All use Jest with `--experimental-vm-modules` for ESM.

| Test file | What it covers |
|---|---|
| `coordinates.test.ts` | PinX/PinY math, 1D connector glue, top-left convention, parser ID normalisation, cluster-endpoint gluing, `parsePathToVisio` SVG commands |
| `structural_lint.test.ts` | Visio XML schema order (Cells→Sections→Text), ObjType=2, Connection IX base, shape count for rob_test fixture |
| `fixtures.test.ts` | End-to-end parse+generate for `all_features.mmd` and `rob_test.mmd`; validates coordinate bounds, glued connectors, connect count |
| `styling.test.ts` | Color normalisation, fill/stroke/lineweight cells |
| `shapes.test.ts` | Geometry section rows for each node type |
| `generator.test.ts` | Mermaid source round-trip in ZIP, page sizing |
| `layout.test.ts` | ELK vs dagre layout selection; frontmatter detection; default look/layout pinned regardless of Mermaid's defaults |
| `mermaid_config.test.ts` | `buildMermaidConfig` defaults, precedence, and coercion of hostile caller config |
| `parse_errors.test.ts` | Error formatting, inline-comment hint |
| `launch_errors.test.ts` | `explainLaunchFailure` message classification |
| `gui.test.ts` | HTTP endpoints, VSDX download header |
| `mcp_server.test.ts` | MCP tool call → VSDX buffer |
| `package_structure.test.ts` | `dist/` artefacts exist after build |
| `render_libreoffice.test.ts` | Round-trip through LibreOffice (skipped unless `soffice` + `libreoffice-draw` present) |
| `validate.test.ts` | Runs `validateVsdx` over fixtures + a synthetic all-node-types graph; negative tests corrupt a package to prove the validator fires |
| `diagram_types.test.ts` | `detectDiagramType` + the diagram-kind registry; every fixture in `tests/fixtures/mermaid/` (one per Mermaid 12.3 diagram type) converts to a structurally valid package; the support matrix for flowchart/class/state/ER/sequence/pie |

Fixtures: `tests/fixtures/all_features.mmd`, `tests/fixtures/rob_test.mmd`, `tests/fixtures/diagram (5).vsdx` (reference VSDX for LibreOffice probe), `tests/fixtures/mermaid/*.mmd` (one sample per diagram type), `tests/fixtures/svg/<mermaid version>/` (reference dumps of Mermaid's SVG and parsed model for each sample, written by `scripts/probe-render.mjs`; coordinates depend on the machine's fonts, so treat them as reference, not as a test oracle).

The suite shares one Chromium, started by `tests/global-setup.mjs` (which also builds the extractor bundle) and exposed through `M2V_BROWSER_WS_ENDPOINT`.

---

## Known Limitations / Future Work

- **Chart-like diagram types are static drawings** (see the README matrix): shapes and text in place, nothing connected.
- **Sequence diagrams are partial:** no loop/alt/opt frames or stick-figure actors, and messages are not glued to lifelines.
- **Compound nodes have one fill and one line colour** (a Visio shape has one of each), so ER attribute rows lose their alternating shading.
- **Font family is opt-in** (`--fonts`). Only Calibri's font-table entry carries Visio's full metadata; other families are listed by name only, which has not yet been confirmed to open without a warning in desktop Visio.
- **A cross edge end (`--x`) is drawn plain**: Visio has no cross line end.
- **Fidelity mode**: The architectural plan envisions a second `fidelity` output mode that transcribes fixed SVG geometry rather than creating dynamic Visio shapes. Not yet implemented.

### Resolved (this session)
- Sequence diagrams now extract actor boxes, lifelines, and labelled messages (were blank).
- Elliptical arcs in the path fallback are now flattened to polylines (was a straight chord).
- Edge-label color/size/weight is now forwarded to a connector `Character` section.
- Unglued fallback edges now share the margin-aware coordinate transform (were offset 0.5").
- The round-trip `mermaid/source.mmd` part now has a declared content type (was an OPC violation / 1400015 candidate), caught by the new `validateVsdx`.

### Verification note
No Microsoft Visio is available in the dev sandbox, so automated checks run through `validateVsdx`, the Jest suite and (when installed) a LibreOffice render. None of those prove Visio accepts a construct: `docs/VISIO_CALIBRATION.md` and `scripts/make-calibration.mjs` produce single-purpose files for checking each construct in real Visio. Changes affecting *visual* fidelity should still be opened in real Visio to confirm — see `PROGRESS_LOG.md` for items tagged `[VERIFY-IN-VISIO]`.
