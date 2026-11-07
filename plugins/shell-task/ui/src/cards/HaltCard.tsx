// A finished turn that hit a limit, was refused or signed out (v1 turns.js limitCard / refusalCard / sign-in-card.js).
// Stub until it is built: renders nothing.
import type { JSX } from 'solid-js';
import type { TurnRow } from '../types.ts';

export function HaltCard(_props: { readonly turn: TurnRow }): JSX.Element {
  return null;
}
