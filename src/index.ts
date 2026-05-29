#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { program } from 'commander';
import { parseMermaid } from './parser.js';
import { VsdxGenerator } from './vsdx.js';

// Read package.json for version
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

program
  .name('mermaid2visio')
  .description('Convert Mermaid diagrams to editable Microsoft Visio (.vsdx) files')
  .version(packageJson.version)
  .argument('<input>', 'Path to the input .mmd or .md file')
  .option('-o, --output <path>', 'Path to the output .vsdx file')
  .option('-l, --layout <engine>', 'Layout engine: dagre (default) or elk')
  .option('-t, --theme <name>', 'Mermaid theme: default, forest, dark, or neutral')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (inputFile, options) => {
    try {
        if (!fs.existsSync(inputFile)) {
            console.error(`Error: Input file not found: ${inputFile}`);
            process.exit(1);
        }

        const outputFile = options.output || inputFile.replace(/\.(mmd|md)$/i, '') + '.vsdx';
        
        if (options.verbose) console.log(`Reading ${inputFile}...`);
        let definition = fs.readFileSync(inputFile, 'utf-8');

        // Markdown Support: Extract mermaid block
        if (inputFile.endsWith('.md') || definition.includes('```mermaid')) {
            if (options.verbose) console.log("Markdown detected. Extracting Mermaid code...");
            const match = definition.match(/```mermaid([\s\S]*?)```/);
            if (match && match[1]) {
                definition = match[1].trim();
            } else {
                console.error("Error: No '```mermaid' code block found in the Markdown file.");
                process.exit(1);
            }
        }

        if (options.verbose) console.log("Parsing Mermaid...");
        const graph = await parseMermaid(definition, {
            verbose: !!options.verbose,
            layout: options.layout,
            theme: options.theme,
        });
        
        if (options.verbose) {
            console.log(`Parsed graph:`);
            console.log(`- Nodes: ${graph.nodes.length}`);
            console.log(`- Edges: ${graph.edges.length}`);
            console.log(`- Clusters: ${graph.clusters?.length || 0}`);
        }

        console.log("Generating VSDX...");
        const generator = new VsdxGenerator();
        const buffer = await generator.generate(graph, definition);

        fs.writeFileSync(outputFile, buffer);
        console.log(`✅ Success! Output saved to: ${outputFile}`);

    } catch (e: any) {
        console.error("❌ Error:", e.message || e);
        if (options.verbose && e.stack) console.error(e.stack);
        process.exit(1);
    }
  });

program.parse();