// Signed in, Home (/): the cloud wisp with a picture of it, your own computers and published apps as
// cards, then what to try next, and the "Add a cloud machine" waitlist dialog.

import type { MachineWish } from '../seats.ts';
import { I, esc, shot, tag, type IconName, type PageCfg, type PageUser } from './common.ts';
import { LIVE, STATE, ago, appPage } from './layout.ts';

/** The user's instance row with hostd's state (accounts.instance + hostd.state). */
export interface InstanceView {
  state: string;
  started_at?: number | null;
  stopped_at?: number | null;
  next_wake_at?: number | null;
}
export interface MachineView {
  cpus?: number | undefined;
  memory?: string | undefined;
  wish?: MachineWish | null;
}
export interface DeviceView {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
}
export interface ComputerView {
  id: string;
  name: string;
  url: string;
  online: boolean;
  lastSeenAt: number | null;
  deviceId?: string;
}
/** A published app (sites.view). */
export interface SiteView {
  key: string;
  title: string;
  url: string;
  files: number;
  updatedAt: number;
}
/** What this grid offers; absent means yes. */
export interface Offers {
  sites?: boolean;
  sandboxes?: boolean;
}

export interface HomeArgs {
  cfg: PageCfg;
  offers: Offers;
  user: PageUser;
  instance: InstanceView;
  machine: MachineView;
  devices: DeviceView[];
  computers: ComputerView[];
  sites: SiteView[];
  csrf: string;
  hidden: string;
  flash: string;
}

