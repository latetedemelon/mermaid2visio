# CLAUDE.md — Mermaid2Visio Architecture

## Project Overview

Converts Mermaid diagram source (`.mmd` / `.md`) into native editable Microsoft Visio (`.vsdx`) files. No Visio installation required. Runs on Windows, macOS, Linux.

Entry points:
- **Fully-browser app**: `src/browser/app.ts` + `src/browser/index.html` → `dist/browser/` (bundled by esbuild via `npm run build:browser`). Runs the entire pipeline client-side — no Node, no Puppeteer, nothing leaves the user's machine.
- **CLI**: `src/index.ts` → `dist/index.js`
- **Web GUI** (Node-backed): `src/gui.ts` → `dist/gui.js`
- **MCP server**: `src/server.ts` → `dist/server.js`

All four share the environment-agnostic core in **`src/core/`** (`extract`, `normalize`, `detect`, `types`) plus `src/vsdx.ts` and `src/validate.ts` (also browser-safe). The Node entries (`parser.ts`, the three servers) wrap that core with Puppeteer + ELK + I/O; the browser entry calls it directly against the live `document`.

Pipeline:
1. **Render**: Mermaid SVG into a DOM (Puppeteer page for Node; `document` directly in browser).
2. **Extract**: `extractGraphFromDom(diagramType)` → raw `GraphData` (DOM-only, env-agnostic).
3. **Normalize**: `normalizeContentBounds(graph)` shifts content to origin (pure).
4. **Generate**: `VsdxGenerator.generate(graph, source?)` → `Uint8Array` VSDX (JSZip + xmlbuilder2).
5. **Validate** (optional): `validateVsdx(bytes)` — structural oracle.

---

## Data Flow

```
.mmd / .md source
       │
       ▼
  parseMermaid()          src/parser.ts
  (Puppeteer + Mermaid.js)
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

### `src/parser.ts`
Headless Chromium (Puppeteer) renders the Mermaid diagram and extracts geometry via DOM APIs.

**Coordinate extraction** uses SVG CTM (`getCTM()`/`getScreenCTM()`) rather than parsing `transform` attributes. This correctly accumulates all ancestor transforms, which is essential for nodes inside nested subgraphs.

**Node IDs**: Mermaid 11.x wraps node IDs as `flowchart-<USERID>-<N>`. The parser strips this scaffold so IDs match what edge paths carry (plain user IDs like `A`, `B`).

**Edge endpoints**: Each `.edgePaths path` element carries `id="L_<src>_<dst>_<idx>"`. The parser extracts `startId`/`endId` from this. Legacy fallback reads `LS-<id>`/`LE-<id>` classes on the parent `<g>`.

**Edge labels**: `g.edgeLabel` groups appear in the same DOM order as `.edgePaths path` elements. The parser matches them by index, storing `text` directly on `GraphEdge`. This avoids needing IDs on label elements (they have none). Only `g.edgeLabel` is selected (not `.edgeLabel`) to avoid the HTML `<span class="edgeLabel">` inside foreignObject.

**Content normalization**: After extraction, all coordinates are translated by `(-minX, -minY)` so the top-left of actual content is at origin. Edge `d` strings are also translated via `translatePathD()`. This prevents off-page shapes when Mermaid/ELK places content with negative SVG coords.

**ELK layout**: When `layout: elk` appears in the diagram's YAML frontmatter, the parser spins up a localhost HTTP server to serve `@mermaid-js/layout-elk/dist/` so Puppeteer can import it as an ES module. Falls back to dagre if registration fails.

**Sequence diagrams**: `parseMermaid` branches on `detectDiagramType`. For `sequenceDiagram` it runs a dedicated extractor (inside the page.evaluate) that maps actor boxes (`rect.actor-top`/`rect.actor-bottom`) to rectangle nodes — pairing each box with the `<text>` whose centre falls inside it — and lifelines (`line.actor-line`) plus messages (`line.messageLine0` solid / `line.messageLine1` dashed) to unglued edges with a synthesized `d`. Message labels (`text.messageText`) are matched to message lines by DOM order. The generator's margin-aware path fallback then draws them. Not yet handled: activations, notes, loop/alt/opt boxes.

**Empty-output warning**: The extractor is flowchart-oriented. If it finds zero geometry (pie/gantt/etc.), `parseMermaid` emits a `console.warn` to stderr naming the detected diagram type (`detectDiagramType()`) and the support matrix, so a blank-but-valid VSDX is never a silent surprise. stderr is safe for CLI, GUI, and the MCP server (whose JSON-RPC channel is stdout).

**GraphData interfaces** (the Intermediate Representation):
```typescript
GraphNode   { id, x, y, width, height, text, type, rounding, url, style }
GraphEdge   { d, startId, endId, arrowStart, arrowEnd, text, style }
GraphCluster { id, x, y, width, height, text, style }
GraphLabel  { x, y, width, height, text, style }  // standalone (rare)
```
All `x`, `y` are **top-left** corners in SVG pixels. `width`/`height` are in SVG pixels.

### `src/vsdx.ts`
Generates the VSDX ZIP package from `GraphData`.

**Coordinate system**: Visio uses inches, left-origin X, **bottom-origin** Y. Helpers:
```
toVisioX(svgPx) = margin + svgPx / dpi
toVisioY(svgPx) = pageHeight - margin - svgPx / dpi
```
`margin = 0.5"`, `dpi = 96`. Page size is `max(8.5×11, content + 2×margin)`.

