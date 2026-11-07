//! .env masking for Changes (v1 server/env-mask.js, the Changes half): a .env file's rows go to the
//! page as `KEY=••••`, and a hunk key the page computed from masked rows still matches. For screens and
//! screen shares, not a wall: Reveal asks for the file unmasked.

use wisp_git_api::{FileDiff, Row};

use crate::hunks::hunk_key;

pub const DOTS: &str = "••••";

/// `.env`, `.env.local`, `.env.production`…, not the templates people commit (`.example`, `.sample`).
pub fn is_env_file(path: &str) -> bool {
    let p = path.replace('\\', "/");
    let base = p.rsplit('/').next().unwrap_or(&p);
    let Some(rest) = base.strip_prefix(".env") else {
        return false;
    };
    let shape = rest.is_empty()
        || (rest.starts_with('.')
            && rest.len() > 1
            && rest[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')));
    let low = base.to_ascii_lowercase();
    shape && !low.ends_with(".example") && !low.ends_with(".sample")
}

/// Where a `[export ]KEY = ` / `KEY: ` prefix ends, if the line starts with one.
fn key_prefix(line: &str) -> Option<usize> {
    let lead = line.len() - line.trim_start().len();
    let after_key = |from: usize| -> Option<usize> {
        let s = &line[from..];
        let mut it = s.char_indices();
        let (_, c0) = it.next()?;
        if !(c0.is_ascii_alphabetic() || c0 == '_') {
            return None;
        }
        let end = s
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
            .unwrap_or(s.len());
        let rest = &s[end..];
        let sep = rest.len() - rest.trim_start().len();
        let rest2 = &rest[sep..];
        if !(rest2.starts_with('=') || rest2.starts_with(':')) {
            return None;
        }
        let after = &rest2[1..];
        let ws = after.len() - after.trim_start().len();
        Some(from + end + sep + 1 + ws)
    };
    let body = &line[lead..];
    if let Some(r) = body.strip_prefix("export")
        && r.starts_with(char::is_whitespace)
    {
        let ws = r.len() - r.trim_start().len();
        if let Some(i) = after_key(lead + 6 + ws) {
            return Some(i);
        }
    }
    after_key(lead)
}

/// A line of a .env file with its value masked; blanks, comments and empty values stay.
pub fn mask_line(line: &str) -> String {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return line.to_owned();
    }
    match key_prefix(line) {
        Some(i) if i >= line.len() => line.to_owned(),
        Some(i) => format!("{}{DOTS}", &line[..i]),
        None => format!("{}{DOTS}", &line[..line.len() - trimmed.len()]),
    }
}

pub fn mask_row(r: &Row) -> Row {
    match &r.text {
        Some(t) => Row {
            text: Some(mask_line(t)),
            ..r.clone()
        },
        None => r.clone(),
    }
}

/// A .env file's rows masked, unless it is binary or revealed.
pub fn mask_file(f: &mut FileDiff, revealed: bool) {
    if f.binary || revealed || !is_env_file(&f.path) {
        return;
    }
    for r in &mut f.rows {
        if let Some(t) = &r.text {
            r.text = Some(mask_line(t));
        }
    }
    f.masked = true;
}

/// The page may have shown a hunk masked: its key is the masked rows'.
pub fn same_hunk(rows: &[Row], key: &str) -> bool {
    hunk_key(rows) == key || hunk_key(&rows.iter().map(mask_row).collect::<Vec<_>>()) == key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_files() {
        for p in [".env", "app/.env.local", ".env.production", "a\\.env"] {
            assert!(is_env_file(p), "{p}");
        }
        for p in [
            ".env.example",
            ".env.local.example",
            ".env.sample",
            "env",
            ".environment",
            "x.env",
            ".env.",
        ] {
            assert!(!is_env_file(p), "{p}");
        }
    }

    #[test]
    fn lines() {
        assert_eq!(mask_line("API_KEY=sk-live-1"), "API_KEY=••••");
        assert_eq!(
            mask_line("export TOKEN = \"x y\" # c"),
            "export TOKEN = ••••"
        );
        assert_eq!(mask_line("  host: db.local"), "  host: ••••");
        assert_eq!(mask_line("EMPTY="), "EMPTY=");
        assert_eq!(mask_line("# comment=1"), "# comment=1");
        assert_eq!(mask_line("   "), "   ");
        assert_eq!(
            mask_line("  sk-bare-value"),
            "  ••••",
            "a bare value goes whole"
        );
        assert_eq!(
            mask_line("export=1"),
            "export=••••",
            "export can be the key"
        );
    }

    #[test]
    fn files_and_keys() {
        let mut f = FileDiff::new(".env", 'M');
        f.rows = vec![Row::removed("A=1", 1), Row::added("A=2", 1)];
        let raw = f.rows.clone();
        mask_file(&mut f, false);
        assert!(f.masked && f.rows[1].text() == "A=••••");
        assert!(
            same_hunk(&raw, &hunk_key(&f.rows)),
            "a masked key matches the real rows"
        );
        assert!(same_hunk(&raw, &hunk_key(&raw)));
        let mut shown = FileDiff::new(".env", 'M');
        mask_file(&mut shown, true);
        assert!(!shown.masked, "revealed");
    }
}
