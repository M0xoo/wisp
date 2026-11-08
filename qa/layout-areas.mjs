// What `node qa/layout.mjs --area=<area>` visits in the app (apps/web on the mock peer, whose rows
// are apps/web/dev/seed.ts: tasks are local:s0000 … local:s0009). One entry per area; add yours:
// each page is a path (navigation state is in the URL) and a selector that shows it's drawn.

const TASK = '/task/local%3As0000';

export const AREAS = {
  shell: [
    { name: 'home', path: '/', ready: '[data-kit="frame"] [data-part="shell.sidebar"] [data-kit="list-row"]' },
    { name: 'task', path: TASK, ready: '[data-kit="frame"][data-page="main"]' },
    { name: 'palette', path: '/?o=dialog:shell.palette', ready: '[data-part="shell.palette"]' },
    { name: 'shortcuts', path: '/?o=dialog:shell.shortcuts', ready: '[data-part="shell.shortcuts"]' },
    { name: 'diagnostics', path: '/?o=viewer:shell.devtools', ready: '[data-part="shell.devtools"]' },
  ],
};
