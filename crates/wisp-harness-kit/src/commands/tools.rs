//! Build tools, package managers and language runtimes: npm, npx, node, python, pip, cargo, go, make,
//! docker, brew, and the dev tools they run (tsc, vitest, eslint, vite …).
//!
//! size-ok: a data table: one describer per tool family

use super::argv::{Ctx, Desc, Known, basename, operands, say, short, strip_flags};
use super::vcs::{describe_gh, describe_git};
use crate::paths::RunPaths;
use crate::re::Re;
use super::clip;

static AT_VERSION: Re = Re::new(r"@[^/]*$");
static SCRIPT_PATH: Re = Re::new(r"^\.{0,2}/|\.(sh|js|mjs|cjs|ts|py|rb)$");
static TEST_TARGET: Re = Re::new(r"^(test|tests|spec|check:test)(:|$)|^test[-_]");
static PY_FLAGS: Re = Re::new(r"^-[IuOBESsq]+$");

#[allow(clippy::unnecessary_wraps)] // describers answer Option: None is "nothing to say"
fn d(text: impl Into<String>) -> Option<Desc> {
    Some(Desc::strong(text))
}

/// Dev tools that run on their own or through npx / pnpm exec / uv run.
pub(super) fn describe_tool(argv: &[String], paths: &RunPaths, via_runner: bool) -> Option<Desc> {
    let (cmd0, args) = argv.split_first()?;
    if cmd0.is_empty() {
        return None;
    }
    let cmd = basename(&AT_VERSION.replace(cmd0, "")).to_owned(); // npx tsc@5 → tsc
    if let Some(known) = known_tool(&cmd, args) {
        return Some(known);
    }
    if SCRIPT_PATH.is_match(cmd0) {
        return d(format!("Running {}", short(cmd0, paths)));
    }
    if via_runner {
        d(format!("Running {cmd}"))
    } else {
        Some(Desc::unknown(format!(
            "Running {}",
            clip(&argv.join(" "), 50)
        )))
    }
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn known_tool(cmd: &str, args: &[String]) -> Option<Desc> {
    match cmd {
        "jest" | "vitest" | "mocha" | "ava" | "tap" | "pytest" | "playwright" | "cypress"
        | "karma" | "jasmine" | "uvu" => {
            if cmd == "playwright" && args.first().is_some_and(|a| a == "install") {
                return d("Installing browsers for Playwright");
            }
            d(if has(args, "--watch") {
                "Running tests in watch mode"
            } else {
                "Running tests"
            })
        }
        "tsc" | "vue-tsc" => d(if has(args, "--watch") || has(args, "-w") {
            "Type-checking in watch mode"
        } else {
            "Type-checking"
        }),
        "eslint" | "biome" | "oxlint" | "stylelint" | "ruff" | "flake8" | "pylint"
        | "golangci-lint" | "rubocop" | "shellcheck" | "standard" | "xo" => {
            if (cmd == "biome" || cmd == "ruff") && args.first().is_some_and(|a| a == "format") {
                return d("Formatting code");
            }
            d(if has(args, "--fix") {
                "Fixing lint issues"
            } else {
                "Linting"
            })
        }
        "prettier" | "black" | "isort" | "gofmt" | "rustfmt" | "dprint" | "clang-format" => {
            d(if has(args, "--check") || has(args, "-c") {
                "Checking formatting"
            } else {
                "Formatting code"
            })
        }
        "vite" | "next" | "nuxt" | "astro" | "webpack" | "rollup" | "esbuild" | "parcel"
        | "tsup" | "turbo" | "nx" | "svelte-kit" | "remix" => {
            let sub = args
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(String::as_str)
                .filter(|s| !s.is_empty());
            match sub {
                None | Some("dev" | "serve" | "start" | "preview") => {
                    d(if matches!(cmd, "esbuild" | "rollup" | "tsup") {
                        "Building the project"
                    } else {
                        "Starting the dev server"
                    })
                }
                Some(s @ ("lint" | "test" | "typecheck")) => Some(describe_target(s)),
                Some(_) => d("Building the project"),
            }
        }
        "mypy" | "pyright" => d("Type-checking"),
        "electron" => d("Starting the Electron app"),
        "electron-builder" | "electron-forge" => d("Packaging the app"),
        "serve" | "http-server" => d("Starting a local web server"),
        "prisma" | "drizzle-kit" => {
            let all = args.join(" ");
            d(if all.contains("migrate") || all.contains("push") {
                "Migrating the database"
            } else {
                "Generating the database client"
            })
        }
        _ if cmd.starts_with("create-") => d("Scaffolding a new project"),
        _ => None,
    }
}

/// `(a|b)(:|$)` at the start of `n`
fn starts(n: &str, names: &[&str]) -> bool {
    names.iter().any(|x| {
        n.strip_prefix(x)
            .is_some_and(|r| r.is_empty() || r.starts_with(':'))
    })
}

fn s(t: impl Into<String>) -> Desc {
    Desc::strong(t)
}

/// `make test`, `npm run lint`, `just build` …
pub(super) fn describe_target(t: &str) -> Desc {
    let n = ["npm:", "pnpm:", "yarn:", "bun:"]
        .iter()
        .find_map(|p| t.strip_prefix(p))
        .unwrap_or(t);
    if TEST_TARGET.is_match(n) {
        return s(if n == "test" || n == "tests" {
            "Running tests".into()
        } else {
            format!("Running tests ({n})")
        });
    }
    if starts(n, &["build", "compile", "bundle", "dist", "package"]) {
        return s("Building the project");
    }
    if starts(n, &["lint", "eslint"]) {
        return s(if n.contains("fix") {
            "Fixing lint issues"
        } else {
            "Linting"
        });
    }
    let table: [(&[&str], &str); 3] = [
        (&["format", "fmt", "prettier"], "Formatting code"),
        (
            &["typecheck", "type-check", "types", "tsc", "check-types"],
            "Type-checking",
        ),
        (&["dev", "start", "serve", "watch", "preview"], ""),
    ];
    for (names, text) in table {
        if starts(n, names) {
            return s(if !text.is_empty() {
                text
            } else if n == "start" {
                "Starting the app"
            } else {
                "Starting the dev server"
            });
        }
    }
    let rest: [(&[&str], &str); 6] = [
        (&["clean"], "Cleaning build output"),
        (
            &["install", "deps", "setup", "bootstrap"],
            "Setting up the project",
        ),
        (&["release", "publish", "deploy"], ""),
        (&["bench", "benchmark"], "Running benchmarks"),
        (&["e2e", "integration"], "Running end-to-end tests"),
        (&["doc", "docs"], "Building the docs"),
    ];
    for (names, text) in rest {
        if starts(n, names) {
            return s(if !text.is_empty() {
                text
            } else if n.starts_with("deploy") {
                "Deploying"
            } else {
                "Publishing a release"
            });
        }
    }
    s(format!("Running the {n} script"))
}

fn pm_fixed(sub: &str) -> Option<&'static str> {
    Some(match sub {
        "start" => "Starting the app",
        "publish" => "Publishing the package",
        "pack" => "Packing the package",
        "outdated" => "Checking for outdated dependencies",
        "audit" => "Auditing dependencies",
        "ls" | "list" | "why" | "explain" => "Inspecting dependencies",
        "init" | "create" => "Scaffolding a new project",
        "link" => "Linking a local package",
        "config" => "Checking npm settings",
        _ => return None,
    })
}

