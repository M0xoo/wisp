// A small event bus. Live server events (features/live.js) are published here, and open views
// subscribe instead of being looked up in the DOM and poked. A subscription tied to a node ends
// once that node has left the page, so a closed dialog stops listening.
//
// Events: agent-login, agents, cloud, config, install, machines, preferences, remote, router.

const subs = new Map(); // type -> Set<{ fn, node }>

export function on(type, fn, { node } = {}) {
  const sub = { fn, node };
  if (!subs.has(type)) subs.set(type, new Set());
  subs.get(type).add(sub);
  return () => subs.get(type).delete(sub);
}

export function emit(type, data) {
  const set = subs.get(type);
  if (!set) return;
  for (const sub of [...set]) {
    if (sub.node && !sub.node.isConnected) set.delete(sub);
    else sub.fn(data);
  }
}

// Forget subscriptions whose node is gone (called when a dialog closes).
export function sweep() {
  for (const set of subs.values()) for (const sub of set) if (sub.node && !sub.node.isConnected) set.delete(sub);
}
