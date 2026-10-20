// What the page knows: sessions and their cards, config, harnesses and machines, plus the
// launcher's picks. UI state that should survive a reload goes to localStorage as wisp.*.

export function load(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
}
export function save(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

export const S = {
  sessions: new Map(), // id -> summary
  full: new Map(), // id -> full session, for expanded items
  open: new Set(load('wisp.open', [])), // expanded item ids
  nodes: new Map(), // id -> { card, head, body, turnNodes, tray, showAll, unfolded, latestTurn }
  tasks: new Map(), // compare task key -> { card, head, runs, lead }
  focus: null, // id of the keyboard-focused item
  config: { defaults: {}, projects: [] },
  agents: load('wisp.agents', []), // the last list seen, so the launcher paints before detection answers
  machines: [], // other computers over SSH: GET /api/machines, kept fresh by the 'machines' event
  filter: load('wisp.filter', 'all'),
  showDone: load('wisp.showDone', false),
  showArchived: false,
  drafts: new Map(),
  replyModes: new Map(), // session id → the mode its next follow-up switches to
  replyRunners: new Map(), // session id → { agent, model, effort } its next follow-up switches to
};
export const saveOpen = () => save('wisp.open', [...S.open]);
export const setAgents = (list) => ((S.agents = list), save('wisp.agents', list));

// Where the launcher sends a prompt: '' = this computer, else machine ids. Several run in parallel,
// each in the project picked for it (launch.picks[place]), and show up as one task. A run can
// work in more of that place's projects too (launch.also[place]): one agent, several folders.
export const launch = {
  project: load('wisp.launchProject', null), // the project picked in the first place
  where: load('wisp.launchWhere', ['']),
  picks: load('wisp.launchPicks', {}),
  also: load('wisp.launchAlso', {}),
};
export const saveLaunch = () => (save('wisp.launchWhere', launch.where), save('wisp.launchPicks', launch.picks), save('wisp.launchAlso', launch.also), save('wisp.launchProject', launch.project));
