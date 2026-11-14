// The router's writes (reference COMMANDS: router.set, router.reset, router.preview; v1 PATCH
// /router, POST /router/reset, POST /router/preview, PATCH /projects/:id). Each declares what the
// screen shows before the peer answers; a refusal rolls it back and the shell shows the toast.

import { defineCommand, entityKey, type EntityKey, type EntityOps, type PeerId } from '@wisp/client';
import { KIND, VIEW_ROW, type PreviewArgs, type PreviewResult, type RouterPatch, type RouterView } from './types.ts';

export const viewKey = (peer: PeerId): EntityKey => entityKey(peer, VIEW_ROW);

const SETTING_FIELDS = ['explore', 'allowed', 'escalate', 'best2', 'habits', 'blocked', 'prefer', 'scout'] as const;

/** Settings → Auto and the table's Never / Prefer: the whole lists go, as in v1. */
export const routerSet = defineCommand<{ peer: PeerId; patch: RouterPatch }, RouterView>({
  id: 'router.set',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const key = viewKey(a.peer);
    if (!base.peek<RouterView>(KIND.view, key)) return [];
    const ops = SETTING_FIELDS.filter((f) => a.patch[f] !== undefined).map((f) => ({ op: 'replace' as const, path: `/settings/${f}`, value: a.patch[f] }));
    if (a.patch.goal !== undefined) ops.push({ op: 'replace', path: '/goal', value: a.patch.goal });
    return ops.length ? [{ e: KIND.view, id: key, op: 'patch', ops }] : [];
  },
});

/** Forget what Auto learned: the peer recomputes the whole view. */
export const routerReset = defineCommand<{ peer: PeerId }, RouterView>({
  id: 'router.reset',
  owner: (a) => a.peer,
  optimistic: 'none', pending: 'the router.reset control',
});

/** What Auto would run for the launcher's text: read-only, so nothing to show before the answer. */
export const routerPreview = defineCommand<{ peer: PeerId } & PreviewArgs, PreviewResult>({
  id: 'router.preview',
  owner: (a) => a.peer,
  optimistic: 'none', pending: 'the router.preview control',
  // a newer question replaces an older one; the same one in flight is that one run
  dedupe: (a) => JSON.stringify([a.peer, a.prompt, a.attachments, a.goal, a.team, a.machine]),
});

/** A project's test command (Tests per project). The project is runtime's resource; the view row shows it. */
export const projectTests = defineCommand<{ peer: PeerId; id: string; testCommand: string }, unknown>({
  id: 'runtime.projectTest',
  owner: (a) => a.peer,
  wire: (a) => ({ name: a.id, testCommand: a.testCommand }),
  optimistic: (base, a): EntityOps => {
    const key = viewKey(a.peer);
    const view = base.peek<RouterView>(KIND.view, key);
    const i = view?.projects.findIndex((p) => p.id === a.id) ?? -1;
    return i < 0 ? [] : [{ e: KIND.view, id: key, op: 'patch', ops: [{ op: 'replace', path: `/projects/${i}/testCommand`, value: a.testCommand }] }];
  },
});