// Signed in, two pages behind one header. Home (/): the cloud wisp with a picture of it, your own
// computers and published apps as cards, then what to try next, each tile saying so when the grid
// knows it's already done. Account (/account): devices, sign-ins, sign out, delete.
// What a cloud wisp could be next (grid/accounts.js MACHINE_WANTS): what each is, for the account
// page's "Add a cloud machine". Only one per account for now; these are on a waitlist.
const WANTS: readonly (readonly [key: string, icon: IconName, name: string, short: string, text: string, listed: string])[] = [
  ['more', 'stack', 'More machines', 'More', 'Several cloud wisps side by side: one per project, or one per teammate.', 'more machines'],
  ['bigger', 'bolt', 'A bigger machine', 'Bigger', 'More CPU and memory, for big repos, long builds and full test suites.', 'a bigger machine'],
  ['gpu', 'gpu', 'GPUs', 'GPU', 'Run local models, fine-tune, or let your agents use CUDA.', 'GPUs'],
];
// "a, b and c"
const and = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1] ?? ''}`);
const wishLine = (wants: readonly string[]): string => (wants.length ? `On the waitlist for ${and(WANTS.filter(([k]) => wants.includes(k)).map((w) => w[5]))}. We’ll write when it’s ready.` : 'One comes with your account for now. More machines, bigger ones and GPUs are on the way.');
const size = (m: unknown): string => {
  const n = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(String(m || ''));
  if (!n) return '';
  const per: Record<string, number> = { k: 1048576, m: 1024, g: 1, '': 1073741824 };
  const gb = Number(n[1]) / (per[(n[2] ?? '').toLowerCase()] ?? 1);
  return `${Math.round(gb * 10) / 10} GB`;
};

// The cloud section's last row: one cloud wisp per account for now, so "add" opens the waitlist
// for more, bigger and GPU machines (machinesDialog). Says when you're on it.
function addMachineRow(wish: MachineWish | null | undefined): string {
  return `<button type="button" class="w add-m" data-open="machines" aria-haspopup="dialog">
      <span class="w-ic">${I.plus}</span>
      <div class="w-tx"><b>Add a cloud machine</b><small>${esc(wishLine(wish?.wants || []))}</small></div>
      ${wish ? `<span class="pill listed">${I.check}On the list</span>` : '<span class="pill soon">Soon</span>'}<span class="chev">${I.chev}</span>
    </button>`;
}

function machinesDialog({ machine = {}, user, hidden }: { machine?: MachineView; user: PageUser; hidden: string }): string {
  const wish = machine.wish;
  const has = (k: string): boolean => !!wish?.wants.includes(k);
  const spec = [machine.cpus && `${machine.cpus} vCPU`, size(machine.memory) && `${size(machine.memory)} memory`, 'sleeps when idle'].filter(Boolean).join(' · ');
  return `<dialog class="mdlg" id="machines" aria-labelledby="mTitle" data-state="${wish ? 'done' : 'pick'}">
    <form method="post" action="/machines/waitlist" id="mForm">${hidden}
    <button class="m-x" type="button" data-close aria-label="Close">${I.x}</button>
    <div class="m-hero" aria-hidden="true"><div class="rack">
      <div class="slot mine">${I.cloud}Yours</div>
      ${WANTS.map(([k, ic, , short]) => `<div class="slot${has(k) ? ' on' : ''}" data-slot="${k}">${I[ic]}${short}</div>`).join('')}
    </div></div>
    <div class="m-body">
      <div class="m-pick">
        <p class="m-kicker">wisp Cloud · coming soon</p>
        <h2 id="mTitle">One cloud machine per account, for now</h2>
        <p class="m-sub">Your account comes with one cloud wisp. More machines, bigger ones and GPUs are on the way. Pick what you’d use and you’ll be among the first to get it.</p>
        <div class="m-have"><span class="w-ic cloud">${I.cloud}</span><div><b>Your cloud wisp</b><small>${esc(spec)}</small></div><span class="pill ok">Included</span></div>
        <fieldset class="m-opts"><legend>What would you use?</legend>
          ${WANTS.map(([k, ic, name, , text]) => `<label class="m-opt"><input type="checkbox" name="want_${k}" value="1"${has(k) ? ' checked' : ''}><span class="m-card"><span class="w-ic">${I[ic]}</span><div><b>${name}</b><small>${text}</small></div><span class="m-tick">${I.check}</span></span></label>`).join('')}
        </fieldset>
        <label class="m-note"><span>What would you run on it? <i>Optional</i></span><textarea name="note" rows="2" maxlength="500" placeholder="A monorepo build, a 70B model, three projects at once…">${esc(wish?.note || '')}</textarea></label>
        <div class="m-foot">${wish ? '<button type="button" class="ghost danger" data-leave>Leave the list</button>' : '<button type="button" class="ghost" data-close>Not now</button>'}<button class="primary" type="submit" data-go${wish ? '' : ' disabled'}>${wish ? 'Save' : 'Join the waitlist'}</button></div>
      </div>
      <div class="m-done" aria-live="polite">
        <div class="m-ok">${I.check}</div>
        <h2>You’re on the list</h2>
        <p class="m-sub">We’ll write${user.email ? ` to <b>${esc(user.email)}</b>` : ''} as soon as it’s ready. Your cloud wisp keeps working as it is meanwhile.</p>
        <div class="m-chips" data-chips>${WANTS.filter(([k]) => has(k)).map(([, ic, name]) => `<span>${I[ic]}${name}</span>`).join('')}</div>
        <div class="m-foot"><button type="button" class="ghost line" data-change>Change</button><button type="button" class="primary" data-close>Done</button></div>
      </div>
    </div>
    </form>
  </dialog>`;
}

// Opens and runs the dialog, also from a link (#machines; #machines/bigger ticks that one, as a
// cloud wisp that ran out of memory links it). Joining shows at once (the row too) and rolls back
// with a toast if the grid says no; the live sync then brings the row from the server, the same.
const MACHINES_JS = `<script>(()=>{const d=document.getElementById('machines'),f=document.getElementById('mForm');if(!d)return;
const W=${JSON.stringify(WANTS.map(([k, ic, name]) => [k, name]))},TEXT=${JSON.stringify(Object.fromEntries([[], ['more'], ['bigger'], ['gpu'], ['more', 'bigger'], ['more', 'gpu'], ['bigger', 'gpu'], ['more', 'bigger', 'gpu']].map((w) => [w.join(','), wishLine(w)])))},ICONS={${WANTS.map(([k, ic]) => `${k}:${JSON.stringify(I[ic])}`).join(',')}};
const boxes=[...f.querySelectorAll('input[type=checkbox]')],go=f.querySelector('[data-go]');
const picked=()=>boxes.filter((b)=>b.checked).map((b)=>b.name.slice(5));
const paint=()=>{const p=picked();go.disabled=!p.length;for(const s of d.querySelectorAll('[data-slot]'))s.classList.toggle('on',p.includes(s.dataset.slot))};
const chips=(p)=>{d.querySelector('[data-chips]').innerHTML=W.filter(([k])=>p.includes(k)).map(([k,n])=>'<span>'+ICONS[k]+n+'</span>').join('')};
const toast=(t)=>{const n=document.createElement('div');n.className='toast bad';n.setAttribute('role','alert');n.textContent=t;document.body.append(n);setTimeout(()=>n.remove(),4500)};
const row=()=>document.querySelector('[data-open=machines]');
const rowFor=(p)=>{const r=row();if(!r)return;
r.querySelector('small').textContent=TEXT[p.join(',')]||TEXT[''];
const pill=r.querySelector('.pill');pill.className='pill '+(p.length?'listed':'soon');pill.innerHTML=p.length?${JSON.stringify(I.check)}+'On the list':'Soon'};
const send=async(wants)=>{const before={state:d.dataset.state,html:row()?.outerHTML};
if(wants.length){chips(wants);d.dataset.fresh='';d.dataset.state='done'}else d.close();rowFor(wants);
try{const r=await fetch('/machines/waitlist',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({csrf:f.csrf.value,wants,note:f.note.value})});
if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'The grid didn’t take it. Try again.')}
catch(e){d.dataset.state=before.state;if(before.html)row()?.replaceWith(Object.assign(document.createElement('div'),{innerHTML:before.html}).firstElementChild);toast(e.message||'You’re offline. Try again.')}};
document.addEventListener('click',(e)=>{if(e.target.closest('[data-open=machines]')){delete d.dataset.fresh;d.showModal()}});
d.addEventListener('click',(e)=>{if(e.target===d||e.target.closest('[data-close]'))d.close();else if(e.target.closest('[data-change]'))d.dataset.state='pick';else if(e.target.closest('[data-leave]')){boxes.forEach((b)=>b.checked=false);paint();send([])}});
f.addEventListener('change',paint);f.addEventListener('submit',(e)=>{e.preventDefault();const p=picked();if(p.length)send(p)});
const link=()=>{const h=/^#machines(?:[/](more|bigger|gpu))?$/.exec(location.hash);if(!h)return;history.replaceState(null,'',location.pathname+location.search);const b=h[1]&&f.querySelector('[name=want_'+h[1]+']');if(b&&!b.checked){b.checked=true;d.dataset.state='pick';paint()}if(!d.open)d.showModal()};
paint();link();addEventListener('hashchange',link)})()</script>`;

export const bare = (u: string): string => u.replace(/^https?:\/\//, '');
export const copyBtn = (v: string, label?: string): string => `<button class="copy" type="button" data-copy="${esc(v)}" title="Copy ${esc(v)}" aria-label="Copy ${esc(v)}"><span>${esc(label || v)}</span>${I.copy}</button>`;
const COPY_JS = `<script>document.addEventListener('click',async(e)=>{const b=e.target.closest('[data-copy]');if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);const s=b.querySelector('span'),t=s.dataset.was||s.textContent;s.dataset.was=t;s.textContent='Copied';setTimeout(()=>s.textContent=t,1200)}catch{}})</script>`;

// What the state means now. Every state has its own line: "Asleep since…" under Waking up reads wrong.
function cloudLine(st: string, instance: InstanceView): string {
  if (st === 'running') return `Started ${ago(instance.started_at)}. Sleeps by itself when nothing’s going on.`;
  if (st === 'starting') return 'A few seconds. It opens as soon as it’s up.';
  if (st === 'queued') return 'The grid is busy. It starts as soon as there’s room.';
  if (st === 'stopping') return 'Your tasks and files stay where they are.';
  return instance.stopped_at ? `Went to sleep ${ago(instance.stopped_at)}. Opening it wakes it in a few seconds.` : 'Starts the first time you open it, in a few seconds.';
}

// The cloud wisp's block, one size in every state: the line keeps its two rows, Sleep keeps its
// place while it's hidden, and a schedule fills a row that's already there.
function cloudBlock({ st, instance, machine, url, hidden }: { st: string; instance: InstanceView; machine: MachineView; url: string; hidden: string }): string {
  const spec = [machine.cpus && `${machine.cpus} vCPU`, size(machine.memory), 'sleeps when idle'].filter(Boolean).join(' · ');
  return `<div class="h-state"><div class="state ${esc(st)}"><i></i>${STATE[st] || esc(st)}</div><p class="h-line">${cloudLine(st, instance)}</p></div><div class="h-acts"><a class="primary" href="/go">Open${I.arrow}</a><form class="inline${st === 'running' ? '' : ' off'}" method="post" action="/instance/stop">${hidden}<button class="ghost line">${I.moon}Sleep</button></form></div><dl class="h-facts"><dt>Address</dt><dd>${copyBtn(url, bare(url))}</dd><dt>Machine</dt><dd>${esc(spec)}</dd><dt>Next schedule</dt><dd>${instance.next_wake_at ? esc(new Date(instance.next_wake_at).toLocaleString()) : 'Nothing scheduled'}</dd></dl>`;
}

const computerCard = (c: ComputerView, hidden: string): string => `<div class="c">
      <div class="c-head"><span class="w-ic">${I.laptop}</span><div class="c-name"><b title="${esc(c.name)}">${esc(c.name)}</b><div class="state ${c.online ? 'running' : 'stopped'}"><i></i>${c.online ? 'Online' : `Offline${c.lastSeenAt ? ` · last seen ${ago(c.lastSeenAt)}` : ''}`}</div></div></div>
      ${copyBtn(c.url, bare(c.url))}
      <div class="c-acts">${c.online ? `<a class="primary" href="/go?computer=${esc(c.id)}">Open${I.arrow}</a>` : `<span class="primary off" aria-disabled="true" title="Back when it’s switched on and wisp runs there.">Open${I.arrow}</span>`}<form class="inline" method="post" action="/computers/${esc(c.id)}/remove">${hidden}<button class="ghost quiet" title="Take it off the grid. wisp on it keeps running.">Remove</button></form></div>
    </div>`;

const siteCard = (x: SiteView, hidden: string): string => `<div class="c">
      <div class="c-head"><span class="w-ic">${I.globe}</span><div class="c-name"><b title="${esc(x.title)}">${esc(x.title)}</b><small>Updated ${ago(x.updatedAt)} · ${x.files} file${x.files === 1 ? '' : 's'}</small></div></div>
      ${copyBtn(x.url, bare(x.url).replace(/\/$/, ''))}
      <div class="c-acts"><a class="ghost line" href="${esc(x.url)}" target="_blank" rel="noopener">Open${I.arrow}</a><form class="inline" method="post" action="/sites/${esc(x.key)}/remove">${hidden}<button class="ghost quiet" title="Take it offline: the link stops working. It stays in My Stuff.">Unpublish</button></form></div>
    </div>`;

// The way in, for someone who hasn't opened anything yet. Only what the grid can see ends it: it
// can't tell whether an agent is signed in, so these are steps to read, not boxes to tick.
const firstSteps = (): string => `<ol class="path">
      <li><span class="n">1</span><div><b>Open your cloud wisp</b><p>It starts in a few seconds.</p></div></li>
      <li><span class="n">2</span><div><b>Sign in to an agent</b><p>Settings → Agents: a link and a code, no terminal.</p></div></li>
      <li><span class="n">3</span><div><b>Send a task, close the laptop</b><p>The report waits for you here and on your phone.</p></div></li>
    </ol>`;

// One tile: what you get, one next step, and what's already true when the grid knows it. The step
// stays where it is either way, so a tile doesn't change shape when it fills in.
function tile({ icon, title, text, on = '', go, href = '', add = false }: { icon: string; title: string; text: string; on?: string; go: string; href?: string; add?: boolean }): string {
  const step = add ? `<button class="t-go" type="button" data-add>${go}${I.arrow}</button>` : `<a class="t-go" href="${esc(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${go}${I.arrow}</a>`;
  return `<div class="t"><span class="w-ic">${icon}</span><b>${title}</b><p>${text}</p><div class="t-foot">${step}${on ? `<span class="t-on">${I.check}${esc(on)}</span>` : ''}</div></div>`;
}

