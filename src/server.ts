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
    sourcePath?: unknown;
    outputPath?: unknown;
    overwrite?: unknown;
}

export interface ConvertResult {
    content: Array<{ type: string, text: string }>;
    isError?: boolean;
}

export interface ConvertDeps {
    cwd?: string;
    now?: () => Date;
    fs?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync'> & { realpathSync?: (p: string) => string };
    parse?: typeof parseMermaid;
    generator?: { generate(graph: any, mermaidSource?: string): Promise<Uint8Array> };
    // When set, files may only be read from and written to this directory
    // tree. Defaults to the M2V_MCP_ROOT environment variable.
    root?: string;
}

// The only files this tool will read. The caller is an AI agent acting on
// text it may not control, so "read whatever path I was handed" is not safe.
const DIAGRAM_FILE = /\.(mmd|mermaid|md|markdown)$/i;

function looksLikeDiagramPath(value: string): boolean {
    return !value.includes('\n') && DIAGRAM_FILE.test(value.trim());
}

export async function handleConvertMermaidToVsdx(args: ConvertArgs, deps: ConvertDeps = {}): Promise<ConvertResult> {
    const _fs = deps.fs ?? fs;
    const _parse = deps.parse ?? parseMermaid;
    const _generator = deps.generator ?? new VsdxGenerator();
    const _cwd = deps.cwd ?? process.cwd();
    const _now = deps.now ?? (() => new Date());
    const rootSetting = deps.root ?? process.env.M2V_MCP_ROOT;
    const root = rootSetting ? path.resolve(_cwd, rootSetting) : undefined;

    // Resolve symlinks on the longest existing prefix of `target`, so a link
    // inside the root can't point reads or writes outside it.
    const realish = (target: string): string => {
        const real = _fs.realpathSync ?? ((p: string) => p);
        let existing = target;
        const tail: string[] = [];
        while (!_fs.existsSync(existing)) {
            const parent = path.dirname(existing);
            if (parent === existing) break;
            tail.unshift(path.basename(existing));
            existing = parent;
        }
        try { return path.join(real(existing), ...tail); } catch { return target; }
    };
    const assertInsideRoot = (target: string, what: string) => {
        if (!root) return;
        const resolvedRoot = realish(root);
        const resolved = realish(target);
        if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
            throw new Error(`${what} must be inside ${root}`);
        }
    };

    let fromFile = false;
    try {
        const hasSource = typeof args?.source === 'string' && args.source.length > 0;
        const hasSourcePath = typeof args?.sourcePath === 'string' && args.sourcePath.length > 0;
        if (!hasSource && !hasSourcePath) {
            throw new Error("Missing 'source' argument");
        }

        let mermaidCode: string;
        let inputPath: string | undefined;
        if (hasSourcePath) {
            inputPath = path.resolve(_cwd, (args.sourcePath as string).trim());
            if (!DIAGRAM_FILE.test(inputPath)) throw new Error("'sourcePath' must be a .mmd, .mermaid or .md file");
            if (!_fs.existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);
        } else if (looksLikeDiagramPath(args.source as string) && _fs.existsSync(path.resolve(_cwd, (args.source as string).trim()))) {
            inputPath = path.resolve(_cwd, (args.source as string).trim());
        }

        if (inputPath) {
            assertInsideRoot(inputPath, 'The source file');
            fromFile = true;
            const content = _fs.readFileSync(inputPath, 'utf-8') as string;
            if (/\.(md|markdown)$/i.test(inputPath) || content.includes('```mermaid')) {
                const match = content.match(/```mermaid([\s\S]*?)```/);
                mermaidCode = match ? match[1].trim() : content;
            } else {
                mermaidCode = content;
            }
        } else {
            mermaidCode = args.source as string;
        }

        let outFile: string;
        if (typeof args.outputPath === 'string' && args.outputPath.length > 0) {
            outFile = path.resolve(_cwd, args.outputPath);
            if (!/\.vsdx$/i.test(outFile)) throw new Error("'outputPath' must end in .vsdx");
            assertInsideRoot(outFile, 'The output file');
            if (_fs.existsSync(outFile) && args.overwrite !== true) {
                throw new Error(`${outFile} already exists. Pass overwrite: true to replace it, or choose another outputPath.`);
            }
            const dir = path.dirname(outFile);
            if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true } as any);
        } else {
            const tmpDir = path.join(root ?? _cwd, 'output');
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
                `Check that the diagram has content.`;
        }

        return {
            content: [{ type: "text", text }],
        };
    } catch (error: any) {
        let message = String(error?.message ?? error);
        // A syntax error quotes the lines around it. That is what the caller
        // wants for code it supplied, but when the text came from a file it
        // would hand back that file's contents, so report only where.
        if (fromFile && /^Mermaid syntax error/.test(message)) {
            const line = /Diagram \(line (\d+)\)/.exec(message)?.[1];
            message = `The file is not a valid Mermaid diagram${line ? ` (syntax error on line ${line})` : ''}.`;
        }
        return {
            content: [{ type: "text", text: `Error generating diagram: ${message}` }],
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
                description: "Converts a Mermaid diagram (source code, or a .mmd/.md file) into a Microsoft Visio .vsdx file. Returns the absolute path to the generated file.",
                inputSchema: {
                    type: "object",
                    properties: {
                        source: {
                            type: "string",
                            description: "The Mermaid diagram definition code. (A single-line path to an existing .mmd/.md file is also accepted.)",
                        },
                        sourcePath: {
                            type: "string",
                            description: "Path to a .mmd, .mermaid or .md file to convert, instead of 'source'.",
                        },
                        outputPath: {
                            type: "string",
                            description: "Optional path for the output file; must end in .vsdx. Defaults to output/diagram_<timestamp>.vsdx in the working directory.",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Replace outputPath if it already exists. Default false.",
                        },
                    },
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
