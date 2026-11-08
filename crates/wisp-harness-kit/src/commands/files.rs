//! Commands that read, search, list or change files: cat, head, sed, grep, find, ls, mv, tar …
//!
//! size-ok: a data table: one describer per file command

use super::argv::{Ctx, Desc, Known, count_arg, operands, say, short, shown, silent, value_of};
use crate::paths::RunPaths;
use crate::re::Re;
use crate::text::clip;

static TAIL_FOLLOW: Re = Re::new(r"^-[a-zA-Z]*[fF]");
static TAR_CREATE: Re = Re::new(r"^(-?[a-z]*c|zip)");
static SED_IN_PLACE: Re = Re::new(r"^-[a-zA-Z]*i");
static SED_N: Re = Re::new(r"^-[a-zA-Z]*n");
static SED_LINES: Re = Re::new(concat!(
    r"^([0-9]+|\$)(?:",
    crate::js_s!(),
    r"*,",
    crate::js_s!(),
    r"*([0-9]+|\$))?",
    crate::js_s!(),
    r"*p$"
));
/// JavaScript's `.`: anything but a line end.
static SED_SUBST: Re = Re::new(r"^s[^\n\r\x{2028}\x{2029}]");

#[allow(clippy::unnecessary_wraps)] // a table answer: None is "not my command"
fn some(d: Desc) -> Known {
    Some(Some(d))
}

fn reading(c: &Ctx) -> Known {
    if !c.files.is_empty() {
        say(format!("Reading {}", c.target()))
    } else if c.piped {
        some(Desc::weak("Reading input"))
    } else {
        silent()
    }
}

fn head_tail(c: &Ctx) -> Desc {
    let head = c.cmd == "head";
    if !head && c.args.iter().any(|a| TAIL_FOLLOW.is_match(a)) {
        return Desc::strong(if c.files.is_empty() {
            "Watching output".into()
        } else {
            format!("Watching {}", c.target())
        });
    }
    let n = count_arg(c.args);
    if c.files.is_empty() {
        return Desc::weak(n.map_or_else(
            || "Trimming output".into(),
            |n| {
                format!(
                    "Taking the {} {n} lines",
                    if head { "first" } else { "last" }
                )
            },
        ));
    }
    Desc::strong(match n {
        Some(n) => format!(
            "Reading the {} {n} lines of {}",
            if head { "first" } else { "last" },
            c.target()
        ),
        None => format!(
            "Reading the {} of {}",
            if head { "start" } else { "end" },
            c.target()
        ),
    })
}

fn find(c: &Ctx) -> Desc {
    let ops = operands(c.args);
    let name = value_of(c.args, &["-name", "-iname", "-path", "-ipath"]).or_else(|| {
        if c.cmd == "fd" {
            ops.first().copied()
        } else {
            None
        }
    });
    let where_ = if c.cmd == "find" {
        c.arg(0).filter(|a| !a.starts_with('-')).unwrap_or("")
    } else {
        ops.get(1).copied().unwrap_or("")
    };
    let in_where = if !where_.is_empty() && where_ != "." {
        format!(" in {}", c.f(where_))
    } else {
        String::new()
    };
    if c.has("-delete") {
        return Desc::strong(format!(
            "Deleting {}{in_where}",
            name.map_or_else(|| "files".into(), |n| format!("{n} files"))
        ));
    }
    Desc::strong(match name {
        Some(n) => format!("Finding {}{in_where}", clip(n, 40)),
        None => format!("Finding files{in_where}"),
    })
}

fn archive(c: &Ctx) -> Desc {
    let creating = TAR_CREATE.is_match(c.arg(0).unwrap_or("")) && c.cmd == "tar";
    let t = c.target();
    Desc::strong(if creating {
        "Creating an archive".into()
    } else {
        format!(
            "Extracting {}",
            if t.is_empty() { "an archive" } else { &t }
        )
    })
}

fn or_word(s: String, fallback: &str) -> String {
    if s.is_empty() { fallback.to_owned() } else { s }
}

