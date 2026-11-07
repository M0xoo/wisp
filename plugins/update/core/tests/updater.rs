//! v1 test/update.test.js, the parts that are decisions: channels, install methods, what to run, the
//! relaunch hand-off and the app's release pick. The IO parts are in wisp-update's tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests may fail loudly
use serde_json::{Value, json};
use wisp_update_core::app::sha256_hex;
use wisp_update_core::{
    Env, Install, InstallStep, Method, Platform, Refusal, Status, Swap, Updater, asset_name,
    cargo_clone, detect, installed_version,
};

const CURRENT: &str = "2.0.0";
const KEG_BIN: &str = "/opt/homebrew/Cellar/wisp-agents/2.0.0/libexec/lib/node_modules/wisp-agents/node_modules/@wisp/core-darwin-arm64/bin/wisp";

fn mac() -> Platform {
    Platform::new("darwin", "arm64")
}

fn global() -> Install {
    detect(
        "/usr/local/lib/node_modules/wisp-agents/node_modules/@wisp/core-darwin-arm64/bin/wisp",
        &mac(),
        None,
        false,
        None,
    )
}

fn updater(install: Install, env: Env) -> Updater {
    Updater::new(install, mac(), CURRENT, 1, env)
}

fn check(u: &mut Updater, pref: &str, body: &Value) -> wisp_update_core::View {
    let req = u.begin_check(0, pref);
    u.end_check(&req, Some(body));
    u.view(pref)
}

#[test]
fn npm_installs_follow_their_channel_and_the_newest_wins() {
    let dist = json!({ "latest": "2.0.1", "next": "2.1.0-beta.1", "nightly": "2.1.0-nightly.20261024.317" });
    for (channel, latest, tag) in [
        ("stable", "2.0.1", "latest"),
        ("beta", "2.1.0-beta.1", "next"),
        ("nightly", "2.1.0-nightly.20261024.317", "nightly"),
        ("bogus", "2.0.1", "latest"),
    ] {
        let mut u = updater(global(), Env::default());
        let v = check(&mut u, channel, &dist);
        assert_eq!(v.latest.as_deref(), Some(latest), "{channel}");
        assert_eq!(
            v.channel,
            if channel == "bogus" {
                "stable"
            } else {
                channel
            }
        );
        assert_eq!(
            v.command.as_deref(),
            Some(format!("npm install -g wisp-agents@{tag}").as_str())
        );
        assert!(v.available);
    }
    // A stable release newer than the last beta: beta takes it, from latest.
    let mut u = updater(global(), Env::default());
    assert_eq!(
        check(
            &mut u,
            "beta",
            &json!({ "latest": "2.1.0", "next": "2.1.0-beta.3" })
        )
        .latest
        .as_deref(),
        Some("2.1.0")
    );
    assert_eq!(
        u.command().as_deref(),
        Some("npm install -g wisp-agents@latest")
    );
    u.install.method = Method::Npx;
    assert!(
        u.relaunch_command(false)
            .starts_with("npx -y wisp-agents@latest ")
    );
}

#[test]
fn the_registry_is_asked_and_a_failed_fetch_changes_nothing() {
    let mut u = updater(global(), Env::default());
    let req = u.begin_check(0, "stable");
    assert_eq!(
        req.url,
        "https://registry.npmjs.org/-/package/wisp-agents/dist-tags"
    );
    assert_eq!(req.accept, "application/json");
    assert!(!u.end_check(&req, None));
    assert_eq!(u.view("stable").latest, None);
    assert!(!u.available);
}

#[test]
fn homebrew_stays_on_stable_whatever_the_channel_says() {
    let mut u = updater(detect(KEG_BIN, &mac(), None, false, None), Env::default());
    let v = check(
        &mut u,
        "nightly",
        &json!({ "latest": "2.0.1", "nightly": "99.0.0-nightly.1" }),
    );
    assert_eq!(v.channel, "stable");
    assert_eq!(v.latest.as_deref(), Some("2.0.1"));
}

