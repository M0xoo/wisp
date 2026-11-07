// Modules the CLI loads only if this build has them (delegate.ts). TypeScript takes these declarations
// over the real modules, so they claim nothing: delegate.ts checks each export at run time. Without
// them, tsc would refuse a build in which the package isn't there yet. tools/bundle.ts inlines each one
// that resolves, and stands an empty module in for one that doesn't.

declare module '@wisp-plugin/mcp' {
  export const serveMcp: unknown;
}

declare module '@wisp/grid/cli' {
  export const gridCli: unknown;
  export const GRID_COMMANDS: unknown;
}
