//! boxd, wisp Grid's root helper (v1 grid/boxd.js): the one part of the grid that runs as root. Whoever can run
//! docker is root on the host, so the grid doesn't: it asks boxd, over a Unix socket only the grid's group can open,
//! to run, stop or delete one user's box. boxd builds `docker run` from its own settings (image, runtime, network,
//! the box's uid), so a grid that was broken into can't ask for more than a box. The boxes' homes, where the agents
//! keep their logins, live in boxd's own folder (`/var/lib/wisp-grid-boxes`, root only).
//!
//! ```text
//! wisp-grid-boxd serve   [--socket /run/wisp-grid/box.sock] [--group wisp] [--data /var/lib/wisp-grid]
//!                        [--boxes /var/lib/wisp-grid-boxes] [--image wisp-grid-user] [--runtime runsc]
//!                        [--network wisp-users] [--uid 1000] [--docker docker]
//! wisp-grid-boxd migrate [--data …] [--boxes …]   move homes from <data>/users/<id>/home (grid stopped)
//! ```
//!
//! std only, on purpose (ADR-0014): every line it pulled in would run as root.

pub mod json;
pub mod run;
pub mod serve;

use serve::Opts;

fn opts(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (k, v) = match a.split_once('=') {
            Some((k, v)) => (k, v.to_owned()),
            None => (a.as_str(), it.next().cloned().ok_or_else(|| format!("{a} needs a value"))?),
        };
        match k {
            "--socket" => o.socket = v.into(),
            "--group" => o.group = v,
            "--data" => o.data = v.into(),
            "--boxes" => o.boxes = v.into(),
            "--image" => o.container.image = v,
            "--runtime" => o.container.runtime = if v == "runc" { String::new() } else { v },
            "--network" => o.container.network = v,
            "--uid" => o.container.uid = v.parse().map_err(|_| format!("--uid {v}: a number"))?,
            "--docker" => o.docker = v,
            other => return Err(format!("What is \"{other}\"?")),
        }
    }
    Ok(o)
}

#[must_use]
#[allow(clippy::needless_pass_by_value)] // main hands over its arguments
pub fn main_with(args: Vec<String>) -> i32 {
    let usage = "usage: wisp-grid-boxd serve|migrate [--socket S] [--group G] [--data DIR] [--boxes DIR] [--image I] [--runtime R] [--network N] [--uid U]";
    let Some((cmd, rest)) = args.split_first().map(|(c, r)| (c.as_str(), r)) else {
        eprintln!("{usage}");
        return 2;
    };
    let o = match opts(rest) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("boxd: {e}");
            return 2;
        }
    };
    match cmd {
        "serve" => match serve::serve(o) {
            Ok((b, l)) => {
                let c = &b.o.container;
                eprintln!("boxd: listening at {} (group {}); boxes in {}, image {}, runtime {}, network {}", b.o.socket.display(), b.o.group, b.o.boxes.display(), c.image, if c.runtime.is_empty() { "runc" } else { &c.runtime }, c.network);
                serve::accept(&b, &l);
                0
            }
            Err(e) => {
                eprintln!("boxd: {e}");
                1
            }
        },
        "migrate" => match serve::migrate(&o) {
            Ok((moved, skipped)) => {
                eprintln!("boxd: moved {} home{}{}.", moved.len(), if moved.len() == 1 { "" } else { "s" }, if skipped.is_empty() { String::new() } else { format!(", skipped {}", skipped.len()) });
                i32::from(!skipped.is_empty())
            }
            Err(e) => {
                eprintln!("boxd: {e}");
                1
            }
        },
        _ => {
            eprintln!("{usage}");
            2
        }
    }
}
