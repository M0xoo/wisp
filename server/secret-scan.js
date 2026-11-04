// The scanner lives with the page's modules (web/js/secret-scan.js): panes scrub what they're sent
// in the browser (web/js/pane-bridge.js), and the page can only import what's under web/.
export { redactSecrets, scanAll, scanSecrets } from '../web/js/secret-scan.js';
