//! In-app browsers (v1 `grid/in-app.js`): X, Instagram, Facebook and friends open links in their own
//! web view. Google refuses to sign anyone in there (403 `disallowed_useragent`) and nobody is signed in
//! to GitHub in it, so the sign-in page offers the phone's real browser instead. trywisp.dev's
//! `docs/main.js` has the same list: keep the two in step.

use crate::http::encode_component;

/// The phone an in-app browser runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Ios,
    Android,
    Other,
}

/// An app's own browser: which app, on which phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InApp {
    /// "X", "Instagram", … or "this app" for any other Android web view.
    pub app: &'static str,
    pub os: Os,
}

/// Each app and the words its user agent carries (v1's regexes are plain alternations).
const APPS: &[(&str, &[&str])] = &[
    ("X", &["Twitter for iPhone", "Twitter for iPad", "TwitterAndroid"]),
    ("Instagram", &["Instagram"]),
    ("Facebook", &["FBAN", "FBAV", "FB_IAB", "FBIOS"]),
    ("LinkedIn", &["LinkedInApp"]),
    ("Threads", &["Barcelona"]),
    ("TikTok", &["BytedanceWebview", "musical_ly", "TikTok"]),
    ("Snapchat", &["Snapchat"]),
];

/// The in-app browser a user agent belongs to, or `None` for a real browser.
pub fn in_app_browser(ua: &str) -> Option<InApp> {
    let os = if ["iPhone", "iPad", "iPod"].iter().any(|w| ua.contains(w)) {
        Os::Ios
    } else if ua.contains("Android") {
        Os::Android
    } else {
        Os::Other
    };
    if let Some((app, _)) = APPS.iter().find(|(_, words)| words.iter().any(|w| ua.contains(w))) {
        return Some(InApp { app, os });
    }
    // Any other Android app's web view says "; wv)".
    (os == Os::Android && ua.contains("; wv)")).then_some(InApp { app: "this app", os })
}

/// A link that leaves the app for the phone's browser: Chrome on Android (an intent, falling back
/// to the page itself), Safari on iOS 17+ (`x-safari-https://`). Elsewhere, the page as it is.
pub fn open_outside(url: &str, os: Os) -> String {
    match os {
        Os::Android => {
            let Ok(u) = url::Url::parse(url) else {
                return url.to_string();
            };
            let host = match (u.host_str(), u.port()) {
                (Some(h), Some(p)) => format!("{h}:{p}"),
                (Some(h), None) => h.to_string(),
                _ => String::new(),
            };
            let search = u.query().map(|q| format!("?{q}")).unwrap_or_default();
            format!(
                "intent://{host}{}{search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url={};end",
                u.path(),
                encode_component(url)
            )
        }
        Os::Ios => format!("x-safari-{url}"),
        Os::Other => url.to_string(),
    }
}

/// The browser `open_outside` goes to.
pub fn browser_name(os: Os) -> &'static str {
    match os {
        Os::Android => "Chrome",
        Os::Ios => "Safari",
        Os::Other => "your browser",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const X_IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24A446 Twitter for iPhone/12.36";
    const X_ANDROID: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 TwitterAndroid";

    // v1 test/grid.test.js: "in-app browsers: X, Instagram, Facebook… are spotted; Safari, Chrome and
    // desktop are not"
    #[test]
    fn in_app_browsers_x_instagram_facebook_are_spotted_safari_chrome_and_desktop_are_not() {
        let hit = |app, os| Some(InApp { app, os });
        assert_eq!(in_app_browser(X_IPHONE), hit("X", Os::Ios));
        assert_eq!(in_app_browser(X_ANDROID), hit("X", Os::Android));
        assert_eq!(
            in_app_browser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/22A3354 Instagram 350.0"),
            hit("Instagram", Os::Ios)
        );
        assert_eq!(in_app_browser("Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]"), hit("Facebook", Os::Ios));
        assert_eq!(
            in_app_browser("Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"),
            hit("this app", Os::Android)
        );
        for real in [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
            "",
        ] {
            assert_eq!(in_app_browser(real), None, "{real}");
        }
        assert_eq!(
            open_outside("https://grid.example.com/signin?return=%2F", Os::Ios),
            "x-safari-https://grid.example.com/signin?return=%2F"
        );
        assert_eq!(
            open_outside("https://grid.example.com/", Os::Android),
            "intent://grid.example.com/#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fgrid.example.com%2F;end"
        );
    }
}
