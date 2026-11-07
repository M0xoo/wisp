// Copy a link. The shell's platform has copy() (packages/shell/src/platform), but plugins don't get
// the platform yet: until they do, the browser's clipboard, which every host wisp runs in has.
export async function copyText(text: string): Promise<boolean> {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
