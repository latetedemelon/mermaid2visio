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

### BIGGEST REMAINING OPPORTUNITY
- **Sequence diagrams** (and pie/gantt/journey/etc.) produce a blank VSDX. The flowchart
  extractor can't see their SVG structure. A dedicated sequence-diagram serialiser (actor
  columns × message rows → Visio shapes/connectors) is the highest-value next feature.
- **Font family** is parsed but not emitted (needs a `FaceNames` table; risky without a Visio
  oracle to confirm it doesn't re-trigger 1400015). Size/color/weight/italic ARE forwarded.
