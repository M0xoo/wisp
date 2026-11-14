// View kinds plugins register for `main`, `side` and overlays (plan §4.6.4): typed params, no
// router of their own. A registration belongs to the plugin's scope, so switching the plugin off
// unregisters its views and a URL naming one lands on Home.

import type { Intent, Overlay } from './nav.ts';
import type { Scope } from './scope.ts';
import type { ExtensionId, Json } from './types.ts';

export type Slot = 'main' | 'side' | 'overlay';

export interface ViewDecl<P extends Json> {
  id: string; // owner-prefixed: 'stuff.viewer'
  slot: Slot;
  /** checks params read from a URL or a link; undefined refuses them */
  parse(params: Json): P | undefined;
  /** overlays only: how it sits over the page */
  overlay?: Overlay['kind'];
}

export interface ViewHandle<P extends Json> {
  readonly id: ExtensionId;
  /** the intent that opens this view with typed params */
  open(params: P): Intent;
}

export interface ViewRegistry {
  register<P extends Json>(scope: Scope, decl: ViewDecl<P>): ViewHandle<P>;
  accepts(slot: Slot, id: string, params: Json): boolean;
  ids(): readonly string[];
}

export function createViews(): ViewRegistry {
  const decls = new Map<string, ViewDecl<Json>>();
  return {
    register<P extends Json>(scope: Scope, decl: ViewDecl<P>): ViewHandle<P> {
      if (decls.has(decl.id)) throw new Error(`view ${decl.id} is registered twice`);
      decls.set(decl.id, decl);
      scope.add(() => decls.delete(decl.id));
      const id = decl.id as ExtensionId;
      return {
        id,
        open(params) {
          switch (decl.slot) {
            case 'main':
              return { t: 'openView', id, params };
            case 'side':
              return { t: 'openSide', side: { kind: 'view', id } };
            case 'overlay':
              return { t: 'openOverlay', overlay: { kind: decl.overlay ?? 'dialog', id, params } };
          }
        },
      };
    },
    accepts(slot, id, params) {
      const d = decls.get(id);
      return d !== undefined && d.slot === slot && d.parse(params) !== undefined;
    },
    ids: () => [...decls.keys()],
  };
}
