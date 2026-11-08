//! v1 codex.js `unwrapShell`: codex reports commands wrapped in a shell (`bash -lc '…'` on Unix,
//! `powershell.exe -Command "…"` and `cmd /c` on Windows); the ticker shows the inner command.

use serde_json::Value;
use wisp_harness_kit::Re;

static SH: Re = Re::new(r#"^(?:\S*/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)$"#);
static PS: Re = Re::new(r#"(?i)^"?(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?: -NoProfile| -NoLogo)* -(?:Command|c) ([\s\S]*)$"#);
static CMD: Re = Re::new(r#"^"?(?:[^"]*[\\/])?cmd(?:\.exe)?"? /[cC] ([\s\S]*)$"#);
static FLAG: Re = Re::new(r"(?i)^(-l?c|-Command|/c)$");

/// `(['"]?)(body)\1$` without a backreference: the quotes come off when both ends have the same one.
fn unquote(s: &str) -> &str {
    for q in ['\'', '"'] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s
}

pub fn unwrap_shell(cmd: &Value) -> String {
    if let Value::Array(parts) = cmd {
        let parts: Vec<String> = parts.iter().map(wisp_harness_kit::js::string).collect();
        let i = parts.iter().position(|a| FLAG.is_match(a));
        return match i {
            Some(i) if i + 2 == parts.len() => parts[i + 1].clone(),
            _ => parts.join(" "),
        };
    }
    let s = wisp_harness_kit::js::str(cmd);
    if let Some(c) = SH.captures(&s) {
        let q = c.get(1).map_or("", |m| m.as_str());
        let body = c.get(2).map_or("", |m| m.as_str());
        if let Some(inner) = body.strip_suffix(q) {
            return inner.to_owned();
        }
    }
    for re in [&PS, &CMD] {
        if let Some(c) = re.captures(&s) {
            return unquote(c.get(1).map_or("", |m| m.as_str())).to_owned();
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shells_come_off() {
        for p in [&SH, &PS, &CMD, &FLAG] {
            assert!(p.compiles(), "{}", p.pattern());
        }
        assert_eq!(unwrap_shell(&json!("/bin/bash -lc 'npm test'")), "npm test");
        assert_eq!(unwrap_shell(&json!("zsh -c \"ls -la\"")), "ls -la");
        assert_eq!(unwrap_shell(&json!("bash -lc 'unterminated")), "bash -lc 'unterminated");
        assert_eq!(unwrap_shell(&json!(r#""C:\Windows\powershell.exe" -NoProfile -Command "dir""#)), "dir");
        assert_eq!(unwrap_shell(&json!("cmd.exe /c dir")), "dir");
        assert_eq!(unwrap_shell(&json!(["bash", "-lc", "echo hi"])), "echo hi");
        assert_eq!(unwrap_shell(&json!(["git", "status"])), "git status");
        assert_eq!(unwrap_shell(&Value::Null), "");
    }
}