#[test]
fn install_method_tells_a_clone_npx_a_keg_an_app_and_a_global_install_apart() {
    let p = mac();
    assert_eq!(
        detect(
            "/home/u/.npm/_npx/abc123/node_modules/@wisp/core-linux-x64/bin/wisp",
            &p,
            None,
            false,
            None
        )
        .method,
        Method::Npx
    );
    let keg = detect(KEG_BIN, &p, None, false, None);
    assert_eq!(keg.method, Method::Brew);
    assert_eq!(keg.brew.as_deref(), Some("/opt/homebrew"));
    assert_eq!(
        detect(
            "/home/linuxbrew/.linuxbrew/Cellar/wisp-agents/2.0.0/bin/wisp",
            &p,
            None,
            false,
            None
        )
        .brew
        .as_deref(),
        Some("/home/linuxbrew/.linuxbrew")
    );
    let g = global();
    assert_eq!(g.method, Method::Global);
    assert_eq!(
        g.root, "/usr/local/lib/node_modules/wisp-agents",
        "hoisted or nested, the launcher's folder"
    );
    assert_eq!(
        detect(
            "/usr/local/lib/node_modules/@wisp/core-darwin-arm64/bin/wisp",
            &p,
            None,
            false,
            None
        )
        .root,
        "/usr/local/lib/node_modules/wisp-agents"
    );
    assert_eq!(
        cargo_clone("/Users/me/wisp/target/release/wisp").as_deref(),
        Some("/Users/me/wisp")
    );
    assert_eq!(cargo_clone("/usr/local/bin/wisp"), None);
    assert_eq!(
        detect(
            "/Users/me/wisp/target/release/wisp",
            &p,
            None,
            false,
            Some("/Users/me/wisp")
        )
        .method,
        Method::Git
    );
    let app = detect(
        "/Applications/wisp.app/Contents/MacOS/wisp",
        &p,
        None,
        true,
        None,
    );
    assert_eq!(
        (app.method, app.root.as_str()),
        (Method::App, "/Applications/wisp.app")
    );
    let image = detect(
        "/tmp/.mount_wispAb12/usr/bin/wisp",
        &Platform::new("linux", "x64"),
        Some("/home/u/wisp.AppImage"),
        true,
        None,
    );
    assert_eq!(
        (image.method, image.root.as_str()),
        (Method::App, "/home/u/wisp.AppImage")
    );
    let win = detect(
        "C:\\Users\\u\\AppData\\Local\\Programs\\wisp\\wisp.exe",
        &Platform::new("win32", "x64"),
        None,
        true,
        None,
    );
    assert_eq!(
        (win.method, win.root.as_str()),
        (Method::App, "C:\\Users\\u\\AppData\\Local\\Programs\\wisp")
    );
}

#[test]
fn a_git_clone_never_offers_an_update() {
    let mut u = updater(
        Install {
            method: Method::Git,
            root: "/src/wisp".into(),
            brew: None,
        },
        Env::default(),
    );
    assert!(!u.enabled);
    let v = check(&mut u, "stable", &json!({ "latest": "99.0.0" }));
    assert!(!v.available);
    assert_eq!(v.command, None);
    assert!(
        serde_json::to_value(&v).is_ok_and(|j| j.get("command").is_none()),
        "v1 left the key out"
    );
    assert!(matches!(u.begin_install(), Err(Refusal::Invalid(m)) if m.contains("git clone")));
}

#[test]
fn opt_outs_turn_the_check_off() {
    for env in [
        Env {
            update_check: Some("0".into()),
            ..Env::default()
        },
        Env {
            update_check: Some("off".into()),
            ..Env::default()
        },
        Env {
            ci: Some("true".into()),
            ..Env::default()
        },
        Env {
            ci: Some("0".into()),
            ..Env::default()
        },
    ] {
        assert!(!updater(global(), env).enabled);
    }
    assert!(
        updater(
            global(),
            Env {
                update_check: Some("1".into()),
                ci: Some(String::new()),
                ..Env::default()
            }
        )
        .enabled
    );
}

