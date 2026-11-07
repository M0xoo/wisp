//! v1 test/install.test.js, the installer's decisions (the IO half is in wisp-update's tests).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests may fail loudly
use wisp_update_core::harness::{
    installable, installed_but_broken, not_installable, npm_args, npm_failed, npm_missing, tail,
};

#[test]
fn only_opencode_can_be_installed() {
    assert_eq!(installable("opencode").map(|i| i.pkg), Some("opencode-ai"));
    assert!(installable("claude").is_none());
    assert_eq!(
        not_installable("claude"),
        "wisp can’t install claude. Install it yourself, then re-check."
    );
}

#[test]
fn npm_install_prefix_args() {
    let a = npm_args("opencode-ai", "/home/u/.wisp/tools");
    assert_eq!(&a[..3], ["install", "--prefix", "/home/u/.wisp/tools"]);
    assert_eq!(a.last().map(String::as_str), Some("opencode-ai@latest"));
    assert!(a.contains(&"--no-audit".to_owned()) && a.contains(&"--loglevel=error".to_owned()));
}

#[test]
fn npm_failures_carry_npms_own_words() {
    assert_eq!(
        npm_failed(
            "opencode-ai",
            false,
            "npm error code E404\nnpm error 404 Not Found\n"
        ),
        "npm install opencode-ai failed: npm error code E404 npm error 404 Not Found"
    );
    assert_eq!(
        npm_failed("opencode-ai", true, ""),
        "npm install opencode-ai timed out"
    );
    assert!(npm_missing().contains("npm isn’t on PATH"));
    assert_eq!(
        installed_but_broken("opencode", None),
        "opencode was installed but doesn’t start: unknown error"
    );
    assert_eq!(tail("héllo", 4), "llo");
}