**Emission order** (Z-order via `DisplayLevel`):
1. Clusters / subgraphs — `DisplayLevel: 0` (background)
2. Nodes — `DisplayLevel: 1` (mid)
3. Connectors (edges) — no DisplayLevel (connectors are 1D)
4. Standalone labels — `DisplayLevel: 2` (foreground, rare)

**Clusters** are emitted as `Type="Group"` shapes with a `User/msvStructureType = "Container"` row. They participate in the same `nodeIdToShapeId`/`nodeIdToPin` maps as nodes so cluster-endpoint edges (`G --> B`) can be glued.

**Connectors** (glued path):
- 1D shape: `Width = Euclidean length`, `Height = 0`, `Angle = atan2(dy,dx)`
- `BeginX/EndX` cells set to endpoint PinX/PinY
- Two `<Connect>` rows link Begin/End to their target shape's PinX
- `ObjType = 2` marks the shape as a Visio connector (dynamic routing)
- `ConLineRouteExt = 2` (curved routing, matching Mermaid's `curve: basis` default)
- If `edge.text` is present, a `<Text>` element is embedded in the connector shape; if `edge.labelStyle` is present, a `Character` section (emitted before `<Text>`) forwards the label's color/size/weight so the caption matches the Mermaid theme

**Connectors** (unglued fallback): Raw SVG path geometry is transcribed via `parsePathToVisio()`, using the same margin-aware `toVisioX/Y` transforms as every other shape (so unglued edges share the node coordinate space). Cubic Béziers are approximated with 4 Casteljau steps; quadratics likewise. Elliptical arcs (`A`) are flattened via the SVG endpoint-to-center parameterization (~1 segment / 15°), with a straight-line fallback only for degenerate (zero-radius / coincident-endpoint) arcs.

**Arrow direction**: `EndArrow: 13` when `edge.arrowEnd` is true; `BeginArrow: 13` when `edge.arrowStart` is true. `13` = standard Visio open arrowhead.

**Visio schema order** within each `<Shape>`: Cells → Sections → Text. Violating this order causes Visio to reject the document. Every shape in the generator follows this order explicitly.

**Mermaid source round-trip**: If `mermaidSource` is passed to `generate()`, it is stored as `mermaid/source.mmd` inside the VSDX ZIP. This allows the source to be recovered without reverse-engineering the geometry.

**`VsdxGenerator.normalizeColor`** is intentionally `public static` — `styling.test.ts` calls it directly to verify color normalization without full round-tripping through the generator. Treat it as a stable internal utility rather than a public API: it's `public` only for the testing seam.

### `src/validate.ts`
`validateVsdx(buffer)` — a structural validator that serves as the regression oracle in the absence of a working Visio/LibreOffice importer. Checks OPC package integrity (required parts present, every part has a content type, every relationship `Target` resolves, root `.rels` declares a document relationship) plus the ShapeSheet rules Visio enforces (colors `#RRGGBB`; no formula token in a `V=` without `F=`; `Character.Size` has no `U="PT"` and is a plain number; `Connection` rows start at `IX>=1`; `<Connects>` reference real shapes and sit as a sibling of `<Shapes>`; shape child order `Cells→Sections→Text`). Conservative by design: every rule maps to a documented constraint, so a failure means a real problem.

### `src/index.ts`
CLI using `commander`. Handles `.md` file Markdown extraction (strips the ` ```mermaid ``` ` fence). Passes source string to `generate()` for round-trip storage. Options: `-o/--output`, `-l/--layout` (dagre|elk), `-t/--theme`, `-v/--verbose`.

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
| `layout.test.ts` | ELK vs dagre layout selection; frontmatter detection |
| `parse_errors.test.ts` | Error formatting, inline-comment hint |
| `launch_errors.test.ts` | `explainLaunchFailure` message classification |
| `gui.test.ts` | HTTP endpoints, VSDX download header |
| `mcp_server.test.ts` | MCP tool call → VSDX buffer |
| `package_structure.test.ts` | `dist/` artefacts exist after build |
| `render_libreoffice.test.ts` | Round-trip through LibreOffice (skipped unless `soffice` + `libreoffice-draw` present) |
| `validate.test.ts` | Runs `validateVsdx` over fixtures + a synthetic all-node-types graph; negative tests corrupt a package to prove the validator fires |
| `diagram_types.test.ts` | `detectDiagramType` unit tests + parse→generate→validate across flowchart/class/state/ER (expect shapes) and sequence/pie (expect blank-but-valid), pinning the support matrix |

Fixtures: `tests/fixtures/all_features.mmd`, `tests/fixtures/rob_test.mmd`, `tests/fixtures/diagram (5).vsdx` (reference VSDX for LibreOffice probe).

---

## Known Limitations / Future Work

- **Diagram-type support varies.** Empirically (see `diagram_types.test.ts`): flowchart/graph are full; sequence/classDiagram/stateDiagram/erDiagram are partial; pie/gantt/journey/gitGraph/mindmap/C4/XY/Sankey extract **zero** geometry and produce a blank-but-valid VSDX (the parser now warns when this happens). The README support matrix reflects this honestly.
- **Sequence diagrams are partial:** actor boxes, lifelines, and labelled messages map (see the sequence extractor), but activations, notes, and loop/alt/opt frames are not yet extracted.
- **Font family is not emitted.** `style.fontFamily` is parsed but never written to Visio — emitting it safely requires a populated `FaceNames` table in `document.xml`, and an empty/malformed one is a known 1400015 trigger, so it was left out pending verification in real Visio. Text currently renders in Visio's default face (size/color/weight/italic *are* forwarded).
- **Fidelity mode**: The architectural plan envisions a second `fidelity` output mode that transcribes fixed SVG geometry rather than creating dynamic Visio shapes. Not yet implemented.

### Resolved (this session)
- Sequence diagrams now extract actor boxes, lifelines, and labelled messages (were blank).
- Elliptical arcs in the path fallback are now flattened to polylines (was a straight chord).
- Edge-label color/size/weight is now forwarded to a connector `Character` section.
- Unglued fallback edges now share the margin-aware coordinate transform (were offset 0.5").
- The round-trip `mermaid/source.mmd` part now has a declared content type (was an OPC violation / 1400015 candidate), caught by the new `validateVsdx`.

### Verification note
No Microsoft Visio is available in the dev sandbox, and LibreOffice's VSDX importer is non-functional there, so all checks run through `validateVsdx` + the Jest suite. Changes affecting *visual* fidelity should still be opened in real Visio to confirm — see `PROGRESS_LOG.md` for items tagged `[VERIFY-IN-VISIO]`.
