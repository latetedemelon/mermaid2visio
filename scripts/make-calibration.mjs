#!/usr/bin/env node
// Generates small, single-purpose .vsdx files that each exercise ONE uncertain
// VSDX construct, so a human with desktop Visio can tell us which variants
// Visio actually honours. Nothing in this repo's generator has ever been
// verified against real Visio; these files are the ground truth for it.
//
// Usage: node scripts/make-calibration.mjs [outDir]   (default: calibration-out)
// Then open each file in Visio and answer the questions in docs/VISIO_CALIBRATION.md.
//
// Each file is deliberately independent: if Visio rejects one construct, the
// other files still open.

import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const NS = 'http://schemas.microsoft.com/office/visio/2012/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PAGE_W = 8.5;
const PAGE_H = 11;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => String(Math.round(v * 1e6) / 1e6);
const cell = (N, V, F, U) => `<Cell N="${N}" V="${esc(V)}"${F ? ` F="${esc(F)}"` : ''}${U ? ` U="${U}"` : ''}/>`;

// ---------------------------------------------------------------- skeletons

// "No Style" style sheet with the defaults Visio itself writes. The current
// generator emits no StyleSheets at all; `rich: false` reproduces that.
const NO_STYLE = `<StyleSheets><StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">` +
    [['EnableLineProps', 1], ['EnableFillProps', 1], ['EnableTextProps', 1], ['HideForApply', 0],
     ['LineWeight', 0.01041666666666667], ['LineColor', 0], ['LinePattern', 1], ['Rounding', 0],
     ['EndArrowSize', 2], ['BeginArrow', 0], ['EndArrow', 0], ['LineCap', 0], ['BeginArrowSize', 2],
     ['LineColorTrans', 0], ['CompoundType', 0], ['FillForegnd', 1], ['FillBkgnd', 0], ['FillPattern', 1],
     ['ShdwForegnd', 0], ['ShdwPattern', 0], ['FillForegndTrans', 0], ['FillBkgndTrans', 0],
     ['LeftMargin', 0], ['RightMargin', 0], ['TopMargin', 0], ['BottomMargin', 0], ['VerticalAlign', 1],
     ['TextBkgnd', 0], ['DefaultTabStop', 0.5], ['TextDirection', 0], ['TextBkgndTrans', 0],
    ].map(([k, v]) => cell(k, v)).join('') +
    `<Section N="Character"><Row IX="0">${cell('Font', 'Calibri')}${cell('Color', 0)}${cell('Style', 0)}${cell('Case', 0)}${cell('Pos', 0)}${cell('FontScale', 1)}${cell('Size', 0.1666666666666667)}</Row></Section>` +
    `<Section N="Paragraph"><Row IX="0">${cell('IndFirst', 0)}${cell('IndLeft', 0)}${cell('IndRight', 0)}${cell('SpLine', -1.2)}${cell('SpBefore', 0)}${cell('SpAfter', 0)}${cell('HorzAlign', 1)}${cell('Bullet', 0)}</Row></Section>` +
    `</StyleSheet></StyleSheets>`;

const CALIBRI = `<FaceName NameU="Calibri" UnicodeRanges="-469750017 -1073732485 9 0" CharSets="536871423 0" Panose="2 15 5 2 2 2 4 3 2 4" Flags="325"/>`;

