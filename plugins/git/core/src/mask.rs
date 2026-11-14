//! .env masking for Changes (v1 server/env-mask.js, the Changes half): a .env file's rows go to the
//! page as `KEY=••••`, and a hunk key the page computed from masked rows still matches. For screens and
//! screen shares, not a wall: Reveal asks for the file unmasked.

use wisp_git_api::{FileDiff, Row};

use crate::hunks::hunk_key;

// one rule set for every view of a .env file (ADR-0050): Changes masks as the transcript does
pub use wisp_envmask::{DOTS, is_env_file, mask_line};

pub fn mask_row(r: &Row) -> Row {
    match &r.text {
        Some(t) => Row { text: Some(mask_line(t)), ..r.clone() },
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
        for p in [".env.example", ".env.local.example", ".env.sample", "env", ".environment", "x.env", ".env."] {
            assert!(!is_env_file(p), "{p}");
        }
    }

    #[test]
    fn lines() {
        assert_eq!(mask_line("API_KEY=sk-live-1"), "API_KEY=••••");
        assert_eq!(mask_line("export TOKEN = \"x y\" # c"), "export TOKEN = ••••");
        assert_eq!(mask_line("  host: db.local"), "  host: ••••");
        assert_eq!(mask_line("EMPTY="), "EMPTY=");
        assert_eq!(mask_line("# comment=1"), "# comment=1");
        assert_eq!(mask_line("   "), "   ");
        assert_eq!(mask_line("  sk-bare-value"), "  ••••", "a bare value goes whole");
        assert_eq!(mask_line("export=1"), "export=••••", "export can be the key");
    }

    #[test]
    fn files_and_keys() {
        let mut f = FileDiff::new(".env", 'M');
        f.rows = vec![Row::removed("A=1", 1), Row::added("A=2", 1)];
        let raw = f.rows.clone();
        mask_file(&mut f, false);
        assert!(f.masked && f.rows[1].text() == "A=••••");
        assert!(same_hunk(&raw, &hunk_key(&f.rows)), "a masked key matches the real rows");
        assert!(same_hunk(&raw, &hunk_key(&raw)));
        let mut shown = FileDiff::new(".env", 'M');
        mask_file(&mut shown, true);
        assert!(!shown.masked, "revealed");
    }
}
