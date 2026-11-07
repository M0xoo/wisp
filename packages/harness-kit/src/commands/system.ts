// Shell built-ins and system commands: cd, echo, sleep, curl, ps, kill, lsof, ssh, nested shells
// and the agent CLIs.

import { lower } from '../text.ts';
import { host, operands, result, weak, type Ctx, type Desc, type Describer, type Table } from './argv.ts';

const fixed =
  (text: string): Describer =>
  () =>
    result(text);
const fixedWeak =
  (text: string): Describer =>
  () =>
    weak(text);

function fetching({ args }: Ctx): Desc {
  const url = args.find((a) => /^https?:\/\//.test(a) || /^(localhost|127\.0\.0\.1|[\w.-]+\.[a-z]{2,})(?:[/:]|$)/.test(a));
  return result(url ? `Fetching ${host(url)}` : 'Fetching a URL');
}

// `while <cond>` / `until <cond>`: say what is being waited on.
function waitingOn({ args, stage }: Ctx): Desc {
  const inner = stage(args);
  return result(inner && !inner.unknown ? `Waiting on: ${lower(inner.text)}` : 'Waiting for something to change');
}

function lsof({ args }: Ctx): Desc {
  const port = args.find((a) => /^-?i?:\d+$/.test(a) || /^tcp:\d+$/.test(a));
  return result(port ? `Checking what is using port ${port.replace(/\D/g, '')}` : 'Checking open files');
}

function shell({ args, f, script }: Ctx): Desc {
  if (args[0] === '-c' || args[0] === '-lc') return script(args[1]);
  const file = operands(args)[0];
  return result(file ? `Running ${f(file)}` : 'Running a shell script');
}

const agentName = (cmd: string): string => (cmd === 'cursor-agent' ? 'Cursor' : cmd.charAt(0).toUpperCase() + cmd.slice(1));

export const SYSTEM_COMMANDS: Table = [
  [['cd', 'pushd', 'popd'], ({ args, f }) => weak(args[0] ? `Going to ${f(args[0])}` : 'Changing folder')],
  [['export', 'set', 'unset', 'source', '.', 'true', 'false', 'shift', 'local', 'read', 'trap', ':', 'for', 'case'], fixedWeak('Setting up the shell')],
  [['echo', 'printf'], fixedWeak('Printing a message')],
  [['pwd'], fixedWeak('Checking the current folder')],
  [['curl', 'wget', 'http', 'xh'], fetching],
  [['open', 'xdg-open'], ({ target }) => result(`Opening ${target || 'a file'}`)],
  [['sleep'], ({ args }) => result(`Waiting ${args[0] ?? ''}${/^\d+$/.test(args[0] ?? '') ? 's' : ''}`.trim())],
  [['wait'], fixed('Waiting for background jobs')],
  [['until', 'while'], waitingOn],
  [['if', 'test', '[', '[['], fixedWeak('Checking a condition')],
  [['ps', 'pgrep', 'top', 'htop'], fixed('Checking running processes')],
  [['kill', 'pkill', 'killall'], fixed('Stopping a process')],
  [['lsof'], lsof],
  [['which', 'whereis', 'type'], ({ args }) => result(`Checking if ${operands(args)[0] ?? 'a tool'} is installed`)],
  [['env', 'printenv'], fixed('Checking environment variables')],
  [['uname', 'sw_vers', 'hostname', 'whoami', 'id'], fixed('Checking the system')],
  [['date'], fixedWeak('Checking the time')],
  [['ssh'], ({ args }) => result(`Connecting to ${operands(args)[0] ?? 'a server'}`)],
  [['scp'], fixed('Copying files over SSH')],
  [['claude', 'codex', 'gemini', 'cursor-agent', 'opencode'], ({ cmd }) => result(`Asking ${agentName(cmd)}`)],
  [['bash', 'sh', 'zsh'], shell],
];