/// The file commands' answer for `c`, or None when `c.cmd` isn't one of them.
pub(super) fn describe(c: &Ctx) -> Known {
    let t = || c.target();
    let has_files = !c.files.is_empty();
    match c.cmd {
        "cat" | "bat" | "less" | "more" => reading(c),
        "nl" => {
            if has_files {
                say(format!("Reading {}", t()))
            } else {
                silent()
            }
        }
        "head" | "tail" => some(head_tail(c)),
        "sed" | "gsed" => some(describe_sed(c.args, c.paths, c.piped)),
        "awk" | "gawk" => {
            let ops = operands(c.args);
            some(ops.get(1).map_or_else(
                || Desc::weak("Processing text"),
                |f| Desc::strong(format!("Reading {}", c.f(f))),
            ))
        }
        "grep" | "egrep" | "fgrep" | "rg" | "ag" | "ack" => {
            some(describe_grep(c.cmd, c.args, c.paths, c.piped))
        }
        "find" | "fd" => some(find(c)),
        "ls" | "eza" | "exa" | "tree" => say(if has_files {
            format!("Listing {}", t())
        } else if c.cmd == "tree" {
            "Looking at the folder tree".into()
        } else {
            "Listing files".into()
        }),
        "wc" => some(if has_files {
            Desc::strong(format!(
                "Counting {} in {}",
                if c.has("-l") { "lines" } else { "words" },
                t()
            ))
        } else {
            Desc::weak("Counting lines")
        }),
        "sort" | "uniq" | "cut" | "tr" | "column" | "fold" | "rev" => some(if has_files {
            Desc::strong(format!("Reading {}", t()))
        } else {
            Desc::weak("Processing text")
        }),
        "jq" | "yq" => some(match operands(c.args).get(1) {
            Some(f) => Desc::strong(format!("Reading {}", c.f(f))),
            None if c.piped => Desc::weak("Parsing JSON"),
            None => Desc::strong("Parsing JSON"),
        }),
        "diff" | "cmp" | "colordiff" => say(if c.files.len() >= 2 {
            format!("Comparing {} and {}", c.f(c.files[0]), c.f(c.files[1]))
        } else {
            "Comparing files".into()
        }),
        "stat" | "file" => say(format!("Inspecting {}", or_word(t(), "a file"))),
        "du" | "df" => say(if has_files {
            format!("Checking disk usage of {}", t())
        } else {
            "Checking disk usage".into()
        }),
        "mkdir" => say(format!("Creating folder {}", t())),
        "touch" => say(format!("Creating {}", t())),
        "rm" | "rmdir" | "trash" => say(format!("Deleting {}", or_word(t(), "files"))),
        "mv" => say(if c.files.len() == 2 {
            format!("Moving {} to {}", c.f(c.files[0]), c.f(c.files[1]))
        } else {
            format!("Moving {}", t())
        }),
        "cp" | "rsync" => say(if c.files.len() == 2 {
            format!("Copying {} to {}", c.f(c.files[0]), c.f(c.files[1]))
        } else {
            format!("Copying {}", t())
        }),
        "ln" => say(format!("Linking {}", t())),
        "chmod" | "chown" => {
            let ops = operands(c.args);
            let list = ops
                .iter()
                .skip(1)
                .map(|p| c.f(p))
                .collect::<Vec<_>>()
                .join(", ");
            say(format!(
                "Changing permissions of {}",
                or_word(list, "files")
            ))
        }
        "tee" => say(if has_files {
            format!("Writing {}", t())
        } else {
            "Saving output".into()
        }),
        "tar" | "unzip" | "gunzip" | "7z" => some(archive(c)),
        "zip" => say("Creating an archive"),
        _ => None,
    }
}

