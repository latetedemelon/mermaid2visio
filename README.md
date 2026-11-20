# Mermaid2Visio

[![CI](https://github.com/latetedemelon/mermaid2visio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/latetedemelon/mermaid2visio/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-ISC-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-lightgrey)
![Status](https://img.shields.io/badge/status-Active-green)

**Mermaid2Visio** is a modern, cross-platform utility that converts [MermaidJS](https://mermaid.js.org/) diagrams into native, editable Microsoft Visio (`.vsdx`) files. 

Unlike legacy tools that rely on a local installation of Visio (COM automation), this project is built on **Node.js** and generates the VSDX XML structure directly. This means it runs on **Windows, macOS, and Linux**, and produces high-fidelity files without requiring Visio to be installed on the machine performing the conversion.

## Key Advantages

- **No Visio License Required**: Built on a modern Node.js architecture that generates native `.vsdx` XML directly. This means you don't need to buy or install Microsoft Visio to perform conversions.
- **Cross-Platform**: Runs seamlessly on **Windows, macOS, and Linux**.
- **AI-Native Integration**: Includes a built-in **Model Context Protocol (MCP)** server. Connect it to AI agents (like Claude Desktop) to give them the "skill" to generate professional diagrams for you.
- **Smart Glue & Dynamic Routing**: Features an advanced routing engine that creates "Smart Glue" connectors. When you open the file in Visio and move a shape, the lines follow and reroute automatically.
- **Web-Based Visual Editor**: Comes with a local web GUI for instant previewing and one-click downloads.

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v22.12 or later (required by Mermaid 12)

### Setup
```bash
git clone https://github.com/tropikandy/mermaid2visio.git
cd mermaid2visio
npm install
npm run build
```
## Usage

### 0. Fully-browser app (no server, no install)
Build once, then open `dist/browser/index.html` in any modern browser. The
entire pipeline — Mermaid render → geometry extraction → VSDX assembly —
runs client-side. Nothing leaves your machine.
```bash
npm run build:browser
# open dist/browser/index.html
```
Or serve it any way you like (`npx http-server dist/browser`). The bundle is
self-contained (mermaid + ELK + JSZip + xmlbuilder2 + the core extractor and
generator, ~7 MB).

### 1. Web GUI (Recommended for the Node-backed editor)
Visual editor with live preview and configuration panel.
```bash
node dist/gui.js
```
Opens `http://localhost:3333` in your browser. Configure layout, theme, and styling options, paste Mermaid code, verify the preview, and download the `.vsdx`.

#### Configuration Options
The web UI now includes:
- **Layout Engines**: 
  - Dagre (Hierarchical) - Default
  - ELK (Orthogonal) - Professional, structured layouts
  - ELK Stress / ELK Tree - alternative ELK algorithms
- **Themes**: Default, Forest, Dark, Neutral
- **Theme Variables**: 
  - Primary Color
  - Font Family (Segoe UI, Arial, Times New Roman, Courier New, Georgia)
- **Advanced Options**:
  - Node Spacing (10-200 px)
  - Rank Spacing (10-200 px)
  - Curve Type (Basis, Linear, Cardinal, Monotone X)

### 2. Command Line (CLI)
Convert files in bulk or via scripts.
```bash
node dist/index.js input.mmd -o output.vsdx
```
Options:
- `-o, --output <path>` — output file (defaults to the input name with a `.vsdx` extension)
- `-l, --layout <engine>` — `dagre` (default), `elk`, or an ELK algorithm such as `elk.stress` or `elk.mrtree`
- `-t, --theme <name>` — `default`, `forest`, `dark`, or `neutral`
- `--validate` — structurally check the result; nothing is written if it fails
- `--fonts` — also write each text's font family (experimental)
- `-v, --verbose` — diagnostic logging (layout selection, parsed graph summary, render errors)

Accepts a `.mmd` file or a `.md` file containing a ```` ```mermaid ```` fenced block.

### 3. AI Agent Integration (MCP)
Add this tool to your AI assistant (e.g., Claude Desktop) to give it "Visio Skills".

**Configuration (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "mermaid2visio": {
      "command": "node",
      "args": [
        "/absolute/path/to/mermaid2visio/dist/server.js"
      ]
    }
  }
}
```
**Prompt:** *"Generate a system architecture diagram for a cloud app using ELK layout and save it as a Visio file."*

The tool is `convert_mermaid_to_vsdx`. Arguments: `source` (Mermaid code) or `sourcePath` (a `.mmd`/`.md` file), optional `outputPath` (must end in `.vsdx`; defaults to `output/diagram_<timestamp>.vsdx`) and `overwrite`. To confine it to one folder, add `"env": { "M2V_MCP_ROOT": "/path/to/diagrams" }` to the server entry above.

### 4. Windows Context Menu
Right-click any `.mmd` or `.md` file to convert.
1. Run `install_context_menu.bat` as Administrator.
2. Right-click a file -> **Convert to Visio**.

## Supported Diagram Types

Every diagram type Mermaid 12.3 renders converts to a non-blank `.vsdx`. How
"live" the result is depends on the type:

| Diagram type | Result | Notes |
|---|---|---|
| **Flowcharts** (`flowchart`, `graph`) | ✅ Live | Shapes, subgraphs as containers, connectors glued to their shapes, captions, styling, hyperlinks. Shapes without a Visio equivalent keep the exact outline Mermaid drew. |
| **Class diagrams** | ✅ Live | Each class is a group: outline with compartment dividers, and every member as its own text. Relationships are glued, with UML line ends and multiplicities. |
| **State diagrams** | ✅ Live | States, transitions, start/end/choice nodes; composite states are containers. |
| **ER diagrams** | ✅ Live | Entities with their attribute rows; relationships glued, with crow's-foot ends. |
| **C4, architecture, block** | ✅ Live | Each element is one shape (a group when it has several coloured parts, such as a C4 person or an architecture service icon) with its texts; relationships are glued connectors with their labels; architecture groups are containers. |
| **Requirement, mindmap, kanban, use case, swimlane, agent flow** | 🟡 Live, less polished | Nodes and glued connectors map; type-specific decoration may be simplified. |
| **Sequence diagrams** | 🟡 Mostly | Every participant kind (box, stick figure, boundary, control, entity, database, collections, queue) as one named shape; lifelines; messages with captions and the right arrowheads; activations; notes; loop/alt/opt/par/critical/break frames as one grouped shape; autonumber badges; group boxes and highlights. Messages are lines, not glued to lifelines. |
| **Pie, Gantt, XY chart, quadrant, Sankey, timeline, journey, git graph, packet, radar, treemap, tree view, Venn, Ishikawa, Wardley, Cynefin, railroad, event modeling** | 🟦 Static drawing | Drawn as individual editable shapes and text boxes in the right places and colours. Nothing is connected: moving a box does not move its lines. |

"Static drawing" means every bar, slice, line and label is its own Visio shape
you can recolour, move or delete, but the file does not know that, say, an
arrow joins two boxes.

Flowcharts support:
- **Subgraphs**, as Visio containers that move their members
- **Shapes**: rectangle, rounded, stadium, cylinder, diamond, hexagon, parallelogram (both leans), trapezoid (both ways), subroutine, circle, double circle
- **Connectors** that open on Mermaid's own route and re-route when a shape is moved, with their captions where Mermaid placed them
- **Edge ends** (arrow, circle, none, both) and **line styles** (solid, dotted, thick)
- **Styling** (`fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `color`, transparency)
- **Hyperlinks** (`click` directive)
- **ELK layout** on request, and Mermaid theme variables

## Security

Diagram source is treated as untrusted input.

- **Rendering.** Mermaid runs at `securityLevel: strict` (no click callbacks; label HTML is sanitised). The headless page is cut off from the network: images a diagram references are replaced by a blank placeholder and every other request is blocked. Each render has a 60-second limit.
- **Chromium sandbox.** On wherever it can run. It cannot run as root, and some containers lack the kernel support; in those cases the tool warns once and runs without it. Set `M2V_NO_SANDBOX=1` to opt out explicitly.
- **Web GUI.** Binds to `127.0.0.1` unless `HOST` says otherwise and has no authentication, so do not expose it to networks you don't trust. `POST /convert` refuses cross-origin browser requests, caps request bodies at 1 MiB, and runs at most two conversions at once (further requests queue, then receive `503`).
- **MCP server.** Reads only `.mmd`, `.mermaid` and `.md` files, writes only `.vsdx` files, and will not replace an existing file unless called with `overwrite: true`. Set `M2V_MCP_ROOT=/some/dir` to confine all reads and writes to that directory tree.

## Troubleshooting

### `Failed to launch the browser process: Code 127`
Puppeteer's bundled Chromium is missing or can't resolve its shared libraries
(exit 127 = "command not found" under the hood). Pick one:

1. **Install the bundled browser:** `npm run install:browser`
   (equivalent to `npx puppeteer browsers install chrome`)
2. **Point at an existing Chrome/Chromium:**
   `export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`
3. **On Debian/Ubuntu, install missing system libraries:**
   ```bash
   sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
     libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
     libgbm1 libpango-1.0-0 libcairo2 libasound2
   ```

Run `npm run doctor` to diagnose which of the above applies.

### Output looks different from mermaid.live
This tool renders with **Mermaid 12.3.0** (pinned exactly, because the
converter reads Mermaid's rendered SVG and its parsed model). Two defaults are
deliberately different from Mermaid's own:

- **Look** is always `classic`. Mermaid 12's default `neo` look uses gradient
  strokes and drop shadows that have no Visio equivalent.
- **Layout** defaults to `dagre`. Mermaid 12 defaults to ELK; ask for it with
  `--layout elk`, the GUI's layout picker, or `layout: elk` in the diagram's
  frontmatter (frontmatter always wins, as in Mermaid itself).

ELK is bundled with Mermaid 12, so there is nothing extra to install.

## License
ISC
