# Autonomous Session Progress Log

Started: 2026-05-29. Working branch: `claude/code-review-VUu3e` (based off freshly-merged `master`).

Context: User asked to (1) merge all branches to main, (2) double-check, then (3) take the
project as far as possible over ~4 hours unsupervised, keeping a log of things to verify.

**Important constraint:** No Microsoft Visio available in this sandbox, and LibreOffice
(`soffice`) is installed but non-functional here (cannot even convert a plain `.txt` —
"source file could not be loaded"), so the `render_libreoffice.test.ts` suite legitimately
skips. All verification below is via XML structural validation + the Jest suite, NOT via a
real Visio render. **Anything tagged [VERIFY-IN-VISIO] should be opened in actual Visio to
confirm visual fidelity.**

---

## 0. Branch merge (done first, as requested)

- `claude/code-review-VUu3e` was already fully contained in `master`.
- `claude/fix-flowchart-diagram-PKvF1` had 6 commits not in master (margin support,
  embedded edge labels, curved routing, per-edge arrows, CLAUDE.md, 12 code-review fixes).
- Merged `fix-flowchart` → `master` (commit on master), `npm ci`, `npm run build`, full
  test suite: **90 passed, 2 skipped (LibreOffice)**. Pushed master.
- Double-checked: `git log master..fix-flowchart` is empty; both branches fully merged.

---

## Plan for the autonomous session (priority order)

- [ ] **A. Structural validator (oracle).** Deep VSDX package validator + test, run over all
      fixtures. Becomes the regression oracle for everything below since there's no Visio.
- [ ] **B1. Fallback-edge coordinate bug.** `parsePathToVisio` used margin-less `x/dpi` and
      `pageHeight - y/dpi`, while every other shape uses margin-aware helpers. Unglued edges
      were offset by the 0.5" margin. Fix to share the class helpers.
- [ ] **C1. Edge-label style on connectors.** Embedded connector `<Text>` had no Character
      section, so label color/size from the Mermaid theme was dropped. Forward it.
- [ ] **C2. Elliptical arc flattening.** Path-fallback `A` command drew a straight line;
      implement proper SVG-arc → polyline (center parameterization).
- [ ] **D. Cross-entry-point parity.** Pass Mermaid source through MCP + GUI for round-trip
      storage (CLI already does). Add `--layout`/`--theme` CLI options.
- [ ] **E. Docs + wrap-up.** Update CLAUDE.md limitations, final full test run, push.

---

## Work done (chronological)

### Phase A — Structural validator (oracle) ✅
- Added `src/validate.ts` exporting `validateVsdx(buffer)`: checks OPC package integrity
  (required parts present; every part has a content type via Default/Override; every .rels
  Target resolves to a real part; root .rels declares a document relationship) plus Visio
  ShapeSheet rules (colors are #RRGGBB; no formula token in a V= without F=; Character.Size
  has no U="PT" and is a plain number; Connection rows start at IX>=1; Connects reference
  real shapes; Connects is a sibling of Shapes; shape child order Cells->Sections->Text).
- Added `tests/validate.test.ts`: runs the validator over both fixtures + a synthetic graph
  exercising every node type and a glued + an unglued (curve+arc) edge, plus two negative
  tests that corrupt a package to prove the validator actually fires.
- **Bug found & fixed by the validator:** the round-trip `mermaid/source.mmd` part had NO
  declared content type — an OPC violation and a candidate Visio-1400015 trigger. Added a
  `Default Extension="mmd" ContentType="text/plain"` to `addContentTypes()`.
- Full suite green: 95 passed, 2 skipped (LibreOffice).

### Phase B1 — Fallback-edge coordinate/margin bug ✅
- `parsePathToVisio` had its own `toVisioX/Y` that omitted the 0.5" margin and used
  `pageHeight` instead of `pageHeight - margin`. Unglued fallback edges therefore rendered
  offset by (-0.5", +0.5") from the nodes they connect. Now delegates to the class helpers.
