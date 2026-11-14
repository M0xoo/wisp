// The `tree` block's layout (v1 R.tree): paths → a nested tree → the rows to draw, folders first
// then by name, and a folder with one folder in it shown as one row (`src/lib/util/`).

export interface TreeItem {
  readonly path: string;
  readonly change: unknown;
  readonly note: string;
}

export interface TreeRow {
  /** the full path to this row: stable across renders, the row's key */
  readonly path: string;
  /** what the row says: a name, or a chain of folders `src/lib` */
  readonly name: string;
  readonly depth: number;
  readonly dir: boolean;
  /** the item this row is, for a file (or a folder that was listed itself) */
  readonly item: TreeItem | undefined;
}

interface Node {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, Node>;
  item: TreeItem | undefined;
}

const node = (name: string, path: string): Node => ({ name, path, children: new Map(), item: undefined });

function build(items: readonly TreeItem[]): Node {
  const root = node('', '');
  for (const it of items) {
    const parts = it.path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    parts.forEach((p, i) => {
      let next = cur.children.get(p);
      if (!next) {
        next = node(p, parts.slice(0, i + 1).join('/'));
        cur.children.set(p, next);
      }
      cur = next;
    });
    cur.item = it;
  }
  return root;
}

const isFolder = (n: Node): boolean => n.children.size > 0;
const order = (a: Node, b: Node): number => Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name);

function only(n: Node): Node | undefined {
  if (n.children.size !== 1) return undefined;
  const [child] = n.children.values();
  return child;
}

function walk(parent: Node, depth: number, out: TreeRow[]): void {
  for (const start of [...parent.children.values()].sort(order)) {
    let n = start;
    let name = n.name;
    // a folder holding a single folder (and nothing listed itself) folds into one row
    for (let c = only(n); !n.item && c && isFolder(c); c = only(n)) {
      n = c;
      name += `/${n.name}`;
    }
    const dir = isFolder(n) && !n.item;
    out.push({ path: n.path, name, depth, dir, item: n.item });
    if (isFolder(n)) walk(n, depth + 1, out);
  }
}

/** The rows of a tree block, in the order they are drawn. */
export function treeRows(items: readonly TreeItem[]): TreeRow[] {
  const out: TreeRow[] = [];
  walk(build(items), 0, out);
  return out;
}
