// The order projects show in, everywhere one shows: the order the user dragged them into
// (p.order, PUT /projects/order), with any added since first, most recent first. Never dragged:
// most recent first. DOM-free, so the tests read it as it is.

const at = (p) => p.lastUsedAt || p.addedAt || 0;
export const recentFirst = (a, b) => at(b) - at(a);
export const byOrder = (a, b) => (a.order ?? -1) - (b.order ?? -1) || recentFirst(a, b);

// ids with `id` moved to just before (or after) `to`. The same list back when nothing moves.
export function moved(ids, id, to, after = false) {
  if (id === to || !ids.includes(id) || !ids.includes(to)) return ids;
  const rest = ids.filter((x) => x !== id);
  rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, id);
  return rest.every((x, i) => x === ids[i]) ? ids : rest;
}
