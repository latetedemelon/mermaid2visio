# Mermaid2Visio

![License](https://img.shields.io/badge/license-ISC-blue)
![Build Status](https://github.com/tropikandy/mermaid2visio/actions/workflows/ci.yml/badge.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-lightgrey)
![Status](https://img.shields.io/badge/status-Active-green)

Let's fix the build status.

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
Visual editor with live preview.
```bash
node dist/gui.js
```
Opens `http://localhost:3000` in your browser. Paste Mermaid code, verify the preview, and download the `.vsdx`.

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
**Prompt:** *"Generate a system architecture diagram for a cloud app and save it as a Visio file."*

### 4. Windows Context Menu
Right-click any `.mmd` or `.md` file to convert.
1. Run `install_context_menu.bat` as Administrator.
2. Right-click a file -> **Convert to Visio**.

## Supported Features

- **Flowcharts** (`graph TD`, `LR`, etc.)
- **Subgraphs** (mapped to Containers)
- **Shapes**:
  - Rectangle `[]`
  - Rounded `()`
  - Cylinder `[()]` (Database)
  - Rhombus `{}` (Decision)
  - Stadium `([])`
  - Subroutine `[[]]`
  - Circle `(())`
- **Styling**: `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `color`
- **Interactivity**: Hyperlinks (`click` directive)

## License
ISC