#[test]
fn due_at_most_once_a_day_on_the_wall_clock() {
    let mut u = updater(global(), Env::default());
    let t = 1_000_000;
    assert!(u.due(t));
    u.begin_check(t, "stable");
    assert!(!u.due(t + 23 * 3_600_000));
    assert!(u.due(t + 24 * 3_600_000));
}

#[test]
fn relaunch_keeps_the_port_wisp_is_serving_on() {
    let mut u = Updater::new(global(), mac(), CURRENT, 5123, Env::default());
    for m in [Method::Global, Method::Npx] {
        u.install.method = m;
        assert!(
            u.relaunch_command(false)
                .ends_with(" --browser --no-open --port 5123")
        );
        let d = u.relaunch_command(true);
        assert!(
            d.ends_with("wisp-agents@latest --port 5123") || d.ends_with("wisp.js\" --port 5123"),
            "{d}"
        );
    }
    u.install.method = Method::Global;
    u.env.node = Some("/usr/local/bin/node".into());
    assert_eq!(
        u.relaunch_command(true),
        "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/wisp-agents/bin/wisp.js\" --port 5123"
    );
    u.env.desktop = Some("tauri".into());
    u.env.ppid = 77;
    assert!(
        u.relaunch_command(true).starts_with(
            "for i in $(seq 100); do kill -0 77 2>/dev/null || break; sleep 0.1; done; "
        )
    );
}

#[test]
fn homebrew_upgrades_through_brew_and_relaunches_from_opt() {
    let u = Updater::new(
        detect(KEG_BIN, &mac(), None, false, None),
        mac(),
        CURRENT,
        5123,
        Env::default(),
    );
    assert_eq!(
        u.command().as_deref(),
        Some("\"/opt/homebrew/bin/brew\" upgrade m0xoo/tap/wisp-agents")
    );
    assert!(u.relaunch_command(false).ends_with("\"/opt/homebrew/opt/wisp-agents/libexec/lib/node_modules/wisp-agents/bin/wisp.js\" --browser --no-open --port 5123"));
}

#[test]
fn install_runs_the_command_and_refuses_to_relaunch_the_same_version() {
    let mut brew = Updater::new(
        detect(KEG_BIN, &mac(), None, false, None),
        mac(),
        CURRENT,
        1,
        Env::default(),
    );
    brew.latest = Some("99.0.0".into());
    let step = brew.begin_install();
    assert_eq!(
        step,
        Ok(InstallStep::Run {
            cmd: "\"/opt/homebrew/bin/brew\" upgrade m0xoo/tap/wisp-agents".into(),
            env: vec![("HOMEBREW_NO_INSTALL_CLEANUP".into(), "1".into())]
        })
    );
    assert_eq!(brew.status, Status::Installing);
    assert!(matches!(brew.begin_install(), Err(Refusal::Conflict(m)) if m == "Already updating."));
    let why = brew.check_installed(Some(CURRENT)).unwrap_err();
    assert_eq!(
        why,
        "Homebrew doesn't have wisp 99.0.0 yet. Try again later."
    );
    brew.install_failed(&why);
    assert_eq!(
        (brew.status, brew.error.as_deref()),
        (Status::Idle, Some(why.as_str()))
    );
    let g = updater(global(), Env::default());
    assert_eq!(
        g.check_installed(Some(CURRENT)).unwrap_err(),
        "npm installed wisp somewhere else: this copy is still 2.0.0."
    );
    assert_eq!(
        g.check_installed(None).unwrap_err(),
        "npm installed wisp somewhere else: this copy is still 2.0.0."
    );
    assert!(g.check_installed(Some("2.0.1")).is_ok());
    let mut npx = updater(global(), Env::default());
    npx.install.method = Method::Npx;
    assert_eq!(npx.begin_install(), Ok(InstallStep::Nothing));
    npx.install_done();
    assert_eq!(npx.view("stable").status, Status::Restarting);
}

