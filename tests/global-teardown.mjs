export default async function globalTeardown() {
    await globalThis.__M2V_SHARED_BROWSER__?.close();
}
