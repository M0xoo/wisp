// A crew job's face on its row (v1 crew.js crewDot): the member as its `crew_member` row holds it (the crew's topic,
// fields under `body`, or flat in dev data and optimistic upserts), and the mood its job puts it in.

export interface MemberRow {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly color?: string;
  readonly body?: { readonly name?: string; readonly avatar?: string; readonly color?: string };
}

export interface CrewFace {
  readonly name: string;
  readonly avatar: string;
  readonly color?: string;
  readonly mood: 'asks' | 'live' | 'idle';
}

/** The face of the member whose job this is; undefined for a task of yours or a member that left. */
export function crewFaceOf(rows: readonly MemberRow[], s: { readonly crew?: { readonly id: string }; readonly state: string }): CrewFace | undefined {
  const id = s.crew?.id;
  const r = id ? rows.find((x) => x.id === id) : undefined;
  if (!r) return undefined;
  const color = r.body?.color ?? r.color;
  const mood = s.state === 'waiting' ? 'asks' : s.state === 'running' ? 'live' : 'idle';
  return { name: r.body?.name ?? r.name, avatar: r.body?.avatar ?? r.avatar ?? '', mood, ...(color !== undefined && { color }) };
}
