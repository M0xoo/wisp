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

// Inside the wisp Android app (mobile/), which appends wispMobile to its WebView's user agent and
// shows this page through an SSH tunnel: there's no terminal, editor or folder picker on the phone.
export const MOBILE = typeof navigator !== 'undefined' && /\bwispMobile\b/.test(navigator.userAgent);
// There, this page is one of your computers, opened from the app's list (mobile/www), which passes
// its name as ?m=: "here" goes by that name instead of "This computer".
export const COMPUTER = MOBILE ? new URLSearchParams(location.search).get('m') || sessionStorage.getItem('wisp.computer') || '' : '';
if (COMPUTER) sessionStorage.setItem('wisp.computer', COMPUTER);
export let HERE = COMPUTER || 'This computer'; // in labels
export let here = COMPUTER || 'this computer'; // mid-sentence
// On a wisp Grid this wisp is the user's cloud computer (GET /config says so: grid).
export const inGrid = () => !!S.config?.grid;
export function nameHere() {
  if (COMPUTER) return;
  HERE = inGrid() ? 'Cloud computer' : 'This computer';
  here = inGrid() ? 'this cloud computer' : 'this computer';
}

// What's typed and not sent yet: the prompt box's ('home') and each task's follow-up box. Kept in
// localStorage as you type, so a reload (wisp updating, ⌘R, the phone dropping the page) doesn't
// lose a half-written task. The most recent MAX_DRAFTS are kept.
const MAX_DRAFTS = 50;
export class Drafts extends Map {
  constructor() {
    super();
    for (const [k, v] of Object.entries(load('wisp.drafts', {}))) if (v && typeof v === 'string') super.set(k, v);
  }
  set(k, v) {
    super.delete(k); // the newest go last, so the oldest go first
    if (v) super.set(k, v);
    while (this.size > MAX_DRAFTS) super.delete(this.keys().next().value);
    save('wisp.drafts', Object.fromEntries(this));
    return this;
  }
  delete(k) {
    if (!super.delete(k)) return false;
    save('wisp.drafts', Object.fromEntries(this));
    return true;
  }
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
  folded: new Set(load('wisp.folded', [])), // Needs you, Crew and Working sections the user folded
  drafts: new Drafts(),
  replyModes: new Map(), // session id → the mode its next follow-up switches to
  replyRunners: new Map(), // session id → { agent, model, effort } its next follow-up switches to
  replyPlaces: new Map(), // session id → the place ('' = this computer) its next follow-up moves it to
  replyTeams: new Map(), // session id → { team, preset } of subagents its next follow-up gives the lead
};
export const saveOpen = () => save('wisp.open', [...S.open]);
export const setAgents = (list) => ((S.agents = list), save('wisp.agents', list));

// Where the launcher sends a prompt: '' = this computer, else machine ids. Several run in parallel,
// all in the project picked (launch.picks['']; any project runs on any place), and show up as one
// task. A run can work in more projects too (launch.also['']): one agent, several folders.
export const launch = {
  project: load('wisp.launchProject', null), // the project picked in the first place
  where: load('wisp.launchWhere', ['']),
  picks: load('wisp.launchPicks', {}),
  also: load('wisp.launchAlso', {}),
};
export const saveLaunch = () => (save('wisp.launchWhere', launch.where), save('wisp.launchPicks', launch.picks), save('wisp.launchAlso', launch.also), save('wisp.launchProject', launch.project));
