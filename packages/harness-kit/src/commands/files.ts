// Commands that read, search, list or change files: cat, head, sed, grep, find, ls, mv, tar …

import { clip } from '../text.ts';
import { countArg, operands, result, valueOf, weak, type Ctx, type Desc, type ShowPath, type Table } from './argv.ts';

const reading = ({ files, target, piped }: Ctx): Desc | null => (files.length ? result(`Reading ${target}`) : piped ? weak('Reading input') : null);

function headTail({ cmd, args, files, target }: Ctx): Desc {
  if (cmd === 'tail' && args.some((a) => /^-[a-zA-Z]*[fF]/.test(a))) return result(files.length ? `Watching ${target}` : 'Watching output');
  const n = countArg(args);
  const head = cmd === 'head';
  if (!files.length) return weak(n ? `Taking the ${head ? 'first' : 'last'} ${n} lines` : 'Trimming output');
  return result(n ? `Reading the ${head ? 'first' : 'last'} ${n} lines of ${target}` : `Reading the ${head ? 'start' : 'end'} of ${target}`);
}

function find({ cmd, args, f }: Ctx): Desc {
  const name = valueOf(args, ['-name', '-iname', '-path', '-ipath']) ?? (cmd === 'fd' ? operands(args)[0] : null);
  const first = args[0];
  const where = cmd === 'find' ? (first && !first.startsWith('-') ? first : '') : operands(args)[1];
  const inWhere = where && where !== '.' ? ` in ${f(where)}` : '';
  if (args.includes('-delete')) return result(`Deleting ${name ? `${name} files` : 'files'}${inWhere}`);
  return result(name ? `Finding ${clip(name, 40)}${inWhere}` : `Finding files${inWhere}`);
}

function archive({ cmd, args, target }: Ctx): Desc {
  const creating = /^(-?[a-z]*c|zip)/.test(args[0] ?? '') && cmd === 'tar';
  return result(creating ? 'Creating an archive' : `Extracting ${target || 'an archive'}`);
}

export const FILE_COMMANDS: Table = [
  [['cat', 'bat', 'less', 'more'], reading],
  [['nl'], ({ files, target }) => (files.length ? result(`Reading ${target}`) : null)],
  [['head', 'tail'], headTail],
  [['sed', 'gsed'], ({ args, f, piped }) => describeSed(args, f, piped)],
  [
    ['awk', 'gawk'],
    ({ args, f }) => {
      const file = operands(args).slice(1);
      return file.length ? result(`Reading ${f(file[0])}`) : weak('Processing text');
    },
  ],
  [['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'], ({ cmd, args, f, piped }) => describeGrep(cmd, args, f, piped)],
  [['find', 'fd'], find],
  [['ls', 'eza', 'exa', 'tree'], ({ cmd, files, target }) => result(files.length ? `Listing ${target}` : cmd === 'tree' ? 'Looking at the folder tree' : 'Listing files')],
  [['wc'], ({ args, files, target }) => (files.length ? result(`Counting ${args.includes('-l') ? 'lines' : 'words'} in ${target}`) : weak('Counting lines'))],
  [['sort', 'uniq', 'cut', 'tr', 'column', 'fold', 'rev'], ({ files, target }) => (files.length ? result(`Reading ${target}`) : weak('Processing text'))],
  [
    ['jq', 'yq'],
    ({ args, f, piped }) => {
      const file = operands(args)[1];
      return result(file ? `Reading ${f(file)}` : 'Parsing JSON', file ? {} : { weak: piped });
    },
  ],
  [['diff', 'cmp', 'colordiff'], ({ files, f }) => result(files.length >= 2 ? `Comparing ${f(files[0])} and ${f(files[1])}` : 'Comparing files')],
  [['stat', 'file'], ({ target }) => result(`Inspecting ${target || 'a file'}`)],
  [['du', 'df'], ({ target }) => result(`Checking disk usage${target ? ` of ${target}` : ''}`)],
  [['mkdir'], ({ target }) => result(`Creating folder ${target}`)],
  [['touch'], ({ target }) => result(`Creating ${target}`)],
  [['rm', 'rmdir', 'trash'], ({ target }) => result(`Deleting ${target || 'files'}`)],
  [['mv'], ({ files, f, target }) => result(files.length === 2 ? `Moving ${f(files[0])} to ${f(files[1])}` : `Moving ${target}`)],
  [['cp', 'rsync'], ({ files, f, target }) => result(files.length === 2 ? `Copying ${f(files[0])} to ${f(files[1])}` : `Copying ${target}`)],
  [['ln'], ({ target }) => result(`Linking ${target}`)],
  [['chmod', 'chown'], ({ args, f }) => result(`Changing permissions of ${operands(args).slice(1).map(f).join(', ') || 'files'}`)],
  [['tee'], ({ files, target }) => result(files.length ? `Writing ${target}` : 'Saving output')],
  [['tar', 'unzip', 'gunzip', '7z'], archive],
  [['zip'], () => result('Creating an archive')],
];

export function describeSed(args: readonly string[], f: ShowPath, piped: boolean): Desc {
  const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  const scripts: (string | undefined)[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-e' || a === '--expression') scripts.push(args[++i]);
    else if (a === '-f') i++;
    else if (a.startsWith('-')) continue;
    else if (inPlace && a === '' && args[i - 1] === '-i') continue; // BSD `sed -i ''`
    else files.push(a);
  }
  if (!scripts.length && files.length) scripts.push(files.shift());
  const target = files.map(f).slice(0, 2).join(', ');
  if (inPlace) return result(target ? `Editing ${target}` : 'Editing files');
  const script = (scripts[0] ?? '').trim();
  const lines = script.match(/^(\d+|\$)(?:\s*,\s*(\d+|\$))?\s*p$/);
  if (lines && args.some((a) => /^-[a-zA-Z]*n/.test(a))) {
    const [, a, b] = lines;
    const span = !b ? `line ${a}` : b === '$' ? `from line ${a} on` : `lines ${a}–${b}`;
    if (!target) return weak(`Taking ${span}`);
    return result(b === '$' ? `Reading ${target} from line ${a} on` : `Reading ${span} of ${target}`);
  }
  if (target) return result(/^s(.)/.test(script) ? `Rewriting text from ${target}` : `Reading ${target}`);
  return piped ? weak('Processing text') : result('Processing text');
}

const GREP_TAKES_VALUE = /^(-e|-f|-m|-A|-B|-C|-g|--glob|-t|--type|-T|--max-count|--context|--after-context|--before-context|--regexp|--include|--exclude|--exclude-dir|-d|-D)$/;

export function describeGrep(cmd: string, args: readonly string[], f: ShowPath, piped: boolean): Desc {
  const listing = cmd === 'rg' && args.includes('--files');
  // undefined (not null) when `-e` is the last word: v1 then searched for “”, and so does this.
  let pattern: string | null | undefined = null;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-e' || a === '--regexp') pattern ??= args[++i];
    else if (GREP_TAKES_VALUE.test(a)) i++;
    else if (a.startsWith('-')) continue;
    else if (pattern === null && !listing) pattern = a;
    else paths.push(a);
  }
  if (listing) return result(paths.length ? `Listing files in ${f(paths[0])}` : 'Listing files');
  if (pattern === null) return piped ? weak('Filtering output') : result('Searching files');
  const where = paths.length ? ` in ${paths.map(f).slice(0, 2).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}` : '';
  if (piped && !paths.length) return weak(`Filtering for “${clip(pattern, 40)}”`);
  return result(`Searching for “${clip(pattern, 40)}”${where}`);
}