/// npm, pnpm, yarn and bun.
fn describe_package_manager(pm: &str, args: &[String], paths: &RunPaths) -> Option<Desc> {
    let Some((sub, more)) = strip_flags(args).split_first() else {
        return d(if pm == "yarn" {
            "Installing dependencies".into()
        } else {
            format!("Running {pm}")
        });
    };
    let sub = sub.as_str();
    match sub {
        "i" | "install" | "ci" | "add" => {
            let pkgs = operands(more);
            d(if pkgs.is_empty() {
                "Installing dependencies".into()
            } else {
                format!("Installing {}", clip(&pkgs.join(", "), 50))
            })
        }
        "un" | "uninstall" | "remove" | "rm" => {
            let list = operands(more).join(", ");
            d(format!(
                "Removing {}",
                if list.is_empty() {
                    "a dependency"
                } else {
                    &list
                }
            ))
        }
        "up" | "update" | "upgrade" => d("Updating dependencies"),
        "t" | "test" | "tst" => d("Running tests"),
        "run" | "run-script" => Some(
            more.first()
                .filter(|m| !m.is_empty())
                .map_or_else(|| Desc::strong("Listing scripts"), |m| describe_target(m)),
        ),
        "exec" | "dlx" | "x" => describe_tool(strip_flags(more), paths, true),
        "version" => d(more.first().filter(|m| !m.is_empty()).map_or_else(
            || "Bumping the version".into(),
            |m| format!("Bumping the version ({m})"),
        )),
        "view" | "info" | "show" => d(format!(
            "Looking up {} on the registry",
            more.first().map_or("a package", String::as_str)
        )),
        _ => {
            if let Some(f) = pm_fixed(sub) {
                return d(f);
            }
            if args.first().is_some_and(|a| a == "-v" || a == "--version") {
                return d(format!("Checking the {pm} version"));
            }
            // `yarn build`, `pnpm lint`, `bun dev`: a script name directly.
            if pm == "npm" {
                d(format!("Running npm {sub}"))
            } else {
                Some(describe_target(sub))
            }
        }
    }
}

