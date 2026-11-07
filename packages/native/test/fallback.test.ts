// The fallback, always: the Python helper when there is a python3, and script(1) without one.

import { startNative } from '../src/index.ts';
import { python } from '../src/fallback/pty-helper.ts';
import { contract } from './contract.ts';

contract({ name: 'fallback (python)', start: () => startNative({ prefer: 'fallback' }), skip: !python() && 'no python3 here', resizable: true });

// WISP_PYTHON pointing nowhere is how a machine without Python looks to the helper lookup.
const noPython = { ...process.env, WISP_PYTHON: '/nonexistent/python3' };
contract({ name: 'fallback (script)', start: () => startNative({ prefer: 'fallback', env: noPython }), skip: false, resizable: false });
