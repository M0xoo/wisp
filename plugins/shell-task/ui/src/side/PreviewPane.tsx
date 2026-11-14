// The side panel's Preview (v1 features/run.js, server/runs.js): the task's app, run from its folder (its worktree)
// with PORT set (wisp.terminal's `run` kind: `terminal.run.info`, `terminal.run.start`, `terminal.close`), and shown
// here. Its output streams from `/sessions/:id/run`; the first local address it prints is where the frame points
// (else its PORT once it has printed anything). Run, Restart and Stop change the pane at once and come back with
// the error if the computer refuses.
import { createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { defineCommand, ownerOf, readonly, type EntityKey } from '@wisp/client';
import { runRequest } from './run-request.ts';
import { RunPreview, Screen, Terminal, useSignal } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { pickedText, withPicked } from './pick.ts';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);
type Info = { open: boolean; port: number; dir: string; guess?: string; proxy?: number };
const info = defineCommand<{ key: EntityKey; id: string }, Info>({ id: 'terminal.run.info', owner: (a) => a.key, wire: (a) => ({ id: a.id }), optimistic: 'none', pending: 'the Preview pane' });
const start = defineCommand<{ key: EntityKey; id: string; command: string; cols: number; rows: number; restart?: boolean }, { ok: boolean; started: boolean; port: number; proxy?: number }>({
  id: 'terminal.run.start',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, command: a.command, cols: a.cols, rows: a.rows, ...(a.restart && { restart: true }) }),
  optimistic: 'none',
  pending: 'Run',
});
const input = defineCommand<{ key: EntityKey; id: string; data: string }, { ok: boolean }>({
  id: 'terminal.input',
  owner: (a) => a.key,
  wire: (a) => ({ kind: 'run', id: a.id, data: a.data }),
  optimistic: 'none',
  pending: 'none: keys go in as typed',
});
const stop = defineCommand<{ key: EntityKey; id: string }, { ok: boolean }>({
  id: 'terminal.close',
  owner: (a) => a.key,
  wire: (a) => ({ kind: 'run', id: a.id }),
  optimistic: 'none',
  pending: 'Stop',
});

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s'"<>`)]*)?/i;

/** The first local address the app's output says it listens on (v1 runs.js urlIn), as a page can open it. */
export function urlIn(text: string): string | undefined {
  const m = text.replace(ANSI, '').match(URL_RE);
  const port = m ? Number(m[1]) : 0;
  if (!m || !port || port > 65535) return undefined;
  return `http://localhost:${port}${(m[2] ?? '/').replace(/[.,;:]+$/, '') || '/'}`;
}

