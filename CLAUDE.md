# CLAUDE.md — Mermaid2Visio Architecture

## Project Overview

Converts Mermaid diagram source (`.mmd` / `.md`) into native editable Microsoft Visio (`.vsdx`) files. No Visio installation required. Runs on Windows, macOS, Linux.

Entry points:
- **CLI**: `src/index.ts` → `dist/index.js`
- **Web GUI**: `src/gui.ts` → `dist/gui.js`
- **MCP server**: `src/server.ts` → `dist/server.js`

All three share the same two-stage pipeline: `parseMermaid` → `VsdxGenerator`.

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
- If `edge.text` is present, a `<Text>` element is embedded in the connector shape

**Connectors** (unglued fallback): Raw SVG path geometry is transcribed via `parsePathToVisio()`. Cubic Béziers are approximated with 4 Casteljau steps. Quadratics likewise. Arcs fall back to straight lines.

**Arrow direction**: `EndArrow: 13` when `edge.arrowEnd` is true; `BeginArrow: 13` when `edge.arrowStart` is true. `13` = standard Visio open arrowhead.

**Visio schema order** within each `<Shape>`: Cells → Sections → Text. Violating this order causes Visio to reject the document. Every shape in the generator follows this order explicitly.

**Mermaid source round-trip**: If `mermaidSource` is passed to `generate()`, it is stored as `mermaid/source.mmd` inside the VSDX ZIP. This allows the source to be recovered without reverse-engineering the geometry.

**`VsdxGenerator.normalizeColor`** is intentionally `public static` — `styling.test.ts` calls it directly to verify color normalization without full round-tripping through the generator. Treat it as a stable internal utility rather than a public API: it's `public` only for the testing seam.

### `src/index.ts`
CLI using `commander`. Handles `.md` file Markdown extraction (strips the ` ```mermaid ``` ` fence). Passes source string to `generate()` for round-trip storage.

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

Fixtures: `tests/fixtures/all_features.mmd`, `tests/fixtures/rob_test.mmd`, `tests/fixtures/diagram (5).vsdx` (reference VSDX for LibreOffice probe).

---

## Known Limitations / Future Work

- **Sequence diagrams**: Rendered as a flat SVG raster approximation; no actor-column × message-row Visio layout. A dedicated serialiser would dramatically improve fidelity.
- **Elliptical arcs in path fallback**: `A` commands fall back to a straight line segment (acceptable for diagram-scale connectors, but lossy for shapes that are actually arcs).
- **Label style on embedded connector text**: `edge.text` is embedded without a Character section (inherits connector defaults). Label font/color from the Mermaid theme is not yet forwarded.
- **Non-flowchart diagram types**: The README claims support for sequence, class, ER, etc. In practice these rely on Mermaid rendering a valid SVG and the parser treating everything as nodes/edges; quality varies significantly.
- **Fidelity mode**: The architectural plan envisions a second `fidelity` output mode that transcribes fixed SVG geometry rather than creating dynamic Visio shapes. Not yet implemented.