fn describe_pip(args: &[String]) -> Desc {
    let stripped = strip_flags(args);
    let (sub, more) = stripped
        .split_first()
        .map_or((None, &[][..]), |(s, m)| (Some(s.as_str()), m));
    Desc::strong(match sub {
        Some("install") => {
            let ops = operands(more);
            if !ops.is_empty() && !has(more, "-r") {
                format!("Installing {}", clip(&ops.join(", "), 50))
            } else {
                "Installing Python packages".into()
            }
        }
        Some("uninstall") => "Removing Python packages".into(),
        Some("list" | "freeze" | "show") => "Checking installed Python packages".into(),
        _ => crate::js::trim(&format!("Running pip {}", sub.unwrap_or(""))).to_owned(),
    })
}

fn py_module(m: &str) -> Option<&'static str> {
    Some(match m {
        "pytest" | "unittest" => "Running tests",
        "venv" | "virtualenv" => "Creating a virtual environment",
        "http.server" => "Starting a local web server",
        "json.tool" => "Formatting JSON",
        _ => return None,
    })
}

fn describe_python(c: &Ctx) -> Option<Desc> {
    let args = c.args;
    match args.first().map(String::as_str) {
        Some("-c") => return d("Running a Python snippet"),
        Some("-m") => {
            let m = args.get(1)?;
            if let Some(f) = py_module(m) {
                return d(f);
            }
            if m == "pip" {
                return Some(describe_pip(&args[2..]));
            }
            // no cwd: v1 named modules as given
            return describe_tool(&args[1..], &RunPaths::default(), false);
        }
        _ => {}
    }
    if has(args, "--version") || has(args, "-V") {
        return d("Checking the Python version");
    }
    let kept: Vec<&String> = args.iter().filter(|a| !PY_FLAGS.is_match(a)).collect();
    let script = operands(&kept).first().copied();
    if let Some(s) = script.filter(|s| !s.is_empty() && *s != "-") {
        return d(format!("Running {}", c.f(s)));
    }
    d(match c.input {
        Some(i) if !i.is_empty() => format!("Running a Python script on {}", c.f(i)),
        _ => "Running a Python script".into(),
    })
}

fn describe_node(c: &Ctx) -> Desc {
    let args = c.args;
    if (c.cmd == "deno" && args.first().is_some_and(|a| a == "test")) || has(args, "--test") {
        return Desc::strong("Running tests");
    }
    if args
        .iter()
        .any(|a| matches!(a.as_str(), "-e" | "--eval" | "-p" | "--print"))
    {
        return Desc::strong("Running a Node snippet");
    }
    if has(args, "--version") || has(args, "-v") {
        return Desc::strong("Checking the Node version");
    }
    Desc::strong(
        operands(args)
            .first()
            .filter(|s| !s.is_empty())
            .map_or_else(
                || "Running a Node script".into(),
                |s| format!("Running {}", c.f(s)),
            ),
    )
}

fn describe_uv(args: &[String], paths: &RunPaths) -> Option<Desc> {
    match args.first().map(String::as_str) {
        Some("add" | "sync" | "install" | "lock") => d("Installing Python packages"),
        Some("pip") => Some(describe_pip(&args[1..])),
        Some("run") => describe_tool(strip_flags(&args[1..]), paths, false)
            .or_else(|| d("Running a Python script")),
        _ => None,
    }
}