export function PreviewPane(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const c = task.client;
  const id = bare(task.key);
  const screen = new Screen(100, 24);
  let es: AbortController | undefined;
  let seen = '';
  const [state, setState] = createSignal<'idle' | 'live' | 'ended'>('idle');
  const [command, setCommand] = createSignal('');
  const [said, setSaid] = createSignal<string | undefined>();
  const [url, setUrl] = createSignal<string | undefined>();
  const [logs, setLogs] = createSignal(false);
  const [ended, setEnded] = createSignal<string | undefined>();
  const [port, setPort] = createSignal(0);
  // Pick element (v1 run.js): through Preview's proxy only (ADR-0049), once the page's script says it's ready
  const [proxy, setProxy] = createSignal<number | undefined>();
  const [pickable, setPickable] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  // the proxy's localhost is this computer's: off it (a wisp Grid, another machine) the frame shows the app's own
  // address and Pick isn't offered (v1 `far`, ADR-0049)
  const here = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(document.URL).hostname);
  const frameSrc = (): string | undefined => {
    const u = url();
    const p = proxy();
    if (!u || !p || !here) return undefined;
    try {
      const at = new URL(u);
      return `http://localhost:${p}${at.pathname}${at.search}${at.hash}`;
    } catch {
      return undefined;
    }
  };
  const accent = (): string => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#3b82f6';
  };
  const pick = (on: boolean): void => {
    if (!frame) return;
    setPicking(on);
    frame.contentWindow?.postMessage({ wisp: 'pick', type: on ? 'on' : 'off', color: accent() }, '*');
    if (on) frame.focus();
  };
  const onMessage = (e: MessageEvent): void => {
    const d = e.data as { wisp?: unknown; type?: unknown } | null;
    if (!frame || e.source !== frame.contentWindow || d?.wisp !== 'pick') return;
    if (d.type === 'ready') setPickable(true);
    if (d.type === 'off' && picking()) {
      setPicking(false);
      document.querySelector<HTMLElement>('[data-part~="panel.preview.pick"]')?.focus(); // Escape in the page: back to what started it
    }
    const text = pickedText(picking(), d);
    if (text) {
      setPicking(false);
      // under what's in the reply box, the caret on a line of its own; nothing sends it but you
      const box = shell.prompts?.get('reply');
      if (box) {
        box.set(withPicked(box.text(), text));
        box.focus();
      }
    }
  };
  // Escape while picking ends it, with the focus on wisp's side of the frame
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && picking()) {
      e.stopPropagation();
      pick(false);
    }
  };
  onMount(() => {
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey, true);
  });
  onCleanup(() => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('keydown', onKey, true);
  });

  const watch = (): void => {
    es?.abort();
    const ac = new AbortController();
    es = ac;
    seen = '';
    void (async () => {
      try {
        for await (const ev of c.http(ownerOf(task.key)).events(`/sessions/${encodeURIComponent(id)}/run`, ac.signal)) {
          if (ev.event === 'hello') {
            const h = JSON.parse(ev.data) as { cols: number; rows: number };
            screen.reset();
            screen.resize(h.cols, h.rows);
          } else if (ev.event === 'data') {
            const d = JSON.parse(ev.data) as string;
            screen.write(d);
            if (!url()) {
              seen = (seen + d).slice(-8192);
              const u = urlIn(seen);
              if (u) setUrl(u);
            }
          } else if (ev.event === 'exit' || ev.event === 'gone') {
            const code = ev.event === 'exit' ? ((JSON.parse(ev.data) as { code: number | null }).code ?? 0) : 0;
            setUrl(undefined);
            setEnded(code ? t('shell-task.preview.exited', { code }) : t('shell-task.preview.stopped'));
            setState('ended');
            ac.abort();
          }
        }
      } catch (e: unknown) {
        if (!ac.signal.aborted) {
          setEnded(e instanceof Error ? e.message : String(e));
          setState('ended');
        }
      }
    })();
  };
  // known once run.info answered: then Run app from the menu can start it here (v1 runApp)
  const [known, setKnown] = createSignal(false);
  onMount(() => {
    c.run(info, { key: task.key, id }).then(
      (i) => {
        setKnown(true);
        setPort(i.port);
        setProxy(i.proxy);
        if (i.guess) {
          setCommand(i.guess);
          setSaid(t('shell-task.preview.guessed'));
        }
        if (i.open) {
          setState('live');
          watch();
        }
      },
      () => undefined,
    );
  });
  onCleanup(() => es?.abort());
  const asked = useSignal(readonly(runRequest));
  createEffect(() => {
    if (asked() !== id || !known()) return;
    runRequest(undefined);
    if (state() === 'idle' && command().trim()) run(); // running, or it failed: the pane shows that (v1)
  });
  const run = (restart = false): void => {
    const cmd = command().trim();
    if (!cmd) return;
    const was = state();
    // the bar at once, "Starting"; back as it was with the reason if the computer refuses
    setState('live');
    setUrl(undefined);
    setEnded(undefined);
    screen.reset();
    c.run(start, { key: task.key, id, command: cmd, cols: 100, rows: 24, ...(restart && { restart: true }) }).then(
      (r) => {
        setPort(r.port);
        setProxy(r.proxy);
        watch();
      },
      (e: unknown) => {
        setState(was === 'live' ? 'idle' : was);
        setEnded(e instanceof Error ? e.message : String(e));
        if (was !== 'ended') setState('ended');
      },
    );
  };
  const halt = (): void => {
    es?.abort();
    setUrl(undefined);
    setState('idle');
    void c.run(stop, { key: task.key, id }).catch(() => undefined);
  };
  return (
    <RunPreview
      part="panel.preview"
      state={state()}
      command={command()}
      placeholder="npm run dev"
      said={said()}
      onCommand={(v) => {
        setCommand(v);
        setSaid(undefined);
      }}
      onRun={() => run(state() === 'ended')}
      url={url()}
      frameSrc={frameSrc()}
      pick={
        frameSrc()
          ? {
              label: t('shell-task.preview.pick'),
              title: pickable() ? t('shell-task.preview.pickTitle') : t('shell-task.preview.pickWait'),
              on: picking(),
              ready: pickable(),
              onClick: () => pick(!picking()),
            }
          : undefined
      }
      onFrame={(el) => (frame = el)}
      onFrameLoad={() => {
        // a new page in the frame (a link, a reload): its script says hello again
        setPickable(false);
        setPicking(false);
        frame?.contentWindow?.postMessage({ wisp: 'pick', type: 'hello' }, '*');
      }}
      showLogs={logs()}
      onLogs={() => setLogs(!logs())}
      onRestart={() => run(true)}
      onStop={halt}
      onOpen={() => {
        const u = url();
        if (u) shell.platform.openExternal(u);
      }}
      ended={ended()}
      logs={
        <Terminal
          screen={screen}
          ended={state() !== 'live'}
          onData={(data) => void c.run(input, { key: task.key, id, data }).catch(() => undefined)}
          labels={{ input: t('shell-task.shell.input'), keys: t('shell-task.shell.keys'), paste: t('shell-task.shell.paste') }}
        />
      }
      labels={{
        intro: t('shell-task.preview.intro'),
        command: t('shell-task.preview.command'),
        run: t('shell-task.preview.run'),
        starting: port() ? t('shell-task.preview.starting', { port: port() }) : t('shell-task.preview.startingNoPort'),
        logs: t('shell-task.preview.logs'),
        restart: t('shell-task.preview.restart'),
        stop: t('shell-task.preview.stop'),
        open: t('shell-task.preview.open'),
        frame: t('shell-task.preview.frame'),
      }}
    />
  );
}
