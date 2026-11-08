//! Finding a program and turning `bin args` into something the OS can start directly (v1
//! server/proc.js). Off Windows it is a PATH lookup. On Windows, CLIs installed through npm (claude,
//! codex, opencode…) are `.cmd` shims that can't start without a shell, and wrapping them in cmd.exe
//! would mangle what wisp passes (JSON, newlines in a system prompt): npm shims are unwrapped into
//! `node <script>` (or the `.exe` they point at), `.ps1`-only installs go through PowerShell, and only
//! unknown batch files go through cmd.exe, escaped as cross-spawn does.
//!
//! Pure: the file system comes in as a `Lookup`, so every platform's answer is tested anywhere.
//!
//! size-ok: Windows command resolution is one algorithm (PATHEXT, cmd shims, quoting); its tests are already beside it

/// What a resolution needs to know about files.
pub trait Lookup {
    fn is_file(&self, path: &str) -> bool;
    /// a file that may be run (Unix: a regular file with an x bit)
    fn is_exe(&self, path: &str) -> bool;
    fn read(&self, path: &str) -> Option<String>;
}

/// The real file system. Blocking: call it off the runtime's workers (`spawn_blocking`).
#[derive(Debug, Clone, Copy, Default)]
pub struct RealFs;

impl Lookup for RealFs {
    fn is_file(&self, path: &str) -> bool {
        std::fs::metadata(path).is_ok_and(|m| m.is_file())
    }
    fn is_exe(&self, path: &str) -> bool {
        let Ok(m) = std::fs::metadata(path) else {
            return false;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            m.is_file() && m.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            m.is_file()
        }
    }
    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Unix,
    Windows,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// What to start: `command args`; `verbatim`: pass args as written (already quoted for cmd.exe).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub command: String,
    pub args: Vec<String>,
    pub verbatim: bool,
}

/// An environment variable, as Windows reads it (case-insensitively: a copied env may spell PATH "Path").
pub fn env_get<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(k, _)| k == name)
        .or_else(|| env.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)))
        .map(|(_, v)| v.as_str())
}

/// `bin` on PATH: an absolute path, or `None`.
pub fn which(
    bin: &str,
    env: &[(String, String)],
    platform: Platform,
    fs: &dyn Lookup,
) -> Option<String> {
    match platform {
        Platform::Windows => which_windows(bin, env, fs),
        Platform::Unix => which_unix(bin, env_get(env, "PATH").unwrap_or(""), fs),
    }
}

fn which_unix(bin: &str, path: &str, fs: &dyn Lookup) -> Option<String> {
    if bin.contains('/') {
        return fs.is_exe(bin).then(|| bin.to_owned());
    }
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| format!("{}/{bin}", d.trim_end_matches('/')))
        .find(|p| fs.is_exe(p))
}

/// As cmd.exe finds it: PATHEXT, then a `.ps1` (some installers, Cursor's, drop only that).
pub fn which_windows(bin: &str, env: &[(String, String)], fs: &dyn Lookup) -> Option<String> {
    let exts: Vec<String> = env_get(env, "PATHEXT")
        .filter(|s| !s.is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_lowercase)
        .collect();
    let names: Vec<String> = if win_ext(bin).is_empty() {
        exts.iter()
            .map(|e| format!("{bin}{e}"))
            .chain([format!("{bin}.ps1")])
            .collect()
    } else {
        vec![bin.to_owned()]
    };
    let dirs: Vec<&str> = if bin.contains(['/', '\\']) {
        vec![""]
    } else {
        env_get(env, "PATH")
            .unwrap_or("")
            .split(';')
            .filter(|d| !d.is_empty())
            .collect()
    };
    for dir in dirs {
        for name in &names {
            let full = if dir.is_empty() {
                name.clone()
            } else {
                win_join(dir, name)
            };
            if fs.is_file(&full) {
                return Some(full);
            }
        }
    }
    None
}

/// What an npm/pnpm/yarn `.cmd` shim runs, relative to its folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shim {
    /// `node <script>`
    Script(String),
    /// the program itself
    Exe(String),
}

/// The shim's last line ending in `%*` names the target:
///   `... & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`
///   `"%~dp0\node.exe"  "%~dp0\..\opencode-ai\bin\opencode" %*`
///   `"%dp0%\node_modules\some-cli\bin\tool.exe"   %*`
pub fn parse_cmd_shim(text: &str) -> Option<Shim> {
    let line = text.lines().map(str::trim).rfind(|l| l.ends_with("%*"))?;
    let quoted = quoted_parts(line);
    let target = from_dp0(quoted.last()?)?;
    let prog = if quoted.len() > 1 {
        quoted[quoted.len() - 2]
    } else {
        ""
    };
    let lower = target.to_lowercase();
    let node = prog.eq_ignore_ascii_case("%_prog%") || {
        let p = prog.to_lowercase();
        let name = p.rsplit('\\').next().unwrap_or(&p);
        name == "node" || name == "node.exe"
    };
    if node || [".js", ".cjs", ".mjs"].iter().any(|e| lower.ends_with(e)) {
        return Some(Shim::Script(target.to_owned()));
    }
    if [".exe", ".com"].iter().any(|e| lower.ends_with(e)) {
        return Some(Shim::Exe(target.to_owned()));
    }
    None
}

fn quoted_parts(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        if end > 0 {
            out.push(&after[..end]);
        }
        rest = &after[end + 1..];
    }
    out
}

