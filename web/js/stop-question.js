// What Stop asks before it stops a run (turns.js), for a lead and a subagent alike. DOM-free, so
// the tests read it. It says what else a Stop does: the lead's running subagents (`live`) stop
// with it (runner.stop), a stopped subagent sends its lead no report (runner #delegateDone), and
// queued follow-ups stay, held.
export function stopQuestion(s, name, live = 0) {
  const sub = !!s.parentId;
  const queued = s.queue?.length ?? s.queued ?? 0;
  const more = [
    sub && 'Its lead gets no report from it: it stops waiting for this one.',
    live && `Its ${live === 1 ? 'subagent stops' : `${live} subagents stop`} too.`,
    queued && `Your queued follow-up${queued > 1 ? 's stay' : ' stays'}, held until you send one.`,
  ].filter(Boolean);
  return { text: `Stop ${sub ? 'this subagent' : name}?${more.length ? `\n\n${more.join(' ')}` : ''}`, ok: sub ? 'Stop subagent' : 'Stop' };
}
