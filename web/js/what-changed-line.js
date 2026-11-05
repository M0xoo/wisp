// The words for what moved in the CLI since the last turn (what-changed.js). DOM-free: the page
// escapes them. The limit goes with every line, as text: phones have no hover to find it in.

const NAMED = 3; // tools by name in a line, added first; the rest are a count

// mcp__github__create_issue → create issue (github)
const words = (s) => s.replace(/[_-]+/g, ' ').trim();
function toolName(name) {
  const mcp = /^mcp__(.+?)(?:__(.+))?$/.exec(name);
  if (!mcp) return name;
  return mcp[2] ? `${words(mcp[2])} (${words(mcp[1])})` : words(mcp[1]);
}

const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

function toolsLine({ added, removed }) {
  let room = NAMED;
  const say = (list, verb) => {
    if (!list.length) return [];
    const names = list.slice(0, room).map(toolName);
    room -= names.length;
    const more = list.length - names.length;
    if (!names.length) return [`${more} tool${more === 1 ? '' : 's'} ${verb}`];
    return [`${more ? `${names.join(', ')} and ${more} more` : listed(names)} ${verb}`];
  };
  return [...say(added, 'added'), ...say(removed, 'removed')];
}

// `moved` from whatChanged, `name` the harness's, `noted`: its harness note on this turn already
// gives the version. { said, limit }, or null when there's nothing left to say.
export function whatChangedLine(moved, { name, noted = false }) {
  if (!moved) return null;
  const parts = [
    ...(moved.version && !noted ? [`${name} ${moved.version[0]} → ${moved.version[1]}`] : []),
    ...(moved.tools === true ? ['tool set changed'] : moved.tools ? toolsLine(moved.tools) : []),
    ...(moved.catalog ? [`${name} model catalog changed`] : []),
  ];
  if (!parts.length) return null;
  return { said: `Since the last turn: ${parts.join(', ')}.`, limit: `Possible cause${parts.length > 1 ? 's' : ''}, not proof; a server-side change won’t show.` };
}
