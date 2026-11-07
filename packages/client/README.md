# @wisp/client

The client's state: one home for every kind of state (plan §4.6, ADR-0006), and the peers it comes
from (§7.2.1, §7.3). Plain TypeScript on `alien-signals`, with no framework. Solid binds to the signals
natively; React binds through `subscribe`. It runs in the browser, the desktop app and the phone (the
same bundle). Its tests run in Node with no DOM: IndexedDB, fetch and `window` sit behind small
interfaces.

```ts
import { createClient, browserHistory, httpTransport, indexedDBPersist, peerId } from '@wisp/client';

const client = createClient({
  clientId, build, home: peerId('laptop'), width: innerWidth,
  persist: indexedDBPersist(indexedDB, IDBKeyRange),
  history: browserHistory(window),
  onError: (err) => toast(err.message), // a command was refused
});
await client.start([{ peer: peerId('laptop'), name: 'laptop', transport: httpTransport({ base: '' }) }]);
```

`start` paints from IndexedDB first: rows, cursors, pending commands, drafts and the last place. Then
it connects to every peer and resumes from its cursor.

## The six kinds of state

| Kind | Home | Who writes it | Kept |
|---|---|---|---|
| 1. Server data | `client.entities`: rows by kind, keyed `<peer>:<id>`, one signal per row | only the sync layer and commands' optimistic patches | IndexedDB |
| 2. Derived | selectors: `filterBy`, `sortBy`, `count`, `groupBy`, `family` | nobody: computed and memoised | no |
| 3. Navigation | `client.nav`: one `Nav`, mirrored in the URL | `navigate(intent)` only | URL and the last place |
| 4. Flows | `machine()`, run inside a scope | events sent to the machine | no |
| 5. Drafts | `client.drafts`, keyed by (entity, field) | the component that owns the field | IndexedDB, per peer |
| 6. Settings | `client.settings`, typed from manifest declarations | settings commands (server keys) or the device | server, or this device |

Everything else (hover, focus, an open popover) is a local signal inside the component. Rows are
`DeepReadonly`, and the entity writer is not exported, so UI code can read rows but has no way to write
them.

```ts
const row = client.entities.row<Session>('session', key); // a signal: one row repaints, nothing else
const running = filterBy(client.entities.list<Session>('session'), (s) => s.state === 'running');
const newestFirst = sortBy(running, byKeys({ of: (s) => s.updated_at, desc: true }));
```

The entity store has two layers. **Base** is server truth, advanced only by patches and snapshots.
**Pending** holds the optimistic patches of commands in flight, replayed over base in the order they
ran. An ack keeps its patch on screen until the peer's cursor reaches the ack's seq, so the old value
never flashes back. A reject drops the patch at once.

`list(kind)` is kept in place: a changed row replaces one slot, and membership changes are applied
once per batch. `filterBy` and `sortBy` patch their previous answer when rows change in place. When the
changed row isn't one they show, they return the same array, so their dependents don't rerun.

## A plugin

`client.plugin(id)` gives a plugin the same APIs a built-in uses. All of them are owned by the plugin's
scope, so switching the plugin off drops its stores, views, strings, settings, machines, transcripts
and subscriptions.

```ts
const p = client.plugin('crew');
p.strings({ 'crew.title': 'Crew', 'crew.count.one': '{count} member', 'crew.count.other': '{count} members' });
const board = p.registerView({ id: 'crew.board', slot: 'main', parse: (v) => (typeof v === 'string' ? v : undefined) });
const settings = p.settings([{ key: 'crew.size', type: 'int', min: 1, max: 9, default: 3, scope: 'device' }] as const);
const view = p.defineStore({ id: 'crew.view', version: 2, defaults: { mode: 'list' }, check, migrate, persist: true });
```

A plugin store whose saved data fails its migration or its check is reset to its defaults with a
warning, and the plugin keeps working.

### Commands: optimistic is required

A write is a command. Its type requires `optimistic`: either a patch computed from what's on screen,
or `'none'`. There is no third option, so the optimistic part can't be forgotten.

```ts
export const rename = defineCommand<{ id: EntityKey; title: string }>({
  id: 'session.rename',
  owner: (a) => a.id, // the peer named in the id runs it (origin routing)
  optimistic: (base, a) => [{ e: 'session', id: a.id, op: 'patch', ops: [{ op: 'replace', path: '/title', value: a.title }] }],
  feature: { plugin: 'wisp.runtime', label: 'Rename' }, // refused at once, with the reason, if the peer lacks it
});
await p.run(rename, { id, title: 'New title' });
```

Running a command:

- It gets a UUIDv7 mid, which is its idempotency key.
- Its patch shows at once.
- It is persisted, then handed to its peer's sync link.
- **Offline**, it waits in the pending list ("waiting for <box> to wake") and is sent after the next
  welcome with the same mid. A command for a sleeping box wakes it.
