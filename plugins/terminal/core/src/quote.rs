//! Quoting a command line for each shell a terminal app runs it through.

/// POSIX sh single quotes: `it's` → `'it'\''s'`.
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A PowerShell single-quoted string: `it's` → `'it''s'`.
pub fn psq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// An `AppleScript` string literal.
pub fn as_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// cmd.exe's metacharacters, each escaped with `^`.
const META: &[char] = &['(', ')', ']', '[', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?'];

fn caret(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if META.contains(&c) {
            out.push('^');
        }
        out.push(c);
    }
    out
}

/// A program name for cmd.exe (v1 proc.js `escapeCmdCommand`).
pub fn cmd_command(s: &str) -> String {
    caret(s)
}

/// An argument for cmd.exe (v1 proc.js `escapeCmdArgument`, after cross-spawn): quoted for the
/// program's own parser (backslashes before a quote or the end doubled), then each metacharacter
/// escaped for cmd, twice when cmd runs it through another cmd (`/s /c "…"`). v1's lookahead regex
/// doubled only one backslash of a run; this doubles the run, as the parser needs.
pub fn cmd_argument(arg: &str, double: bool) -> String {
    let mut q = String::with_capacity(arg.len() + 2);
    q.push('"');
    let mut slashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                q.push_str(&"\\".repeat(2 * slashes + 1));
                q.push('"');
                slashes = 0;
            }
            _ => {
                q.push_str(&"\\".repeat(slashes));
                q.push(c);
                slashes = 0;
            }
        }
    }
    q.push_str(&"\\".repeat(2 * slashes));
    q.push('"');
    let once = caret(&q);
    if double { caret(&once) } else { once }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_powershell_applescript() {
        assert_eq!(shq("it's-1"), "'it'\\''s-1'");
        assert_eq!(psq("it's-1"), "'it''s-1'");
        assert_eq!(as_str("cd 'a' && \"b\\c\""), "\"cd 'a' && \\\"b\\\\c\\\"\"");
    }

    #[test]
    fn cmd_exe() {
        assert_eq!(cmd_command("my tool.exe"), "my^ tool.exe");
        assert_eq!(cmd_argument("a b", false), "^\"a^ b^\"");
        assert_eq!(cmd_argument("x", true), "^^^\"x^^^\"");
        assert_eq!(cmd_argument(r#"say "hi""#, false), r#"^"say^ \^"hi\^"^""#);
        assert_eq!(cmd_argument(r"C:\dir\", false), r#"^"C:\dir\\^""#, "a trailing backslash can't eat the quote");
        assert_eq!(cmd_argument(r#"a\\"b"#, false), r#"^"a\\\\\^"b^""#, "a run of backslashes before a quote doubles whole");
    }
}
