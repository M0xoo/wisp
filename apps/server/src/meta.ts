// What this server is: its version (the published package's), the API version clients check, and the
// port it listens on by default. Nothing here imports another module, so the CLI reads it cheaply.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
/** Bumped only when a v1 client could no longer talk to this server (v1's routes/meta.js). */
export const API_VERSION = 1;
export const DEFAULT_PORT = 4477;
