// Copy or save a picture from an answer (v1 ui/image.js): clipboards only reliably take PNG, so it's drawn onto a
// canvas first; a picture from a site that won't let itself be read copies its link instead.

/** The file name it saves under (v1 imageName): the path it came from, or its alt text. */
export function fileName(src: string, alt = ''): string {
  let p = '';
  try {
    const u = new URL(src, 'http://x/');
    p = u.searchParams.get('path') ?? decodeURIComponent(u.pathname);
  } catch {
    p = src;
  }
  const base = (p.split(/[\\/]/).pop() ?? '').trim();
  if (/\.\w{2,5}$/.test(base)) return base;
  return `${(alt || base || 'image').replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`;
}

/** The picture as a PNG: loaded by the browser as the page shows it and drawn onto a canvas (the clipboard reliably
 *  takes only PNG). Another site's picture taints the canvas: that throws, and the caller copies its link. */
async function pngBlob(src: string): Promise<Blob> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  // an SVG without a size decodes at 0×0 in some browsers
  c.width = img.naturalWidth || 1200;
  c.height = img.naturalHeight || 800;
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  return await new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('no PNG'))), 'image/png'));
}

/** Puts the picture on the clipboard; false when the page may not. Handing the clipboard a promise keeps Safari's
 *  click permission while the picture loads. */
export async function copyImage(src: string): Promise<boolean> {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  try {
    if (!clip?.write || typeof ClipboardItem === 'undefined') throw new Error('no clipboard');
    await clip.write([new ClipboardItem({ 'image/png': pngBlob(src) })]);
    return true;
  } catch {
    // a picture from another site: its link is the next best thing
    if (/^https?:/.test(src) && clip?.writeText)
      return clip.writeText(src).then(
        () => true,
        () => false,
      );
    return false;
  }
}
