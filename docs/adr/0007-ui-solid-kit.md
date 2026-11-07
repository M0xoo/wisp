# ADR-0007: UI: Solid with a strict kit, and feature CSS banned

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 had 8,546 px literals with 157 distinct values, 97 `:has(`, and features restyling their own buttons. Plan §0.2 left two choices to the owner. The owner's instruction: what's in the plan is what they want, so the plan's recommendations stand.

## Decision

- **Solid 1.9** (gate G10's tie-break: Solid streams with a sixth of React's scripting and ships an eighth of the bytes). Zag.js machines for widgets.
- **`@wisp/ui` is the only package with CSS.** Components take no `class` or `style` (TypeScript rejects them), only token-typed props, and CSS custom properties for measured values. Tokens come from `@wisp/tokens` as CSS variables and TS unions.
- Layers `reset, tokens, kit, plugins`, with plugins last. Light DOM only. Every element a plugin may restyle has `data-part`. Plugins restyle through `contributes.partStyles`, emitted in `@layer plugins`.
- Answer blocks, Markdown, Diff and the terminal are kit components. `VirtualList` handles any long list.

## Consequences

A kit change may land in the feature's own PR, so the kit is never a queue. v1's 409 selector-based `PARTS` map to `data-part` names through a compatibility table, for imported spells.
