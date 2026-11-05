// The comments waiting on each task, on their own: Ship it and Merge read the count, and comments.js
// sits in the import cycle that ship.js would otherwise have to join.

import { load, save } from '../core/state.js';

// session id -> its comments, in the order they go out: { id, turn, i (block), label, kind, quote,
// x, y, at, note }; a diff line's (kind 'line') has { file, side, from, to, mixed, first, last (its
// rows' keys) } instead of a turn and block. Kept like drafts: a reload doesn't lose them.
export const pending = new Map(load('wisp.comments', []));
export const keep = () => save('wisp.comments', [...pending].filter(([, l]) => l.length));
export const listOf = (id) => pending.get(id) || [];
export const commentCount = (id) => listOf(id).length;