- **The same command again while it is in flight** (same id and args) returns the first run (#643).
- **A reject** rolls the patch back and calls `onError`.

### Navigation intents

`navigate(intent)` is the only writer of navigation state: a pure reducer from `(Nav, intent)` to `Nav`.
Intents name what the user did; the reducer decides what that means.

| Intent | What happens |
|---|---|
| `openTask`, `openCrew`, `openView`, `home` | a new main; the overlays close, and so does a side pane bound to another task |
| `openSide`, `toggleSide`, `closeSide` | a task's pane (`changes`, `shell`, `pr`) opens beside that task |
| `openOverlay`, `closeOverlay{id?}` | a stack; a double open is one open; closing by id closes everything above it |
| `back` | pops the top overlay, then the side pane, then main (to Home) |
| `markDone`, `archive`, `delete` | if the task was open: Home, not the next task (#354) |
| `rename` | nothing: renaming keeps the task open (#406) |
| `openFromToast{target}` | the target opens with nothing over it (#573, #574) |
| `resize{width}` | `split` at 900 px and up, `stack` below. Features never set the layout. |

Opening something pushes a history entry; closing replaces the current one. A URL that is broken, or
names a view that isn't registered, lands on Home. Plugins register their views
(`registerView({ id, slot, parse })`) and open them with `handle.open(params)`. A plugin never uses its
own router, and never touches `history` or `location`.

### Machines

Anything with more than two states, or anything async, is a machine:

```ts
const shell = machine({
  id: 'terminal.shell',
  initial: 'idle',
  states: {
    idle: { on: { START: 'starting' } },
    starting: { invoke: (pty, signal) => pty.start(signal), on: { READY: 'running', STOP: 'stopping' }, onError: 'failed', after: { 8000: 'slow' } },
    // …
  },
});
const m = p.machine(shell, pty); // owned by the plugin's scope, or pass the component's scope
m.send('START');
```

States and events are inferred: a transition to a state that doesn't exist won't compile. Each state
entry gets its own scope. Leaving the state aborts what it invoked and clears its `after` timers, so a
late answer never lands on the wrong state. `paths(def)` lists the shortest path into every state and
through every transition, for model-based tests, and reports states no path reaches.

### Drafts

```ts
const text = client.drafts.get(sessionKey, 'composer'); // a signal; undefined when empty
client.drafts.set(sessionKey, 'composer', value);       // on screen at once, on disk after 400 ms
```

Drafts are kept per peer (`drafts:<peer>`). An emptied draft is deleted. Whatever is still waiting when
the scope ends is written.

### Settings

Settings are declared in the manifest (`SettingDecl`) and typed from that declaration: a `bool` reads as
`boolean`, an `enum` as the union of its values.

- **`scope: 'server'`** keys read from the home peer's `setting` rows. They are written by the
  `settings.set` command, with an optimistic patch.
- **`scope: 'device'`** keys stay on this device.

A value another plugin locked reads `lockedBy` that plugin and can't be set. Out-of-range values are
refused before anything is sent.

## Peers

Every wisp is a peer, and the client connects to many at once. Each peer has its own transport,
`SyncClient` (from `@wisp/sync`, keeping the epoch and cursor), status and subscriptions.

- **Status:** `online`, `connecting`, `asleep`, `waking`, `unreachable{reason}`, or
  `incompatible{reason, update}` ("Update wisp on studio-mac").
- **Features come from the peer:** `peers.hasFeature(peer, { plugin, command?, minVersion? })` returns
  `{ ok }` or a reason to grey the feature out with. UI code never checks a version.
- **`peers.watch(peer, topic, scope, { passive })`** keeps a topic live while the scope lives. Two
  views of one task share one subscription. A passive watch never wakes a box; opening its task does.
- **An op the store can't apply** sends `drifted` to the link, which unsubscribes and takes the topic
  afresh.
- **Transports** implement `{ connect(params, signal) → frames, post(message), wake? }`.
  `httpTransport` is the only `fetch` in the UI: it streams `GET /api/events` and posts to
  `POST /api/events`.

### Transcripts

```ts
const tr = p.transcript<EventRow>(peer, sessionId, viewScope);
tr.events();       // oldest first: the pages loaded so far plus the live tail
await tr.older();  // the page before the oldest event held
tr.paging();       // { kind: 'idle', atStart } | { kind: 'loading' } | { kind: 'failed', reason }
```

Opening subscribes to `session:<id>`, so the tail arrives with its snapshot and appends.

- **Paging:** `older()` sends `window{before_seq: oldest held seq, limit}` and merges the `rows` under
  the tail in the entity store, deduped by `seq`. A short page means the start was reached.
- **Joining:** a call while a page is loading joins it.
- **Offline:** the request waits for the peer to come back.
- **Closing:** an answer that comes after the view closed is dropped (#492). No answer within 15 s
  shows `failed`, and the next `older()` asks again.

## Devtools

`client.devtools` keeps a ring of the last 500 frames, commands, acks, rejects and machine
transitions, plus every live machine's state. `export()` gives the JSON a bug report attaches.

## Performance

Run `node spikes/client-bench/bench.ts`. It measures 5,000 rows with one token patch every 16 ms on one
row, while 3 selectors are live and every row has an effect. It reports ms per patch, and fails unless
exactly one row signal fires per patch. On an M-series Mac, through the whole path (frame → SyncClient
→ store → signals), the result is p50 0.04 ms, p99 0.2 ms, max 2 ms.
