// Shared shapes of the structure checker (plan §5, §9.2). A rule reads the tree through `Ctx` and
// returns findings; it never writes anything.

import type ts from 'typescript';

export type Severity = 'error' | 'warn';

export interface Finding {
  file: string; // repo-relative, posix
  line: number; // 1-based; 1 when the finding is about the whole file
  rule: string;
  message: string;
  severity: Severity;
}

/** Where a workspace package sits in the layers (ARCHITECTURE.md rule 1). */
export type PkgKind = 'package' | 'plugin-api' | 'plugin-host' | 'plugin-ui' | 'app';

export interface Pkg {
  name: string;
  dir: string; // repo-relative, posix, no trailing slash
  kind: PkgKind;
  /** the plugin folder name for plugins/<plugin>/{api,host,ui} */
  plugin: string | undefined;
  /** runs in the page: packages/ui, plugins/*\/ui, apps/web */
  ui: boolean;
  /** workspace dependencies declared in package.json (dependencies, devDependencies, peerDependencies) */
  declared: Set<string>;
  /** subpaths of package.json `exports` ('.', './client', './x/*') */
  exports: string[];
  manifest: Record<string, unknown>;
}

export interface Import {
  spec: string;
  line: number;
  /** erased at runtime: `import type`, `export type … from`, `import('x').T` */
  typeOnly: boolean;
  dynamic: boolean;
}

export type Resolved =
  | { kind: 'node'; name: string }
  | { kind: 'workspace'; pkg: Pkg; subpath: string } // subpath '' is the package's entry
  | { kind: 'relative'; target: string; file: string | undefined; pkg: Pkg | undefined }
  | { kind: 'external'; name: string };

export interface Ctx {
  root: string; // absolute
  pkgs: readonly Pkg[];
  pkgByName: ReadonlyMap<string, Pkg>;
  /** every scanned file, repo-relative posix, sorted */
  files: readonly string[];
  pkgOf(file: string): Pkg | undefined;
  exists(file: string): boolean;
  read(file: string): string;
  source(file: string): ts.SourceFile;
  imports(file: string): readonly Import[];
  resolve(from: string, spec: string): Resolved;
}

export interface Rule {
  id: string;
  description: string;
  run(ctx: Ctx): Finding[] | Promise<Finding[]>;
}
