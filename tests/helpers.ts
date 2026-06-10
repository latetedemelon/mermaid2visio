import JSZip from 'jszip';

export async function unzipPage(buffer: Uint8Array): Promise<string> {
    const zip = await JSZip.loadAsync(buffer);
    const file = zip.file('visio/pages/page1.xml');
    if (!file) throw new Error('page1.xml not found');
    return file.async('string');
}

export async function unzipAll(buffer: Uint8Array): Promise<Record<string, string>> {
    const zip = await JSZip.loadAsync(buffer);
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        out[name] = await entry.async('string');
    }
    return out;
}

export function getShape(xml: string, shapeId: number): string {
    const re = new RegExp(`<Shape\\b[^>]*ID="${shapeId}"[^>]*>([\\s\\S]*?)</Shape>`);
    const m = re.exec(xml);
    if (!m) throw new Error(`Shape ${shapeId} not found`);
    return m[1];
}

export function getGeometrySection(shapeBody: string, ix: number = 0): string {
    const re = new RegExp(`<Section\\b[^>]*N="Geometry"[^>]*IX="${ix}"[^>]*>([\\s\\S]*?)</Section>`);
    const m = re.exec(shapeBody);
    if (!m) throw new Error(`Geometry section IX=${ix} not found`);
    return m[1];
}

export function getRowTypes(geomBody: string): string[] {
    const re = /<Row\b[^>]*T="([^"]+)"/g;
    const types: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(geomBody)) !== null) {
        types.push(m[1]);
    }
    return types;
}

export function getCell(shapeBody: string, name: string): string | null {
    const re = new RegExp(`<Cell\\b[^>]*N="${name}"[^>]*V="([^"]*)"`);
    const m = re.exec(shapeBody);
    return m ? m[1] : null;
}