function documentXml({ rich, faceNames }) {
    const faces = faceNames ?? (rich ? CALIBRI : '');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<VisioDocument xmlns="${NS}" xmlns:r="${RNS}">` +
        `<DocumentSettings${rich ? ' TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0"' : ''}><DynamicGridEnabled>1</DynamicGridEnabled></DocumentSettings>` +
        `<Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/></Colors>` +
        (faces ? `<FaceNames>${faces}</FaceNames>` : '') +
        (rich ? NO_STYLE : '') +
        `</VisioDocument>`;
}

const DYNAMIC_CONNECTOR_MASTER_ID = 2;

// A hand-written equivalent of Visio's built-in "Dynamic connector" master:
// only the functional cells (1-D transform formulas, routing behaviour, text
// control handle). No icon, help topic or style references.
const MASTER_CONTENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<MasterContents xmlns="${NS}" xmlns:r="${RNS}"><Shapes><Shape ID="5" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
    cell('PinX', 1.5, 'GUARD((BeginX+EndX)/2)') + cell('PinY', 1.5, 'GUARD((BeginY+EndY)/2)') +
    cell('Width', 1, 'GUARD(EndX-BeginX)') + cell('Height', -1, 'GUARD(EndY-BeginY)') +
    cell('LocPinX', 0.5, 'GUARD(Width*0.5)') + cell('LocPinY', -0.5, 'GUARD(Height*0.5)') +
    cell('Angle', 0, 'GUARD(0DA)') + cell('FlipX', 0, 'GUARD(FALSE)') + cell('FlipY', 0, 'GUARD(FALSE)') + cell('ResizeMode', 0) +
    cell('BeginX', 1) + cell('BeginY', 2) + cell('EndX', 2) + cell('EndY', 1) +
    cell('TxtPinX', 0, 'SETATREF(Controls.TextPosition)') + cell('TxtPinY', -1, 'SETATREF(Controls.TextPosition.Y)') +
    cell('TxtWidth', 0.5555555555555556, 'MAX(TEXTWIDTH(TheText),5*Char.Size)') +
    cell('TxtHeight', 0.2444444444444444, 'TEXTHEIGHT(TheText,TxtWidth)') +
    cell('TxtLocPinX', 0.2777777777777778, 'TxtWidth*0.5') + cell('TxtLocPinY', 0.1222222222222222, 'TxtHeight*0.5') + cell('TxtAngle', 0) +
    cell('LockHeight', 1) + cell('LockCalcWH', 1) + cell('NoAlignBox', 1) + cell('DynFeedback', 2) + cell('GlueType', 2) +
    cell('ObjType', 2) + cell('NoLiveDynamics', 1) + cell('ShapeSplittable', 1) + cell('TextBkgnd', 2) +
    `<Section N="Control"><Row N="TextPosition">${cell('X', 0)}${cell('Y', -1)}${cell('XDyn', 0, 'Controls.TextPosition')}${cell('YDyn', -1, 'Controls.TextPosition.Y')}` +
    `${cell('XCon', 5, 'IF(OR(STRSAME(SHAPETEXT(TheText),""),HideText),5,0)')}${cell('YCon', 0)}${cell('CanGlue', 0)}${cell('Prompt', 'Reposition Text')}</Row></Section>` +
    `<Section N="Geometry" IX="0">${cell('NoFill', 1)}${cell('NoLine', 0)}${cell('NoShow', 0)}${cell('NoSnap', 0)}${cell('NoQuickDrag', 0)}` +
    `<Row T="MoveTo" IX="1">${cell('X', 0)}${cell('Y', 0)}</Row><Row T="LineTo" IX="2">${cell('X', 0)}${cell('Y', -1)}</Row><Row T="LineTo" IX="3">${cell('X', 1)}${cell('Y', -1)}</Row></Section>` +
    `</Shape></Shapes></MasterContents>`;

const MASTERS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Masters xmlns="${NS}" xmlns:r="${RNS}"><Master ID="${DYNAMIC_CONNECTOR_MASTER_ID}" NameU="Dynamic connector" IsCustomNameU="1" Name="Dynamic connector" IsCustomName="1" Prompt="" IconSize="1" AlignName="2" MatchByName="1" IconUpdate="0" UniqueID="{002A9508-0000-0000-8E40-00608CF305B2}" BaseID="{F7290A45-E3AD-11D2-AE4F-006008C9F5A9}" PatternFlags="0" Hidden="0" MasterType="541">` +
    `<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">${cell('PageWidth', 3)}${cell('PageHeight', 3)}${cell('ShdwOffsetX', 0.125)}${cell('ShdwOffsetY', -0.125)}${cell('PageScale', 1, null, 'IN_F')}${cell('DrawingScale', 1, null, 'IN_F')}${cell('DrawingSizeType', 4)}${cell('DrawingScaleType', 0)}${cell('InhibitSnap', 0)}</PageSheet>` +
    `<Rel r:id="rId1"/></Master></Masters>`;

const rels = (items) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') + `</Relationships>`;

const VREL = 'http://schemas.microsoft.com/visio/2010/relationships/';

async function writePackage(outFile, { shapes, connects = '', rich = true, faceNames, master = false, png = null }) {
    const zip = new JSZip();
    const overrides = [
        ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
        ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
        ['/visio/document.xml', 'application/vnd.ms-visio.drawing.main+xml'],
        ['/visio/windows.xml', 'application/vnd.ms-visio.windows+xml'],
        ['/visio/pages/pages.xml', 'application/vnd.ms-visio.pages+xml'],
        ['/visio/pages/page1.xml', 'application/vnd.ms-visio.page+xml'],
    ];
    if (master) {
        overrides.push(['/visio/masters/masters.xml', 'application/vnd.ms-visio.masters+xml']);
        overrides.push(['/visio/masters/master1.xml', 'application/vnd.ms-visio.master+xml']);
    }
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        (png ? `<Default Extension="png" ContentType="image/png"/>` : '') +
        overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('') + `</Types>`);
    zip.file('_rels/.rels', rels([
        ['rId1', VREL + 'document', 'visio/document.xml'],
        ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
        ['rId3', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
    ]));
    zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Visio</Application><AppVersion>16.0000</AppVersion></Properties>`);
    zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:creator>mermaid2visio calibration</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">1970-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`);
    zip.file('visio/document.xml', documentXml({ rich, faceNames }));
    const docRels = [['rId1', VREL + 'pages', 'pages/pages.xml'], ['rId2', VREL + 'windows', 'windows.xml']];
    if (master) docRels.push(['rId3', VREL + 'masters', 'masters/masters.xml']);
    zip.file('visio/_rels/document.xml.rels', rels(docRels));
    zip.file('visio/windows.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Windows xmlns="${NS}" ClientWidth="1024" ClientHeight="768"><Window ID="0" WindowType="Drawing" WindowState="1073741824" WindowLeft="0" WindowTop="0" WindowWidth="1024" WindowHeight="768" ContainerType="Page" Page="0" ViewScale="-1" ViewCenterX="${PAGE_W / 2}" ViewCenterY="${PAGE_H / 2}">` +
        `<ShowRulers>1</ShowRulers><ShowGrid>1</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>1</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><TabSplitterPos>0.5</TabSplitterPos></Window></Windows>`);
    zip.file('visio/pages/pages.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Pages xmlns="${NS}" xmlns:r="${RNS}"><Page ID="0" NameU="Page-1" Name="Page-1" ViewScale="1" ViewCenterX="${PAGE_W / 2}" ViewCenterY="${PAGE_H / 2}">` +
        `<PageSheet${rich ? ' LineStyle="0" FillStyle="0" TextStyle="0"' : ''}>${cell('PageWidth', PAGE_W)}${cell('PageHeight', PAGE_H)}${cell('ShdwOffsetX', 0.125)}${cell('ShdwOffsetY', -0.125)}${cell('PageScale', 1, null, 'IN_F')}${cell('DrawingScale', 1, null, 'IN_F')}${cell('DrawingSizeType', 0)}${cell('DrawingScaleType', 0)}${cell('InhibitSnap', 0)}</PageSheet>` +
        `<Rel r:id="rId1"/></Page></Pages>`);
    zip.file('visio/pages/_rels/pages.xml.rels', rels([['rId1', VREL + 'page', 'page1.xml']]));
    zip.file('visio/pages/page1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<PageContents xmlns="${NS}" xmlns:r="${RNS}"><Shapes>${shapes}</Shapes>${connects ? `<Connects>${connects}</Connects>` : ''}</PageContents>`);
    const pageRels = [];
    if (master) pageRels.push(['rId1', VREL + 'master', '../masters/master1.xml']);
    if (png) pageRels.push(['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', '../media/image1.png']);
    if (pageRels.length) zip.file('visio/pages/_rels/page1.xml.rels', rels(pageRels));
    if (master) {
        zip.file('visio/masters/masters.xml', MASTERS_XML);
        zip.file('visio/masters/_rels/masters.xml.rels', rels([['rId1', VREL + 'master', 'master1.xml']]));
        zip.file('visio/masters/master1.xml', MASTER_CONTENTS);
    }
    if (png) zip.file('visio/media/image1.png', png);
    fs.writeFileSync(outFile, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ------------------------------------------------------------ shape helpers

const rectGeom = (w, h, extra = '') => `<Section N="Geometry" IX="0">${extra}` +
    `<Row T="MoveTo" IX="1">${cell('X', 0)}${cell('Y', 0)}</Row>` +
    `<Row T="LineTo" IX="2">${cell('X', n(w), 'Width')}${cell('Y', 0)}</Row>` +
    `<Row T="LineTo" IX="3">${cell('X', n(w), 'Width')}${cell('Y', n(h), 'Height')}</Row>` +
    `<Row T="LineTo" IX="4">${cell('X', 0)}${cell('Y', n(h), 'Height')}</Row>` +
    `<Row T="LineTo" IX="5">${cell('X', 0)}${cell('Y', 0)}</Row></Section>`;

const xform = (cx, cy, w, h) => cell('PinX', n(cx)) + cell('PinY', n(cy)) + cell('Width', n(w)) + cell('Height', n(h)) +
    cell('LocPinX', n(w / 2), 'Width*0.5') + cell('LocPinY', n(h / 2), 'Height*0.5');

const charSection = (cells) => `<Section N="Character"><Row IX="0">${cells}</Row></Section>`;

// A filled box. `cells`/`sections` are appended in schema order (Cells, Sections, Text).
function box(id, cx, cy, w, h, text, { cells = '', sections = '', fill = '#e1f5fe', geom } = {}) {
    return `<Shape ID="${id}" Type="Shape">${xform(cx, cy, w, h)}` +
        cell('FillForegnd', fill) + cell('LineColor', '#01579b') + cell('LineWeight', 0.0104) + cells +
        (geom ?? rectGeom(w, h)) + sections + (text != null ? `<Text>${esc(text)}</Text>` : '') + `</Shape>`;
}

// Borderless caption text.
function note(id, cx, cy, w, h, text, size = 0.125) {
    return `<Shape ID="${id}" Type="Shape">${xform(cx, cy, w, h)}` + cell('LinePattern', 0) + cell('FillPattern', 0) + cell('VerticalAlign', 0) +
        rectGeom(w, h, cell('NoFill', 1) + cell('NoLine', 1)) +
        charSection(cell('Size', size)) + `<Section N="Paragraph"><Row IX="0">${cell('HorzAlign', 0)}</Row></Section>` +
        `<Text>${esc(text)}</Text></Shape>`;
}

const title = (id, text) => note(id, PAGE_W / 2, PAGE_H - 0.6, PAGE_W - 1, 0.8, text, 0.1528);

// Dynamic connector between two shapes, drawn with an initial route of page
// points `pts` ([[x,y],...]; first = begin, last = end).
function dynConnector(id, fromId, toId, pts, text, { master = false, extraCells = '', staticGlue = null } = {}) {
    const [bx, by] = pts[0];
    const [ex, ey] = pts[pts.length - 1];
    const w = ex - bx, h = ey - by;
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    const next = pts[Math.floor((pts.length - 1) / 2) + 1] ?? mid;
    const tx = (mid[0] + next[0]) / 2 - bx, ty = (mid[1] + next[1]) / 2 - by;
    const beginF = staticGlue ? `PAR(PNT(Sheet.${fromId}!Connections.X${staticGlue[0]},Sheet.${fromId}!Connections.Y${staticGlue[0]}))` : '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)';
    const endF = staticGlue ? `PAR(PNT(Sheet.${toId}!Connections.X${staticGlue[1]},Sheet.${toId}!Connections.Y${staticGlue[1]}))` : '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)';
    let s = `<Shape ID="${id}" NameU="Dynamic connector${master ? '' : '.' + id}" Type="Shape"${master ? ` Master="${DYNAMIC_CONNECTOR_MASTER_ID}"` : ''}>`;
    if (master) {
        s += cell('PinX', n((bx + ex) / 2), 'Inh') + cell('PinY', n((by + ey) / 2), 'Inh') + cell('Width', n(w), 'Inh') + cell('Height', n(h), 'Inh') +
            cell('LocPinX', n(w / 2), 'Inh') + cell('LocPinY', n(h / 2), 'Inh');
    } else {
        s += cell('PinX', n((bx + ex) / 2), 'GUARD((BeginX+EndX)/2)') + cell('PinY', n((by + ey) / 2), 'GUARD((BeginY+EndY)/2)') +
            cell('Width', n(w), 'GUARD(EndX-BeginX)') + cell('Height', n(h), 'GUARD(EndY-BeginY)') +
            cell('LocPinX', n(w / 2), 'GUARD(Width*0.5)') + cell('LocPinY', n(h / 2), 'GUARD(Height*0.5)') + cell('Angle', 0, 'GUARD(0DA)');
    }
    s += cell('BeginX', n(bx), beginF) + cell('BeginY', n(by), beginF) + cell('EndX', n(ex), endF) + cell('EndY', n(ey), endF);
    if (!staticGlue) {
        s += cell('BegTrigger', 2, `_XFTRIGGER(Sheet.${fromId}!EventXFMod)`) + cell('EndTrigger', 2, `_XFTRIGGER(Sheet.${toId}!EventXFMod)`);
    }
    if (!master) {
        s += cell('ObjType', 2) + cell('GlueType', 2) + cell('NoAlignBox', 1) + cell('DynFeedback', 2) + cell('ShapeSplittable', 1) + cell('TextBkgnd', 2) + cell('FillPattern', 0);
    }
    s += cell('LineColor', '#01579b') + cell('LineWeight', 0.0139) + cell('EndArrow', 13) + cell('EndArrowSize', 2) + extraCells;
    s += cell('TxtPinX', n(tx), master ? 'Inh' : 'SETATREF(Controls.TextPosition)') + cell('TxtPinY', n(ty), master ? 'Inh' : 'SETATREF(Controls.TextPosition.Y)');
    if (!master) {
        s += cell('TxtWidth', 0.6, 'MAX(TEXTWIDTH(TheText),5*Char.Size)') + cell('TxtHeight', 0.25, 'TEXTHEIGHT(TheText,TxtWidth)') +
            cell('TxtLocPinX', 0.3, 'TxtWidth*0.5') + cell('TxtLocPinY', 0.125, 'TxtHeight*0.5');
    }
    s += `<Section N="Control"><Row N="TextPosition">${cell('X', n(tx))}${cell('Y', n(ty))}` +
        (master ? cell('XDyn', n(tx), 'Inh') + cell('YDyn', n(ty), 'Inh')
                : cell('XDyn', n(tx), 'Controls.TextPosition') + cell('YDyn', n(ty), 'Controls.TextPosition.Y') + cell('XCon', 0) + cell('YCon', 0) + cell('CanGlue', 0)) +
        `</Row></Section>`;
    s += `<Section N="Geometry" IX="0">${master ? '' : cell('NoFill', 1) + cell('NoLine', 0)}` +
        pts.map(([x, y], i) => `<Row T="${i === 0 ? 'MoveTo' : 'LineTo'}" IX="${i + 1}">${cell('X', n(x - bx))}${cell('Y', n(y - by))}</Row>`).join('') + `</Section>`;
    if (text) s += charSection(cell('Size', 0.111)) + `<Text>${esc(text)}</Text>`;
    return s + `</Shape>`;
}

const dynConnects = (id, fromId, toId) =>
    `<Connect FromSheet="${id}" FromCell="BeginX" FromPart="9" ToSheet="${fromId}" ToCell="PinX" ToPart="3"/>` +
    `<Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="${toId}" ToCell="PinX" ToPart="3"/>`;

// Four connection points, in the form real Visio files use (T="Connection", IX from 0).
const connectionPoints = (w, h) => `<Section N="Connection">` +
    [[w / 2, 0, 'Width*0.5', null, 0, -1], [w / 2, h, 'Width*0.5', 'Height', 0, 1], [0, h / 2, null, 'Height*0.5', -1, 0], [w, h / 2, 'Width', 'Height*0.5', 1, 0]]
        .map(([x, y, fx, fy, dx, dy], i) => `<Row T="Connection" IX="${i}">${cell('X', n(x), fx)}${cell('Y', n(y), fy)}${cell('DirX', dx)}${cell('DirY', dy)}${cell('Type', 0)}</Row>`).join('') +
    `</Section>`;

// A straight unglued line with an arrowhead/pattern, as a 1-D shape.
function line(id, x1, y1, x2, y2, extraCells = '') {
    const w = x2 - x1, h = y2 - y1;
    return `<Shape ID="${id}" Type="Shape">` +
        cell('PinX', n((x1 + x2) / 2), '(BeginX+EndX)/2') + cell('PinY', n((y1 + y2) / 2), '(BeginY+EndY)/2') +
        cell('Width', n(w), 'EndX-BeginX') + cell('Height', n(h), 'EndY-BeginY') +
        cell('LocPinX', n(w / 2), 'Width*0.5') + cell('LocPinY', n(h / 2), 'Height*0.5') +
        cell('BeginX', n(x1)) + cell('BeginY', n(y1)) + cell('EndX', n(x2)) + cell('EndY', n(y2)) +
        cell('LineColor', '#000000') + cell('LineWeight', 0.0139) + extraCells +
        `<Section N="Geometry" IX="0">${cell('NoFill', 1)}<Row T="MoveTo" IX="1">${cell('X', 0)}${cell('Y', 0)}</Row><Row T="LineTo" IX="2">${cell('X', n(w))}${cell('Y', n(h))}</Row></Section></Shape>`;
}

// Minimal RGBA PNG encoder (checkerboard) so the image test needs no binary fixture.
function makePng(size = 64) {
    const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const o = y * (size * 4 + 1) + 1 + x * 4;
            const on = ((x >> 3) + (y >> 3)) % 2 === 0;
            raw[o] = on ? 0x01 : 0xff; raw[o + 1] = on ? 0x57 : 0xc1; raw[o + 2] = on ? 0x9b : 0x07; raw[o + 3] = 0xff;
        }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// -------------------------------------------------------------------- files

const files = {
    // Dynamic glue without a master. A/B: right-angle route. C/D: same with ConFixedCode=6.
    '02-connector-dynamic-no-master.vsdx': () => ({
        shapes: title(90, '02  Connector WITHOUT a master, dynamic glue. Each arrow should start and end on the box edges (not the centres) and carry its label. Drag any box: the arrow should follow and re-route.') +
            box(1, 2, 8.5, 1.5, 0.75, 'A') + box(2, 6, 6.5, 1.5, 0.75, 'B') +
            dynConnector(3, 1, 2, [[2.75, 8.5], [6, 8.5], [6, 6.875]], 'A to B', { extraCells: cell('ShapeRouteStyle', 1) }) +
            box(4, 2, 4.5, 1.5, 0.75, 'C') + box(5, 6, 2.5, 1.5, 0.75, 'D') +
            dynConnector(6, 4, 5, [[2.75, 4.5], [6, 4.5], [6, 2.875]], 'C to D', { extraCells: cell('ShapeRouteStyle', 1) + cell('ConFixedCode', 6) }),
        connects: dynConnects(3, 1, 2) + dynConnects(6, 4, 5),
    }),
    // Static glue to named connection points, plus what the generator emits today.
    '03-connector-static-and-legacy.vsdx': () => ({
        shapes: title(90, '03  TOP pair: static glue to connection points (right side of A to top of B). BOTTOM pair: what mermaid2visio writes today (centre to centre). For each: is the arrow visible, where does it start/end, and does it follow when you drag a box?') +
            box(1, 2, 8.5, 1.5, 0.75, 'A', { sections: connectionPoints(1.5, 0.75) }) + box(2, 6, 6.5, 1.5, 0.75, 'B', { sections: connectionPoints(1.5, 0.75) }) +
            dynConnector(3, 1, 2, [[2.75, 8.5], [6, 8.5], [6, 6.875]], 'static', { staticGlue: [4, 2] }) +
            box(4, 2, 4.5, 1.5, 0.75, 'C', { cells: cell('DisplayLevel', 1) }) + box(5, 6, 2.5, 1.5, 0.75, 'D', { cells: cell('DisplayLevel', 1) }) +
            // Verbatim shape of the current generator's glued connector.
            (() => { const dx = 4, dy = -2, len = Math.hypot(dx, dy); return `<Shape ID="6" Type="Shape">` +
                cell('PinX', 4) + cell('PinY', 3.5) + cell('Width', n(len)) + cell('Height', 0) + cell('LocPinX', n(len / 2)) + cell('LocPinY', 0) + cell('Angle', n(Math.atan2(dy, dx))) +
                cell('BeginX', 2) + cell('BeginY', 4.5) + cell('EndX', 6) + cell('EndY', 2.5) + cell('FillPattern', 0) + cell('EndArrow', 13) + cell('ObjType', 2) + cell('LineColor', '#01579b') + cell('LineWeight', 0.0104) +
                `<Section N="Geometry" IX="0">${cell('NoFill', 1)}<Row T="MoveTo" IX="1">${cell('X', 0)}${cell('Y', 0)}</Row><Row T="LineTo" IX="2">${cell('X', n(len), 'Width')}${cell('Y', 0)}</Row></Section>` +
                `<Text>legacy</Text></Shape>`; })(),
        connects: `<Connect FromSheet="3" FromCell="BeginX" FromPart="9" ToSheet="1" ToCell="Connections.X4" ToPart="103"/>` +
            `<Connect FromSheet="3" FromCell="EndX" FromPart="12" ToSheet="2" ToCell="Connections.X2" ToPart="101"/>` +
            `<Connect FromSheet="6" FromCell="BeginX" ToSheet="4" ToCell="PinX"/><Connect FromSheet="6" FromCell="EndX" ToSheet="5" ToCell="PinX"/>`,
    }),
    // Same as 02 but the connector is an instance of an embedded master.
    '04-connector-with-master.vsdx': () => ({
        master: true,
        shapes: title(90, '04  Connector that uses an embedded "Dynamic connector" master. Same checks as file 02: arrow on the box edges, label present, follows and re-routes when a box is dragged.') +
            box(1, 2, 8.5, 1.5, 0.75, 'A') + box(2, 6, 6.5, 1.5, 0.75, 'B') +
            dynConnector(3, 1, 2, [[2.75, 8.5], [6, 8.5], [6, 6.875]], 'A to B', { master: true }),
        connects: dynConnects(3, 1, 2),
    }),
    // Containers: three ways to say "these shapes belong to this box".
    '05-containers.vsdx': () => {
        const userRows = `<Section N="User"><Row N="msvStructureType">${cell('Value', 'Container', null, 'STR')}</Row><Row N="msvSDContainerMargin">${cell('Value', 0.125)}</Row><Row N="msvSDContainerResize">${cell('Value', 0)}</Row></Section>`;
        const lvl = cell('DisplayLevel', -25000);
        return {
            shapes: title(90, '05  Three containers. For each (X, Y, Z): drag the big box by its border. Do the two small boxes inside move with it? Does Visio show the "Container Tools" ribbon tab when the big box is selected?') +
                // X: container user cells + Relationships both ways.
                box(1, 2.25, 8, 3.5, 1.75, 'X: user cells + Relationships', { fill: '#fff8e1', cells: cell('VerticalAlign', 0) + lvl + cell('Relationships', 0, 'SUM(DEPENDSON(1,Sheet.2!SheetRef(),Sheet.3!SheetRef()))'), sections: userRows }) +
                box(2, 1.5, 7.8, 1, 0.5, 'x1', { cells: cell('Relationships', 0, 'SUM(DEPENDSON(4,Sheet.1!SheetRef()))') }) +
                box(3, 3, 7.8, 1, 0.5, 'x2', { cells: cell('Relationships', 0, 'SUM(DEPENDSON(4,Sheet.1!SheetRef()))') }) +
                // Y: container user cells only.
                box(4, 6.25, 8, 3.5, 1.75, 'Y: user cells only', { fill: '#fff8e1', cells: cell('VerticalAlign', 0) + lvl, sections: userRows }) +
                box(5, 5.5, 7.8, 1, 0.5, 'y1') + box(6, 7, 7.8, 1, 0.5, 'y2') +
                // Z: a real Group with child shapes (child coordinates are group-local).
                `<Shape ID="7" Type="Group">${xform(4.25, 4.5, 3.5, 1.75)}${cell('FillForegnd', '#fff8e1')}${cell('LineColor', '#01579b')}${cell('VerticalAlign', 0)}` +
                rectGeom(3.5, 1.75) + `<Text>Z: real group</Text><Shapes>` +
                box(8, 1, 0.675, 1, 0.5, 'z1') + box(9, 2.5, 0.675, 1, 0.5, 'z2') + `</Shapes></Shape>`,
        };
    },
    // Text block placement, vertical alignment, text on lines.
    '06-text-placement.vsdx': () => ({
        shapes: title(90, '06  Text placement. (1) Left box: text at the TOP. Middle: CENTRE. Right: BOTTOM. (2) The zig-zag line: the word "here" should sit on the white patch near its second bend, not in the middle of the page, and the line should end in an arrowhead. (3) The straight arrow: "above" should sit just above the line.') +
            box(1, 1.75, 8.5, 2, 1.25, 'top', { cells: cell('VerticalAlign', 0) }) +
            box(2, 4.25, 8.5, 2, 1.25, 'centre', { cells: cell('VerticalAlign', 1) }) +
            box(3, 6.75, 8.5, 2, 1.25, 'bottom', { cells: cell('VerticalAlign', 2) }) +
            // 2-D open polyline with a tight bounding box and an explicitly placed text block.
            `<Shape ID="4" Type="Shape">${xform(4, 5.5, 5, 1.5)}${cell('FillPattern', 0)}${cell('LineColor', '#000000')}${cell('LineWeight', 0.0139)}${cell('EndArrow', 13)}` +
            cell('TxtPinX', 3.5) + cell('TxtPinY', 1.5) + cell('TxtWidth', 0.6) + cell('TxtHeight', 0.25) + cell('TxtLocPinX', 0.3) + cell('TxtLocPinY', 0.125) + cell('TextBkgnd', 2) +
            `<Section N="Geometry" IX="0">${cell('NoFill', 1)}<Row T="MoveTo" IX="1">${cell('X', 0)}${cell('Y', 0)}</Row><Row T="LineTo" IX="2">${cell('X', 2)}${cell('Y', 1.5)}</Row><Row T="LineTo" IX="3">${cell('X', 3.5)}${cell('Y', 1.5)}</Row><Row T="LineTo" IX="4">${cell('X', 5)}${cell('Y', 0)}</Row></Section>` +
            `<Text>here</Text></Shape>` +
            // 1-D line with its label lifted above it.
            `<Shape ID="5" Type="Shape">` + cell('PinX', 4, '(BeginX+EndX)/2') + cell('PinY', 3, '(BeginY+EndY)/2') + cell('Width', 4, 'EndX-BeginX') + cell('Height', 0, 'EndY-BeginY') +
            cell('LocPinX', 2, 'Width*0.5') + cell('LocPinY', 0, 'Height*0.5') + cell('BeginX', 2) + cell('BeginY', 3) + cell('EndX', 6) + cell('EndY', 3) +
            cell('LineColor', '#000000') + cell('LineWeight', 0.0139) + cell('EndArrow', 13) +
            cell('TxtPinX', 2) + cell('TxtPinY', 0.15) + cell('TxtWidth', 1) + cell('TxtHeight', 0.25) + cell('TxtLocPinX', 0.5) + cell('TxtLocPinY', 0.125) +
            `<Section N="Geometry" IX="0">${cell('NoFill', 1)}<Row T="MoveTo" IX="1">${cell('X', 0)}${cell('Y', 0)}</Row><Row T="LineTo" IX="2">${cell('X', 4)}${cell('Y', 0)}</Row></Section>` +
            `<Text>above</Text></Shape>`,
    }),
    // Fonts, with complete FaceName metadata for one and name-only entries for the rest.
    '07-fonts.vsdx': () => ({
        faceNames: CALIBRI + `<FaceName NameU="Segoe UI"/><FaceName NameU="Courier New"/><FaceName NameU="Times New Roman"/>`,
        shapes: title(90, '07  Fonts. Does the file open without a warning? Is each box shown in the font it names (select the text and read the font box on the Home tab)? Are the bold and italic boxes bold and italic?') +
            ['Calibri', 'Segoe UI', 'Courier New', 'Times New Roman'].map((f, i) =>
                box(i + 1, 2.25 + (i % 2) * 4, 8.5 - Math.floor(i / 2) * 1.5, 3, 0.9, f, { sections: charSection(cell('Font', f) + cell('Size', 0.1944)) })).join('') +
            box(5, 2.25, 5, 3, 0.9, 'Segoe UI bold', { sections: charSection(cell('Font', 'Segoe UI') + cell('Size', 0.1944) + cell('Style', 1)) }) +
            box(6, 6.25, 5, 3, 0.9, 'Segoe UI italic', { sections: charSection(cell('Font', 'Segoe UI') + cell('Size', 0.1944) + cell('Style', 2)) }),
    }),
    // Line-end and line-pattern galleries: read off which numbers look like what.
    '08-line-ends-and-patterns.vsdx': () => {
        let s = title(900, '08  Galleries. LEFT block: line ends 0-45 (the number is the code). RIGHT block: line patterns 0-23. Please tell me which codes look like: open arrow, filled triangle, hollow triangle, filled diamond, hollow diamond, filled circle, hollow circle, cross / X, and the four crow\'s-foot ends; and which patterns are dashed, dotted, and dash-dot.');
        let id = 1;
        for (let i = 0; i <= 45; i++) {
            const col = Math.floor(i / 16), row = i % 16;
            const x = 0.9 + col * 1.75, y = 9.4 - row * 0.5;
            s += note(id++, x - 0.25, y, 0.4, 0.3, String(i));
            s += line(id++, x, y, x + 1.1, y, cell('EndArrow', i) + cell('EndArrowSize', 3));
        }
        for (let i = 0; i <= 23; i++) {
            const col = Math.floor(i / 16), row = i % 16;
            const x = 6.3 + col * 1.1, y = 9.4 - row * 0.5;
            s += note(id++, x - 0.25, y, 0.4, 0.3, String(i));
            s += line(id++, x, y, x + 0.7, y, cell('LinePattern', i) + cell('LineWeight', 0.0208));
        }
        return { shapes: s };
    },
    // Arbitrary outlines, arcs, transparency, no-fill.
    '09-geometry.vsdx': () => {
        const rel = (rows, extra = '') => `<Section N="Geometry" IX="0">${extra}${rows.map(([t, cells], i) => `<Row T="${t}" IX="${i + 1}">${Object.entries(cells).map(([k, v]) => cell(k, v)).join('')}</Row>`).join('')}</Section>`;
        const hexagon = rel([['RelMoveTo', { X: 0.25, Y: 0 }], ['RelLineTo', { X: 0.75, Y: 0 }], ['RelLineTo', { X: 1, Y: 0.5 }], ['RelLineTo', { X: 0.75, Y: 1 }], ['RelLineTo', { X: 0.25, Y: 1 }], ['RelLineTo', { X: 0, Y: 0.5 }], ['RelLineTo', { X: 0.25, Y: 0 }]]);
        // Rounded "pill" from four cubic Béziers (kappa = 0.5523).
        const k = 0.2761;
        const blob = rel([['RelMoveTo', { X: 0.5, Y: 0 }],
            ['RelCubBezTo', { X: 1, Y: 0.5, A: 0.5 + k, B: 0, C: 1, D: 0.5 - k }], ['RelCubBezTo', { X: 0.5, Y: 1, A: 1, B: 0.5 + k, C: 0.5 + k, D: 1 }],
            ['RelCubBezTo', { X: 0, Y: 0.5, A: 0.5 - k, B: 1, C: 0, D: 0.5 + k }], ['RelCubBezTo', { X: 0.5, Y: 0, A: 0, B: 0.5 - k, C: 0.5 - k, D: 0 }]]);
        const w = 2.5, h = 1, r = h / 2;
        const stadium = `<Section N="Geometry" IX="0">` +
            `<Row T="MoveTo" IX="1">${cell('X', n(r), 'Height*0.5')}${cell('Y', 0)}</Row>` +
            `<Row T="LineTo" IX="2">${cell('X', n(w - r), 'Width-Height*0.5')}${cell('Y', 0)}</Row>` +
            `<Row T="EllipticalArcTo" IX="3">${cell('X', n(w - r), 'Width-Height*0.5')}${cell('Y', n(h), 'Height')}${cell('A', n(w), 'Width')}${cell('B', n(r), 'Height*0.5')}${cell('C', 0)}${cell('D', 1)}</Row>` +
            `<Row T="LineTo" IX="4">${cell('X', n(r), 'Height*0.5')}${cell('Y', n(h), 'Height')}</Row>` +
            `<Row T="EllipticalArcTo" IX="5">${cell('X', n(r), 'Height*0.5')}${cell('Y', 0)}${cell('A', 0)}${cell('B', n(r), 'Height*0.5')}${cell('C', 0)}${cell('D', 1)}</Row></Section>`;
        return {
            shapes: title(90, '09  Shapes. Expected, left to right, top row: a hexagon, an ellipse, a stadium (rectangle with fully rounded ends). Bottom row: a box whose fill is 50% see-through (the grey bar behind it shows through), a box with NO fill (bar fully visible), a box with a dashed border. Do they resize sensibly when you drag a corner?') +
                box(1, 1.75, 8.25, 2, 1.25, 'hexagon', { geom: hexagon }) +
                box(2, 4.25, 8.25, 2, 1.25, 'ellipse', { geom: blob }) +
                box(3, 6.9, 8.25, w, h, 'stadium', { geom: stadium }) +
                box(4, 4.25, 5, 7.5, 0.3, null, { fill: '#9e9e9e' }) +
                box(5, 1.75, 5, 2, 1.25, '50%', { cells: cell('FillForegndTrans', 0.5) }) +
                box(6, 4.25, 5, 2, 1.25, 'no fill', { cells: cell('FillPattern', 0) }) +
                box(7, 6.75, 5, 2, 1.25, 'dashed', { cells: cell('LinePattern', 2) }),
        };
    },
    // Embedded PNG.
    '10-image.vsdx': () => ({
        png: makePng(),
        shapes: title(90, '10  Image. A blue-and-amber checkerboard square should appear below. Does it show, and can you move/resize it?') +
            `<Shape ID="1" Type="Foreign">${xform(4.25, 6.5, 2, 2)}${cell('ImgOffsetX', 0)}${cell('ImgOffsetY', 0)}${cell('ImgWidth', 2)}${cell('ImgHeight', 2)}` +
            rectGeom(2, 2, cell('NoFill', 1) + cell('NoLine', 1)) +
            `<ForeignData ForeignType="Bitmap" CompressionType="PNG"><Rel r:id="rId2"/></ForeignData></Shape>`,
    }),
    // The minimal skeleton the generator uses today (no StyleSheets / FaceNames), with one plain box.
    '11-minimal-skeleton.vsdx': () => ({
        rich: false,
        shapes: title(90, '11  Minimal file (no style sheets). Does it open without a warning or repair prompt, and is the blue box visible?') +
            box(1, 4.25, 7, 2.5, 1.25, 'plain box'),
    }),
};

const outDir = path.resolve(process.argv[2] || 'calibration-out');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, build] of Object.entries(files)) {
    await writePackage(path.join(outDir, name), build());
    console.log('wrote', path.join(outDir, name));
}