/// `%~dp0\x`, `%dp0%\x`, `%~dp0x` → `x`: only targets relative to the shim count.
fn from_dp0(s: &str) -> Option<&str> {
    let lower = s.to_ascii_lowercase();
    let mut i = 0;
    if !lower[i..].starts_with('%') {
        return None;
    }
    i += 1;
    if lower[i..].starts_with('~') {
        i += 1;
    }
    if !lower[i..].starts_with("dp0") {
        return None;
    }
    i += 3;
    if lower[i..].starts_with('%') {
        i += 1;
    }
    if lower[i..].starts_with('\\') {
        i += 1;
    }
    let rest = &s[i..];
    (!rest.is_empty()).then_some(rest)
}

const META: &[char] = &[
    '(', ')', ']', '[', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?',
];

fn caret(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if META.contains(&c) {
            out.push('^');
        }
        out.push(c);
    }
    out
}

/// cmd.exe escaping of the program, as cross-spawn.
pub fn escape_cmd_command(s: &str) -> String {
    caret(s)
}

/// cmd.exe escaping of one argument, byte for byte as cross-spawn@7's (its expected values are the
/// tests'): quote for `CommandLineToArgvW`, then caret-escape cmd's metacharacters, twice when the
/// target is a batch file (it re-parses its line).
pub fn escape_cmd_argument(arg: &str, double: bool) -> String {
    // cross-spawn: `/(?=(\\+?)?)\1"/g → '$1$1\\"'`: a quote, with the one backslash before it doubled.
    let chars: Vec<char> = arg.chars().collect();
    let mut s = String::with_capacity(arg.len() + 8);
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'"') {
            s.push_str("\\\\\\\"");
            i += 2;
        } else if chars[i] == '"' {
            s.push_str("\\\"");
            i += 1;
        } else {
            s.push(chars[i]);
            i += 1;
        }
    }
    // `/(?=(\\+?)?)\1$/ → '$1$1'`: a trailing backslash doubled, so it doesn't escape the closing quote.
    if s.ends_with('\\') {
        s.push('\\');
    }
    let once = caret(&format!("\"{s}\""));
    if double { caret(&once) } else { once }
}

/// `bin args` as the platform can start them directly.
pub fn resolve_command(
    bin: &str,
    args: &[String],
    env: &[(String, String)],
    platform: Platform,
    fs: &dyn Lookup,
) -> Resolved {
    let plain = |command: &str, args: Vec<String>| Resolved {
        command: command.to_owned(),
        args,
        verbatim: false,
    };
    if platform == Platform::Unix {
        return plain(bin, args.to_vec());
    }
    // Not found: let the spawn report it.
    let Some(file) = which_windows(bin, env, fs) else {
        return plain(bin, args.to_vec());
    };
    match win_ext(&file).to_lowercase().as_str() {
        ".ps1" => {
            let mut a: Vec<String> = [
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
            .map(String::from)
            .to_vec();
            a.push(file);
            a.extend_from_slice(args);
            plain("powershell.exe", a)
        }
        ".cmd" | ".bat" => resolve_batch(&file, args, env, fs),
        _ => plain(&file, args.to_vec()),
    }
}

fn resolve_batch(
    file: &str,
    args: &[String],
    env: &[(String, String)],
    fs: &dyn Lookup,
) -> Resolved {
    let dir = win_dirname(file);
    match fs.read(file).as_deref().and_then(parse_cmd_shim) {
        Some(Shim::Exe(exe)) => {
            let exe = win_resolve(dir, &exe);
            if fs.is_file(&exe) {
                return Resolved {
                    command: exe,
                    args: args.to_vec(),
                    verbatim: false,
                };
            }
        }
        Some(Shim::Script(script)) => {
            let script = win_resolve(dir, &script);
            if fs.is_file(&script) {
                let local = win_join(dir, "node.exe");
                let node = if fs.is_file(&local) {
                    local
                } else {
                    which_windows("node", env, fs).unwrap_or_else(|| "node".into())
                };
                let mut a = vec![script];
                a.extend_from_slice(args);
                return Resolved {
                    command: node,
                    args: a,
                    verbatim: false,
                };
            }
        }
        None => {}
    }
    // An unknown batch file: through cmd.exe. Newlines can't survive cmd's parser.
    let mut line = escape_cmd_command(file);
    for a in args {
        line.push(' ');
        line.push_str(&escape_cmd_argument(
            &a.replace("\r\n", " ").replace('\n', " "),
            true,
        ));
    }
    let shell = env_get(env, "ComSpec").unwrap_or("cmd.exe").to_owned();
    Resolved {
        command: shell,
        args: vec!["/d".into(), "/s".into(), "/c".into(), format!("\"{line}\"")],
        verbatim: true,
    }
}

// ---- Windows paths as strings (so they are tested on any OS) ----

fn win_ext(p: &str) -> &str {
    let name = p.rsplit(['\\', '/']).next().unwrap_or(p);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[i..],
        _ => "",
    }
}

fn win_dirname(p: &str) -> &str {
    p.rfind(['\\', '/']).map_or(".", |i| &p[..i])
}

fn win_join(dir: &str, name: &str) -> String {
    format!(
        "{}\\{}",
        dir.trim_end_matches(['\\', '/']),
        name.trim_start_matches(['\\', '/'])
    )
}

/// `dir` + a relative path with `..` and `.` folded (path.win32.resolve for the shim's targets).
fn win_resolve(dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = dir.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    for seg in rel.split(['\\', '/']) {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            s => parts.push(s),
        }
    }
    parts.join("\\")
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;
