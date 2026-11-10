import type { Rule } from '../core/types.ts';
import { css } from './css.ts';
import { cycles } from './cycles.ts';
import { i18n } from './i18n.ts';
import { layers } from './layers.ts';
import { manifests } from './manifests.ts';
import { noAny } from './no-any.ts';
import { protocol } from './protocol.ts';
import { publicEntry } from './public-entry.ts';
import { RUST_RULES } from './rust.ts';
import { sizes } from './sizes.ts';
import { state } from './state.ts';
import { uiCommands } from './ui-commands.ts';
import { v1Coverage } from './v1-coverage.ts';

/** In ARCHITECTURE.md order. Turning one off needs an ADR (AGENTS.md). */
// `openapi` (rules/openapi.ts) is retired: it read v1's apps/server. The Rust edge builds /api/openapi.json
// from its route table, and crates/wisp/tests/serve_task.rs checks that table (ADR-0019).
export const RULES: readonly Rule[] = [layers, publicEntry, cycles, css, state, manifests, protocol, sizes, noAny, i18n, uiCommands, v1Coverage, ...RUST_RULES];
