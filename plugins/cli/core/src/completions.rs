//! `wisp completions zsh|bash|fish`: the scripts, written from the same catalogue as the verbs (the
//! curated commands, every plugin and its verbs, each verb's flags).

use std::fmt::Write as _;

use crate::verbs::Catalogue;

fn q(s: &str) -> String {
    s.replace('\'', "")
}

/// A plugin's first word and its verbs, each with its flags.
type Tree = Vec<(String, Vec<(String, Vec<String>)>)>;

/// (word, its verbs as words, each verb's flags) for every plugin.
fn tree(c: &Catalogue) -> Tree {
    c.plugins()
        .into_iter()
        .map(|(p, verbs)| {
            let vs = verbs.iter().map(|v| (v.words.join("-"), v.spec.fields.iter().map(|f| format!("--{}", f.flag())).collect())).collect();
            (p.to_owned(), vs)
        })
        .collect()
}

/// The script for `shell`, or None for a shell it doesn't know.
pub fn script(shell: &str, c: &Catalogue, curated: &[&str]) -> Option<String> {
    match shell {
        "zsh" => Some(zsh(c, curated)),
        "bash" => Some(bash(c, curated)),
        "fish" => Some(fish(c, curated)),
        _ => None,
    }
}

fn bash(c: &Catalogue, curated: &[&str]) -> String {
    let t = tree(c);
    let mut s = String::from(
        "# wisp completions for bash: eval \"$(wisp completions bash)\"\n_wisp() {\n  local cur=${COMP_WORDS[COMP_CWORD]} p=${COMP_WORDS[1]} v=${COMP_WORDS[2]}\n  if [ \"$COMP_CWORD\" -eq 1 ]; then\n",
    );
    let firsts: Vec<String> = curated
        .iter()
        .map(|x| (*x).to_owned())
        .chain(t.iter().map(|(p, _)| p.clone()))
        .chain(["help".into(), "completions".into(), "attach".into()])
        .collect();
    let _ = writeln!(s, "    COMPREPLY=($(compgen -W '{}' -- \"$cur\")); return\n  fi\n  case \"$p\" in", q(&firsts.join(" ")));
    for (p, verbs) in &t {
        let names: Vec<&str> = verbs.iter().map(|(v, _)| v.as_str()).collect();
        let _ = writeln!(
            s,
            "    {p}) if [ \"$COMP_CWORD\" -eq 2 ]; then COMPREPLY=($(compgen -W '{}' -- \"$cur\")); return; fi\n      case \"$v\" in",
            q(&names.join(" "))
        );
        for (v, flags) in verbs {
            let _ = writeln!(s, "        {v}) COMPREPLY=($(compgen -W '{} --json --help' -- \"$cur\")) ;;", q(&flags.join(" ")));
        }
        s.push_str("      esac ;;\n");
    }
    s.push_str("    completions) COMPREPLY=($(compgen -W 'zsh bash fish' -- \"$cur\")) ;;\n  esac\n}\ncomplete -F _wisp wisp\n");
    s
}

fn zsh(c: &Catalogue, curated: &[&str]) -> String {
    let t = tree(c);
    let mut s = String::from(
        "#compdef wisp\n# wisp completions for zsh: wisp completions zsh > \"${fpath[1]}/_wisp\"\n_wisp() {\n  local -a firsts verbs flags\n",
    );
    let firsts: Vec<String> = curated
        .iter()
        .map(|x| format!("'{x}:a wisp command'"))
        .chain(t.iter().map(|(p, v)| format!("'{p}:{} commands'", v.len())))
        .chain(["'help:every command'".into(), "'completions:shell completions'".into(), "'attach:follow a task live'".into()])
        .collect();
    let _ = writeln!(
        s,
        "  firsts=({})\n  if (( CURRENT == 2 )); then _describe 'command' firsts; return; fi\n  case $words[2] in",
        firsts.join(" ")
    );
    for (p, verbs) in &t {
        let names: Vec<String> = verbs.iter().map(|(v, _)| format!("'{}'", q(v))).collect();
        let _ = writeln!(
            s,
            "    {p})\n      verbs=({})\n      if (( CURRENT == 3 )); then _describe 'verb' verbs; return; fi\n      case $words[3] in",
            names.join(" ")
        );
        for (v, flags) in verbs {
            let _ = writeln!(s, "        {v}) flags=({} --json --help) ;;", flags.join(" "));
        }
        s.push_str("      esac\n      _describe 'flag' flags ;;\n");
    }
    s.push_str("    completions) _values 'shell' zsh bash fish ;;\n  esac\n}\ncompdef _wisp wisp\n");
    s
}

fn fish(c: &Catalogue, curated: &[&str]) -> String {
    let t = tree(c);
    let mut s =
        String::from("# wisp completions for fish: wisp completions fish > ~/.config/fish/completions/wisp.fish\ncomplete -c wisp -f\n");
    for x in curated.iter().chain(["help", "completions", "attach"].iter()) {
        let _ = writeln!(s, "complete -c wisp -n '__fish_use_subcommand' -a '{x}'");
    }
    for (p, verbs) in &t {
        let _ = writeln!(s, "complete -c wisp -n '__fish_use_subcommand' -a '{p}' -d '{} commands'", verbs.len());
        for (v, flags) in verbs {
            let _ = writeln!(s, "complete -c wisp -n '__fish_seen_subcommand_from {p}; and not __fish_seen_subcommand_from {v}' -a '{v}'");
            for f in flags {
                let _ = writeln!(s, "complete -c wisp -n '__fish_seen_subcommand_from {v}' -l '{}'", f.trim_start_matches("--"));
            }
        }
    }
    let _ = writeln!(s, "complete -c wisp -n '__fish_seen_subcommand_from completions' -a 'zsh bash fish'");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_kernel::CommandInfo;

    #[test]
    fn each_shell_names_every_plugin_verb_and_flag() {
        let c = Catalogue::new(vec![CommandInfo {
            id: "crew.create".into(),
            plugin: "wisp.crew".into(),
            title: None,
            read_only: false,
            permission: "crew:write".into(),
            args: Some("{ name?: string, }".into()),
            ui_only: None,
        }]);
        for sh in ["zsh", "bash", "fish"] {
            let s = script(sh, &c, &["ls", "show"]).unwrap();
            assert!(s.contains("crew") && s.contains("create") && s.contains("name") && s.contains("ls"), "{sh}: {s}");
        }
        assert!(script("tcsh", &c, &[]).is_none());
    }
}
