//! Pure helpers for the web bundle: content types, content-hashed names, and index.html's two forms
//! (the build named in it, and the phone's boot page whose modules wait for the service worker).

pub fn mime(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        // iOS reads the home-screen manifest by this URL when it's added: unversioned, no-cache
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn is_text(ext: &str) -> bool {
    matches!(
        ext,
        "html" | "js" | "mjs" | "css" | "svg" | "json" | "map" | "md" | "webmanifest" | "txt"
    )
}

/// A bundler's content hash in a file name (`index-B3x9_aQz.js`): `/[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/`.
pub fn hashed(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if ext.is_empty()
        || !ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return false;
    }
    // the tail after the first separator that leaves no '.' behind it is the longest candidate
    let from = stem.rfind('.').unwrap_or(0);
    let Some(sep) = stem[from..].find(['.', '-']).map(|i| i + from) else {
        return false;
    };
    let tail = &stem[sep + 1..];
    tail.len() >= 8
        && tail
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The value of attribute `name` inside one tag's text.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let at = tag.find(&key)? + key.len();
    let end = tag[at..].find('"')? + at;
    Some(&tag[at..end])
}

/// Every `<script type="module" … src>…</script>` and `<link rel="modulepreload" … href>`: (whole tag, url).
type Tags = Vec<(String, String)>;

fn module_tags(html: &str) -> (Tags, Tags) {
    let mut scripts = Vec::new();
    let mut at = 0;
    while let Some(i) = html[at..].find("<script type=\"module\"").map(|i| i + at) {
        let Some(end) = html[i..]
            .find("</script>")
            .map(|e| e + i + "</script>".len())
        else {
            break;
        };
        let tag = &html[i..end];
        if let Some(src) = attr(tag, "src") {
            scripts.push((tag.to_owned(), src.to_owned()));
        }
        at = end;
    }
    let mut preloads = Vec::new();
    at = 0;
    while let Some(i) = html[at..]
        .find("<link rel=\"modulepreload\"")
        .map(|i| i + at)
    {
        let Some(end) = html[i..].find('>').map(|e| e + i + 1) else {
            break;
        };
        let tag = &html[i..end];
        if let Some(href) = attr(tag, "href") {
            preloads.push((tag.to_owned(), href.to_owned()));
        }
        at = end;
    }
    (scripts, preloads)
}

const BOOT: &str = r"(function () {
    var urls = PRELOADS, sw = navigator.serviceWorker, went = false;
    var go = function () {
      if (went) return;
      went = true;
      urls.forEach(function (u, i) {
        var e = document.createElement(i === urls.length - 1 ? 'script' : 'link');
        if (i === urls.length - 1) { e.type = 'module'; e.src = u; } else { e.rel = 'modulepreload'; e.href = u; }
        document.head.append(e);
      });
    };
    if (!sw || sw.controller) return go();
    sw.addEventListener('controllerchange', go);
    sw.register('/sw.js').then(function (r) {
      var w = r.installing || r.waiting;
      if (w) w.addEventListener('statechange', function () { if (w.state === 'redundant') go(); });
      else if (!sw.controller) go();
    }, go);
    setTimeout(go, 180000);
  })();";

/// index.html with the build named (meta wisp-build), and its boot twin for the phone's first open:
/// the module scripts and preloads removed, put back by a script once the service worker controls the
/// page (it fetches every module in one request: /_pack).
pub fn pages(src: &str, build: &str) -> (String, String) {
    let html = src.replacen(
        "</head>",
        &format!("  <meta name=\"wisp-build\" content=\"{build}\">\n</head>"),
        1,
    );
    let (scripts, preloads) = module_tags(&html);
    let urls: Vec<&str> = preloads
        .iter()
        .chain(scripts.iter())
        .map(|(_, u)| u.as_str())
        .collect();
    let mut boot = html.clone();
    for (tag, _) in scripts.iter().chain(preloads.iter()) {
        boot = boot.replacen(tag.as_str(), "", 1);
    }
    let list = serde_json::to_string(&urls).unwrap_or_else(|_| "[]".into());
    boot = boot.replacen(
        "</head>",
        &format!(
            "  <script>{}</script>\n</head>",
            BOOT.replace("PRELOADS", &list)
        ),
        1,
    );
    (html, boot)
}

/// The phone's first open: the app (UA `wispMobile`) without its service worker yet (no `x-wisp-sw`).
pub fn wants_boot(user_agent: Option<&str>, has_sw: bool) -> bool {
    !has_sw
        && user_agent.is_some_and(|ua| {
            ua.split(|c: char| !c.is_ascii_alphanumeric())
                .any(|w| w == "wispMobile")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_names() {
        for yes in [
            "index-B3x9_aQz.js",
            "chunk.Abc12345.css",
            "a-b-c-dEf_1-2345.js",
            "x.12345678.woff2",
        ] {
            assert!(hashed(yes), "{yes}");
        }
        for no in [
            "index.js",
            "app-1234567.js",
            "sw.js",
            "manifest.webmanifest",
            "logo.PNG",
            "foo-bar-baz.js",
            "noext",
        ] {
            assert!(!hashed(no), "{no}");
        }
    }

    #[test]
    fn boot_page_waits_for_the_worker() {
        let src = r#"<html><head><link rel="modulepreload" href="/assets/a-12345678.js"><script type="module" crossorigin src="/assets/index-ABCDEFGH.js"></script></head><body></body></html>"#;
        let (html, boot) = pages(src, "b123");
        assert!(html.contains(r#"<meta name="wisp-build" content="b123">"#));
        assert!(html.contains(r#"src="/assets/index-ABCDEFGH.js""#));
        assert!(!boot.contains(r#"<script type="module""#));
        assert!(!boot.contains("modulepreload\" href"));
        assert!(
            boot.contains(r#"var urls = ["/assets/a-12345678.js","/assets/index-ABCDEFGH.js"]"#)
        );
        assert!(boot.contains("wisp-build"));
    }

    #[test]
    fn boot_only_for_the_app_without_its_worker() {
        assert!(wants_boot(
            Some("Mozilla/5.0 (Linux; Android 14) wispMobile/2.0"),
            false
        ));
        assert!(!wants_boot(
            Some("Mozilla/5.0 (Linux; Android 14) wispMobile/2.0"),
            true
        ));
        assert!(!wants_boot(Some("Mozilla/5.0 Chrome"), false));
        assert!(!wants_boot(Some("notwispMobileX"), false));
        assert!(!wants_boot(None, false));
    }
}