#[test]
fn run_failures_say_what_failed_and_hint_at_permissions() {
    let m = wisp_update_core::run_failed(
        "npm install -g wisp-agents@latest",
        "a\nb\nnpm error EACCES: permission denied\nlast\n",
    );
    assert_eq!(
        m,
        "`npm install -g wisp-agents@latest` failed (permission denied — run it yourself, maybe with sudo): b npm error EACCES: permission denied last"
    );
    assert_eq!(
        wisp_update_core::run_failed("x", "boom"),
        "`x` failed: boom"
    );
}

fn app(os: &str, arch: &str, exe: &str, image: Option<&str>) -> Updater {
    let p = Platform::new(os, arch);
    let env = Env {
        appimage: image.map(str::to_owned),
        ..Env::default()
    };
    Updater::new(detect(exe, &p, image, true, None), p, CURRENT, 1, env)
}

#[test]
fn the_app_checks_github_releases_and_picks_its_download() {
    let assets: Vec<Value> = [
        "wisp-mac-arm64.zip",
        "wisp-mac-x64.zip",
        "wisp-windows-x64-setup.exe",
        "wisp-linux-arm64.AppImage",
    ]
    .iter()
    .map(|n| json!({ "name": n, "browser_download_url": format!("https://dl/{n}") }))
    .collect();
    let rel = json!({ "tag_name": "v99.0.0", "assets": assets });
    for (os, arch, exe, image, want) in [
        (
            "darwin",
            "arm64",
            "/Applications/wisp.app/Contents/MacOS/wisp",
            None,
            Some("wisp-mac-arm64.zip"),
        ),
        (
            "win32",
            "x64",
            "C:\\Programs\\wisp\\wisp.exe",
            None,
            Some("wisp-windows-x64-setup.exe"),
        ),
        (
            "linux",
            "arm64",
            "/tmp/.mount_x/usr/bin/wisp",
            Some("/home/u/wisp.AppImage"),
            Some("wisp-linux-arm64.AppImage"),
        ),
        ("linux", "x64", "/usr/lib/wisp/wisp", None, None), // a .deb: no automatic update
    ] {
        let mut u = app(os, arch, exe, image);
        let req = u.begin_check(0, "stable");
        assert_eq!(
            req.url,
            "https://api.github.com/repos/M0xoo/wisp/releases/latest"
        );
        assert_eq!(req.accept, "application/vnd.github+json");
        u.end_check(&req, Some(&rel));
        let v = u.view("stable");
        assert_eq!(
            (v.method, v.latest.as_deref(), v.available),
            ("app", Some("99.0.0"), true)
        );
        assert_eq!(
            v.command.as_deref(),
            Some("https://github.com/M0xoo/wisp/releases/latest")
        );
        assert_eq!(u.asset.as_ref().map(|a| a.name.as_str()), want);
        assert_eq!(asset_name(&u.platform, image).as_deref(), want);
    }
}

#[test]
fn the_app_on_beta_or_nightly_picks_the_newest_release_its_channel_allows() {
    let asset = |v: &str| json!([{ "name": "wisp-mac-arm64.zip", "browser_download_url": format!("https://dl/{v}/wisp-mac-arm64.zip") }]);
    let list = json!([
        { "tag_name": "nightly", "name": "wisp 99.1.0-nightly.20261024.317", "prerelease": true, "html_url": "https://github.com/M0xoo/wisp/releases/tag/nightly", "assets": asset("nightly") },
        { "tag_name": "v99.1.0-beta.1", "name": "v99.1.0-beta.1", "prerelease": true, "html_url": "https://github.com/M0xoo/wisp/releases/tag/v99.1.0-beta.1", "assets": asset("beta") },
        { "tag_name": "v99.2.0-beta.1", "draft": true, "prerelease": true, "assets": asset("draft") },
        { "tag_name": "v99.0.0", "prerelease": false, "html_url": "https://github.com/M0xoo/wisp/releases/tag/v99.0.0", "assets": asset("stable") },
    ]);
    for (channel, latest, from) in [
        ("beta", "99.1.0-beta.1", "beta"),
        ("nightly", "99.1.0-nightly.20261024.317", "nightly"),
    ] {
        let mut u = app(
            "darwin",
            "arm64",
            "/Applications/wisp.app/Contents/MacOS/wisp",
            None,
        );
        let req = u.begin_check(0, channel);
        assert_eq!(
            req.url,
            "https://api.github.com/repos/M0xoo/wisp/releases?per_page=30"
        );
        u.end_check(&req, Some(&list));
        let v = u.view(channel);
        assert_eq!(v.latest.as_deref(), Some(latest), "{channel}");
        assert_eq!(
            u.asset.as_ref().map(|a| a.url.clone()),
            Some(format!("https://dl/{from}/wisp-mac-arm64.zip"))
        );
        assert_eq!(v.command, u.release.clone());
        assert!(v.command.as_deref().is_some_and(|c| c.contains(from)));
    }
}