function tiles({ offers, instance, devices, computers, sites, host }: { offers: Offers; instance: InstanceView; devices: DeviceView[]; computers: ComputerView[]; sites: SiteView[]; host: string }): string {
  const phone = devices.some((d) => /phone/i.test(d.name));
  const n = computers.length;
  return `<div class="t big"><div class="t-tx"><span class="w-ic cloud">${I.moon}</span><b>Keeps working with your laptop closed</b><p>Leave a task running or schedule one. Your cloud wisp wakes for it, does the work and goes back to sleep. The report waits for you.</p><div class="t-foot"><a class="t-go" href="/go">Schedule a task${I.arrow}</a>${instance.next_wake_at ? `<span class="t-on">${I.check}Scheduled</span>` : ''}</div></div><div class="t-shot" aria-hidden="true">${shot('report', '')}</div></div>${[
    tile({ icon: I.key, title: 'Bring your own agents', text: `Sign in to Claude Code, Codex and GitHub in Settings → Agents. A link and a code, no terminal.`, go: 'Sign in to an agent', href: '/go' }),
    offers.sites === false
      ? ''
      : tile({ icon: I.globe, title: 'Publish an app', text: 'From My Stuff, an app an agent built goes up at a public link, and stays up while your wisp sleeps.', on: sites.length ? `${sites.length} published` : '', go: sites.length ? 'See your apps' : 'Publish from My Stuff', href: sites.length ? '#apps' : '/go' }),
    offers.sandboxes === false ? '' : tile({ icon: I.stack, title: 'A fresh box for one task', text: 'Start a task with /sandbox and it gets a box of its own, deleted with the task.', go: 'Try /sandbox', href: '/go' }),
    tile({ icon: I.phone, title: 'On your phone', text: `Sign in with ${esc(host)} in the wisp app, or add your cloud wisp to an iPhone’s Home Screen.`, on: phone ? 'Phone connected' : '', go: 'How to set it up', href: 'https://trywisp.dev/guides/use-wisp-cloud' }),
    tile({ icon: I.share, title: 'Share a task', text: 'Share… on a task makes a link to what it did, with a passkey if you want one.', go: 'Pick a task', href: '/go' }),
    tile({ icon: I.laptop, title: 'Reach your own computers', text: 'Your phone and other computers open them through the grid. No SSH, no open ports.', on: n ? `${n} added` : '', go: 'Add a computer', add: true }),
    tile({ icon: I.code, title: 'API keys for scripts', text: 'Settings → Connect makes a key, so a script can start tasks in your cloud wisp.', go: 'Make a key', href: '/go' }),
  ].join('')}`;
}

