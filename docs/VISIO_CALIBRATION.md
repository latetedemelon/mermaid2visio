# Visio calibration check

Nothing this tool generates had been opened in real Visio when these files were
made. The files are committed in `docs/calibration/`. Each tests one construct, so the answers decide which XML the
generator should write. Generate them with:

```bash
node scripts/make-calibration.mjs docs/calibration
node dist/index.js tests/fixtures/all_features.mmd -o docs/calibration/01-current-output.vsdx
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

## Optional: a reference file from Visio

If you can spare ten minutes, draw this by hand in Visio and save it as
`tests/fixtures/visio-reference.vsdx`: two rectangles joined by a connector
with a text label, a container (Insert > Container) holding two shapes, and
one grouped pair of shapes. Visio's own XML for those is the best possible
reference, and the file replaces the self-generated fixture that the
LibreOffice render test currently probes with.