#[test]
fn app_downloads_are_checked_against_the_release_sha256() {
    let u = app(
        "linux",
        "x64",
        "/tmp/.mount_x/usr/bin/wisp",
        Some("/home/u/wisp.AppImage"),
    );
    let body = b"new build";
    let good = wisp_update_core::Asset {
        name: "wisp-linux-x64.AppImage".into(),
        url: "https://dl/x".into(),
        digest: Some(format!("sha256:{}", sha256_hex(body))),
    };
    assert!(u.verify_download(&good, body).is_ok());
    let bad = wisp_update_core::Asset {
        digest: Some(format!("sha256:{}", "0".repeat(64))),
        ..good.clone()
    };
    assert!(
        u.verify_download(&bad, body)
            .unwrap_err()
            .contains("didn't match the release's checksum")
    );
    assert!(
        u.verify_download(
            &wisp_update_core::Asset {
                digest: None,
                ..good
            },
            body
        )
        .is_ok(),
        "no digest: nothing to check"
    );
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn the_app_relaunches_through_the_installer_on_windows_and_open_on_macos() {
    let mut win = app("win32", "x64", "C:\\Programs\\wisp\\wisp.exe", None);
    win.swap = Some(Swap::Windows {
        installer: "C:\\Temp\\wisp-update-1\\wisp-windows-x64-setup.exe".into(),
    });
    assert_eq!(
        win.relaunch_command(true),
        "\"C:\\Temp\\wisp-update-1\\wisp-windows-x64-setup.exe\" /S /R"
    );
    let mut mac = app(
        "darwin",
        "arm64",
        "/Applications/wisp.app/Contents/MacOS/wisp",
        None,
    );
    mac.swap = Some(Swap::Mac {
        open: "/Applications/wisp.app".into(),
        remove: "/tmp/wisp-update-1/old.app".into(),
    });
    assert_eq!(
        mac.relaunch_command(true),
        "rm -rf \"/tmp/wisp-update-1/old.app\"; open \"/Applications/wisp.app\""
    );
    let mut linux = app(
        "linux",
        "x64",
        "/tmp/.mount_x/usr/bin/wisp",
        Some("/home/u/wisp.AppImage"),
    );
    linux.swap = Some(Swap::Linux {
        open: "/home/u/wisp.AppImage".into(),
    });
    assert_eq!(
        linux.relaunch_command(true),
        "\"/home/u/wisp.AppImage\" >/dev/null 2>&1"
    );
}

#[test]
fn an_app_with_no_download_for_it_says_where_to_get_the_new_version() {
    let mut u = app("linux", "x64", "/usr/lib/wisp/wisp", None);
    let req = u.begin_check(0, "stable");
    u.end_check(&req, Some(&json!({ "tag_name": "v99.0.0", "assets": [] })));
    let Err(Refusal::Invalid(m)) = u.begin_install() else {
        panic!("must refuse")
    };
    assert!(
        m.contains("no automatic update") && m.ends_with("releases/latest"),
        "{m}"
    );
    assert_eq!(u.status, Status::Idle);
    assert_eq!(u.error.as_deref(), Some(m.as_str()));
}

#[test]
fn installed_version_reads_a_package_json() {
    assert_eq!(
        installed_version(r#"{"name":"wisp-agents","version":"2.0.1"}"#).as_deref(),
        Some("2.0.1")
    );
    assert_eq!(installed_version("not json"), None);
}