export function homeView({ cfg, offers, user, instance, machine, devices, computers, sites, csrf, hidden, flash }: HomeArgs): string {
  const st = instance.state;
  const url = cfg.instanceUrl(user.handle);
  const host = new URL(cfg.publicUrl).host;
  const online = computers.filter((c) => c.online).length;
  // wisp computer on (bin/wisp.js) signs in to grid.trywisp.dev unless told another grid.
  const cliAdd = `npx wisp-agents computer on${host === 'grid.trywisp.dev' ? '' : ` --grid ${host}`}`;
  const fresh = !instance.started_at && !instance.stopped_at && !computers.length && !sites.length && !devices.length;
  const apps = sites.length
    ? `<h2 class="sec" id="apps">Published apps <span class="n">${sites.length}</span></h2><p class="hint">Anyone with the link can open them, while your wisp sleeps too; search engines don’t list them.</p><div class="cards">${sites.map((x) => siteCard(x, hidden)).join('')}</div>`
    : '';

  return appPage({
    cfg,
    title: 'Home',
    user,
    csrf,
    tab: 'home',
    body: `${flash}
      <section class="hero" aria-labelledby="hi">
        <div class="h-main">
          <h1 class="h1" id="hi">Hi ${esc((user.name || user.handle).split(' ')[0])}</h1>
          <p class="sub">Your cloud wisp runs here on ${esc(host)}, so it keeps working while your computers are off.</p>
          <div data-live="cloud">${cloudBlock({ st, instance, machine, url, hidden })}</div>
        </div>
        <div class="h-shot"><a href="/go" tabindex="-1" aria-hidden="true">${shot('app', '')}</a></div>
        <div class="h-more" data-live="wish">${addMachineRow(machine.wish)}</div>
      </section>
      <div data-live="start">${fresh ? firstSteps() : ''}</div>

      <h2 class="sec">Your computers <span class="n" data-live="online">${computers.length ? `${online} of ${computers.length} online` : ''}</span></h2>
      <p class="hint">wisp on your own desktop or laptop, reached through the grid. Your files and agents stay on it.</p>
      <div class="cards">
        <div class="cards-live" data-live="computers">${computers.map((c) => computerCard(c, hidden)).join('')}</div>
        <details class="add" id="add"><summary aria-controls="addHow"><span class="add-plus">${I.plus}</span><b>Add a computer</b><small>One command in a terminal, or a few clicks in the app. No SSH, no open ports.</small></summary></details>
        <div class="how" id="addHow">
          <input type="radio" name="addHow" id="addCli" checked><input type="radio" name="addHow" id="addApp">
          <div class="seg" role="presentation"><label for="addCli">${I.code}In a terminal</label><label for="addApp">${I.laptop}With the app</label></div>
          <ol class="steps p-cli">
            <li><span class="n">1</span><div><b>Run this on that computer</b><p>Node 20 or later. It starts wisp in the background if it isn’t running. Have wisp already? <code>wisp computer on</code> does the same.</p>${copyBtn(cliAdd)}</div></li>
            <li><span class="n">2</span><div><b>Allow it here</b><p>It prints a code and opens a page from this grid; on a server, open the link it prints in any browser, even your phone’s. Check the code matches and press <i>Allow</i>. The computer then shows up in this list, and in the phone app.</p></div></li>
          </ol>
          <ol class="steps p-app">
            <li><span class="n">1</span><div><b>Run wisp on that computer</b><p>The desktop app from <a href="https://trywisp.dev" target="_blank" rel="noopener">trywisp.dev</a>, or <code>npx wisp-agents</code> in a terminal.</p></div></li>
            <li><span class="n">2</span><div><b>Open Machines → Reach this computer from anywhere</b><p>Type this grid’s address and press <i>Sign in and add it</i>:</p>${copyBtn(host)}</div></li>
            <li><span class="n">3</span><div><b>Allow it here</b><p>A page from this grid opens with a code. Check it matches and press <i>Allow</i>. The computer then shows up in this list, and in the phone app.</p></div></li>
          </ol>
        </div>
      </div>

      <div data-live="sites">${apps}</div>

      <h2 class="sec">What your ${/^cloud$/i.test(tag(cfg)) ? 'cloud' : 'grid'} can do</h2>
      <div class="can" data-live="can">${tiles({ offers, instance, devices, computers, sites, host })}</div>
      ${machinesDialog({ machine, user, hidden })}
      ${COPY_JS}${MACHINES_JS}${HOME_JS}${LIVE}`,
  });
}

// Add a computer from anywhere on the page. An old link to the account's Delete lands on its new page.
const HOME_JS = `<script>(()=>{if(location.hash==='#delete')location.replace('/account#delete');document.addEventListener('click',(e)=>{if(!e.target.closest('[data-add]'))return;const d=document.getElementById('add');d.open=true;d.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});d.querySelector('summary').focus({preventScroll:true})})})()</script>`;

