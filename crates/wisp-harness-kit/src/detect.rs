//! What a CLI says about itself, read without running it (the host runs it through the proc service):
//! its version line and the effort levels its `--help` lists (v1 `adapters/common.js`).

use crate::re::Re;

static VERSION: Re =
    Re::new(r"[0-9]+(?:\.[0-9]+)+[^\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF},)]*");
static TRIPLE: Re = Re::new(r"([0-9]+)\.([0-9]+)\.([0-9]+)");
static EFFORT_FLAG: Re = Re::new(r"--(?:reasoning-)?effort\b");
static NEXT_OPTION: Re = Re::new(concat!(r"\n", crate::js_s!(), r"*-{1,2}", crate::js_w!()));
static LEVELS: Re = Re::new(concat!(
    r"(?:\(",
    crate::js_s!(),
    r"*|possible values:",
    crate::js_s!(),
    r"*)([a-z]+(?:",
    crate::js_s!(),
    r"*[,|]",
    crate::js_s!(),
    r"*[a-z]+)+)"
));
static LEVEL_SEP: Re = Re::new(concat!(crate::js_s!(), r"*[,|]", crate::js_s!(), "*"));

/// A CLI's version line ("codex-cli 0.163.0", "2.1.316 (Claude Code)") as the bare version, or ''.
pub fn version_in(line: &str) -> String {
    VERSION.find(line).unwrap_or("").to_owned()
}

/// [major, minor, patch] from a version line, or [] when it has none.
pub fn version_triple(v: &str) -> Vec<u64> {
    TRIPLE.captures(v).map_or_else(Vec::new, |c| (1..=3).filter_map(|i| c.get(i)).map(|m| m.as_str().parse().unwrap_or(0)).collect())
}

/// The thinking levels a CLI's --help gives for its effort flag: "(low, medium, high)",
/// "(low|medium|high)" or "[possible values: low, medium, high]". [] when it lists none.
pub fn help_efforts(text: &str) -> Vec<String> {
    let Some(at) = EFFORT_FLAG.search(text) else {
        return Vec::new();
    };
    // Just this flag's entry: up to the next option.
    let rest = &text[at..];
    let entry = NEXT_OPTION.split(rest).first().copied().unwrap_or("");
    match LEVELS.group(entry, 1) {
        Some(levels) => LEVEL_SEP.split(levels).into_iter().map(str::to_owned).collect(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for r in [&VERSION, &TRIPLE, &EFFORT_FLAG, &NEXT_OPTION, &LEVELS, &LEVEL_SEP] {
            assert!(r.compiles(), "{}", r.pattern());
        }
    }

    #[test]
    fn versions() {
        assert_eq!(version_in("codex-cli 0.163.0"), "0.163.0");
        assert_eq!(version_in("2.1.316 (Claude Code)"), "2.1.316");
        assert_eq!(version_in("v1.2.3-beta.1, built"), "1.2.3-beta.1");
        assert_eq!(version_in("none"), "");
        assert_eq!(version_triple("2.1.316 (Claude Code)"), [2, 1, 316]);
        assert_eq!(version_triple("2.1"), Vec::<u64>::new());
    }

    #[test]
    fn efforts_from_help() {
        assert_eq!(help_efforts("  --effort <level>  Effort (low, medium, high)\n  --model x"), ["low", "medium", "high"]);
        assert_eq!(help_efforts("--reasoning-effort  [possible values: low, high]"), ["low", "high"]);
        assert_eq!(help_efforts("--effort x\n  --other (a|b)"), Vec::<String>::new());
        assert_eq!(help_efforts("nothing"), Vec::<String>::new());
    }
}