fn cargo(sub: &str) -> Option<&'static str> {
    Some(match sub {
        "build" | "b" => "Building the project",
        "test" | "t" => "Running tests",
        "run" | "r" => "Running the program",
        "check" | "c" => "Checking the code compiles",
        "clippy" => "Linting",
        "fmt" => "Formatting code",
        "add" => "Adding a dependency",
        "install" => "Installing a crate",
        "bench" => "Running benchmarks",
        "doc" => "Building docs",
        _ => return None,
    })
}

fn go(args: &[String]) -> Option<&'static str> {
    Some(match args.first().map(String::as_str)? {
        "build" => "Building the project",
        "test" => "Running tests",
        "run" => "Running the program",
        "vet" => "Checking the code",
        "fmt" => "Formatting code",
        "get" => "Adding a dependency",
        "install" => "Installing a Go tool",
        "mod" if args.get(1).is_some_and(|a| a == "tidy") => "Tidying Go modules",
        "mod" => "Managing Go modules",
        "generate" => "Generating code",
        _ => return None,
    })
}

fn describe_docker(args: &[String]) -> Desc {
    let s = strip_flags(args);
    let (sub, action) = (s.first().map(String::as_str), s.get(1).map(String::as_str));
    if matches!(sub, Some("compose" | "docker-compose")) {
        let a = match action {
            Some("up") => "Starting containers",
            Some("down") => "Stopping containers",
            Some("build") => "Building containers",
            Some("logs") => "Reading container logs",
            Some("ps") => "Listing containers",
            Some("exec") => "Running a command in a container",
            _ => "Managing containers",
        };
        return Desc::strong(a);
    }
    Desc::strong(match sub {
        Some("build") => "Building a Docker image".into(),
        Some("run") => "Starting a container".into(),
        Some("ps") => "Listing containers".into(),
        Some("exec") => "Running a command in a container".into(),
        Some("logs") => "Reading container logs".into(),
        Some("pull") => "Pulling a Docker image".into(),
        Some("push") => "Pushing a Docker image".into(),
        Some("stop") => "Stopping a container".into(),
        Some("images") => "Listing Docker images".into(),
        other => crate::js::trim(&format!("Running docker {}", other.unwrap_or(""))).to_owned(),
    })
}

fn describe_brew(args: &[String]) -> Desc {
    let first = args.first().map_or("", String::as_str);
    if matches!(first, "install" | "upgrade" | "reinstall") {
        let list = operands(&args[1..]).join(", ");
        return Desc::strong(format!(
            "Installing {}",
            if list.is_empty() { "packages" } else { &list }
        ));
    }
    Desc::strong(if first == "list" {
        "Listing installed packages".into()
    } else {
        crate::js::trim(&format!("Running brew {first}")).to_owned()
    })
}

/// The tool commands' answer for `c`, or None when `c.cmd` isn't one of them.
pub(super) fn describe(c: &Ctx) -> Known {
    let a0 = c.args.first().map_or("", String::as_str);
    let trim = |s: String| crate::js::trim(&s).to_owned();
    match c.cmd {
        "git" => Some(Some(describe_git(c.args, c.paths))),
        "gh" => Some(Some(describe_gh(c.args))),
        "npm" | "pnpm" | "yarn" | "bun" => Some(describe_package_manager(c.cmd, c.args, c.paths)),
        "npx" | "bunx" | "pnpx" => Some(describe_tool(strip_flags(c.args), c.paths, true)),
        "node" | "deno" | "tsx" | "ts-node" => Some(Some(describe_node(c))),
        "python" | "python3" | "py" => Some(describe_python(c)),
        "uv" | "poetry" | "pipenv" => Some(describe_uv(c.args, c.paths)),
        "pip" | "pip3" => Some(Some(describe_pip(c.args))),
        "cargo" => {
            say(cargo(a0).map_or_else(|| trim(format!("Running cargo {a0}")), str::to_owned))
        }
        "go" => say(go(c.args).map_or_else(|| trim(format!("Running go {a0}")), str::to_owned)),
        "make" | "just" | "task" => Some(Some(
            operands(c.args)
                .first()
                .filter(|t| !t.is_empty())
                .map_or_else(
                    || Desc::strong(format!("Building with {}", c.cmd)),
                    |t| describe_target(t),
                ),
        )),
        "docker" | "podman" => Some(Some(describe_docker(c.args))),
        "brew" => Some(Some(describe_brew(c.args))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for r in [&AT_VERSION, &SCRIPT_PATH, &TEST_TARGET, &PY_FLAGS] {
            assert!(r.compiles(), "{}", r.pattern());
        }
    }
}
