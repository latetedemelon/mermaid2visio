import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseMermaid } from './parser.js';
import { VsdxGenerator } from './vsdx.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ConvertArgs {
    source?: unknown;
    outputPath?: unknown;
}

export interface ConvertResult {
    content: Array<{ type: string, text: string }>;
    isError?: boolean;
}

export interface ConvertDeps {
    cwd?: string;
    now?: () => Date;
    fs?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync'>;
    parse?: typeof parseMermaid;
    generator?: { generate(graph: any, mermaidSource?: string): Promise<Buffer> };
}

export async function handleConvertMermaidToVsdx(args: ConvertArgs, deps: ConvertDeps = {}): Promise<ConvertResult> {
    const _fs = deps.fs ?? fs;
    const _parse = deps.parse ?? parseMermaid;
    const _generator = deps.generator ?? new VsdxGenerator();
    const _cwd = deps.cwd ?? process.cwd();
    const _now = deps.now ?? (() => new Date());

    try {
        if (!args || typeof args.source !== 'string' || args.source.length === 0) {
            throw new Error("Missing 'source' argument");
        }

        let mermaidCode = args.source as string;
        if (_fs.existsSync(mermaidCode)) {
            const content = _fs.readFileSync(mermaidCode, 'utf-8');
            if (mermaidCode.endsWith('.md') || content.includes('```mermaid')) {
                const match = content.match(/```mermaid([\s\S]*?)```/);
                mermaidCode = match ? match[1].trim() : content;
            } else {
                mermaidCode = content;
            }
        }

        let outFile: string;
        if (typeof args.outputPath === 'string' && args.outputPath.length > 0) {
            outFile = args.outputPath;
        } else {
            const tmpDir = path.join(_cwd, 'output');
            if (!_fs.existsSync(tmpDir)) _fs.mkdirSync(tmpDir, { recursive: true } as any);
            const timestamp = _now().toISOString().replace(/[:.]/g, '-');
            outFile = path.join(tmpDir, `diagram_${timestamp}.vsdx`);
        }

        const graph = await _parse(mermaidCode);
        // Pass the source so the VSDX stores mermaid/source.mmd for round-trip,
        // matching the CLI's behaviour.
        const buffer = await _generator.generate(graph, mermaidCode);
        _fs.writeFileSync(outFile, buffer);

        // Surface the empty-output condition in the tool result. The parser
        // warns on stderr, but MCP clients don't show stderr to the agent, so
        // without this an agent converting an unsupported diagram type gets a
        // silent blank file.
        const totalShapes = (graph?.nodes?.length ?? 0) + (graph?.edges?.length ?? 0) +
            (graph?.clusters?.length ?? 0) + (graph?.labels?.length ?? 0);
        let text = `Successfully generated Visio diagram at: ${outFile}`;
        if (totalShapes === 0) {
            text += `\n\nWarning: no shapes were extracted, so the .vsdx will be blank. ` +
                `The converter fully supports flowchart/graph and partially supports ` +
                `sequence/class/state/ER diagrams; other types (pie, gantt, journey, etc.) ` +
                `are not yet supported.`;
        }

        return {
            content: [{ type: "text", text }],
        };
    } catch (error: any) {
        return {
            content: [{ type: "text", text: `Error generating diagram: ${error.message}` }],
            isError: true,
        };
    }
}

export function createMcpServer(): Server {
    const server = new Server(
        { name: "mermaid2visio-server", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "convert_mermaid_to_vsdx",
                description: "Converts a Mermaid diagram (source code or file path) into a Microsoft Visio .vsdx file. Returns the absolute path to the generated file.",
                inputSchema: {
                    type: "object",
                    properties: {
                        source: {
                            type: "string",
                            description: "The Mermaid diagram definition code OR a path to a .mmd/.md file.",
                        },
                        outputPath: {
                            type: "string",
                            description: "Optional absolute path for the output .vsdx file. Defaults to a temp file.",
                        },
                    },
                    required: ["source"],
                },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, (async (request: any) => {
        if (request.params.name === "convert_mermaid_to_vsdx") {
            return handleConvertMermaidToVsdx(request.params.arguments as ConvertArgs);
        }
        throw new Error(`Unknown tool: ${request.params.name}`);
    }) as any);

    return server;
}

async function run() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    run().catch(console.error);
}