- Regression test asserts the fallback transform matches the node transform exactly.
- [VERIFY-IN-VISIO] Open a diagram whose edges *can't* glue (e.g. a diagram type where the
  parser can't resolve endpoint ids) and confirm the lines now sit on the nodes.

### Phase C2 — Elliptical arc flattening ✅
- Path fallback `A` command now flattens via SVG endpoint-to-center parameterization
  (~1 segment / 15°) instead of a single straight chord. Degenerate arcs still draw a line.
- Tests assert the polyline is multi-segment, bows off the chord, and ends at the endpoint.

### Phase C1 — Edge-label style on connectors ✅
- Parser now forwards each edge label's color/fontSize/fontWeight/fontStyle as
  `GraphEdge.labelStyle`; generator emits a Character section on the connector (before the
  embedded `<Text>`, preserving Cells->Sections->Text order).
- Test asserts normalized color (#ff0000), inch size (14/96 = 0.1458), bold style, and that
  the Character section precedes the Text.
- Closes "Known Limitation: Label style on embedded connector text".
- Full suite green: 98 passed, 2 skipped.

### Phase D — Cross-entry-point parity + CLI options ✅
- MCP server and GUI now pass the Mermaid source to `generate()` so all three entry points
  (CLI/GUI/MCP) embed `mermaid/source.mmd` for round-trip. Added an MCP test asserting the
  source reaches the generator.
- CLI gained `-l/--layout <engine>` and `-t/--theme <name>`, forwarded to `parseMermaid`.
- End-to-end smoke test: `node dist/index.js /tmp/smoke.mmd --theme forest` produced a
  package that passes `validateVsdx` (7 shapes, 6 connects, source.mmd embedded).
- Full suite green: 99 passed, 2 skipped.

### Phase F — Diagram-type honesty (warning + coverage + docs) ✅
- Empirically mapped diagram-type support: flowchart/graph full; class/state/ER partial;
  sequence/pie/gantt produce a blank-but-valid VSDX.
- Parser now `console.warn`s (stderr) when zero geometry is extracted, naming the detected
  diagram type and the support matrix — blank output is no longer silent. Verified via CLI.
- Added `detectDiagramType()` (unit-tested) + `tests/diagram_types.test.ts` pinning the matrix.
- Rewrote the README "Supported Diagram Types" section (was the false "all types supported")
  into an honest support table; documented CLI flags. Updated CLAUDE.md throughout.

### Phase G — Defensive validator + user-facing validation ✅
- Validator now flags any `NaN`/`undefined`/`null`/`Infinity` attribute value across all XML
  parts (Visio silently drops such cells, collapsing geometry/transform invisibly). Negative
  test corrupts a PinX to NaN to prove it fires.
- Added CLI `--validate` flag: runs `validateVsdx` on the generated package and reports issues.
- Full suite green: **113 passed, 2 skipped (LibreOffice)**.

---

## SESSION SUMMARY — for the user

**Branch:** `claude/code-review-VUu3e` (based on freshly-merged `master`). All commits pushed.

**What I did, in order:**
1. Merged `claude/fix-flowchart-diagram-PKvF1` into `master` (6 commits), verified, pushed master.
2. Built a structural validator (`src/validate.ts`) as a regression oracle — it immediately
   caught a real OPC bug (round-trip `.mmd` part had no content type; a 1400015 candidate).
3. Fixed a coordinate bug: unglued fallback edges were offset 0.5" from their nodes.
4. Flattened elliptical arcs in the path fallback (were straight chords).
5. Forwarded edge-label color/size/weight to a connector Character section.
6. Round-trip source parity across CLI/GUI/MCP; added CLI `--layout`/`--theme`/`--validate`.
7. Made blank output for unsupported diagram types loud (warning) instead of silent; pinned
   the real support matrix with tests; rewrote the README/CLAUDE.md to be honest.
8. Added a NaN/undefined guard to the validator.

Test count went 90 → **113 passing** (2 LibreOffice render tests skip in this sandbox).

### THINGS TO CHECK IN REAL VISIO  [VERIFY-IN-VISIO]
The sandbox has no working Visio or LibreOffice importer, so visual fidelity was verified only
via structural validation. Please open a few generated `.vsdx` in actual Visio and confirm:
1. **Fallback (unglued) edges** now sit on their nodes (margin fix). Hard to trigger from
   flowcharts since those glue; most relevant if you hit a diagram where endpoints don't resolve.
2. **Edge labels** render in the right color/size (Character-section forwarding).
3. **Curved/looped connectors and cylinder outlines** look smooth (arc flattening).
4. **Connectors still glue and reroute** when you drag nodes (unchanged, but worth a sanity check).
5. Generated files still **open without error 1400015** (the `.mmd` content-type fix should
   only help here, but confirm).

### Phase H — Sequence diagram extractor ✅ (NEW capability)
- Added a dedicated sequence-diagram branch in `parseMermaid` (keyed on `detectDiagramType`).
  Built against the real Mermaid SVG (inspected first): actor boxes (`rect.actor-top/-bottom`)
  → rectangle nodes (text paired by geometric containment); lifelines (`line.actor-line`) and
  messages (`line.messageLine0` solid / `messageLine1` dashed, with `marker-end` arrowheads)
  → unglued edges with a synthesized `d`; message labels (`text.messageText`) matched by DOM
  order and embedded (with a Character section) on the message connector.
- Verified: a 2-actor / 3-message diagram yields 4 boxes + 5 edges (2 lifelines + 3 messages),
  correct labels, dashed return message, horizontal messages, and a VALID package.
- `tests/sequence.test.ts` added; `diagram_types.test.ts` updated (sequence now expects
  shapes); README/CLAUDE.md support matrix updated (sequence: ❌ → 🟡 partial).
- **[VERIFY-IN-VISIO]** Sequence layout is geometry-faithful to Mermaid but I could not see it
  rendered. Confirm actor boxes sit at top & bottom, lifelines run vertically between them,
  and messages are horizontal arrows at the right heights with labels above the lines.
- Still not extracted for sequence: activations, notes, loop/alt/opt frames.

### BIGGEST REMAINING OPPORTUNITY (updated)
- **Sequence diagram polish**: activations (the thin rectangles on lifelines), notes, and
  loop/alt/opt frames. The scaffolding (type-branched extractor) is now in place to add them.
- **pie/gantt/journey/gitGraph/mindmap/C4/XY/Sankey** still produce blank output — each needs
  its own extractor branch (same pattern as the sequence one).
- **Font family** is parsed but not emitted (needs a `FaceNames` table; risky without a Visio
  oracle to confirm it doesn't re-trigger 1400015). Size/color/weight/italic ARE forwarded.

### Phase I — Self code-review (3 correctness angles) ✅
- Ran a high-effort review of the whole branch diff (line-by-line, removed-behavior,
  cross-file). **No critical bugs found.** Refuted candidates: arcTo div-by-zero (guarded by
  the coincident-endpoint check), Character Row IX=0 (the IX>=1 rule is Connection-only; node
  Character sections have always used IX=0), Size leading-zero regex (matches "0.x"),
  toVisio double-transform (cubic/quad call the corrected lineTo). The flagged margin-transform
  and arc-flattening changes are the *intended* fixes, not regressions.
- One real (minor) finding fixed: sequence message `labelStyle` was missing fontWeight/fontStyle.

### Phase J — MCP empty-output warning in tool result ✅
- The blank-output warning only went to stderr; MCP clients don't surface stderr, so an agent
  converting an unsupported diagram type got a silent blank file. The MCP tool result now
  appends the warning when zero shapes were extracted. Two tests added (warn / don't-warn).

### Phase K — Browser-port spike (serialization de-risk) ✅
- Goal: prove the load-bearing assumption of a future full-browser port — that the geometry
  extractor can be a standalone named function passed by reference to `page.evaluate` (rather
  than an inline closure), which is the prerequisite for sharing ONE extractor between the
  Puppeteer/Node path and a real-browser build.
- Split the single inline `page.evaluate(async (def, dtype) => {...})` in `src/parser.ts` into
  two standalone named functions:
  - `renderMermaidToDom(def)` — renders Mermaid into the page DOM (relies on the page `mermaid`
    global); throws the tagged render error.
  - `extractGraphFromDom(dtype)` — pure DOM reader, returns the raw graph. References ONLY its
    param + browser globals (verified: no `def`, no `await`, no module imports, no parseMermaid
    locals), so it serializes cleanly via `page.evaluate` AND could be imported as-is by a
    browser build.
  Node path is now two calls: `await page.evaluate(renderMermaidToDom, definition)` then
  `const result = await page.evaluate(extractGraphFromDom, diagramType)`. No behavior change.
- RESULT — spike PASSED on every axis: build clean (exit 0); full suite 120 passed / 2 skipped;
  **and the coverage run passed too** (76.55% stmts), which is the path that historically broke
  with `page.evaluate` (Istanbul instrumentation injecting `cov_*` globals; mitigated earlier via
  the v8 coverage provider — this confirms the named-function lift doesn't reintroduce it).
- Conclusion: the browser-port refactor is sound. Remaining steps from the sketch (move the two
  functions + pure helpers into `src/core/`, swap Buffer→Uint8Array, add a bundler + browser
  entry) are mechanical and carry no further serialization risk.

### Phase L — Full browser port ✅ (NEW capability)
- Split the source into a Node-only orchestrator (`src/parser.ts`) and an environment-agnostic
  core (`src/core/types.ts`, `detect.ts`, `normalize.ts`, `extract.ts`). `parser.ts` re-exports
  everything tests/CLI/etc. used from the old path, so no caller changed.
- `src/vsdx.ts` and `src/validate.ts` swapped `Buffer` → `Uint8Array` (JSZip output type
  `'uint8array'`). In Node, `Buffer extends Uint8Array`, so `fs.writeFileSync`,
  `JSZip.loadAsync`, and HTTP `res.end` keep accepting it; in the browser, the same bytes flow
  into a `Blob` for download.
- Added `src/browser/app.ts` + `src/browser/index.html` — a real client-side web app
  (textarea, theme picker, preview, Ctrl/⌘+Enter to convert, Blob download). Bundled with
  esbuild: `npm run build:browser` → `dist/browser/app.js` (~7 MB; mermaid + ELK + JSZip +
  xmlbuilder2 + the core). Installed `events` and `url` browser shims so xmlbuilder2's
  top-level requires resolve cleanly in the browser bundle.
- `tests/browser_bundle.test.ts` — real end-to-end smoke test: boots a local file server,
  loads the bundle in headless Chromium, drives the UI, intercepts the Blob bytes via a
  patched `URL.createObjectURL`, and round-trips them through `validateVsdx`. **PASSES.**
  Skips when the bundle isn't built (so `npm test` without `build:browser` stays fast).
- The browser entry imports `renderMermaidToDom`/`extractGraphFromDom`/`normalizeContentBounds`/
  `detectDiagramType`/`VsdxGenerator`/`validateVsdx` directly — the same modules the Node path
  uses via `page.evaluate`. Single source of truth for extraction.

### FINAL TEST STATUS
- `npm test`: **121 passed, 2 skipped** (the 2 skips are LibreOffice render tests; LibreOffice
  is non-functional in this sandbox). `npm run build` clean (exit 0); `npm run build:browser`
  clean (exit 0). All work committed and pushed to `claude/code-review-VUu3e`. Test count
  over the session: 90 → 121.
