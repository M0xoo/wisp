// A follow-up sent again because the page got no answer in time (web/js/features/reply-send.js): the
// first may be through, or still going, and a second run is worse than a slow toast. A send with a
// sendId gets the first one's answer instead of running again. In memory: a restart kills the run
// it started, so what's sent after it can't run beside that one.

const KEEP = 10 * 60_000; // the page stops reusing a sendId by then too

export function sendOnce({ keep = KEEP } = {}) {
  const sends = new Map();
  // run: resolves to [status, data]. A refusal or a failure did nothing, so it isn't remembered.
  return (key, run) => {
    const now = Date.now();
    for (const [k, v] of sends) {
      if (now - v.at < keep) break; // oldest first
      sends.delete(k);
    }
    const seen = sends.get(key);
    if (seen) return seen.out;
    const out = Promise.resolve().then(run);
    sends.set(key, { at: now, out });
    const forget = () => sends.get(key)?.out === out && sends.delete(key);
    out.then((answer) => !(answer?.[0] < 300) && forget(), forget);
    return out;
  };
}