pub(super) fn describe_sed(args: &[String], paths: &RunPaths, piped: bool) -> Desc {
    let in_place = args
        .iter()
        .any(|a| SED_IN_PLACE.is_match(a) || a.starts_with("--in-place"));
    let mut scripts: Vec<Option<&str>> = Vec::new();
    let mut files: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-e" || a == "--expression" {
            i += 1;
            scripts.push(args.get(i).map(String::as_str));
        } else if a == "-f" {
            i += 1;
        } else if a.starts_with('-') || (in_place && a.is_empty() && i > 0 && args[i - 1] == "-i") {
            // a flag, or BSD `sed -i ''`
        } else {
            files.push(a);
        }
        i += 1;
    }
    if scripts.is_empty() && !files.is_empty() {
        scripts.push(Some(files.remove(0)));
    }
    let target = shown(&files, paths);
    if in_place {
        return Desc::strong(if target.is_empty() {
            "Editing files".into()
        } else {
            format!("Editing {target}")
        });
    }
    let script = crate::js::trim(scripts.first().copied().flatten().unwrap_or(""));
    if let Some(m) = SED_LINES
        .captures(script)
        .filter(|_| args.iter().any(|a| SED_N.is_match(a)))
    {
        let a = m.get(1).map_or("", |x| x.as_str());
        let b = m.get(2).map(|x| x.as_str());
        let span = match b {
            None => format!("line {a}"),
            Some("$") => format!("from line {a} on"),
            Some(b) => format!("lines {a}–{b}"),
        };
        if target.is_empty() {
            return Desc::weak(format!("Taking {span}"));
        }
        return Desc::strong(if b == Some("$") {
            format!("Reading {target} from line {a} on")
        } else {
            format!("Reading {span} of {target}")
        });
    }
    if !target.is_empty() {
        return Desc::strong(if SED_SUBST.is_match(script) {
            format!("Rewriting text from {target}")
        } else {
            format!("Reading {target}")
        });
    }
    if piped {
        Desc::weak("Processing text")
    } else {
        Desc::strong("Processing text")
    }
}

fn grep_takes_value(a: &str) -> bool {
    matches!(
        a,
        "-e" | "-f"
            | "-m"
            | "-A"
            | "-B"
            | "-C"
            | "-g"
            | "--glob"
            | "-t"
            | "--type"
            | "-T"
            | "--max-count"
            | "--context"
            | "--after-context"
            | "--before-context"
            | "--regexp"
            | "--include"
            | "--exclude"
            | "--exclude-dir"
            | "-d"
            | "-D"
    )
}

/// What a pattern search is about. `Unset`: none found yet; `Missing`: `-e` was the last word (v1
/// then searched for “”).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pattern<'a> {
    Unset,
    Missing,
    Is(&'a str),
}

pub(super) fn describe_grep(cmd: &str, args: &[String], paths: &RunPaths, piped: bool) -> Desc {
    let listing = cmd == "rg" && args.iter().any(|a| a == "--files");
    let mut pattern = Pattern::Unset;
    let mut found: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if (a == "-e" || a == "--regexp") && matches!(pattern, Pattern::Unset | Pattern::Missing) {
            // v1's `pattern ??= args[++i]` only moves on when it takes the value
            i += 1;
            pattern = args.get(i).map_or(Pattern::Missing, |p| Pattern::Is(p));
        } else if a == "-e" || a == "--regexp" {
            // a second -e: v1's `??=` neither took its value nor moved on, so the value is read next
        } else if grep_takes_value(a) {
            i += 1;
        } else if a.starts_with('-') {
        } else if pattern == Pattern::Unset && !listing {
            pattern = Pattern::Is(a);
        } else {
            found.push(a);
        }
        i += 1;
    }
    let f = |p: &str| short(p, paths);
    if listing {
        return Desc::strong(found.first().map_or_else(
            || "Listing files".into(),
            |p| format!("Listing files in {}", f(p)),
        ));
    }
    let pat = match pattern {
        Pattern::Unset => {
            return if piped {
                Desc::weak("Filtering output")
            } else {
                Desc::strong("Searching files")
            };
        }
        Pattern::Missing => "",
        Pattern::Is(p) => p,
    };
    if piped && found.is_empty() {
        return Desc::weak(format!("Filtering for “{}”", clip(pat, 40)));
    }
    let where_ = if found.is_empty() {
        String::new()
    } else {
        format!(
            " in {}{}",
            shown(&found, paths),
            if found.len() > 2 {
                format!(" +{}", found.len() - 2)
            } else {
                String::new()
            }
        )
    };
    Desc::strong(format!("Searching for “{}”{where_}", clip(pat, 40)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for r in [
            &TAIL_FOLLOW,
            &TAR_CREATE,
            &SED_IN_PLACE,
            &SED_N,
            &SED_LINES,
            &SED_SUBST,
        ] {
            assert!(r.compiles(), "{}", r.pattern());
        }
    }
}
