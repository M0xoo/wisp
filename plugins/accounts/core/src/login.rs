//! Reading a sign-in as the CLI prints it (v1 agent-login.js `clean`, `parse`): the first link, a
//! one-time code, whether it waits for a code pasted back; and the account a sign-in is for.

use wisp_harness_kit::Re;

static ANSI: Re = Re::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\r");
static URL: Re = Re::new(r#"https?://[^\s"'<>]+"#);
static CODE: Re = Re::new(r"\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b");
static NEEDS: Re = Re::new(r"(?i)paste (the )?(authorization )?code|enter (the )?(authorization )?code here|code here if prompted");

/// The time a sign-in may take.
pub const TIMEOUT_MS: i64 = 15 * 60_000;
/// what is kept of its output
pub const MAX_OUT: usize = 8000;

pub fn clean(s: &str) -> String {
    ANSI.replace_all(s, "").into_owned()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Said {
    pub url: String,
    pub code: String,
    pub needs_input: bool,
}

pub fn parse(text: &str) -> Said {
    let t = clean(text);
    let url = URL.find(&t).unwrap_or("").to_owned();
    let rest = if url.is_empty() { t.clone() } else { t.replacen(&url, "", 1) };
    Said { code: CODE.group(&rest, 1).unwrap_or("").to_owned(), needs_input: NEEDS.is_match(&t), url }
}

/// The last line a failed sign-in printed (its reason).
pub fn last_line(out: &str) -> Option<String> {
    clean(out).lines().rev().find(|l| !l.trim().is_empty()).map(str::to_owned)
}

/// Its last few lines, for the page.
pub fn tail(out: &str, n: usize) -> String {
    let c = clean(out);
    let lines: Vec<&str> = c.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// `''` for the CLI's own login, else the account id.
pub fn account_key(acc: &str) -> &str {
    if acc == crate::accounts::DEFAULT { "" } else { acc }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_code_sign_in_in_words() {
        for p in [&ANSI, &URL, &CODE, &NEEDS] {
            assert!(p.compiles(), "{}", p.pattern());
        }
        // codex login --device-auth, as it prints it
        let s = parse("\x1b[1mWelcome\x1b[0m\nOpen https://auth.openai.com/codex/device\nand enter this one-time code ABCD-12345\r\n");
        assert_eq!((s.url.as_str(), s.code.as_str(), s.needs_input), ("https://auth.openai.com/codex/device", "ABCD-12345", false));
        assert!(parse("Paste code here if prompted >").needs_input);
        assert_eq!(last_line("a\nerror: nope\n\n").as_deref(), Some("error: nope"));
        assert_eq!(tail("1\n2\n3\n", 2), "2\n3");
        assert_eq!(account_key("default"), "");
    }
}
