# Mermaid2Visio

[![CI](https://github.com/latetedemelon/mermaid2visio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/latetedemelon/mermaid2visio/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-ISC-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
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
- [Node.js](https://nodejs.org/) (v18 or later)

### Setup
```bash
git clone https://github.com/tropikandy/mermaid2visio.git
cd mermaid2visio
npm install
npm run build
```
## Usage

### 1. Web GUI (Recommended)
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
  - Flexbox - Flexible positioning
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
node dist/index.js input.mmd [output.vsdx]
```

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

### 4. Windows Context Menu
Right-click any `.mmd` or `.md` file to convert.
1. Run `install_context_menu.bat` as Administrator.
2. Right-click a file -> **Convert to Visio**.

## Supported Diagram Types

All MermaidJS diagram types are now supported with enhanced layout and theming:

- **Flowcharts** (`graph TD`, `LR`, `RL`, `BT`)
- **Sequence Diagrams**
- **Class Diagrams**
- **State Diagrams**
- **Entity Relationship (ER) Diagrams**
- **User Journey**
- **Gantt Charts**
- **Pie Charts**
- **Git Graph**
- **C4 Diagrams**
- **Mindmaps**
- **XY Charts**
- **Sankey Diagrams**

All with:
- **Subgraphs** (mapped to Containers)
- **Multiple shape types** (Rectangle, Rounded, Cylinder, Rhombus, Stadium, Subroutine, Circle)
- **Styling** (`fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `color`)
- **Hyperlinks** (`click` directive)
- **Smart Glue & Dynamic Routing** (Auto-rerouting connectors in Visio)
- **ELK Layout Support** (Professional hierarchical & orthogonal layouts)
- **Theme Variables** (Full customization)

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

### `ELK layout option doesn't re-render`
Mermaid 11 moved ELK into a separate package that must be registered at
runtime. This project vendors it automatically (`@mermaid-js/layout-elk`);
if you see ELK silently behaving like dagre, confirm with `npm run doctor`
that the package is installed, then reinstall with `npm ci`.

## License
ISC
