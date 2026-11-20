# Visio calibration check

Nothing this tool generates had been opened in real Visio when these files were
made. The files are committed in `docs/calibration/`. Each tests one construct, so the answers decide which XML the
generator should write. Generate them with:

```bash
node scripts/make-calibration.mjs docs/calibration
# 01 was made with the converter as it stood before the generator fixes; 12-14 with it as it is now.
node dist/index.js tests/fixtures/all_features.mmd -o docs/calibration/01-current-output.vsdx
node dist/index.js tests/fixtures/all_features.mmd -o docs/calibration/12-new-output-flowchart.vsdx
node dist/index.js tests/fixtures/rob_test.mmd -o docs/calibration/13-new-output-architecture.vsdx
node dist/index.js tests/fixtures/mermaid/sequence.mmd -o docs/calibration/14-new-output-sequence.vsdx
node dist/index.js tests/fixtures/mermaid/class.mmd -o docs/calibration/15-new-output-class.vsdx
node dist/index.js tests/fixtures/mermaid/flowchart-shapes.mmd -o docs/calibration/16-new-output-shapes.vsdx
node dist/index.js tests/fixtures/mermaid/gantt.mmd -o docs/calibration/17-new-output-gantt.vsdx
node dist/index.js tests/fixtures/mermaid/pie.mmd -o docs/calibration/18-new-output-pie.vsdx
node dist/index.js tests/fixtures/mermaid/sequence-participants.mmd -o docs/calibration/19-new-output-sequence-kinds.vsdx
node dist/index.js tests/fixtures/mermaid/c4.mmd -o docs/calibration/20-new-output-c4.vsdx
node dist/index.js tests/fixtures/mermaid/architecture.mmd -o docs/calibration/21-new-output-architecture.vsdx
```

Open each file in desktop Visio. Every page has its own instructions at the top.
A one-line answer per file is enough; "opens with a repair prompt" or "does not
open" is a useful answer too.

| File | What to look at |
|---|---|
| `01-current-output.vsdx` | Today's converter output for a flowchart. Does it open cleanly? Are arrows visible and attached? Do they follow when a shape is dragged? Does text fit its shapes? |
| `02-connector-dynamic-no-master.vsdx` | Arrows start/end on box edges, carry a label, follow and re-route when a box is dragged. Any difference between the top pair and the bottom pair? |
| `03-connector-static-and-legacy.vsdx` | Top pair: glued to fixed connection points. Bottom pair: today's centre-to-centre connector. Where does each arrow start/end; does it follow on drag? |
| `04-connector-with-master.vsdx` | Same checks as 02, for a connector built from an embedded master. |
| `05-containers.vsdx` | For X, Y and Z: do the inner boxes move when the outer box is dragged? Does the Container Tools tab appear? |
| `06-text-placement.vsdx` | Top / centre / bottom text; label position on the zig-zag and on the straight arrow; arrowhead on the zig-zag. |
| `07-fonts.vsdx` | Opens without a warning; each box is in the font it names; bold and italic work. |
| `08-line-ends-and-patterns.vsdx` | Which line-end codes are: open arrow, filled triangle, hollow triangle, filled diamond, hollow diamond, filled circle, hollow circle, cross, crow's-foot variants. Which pattern codes are dashed, dotted, dash-dot. |
| `09-geometry.vsdx` | Hexagon, ellipse, stadium look right; 50% transparent fill, no fill and dashed border behave as labelled. |
| `10-image.vsdx` | The checkerboard image shows. |
| `11-minimal-skeleton.vsdx` | A file with no style sheets opens without a repair prompt. |
| `12-new-output-flowchart.vsdx` | The same flowchart as 01, from the rewritten generator. Compare with 01: shapes sit where their connectors meet them, connectors follow curved routes and re-route on drag, labels sit on their lines, the subgraph moves its members. |
| `13-new-output-architecture.vsdx` | A large real-world flowchart (ELK layout, nested subgraphs, emoji, long labels). Anything misplaced, any text that overflows its box? |
| `14-new-output-sequence.vsdx` | A sequence diagram: message captions above their lines, arrowheads only where the message has one. |
| `15-new-output-class.vsdx` | A class diagram. Each class should be one group: drag it and its member text moves with it; relationships stay attached; hollow triangle / diamond ends look right. |
| `16-new-output-shapes.vsdx` | Newer flowchart shapes (document, cloud, triangle, flag...) drawn from Mermaid's own outlines. Do the outlines look right, is the text inside, do they resize sensibly? |
| `17-new-output-gantt.vsdx` | A Gantt chart as a static drawing: bars, grid lines and labels in place, each individually selectable. |
| `18-new-output-pie.vsdx` | A pie chart as a static drawing: three slices in three colours, legend and percentages. |
| `19-new-output-sequence-kinds.vsdx` | Every sequence participant kind, frames (par, critical, break), a group box and a highlight. Each participant should be one shape with its name; each frame one group. |
| `20-new-output-c4.vsdx` | A C4 context diagram. Drag the Customer: its head, body and texts move together and the "Uses" arrow follows. |
| `21-new-output-architecture.vsdx` | An architecture diagram. Service icons in colour; drag a service and its line follows; drag the API group and the services move with it. |

## Optional: a reference file from Visio

If you can spare ten minutes, draw this by hand in Visio and save it as
`tests/fixtures/visio-reference.vsdx`: two rectangles joined by a connector
with a text label, a container (Insert > Container) holding two shapes, and
one grouped pair of shapes. Visio's own XML for those is the best possible
reference, and the file replaces the self-generated fixture that the
LibreOffice render test currently probes with.
