// A page on the computer's localhost, shown through wisp Grid at its p<port>--<this wisp's address>
// preview address (preview-spec.js boxUrl). The phone app's page has this wisp's cookie but not
// the grid's sign-in that the preview address would send a frame through, so the frame starts at a
// one-time link that signs it in there (POST /_grid/preview). An older grid lacks it, and a page
// not behind this wisp's own address needs none: the address as it is.

export async function gridLink(url, to) {
  if (!to || !new URL(to).host.endsWith(`--${location.host}`)) return to;
  const u = new URL(url);
  try {
    const r = await fetch(`/_grid/preview?port=${u.port || 80}&path=${encodeURIComponent(u.pathname + u.search + u.hash)}`, { method: 'POST', credentials: 'same-origin' });
    return (r.ok && (await r.json()).url) || to;
  } catch {
    return to;
  }
}
