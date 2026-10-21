// Single-quote for a POSIX shell. Its own module so the page and the mobile app can load it too.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
