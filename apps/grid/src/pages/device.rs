//! Connecting a device (`/activate`: type the code, then Allow), and the plain pages: a message
//! (`Nothing here`, `Device connected`, errors) and the one shown while a sleeping wisp wakes.

use super::layout::{AppPage, app_page};
use super::{PageCfg, PageUser, Tone, esc};
use crate::http::encode_component;

/// Opens the Android app (its intent filter in mobile/android/…/AndroidManifest.xml).
pub const APP_URL: &str = "dev.trywisp.mobile://signed-in";

/// The device asking to be let in.
#[derive(Debug, Clone, Default)]
pub struct DeviceAsk {
    pub name: String,
    pub user_code: String,
}

#[derive(Debug, Clone, Default)]
pub struct ActivatePage {
    pub code: String,
    /// the code matched a device that's waiting
    pub device: Option<DeviceAsk>,
    /// from the Android app: Allow sends it back there
    pub app: bool,
    pub csrf: String,
    pub error: String,
}

pub fn activate_page(cfg: &PageCfg, user: &PageUser, p: &ActivatePage) -> String {
    let app = if p.app { r#"<input type="hidden" name="app" value="android">"# } else { "" };
    let csrf = esc(&p.csrf);
    let body = match &p.device {
        None => {
            let error = if p.error.is_empty() { String::new() } else { format!(r#"<div class="flash bad">{}</div>"#, esc(&p.error)) };
            format!(
                r#"<h1 class="h1">Connect a device</h1><p class="sub">Type the code wisp shows on your computer or phone.</p>{error}
        <form method="get" action="/activate" style="margin-top:20px;display:flex;flex-direction:column;gap:10px"><input class="input" name="code" value="{}" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" autofocus required>{app}
        <button class="primary tall">Continue</button></form>"#,
                esc(&p.code)
            )
        }
        Some(d) => {
            let back = format!("/activate?code={}{}", d.user_code, if p.app { "&app=android" } else { "" });
            format!(
                r#"<h1 class="h1">Let this device in?</h1>
      <p class="sub"><b>{name}</b> asks to use your wisp as <b>{handle}</b>. Allow it only if you just started this on your own computer or phone, and the code matches.</p>
      <div class="code">{code}</div>
      <form method="post" action="/activate" style="display:flex;gap:10px">
        <input type="hidden" name="csrf" value="{csrf}"><input type="hidden" name="code" value="{code}">{app}
        <button class="ghost line tall" style="flex:1;justify-content:center" name="answer" value="deny">Don’t allow</button>
        <button class="primary tall" style="flex:1" name="answer" value="allow">Allow</button>
      </form>
      <form method="post" action="/signout?return={ret}" style="margin-top:16px;text-align:center">
        <input type="hidden" name="csrf" value="{csrf}"><span class="sub">Not {handle}?</span> <button class="ghost">Use another account</button>
      </form>"#,
                name = esc(&d.name),
                handle = esc(&user.handle),
                code = esc(&d.user_code),
                ret = encode_component(&back),
            )
        }
    };
    app_page(&AppPage { user: Some(user), csrf: &p.csrf, narrow: true, ..AppPage::new(cfg, "Connect a device", &body) })
}

/// A page that says one thing, with a link onwards.
#[derive(Debug, Clone, Default)]
pub struct MessagePage {
    pub title: String,
    pub text: String,
    /// (href, label)
    pub link: Option<(String, String)>,
    pub tone: Tone,
}

pub fn message_page(cfg: &PageCfg, p: &MessagePage) -> String {
    let text = if p.tone == Tone::Plain {
        format!(r#"<p class="sub">{}</p>"#, esc(&p.text))
    } else {
        format!(r#"<div class="flash {}">{}</div>"#, p.tone.class(), esc(&p.text))
    };
    let link = p.link.as_ref().map_or_else(String::new, |(href, label)| {
        format!(r#"<p style="margin-top:20px"><a class="primary tall" href="{}">{}</a></p>"#, esc(href), esc(label))
    });
    let body = format!(r#"<h1 class="h1">{}</h1>{text}{link}"#, esc(&p.title));
    app_page(&AppPage { narrow: true, ..AppPage::new(cfg, &p.title, &body) })
}

/// A published app's address with nothing behind it (v1 server.js:1322).
pub fn site_not_found(cfg: &PageCfg) -> String {
    message_page(
        cfg,
        &MessagePage {
            title: "Nothing here".into(),
            text: "This app was unpublished, or its link has a typo.".into(),
            link: Some((cfg.public_url.clone(), "Home".into())),
            tone: Tone::Plain,
        },
    )
}

/// Shown at `<handle>.<domain>` while its wisp starts; reloads itself once it answers.
pub fn waking_page(cfg: &PageCfg, user: &PageUser) -> String {
    let body = format!(
        r#"<div class="center" style="padding-top:48px"><div class="orb"></div><h1 class="h1">Waking your wisp</h1><p class="sub" id="msg">{}’s computer was asleep. A few seconds.</p></div>
      <script>(async function poll(n){{try{{const r=await fetch('/_grid/state',{{cache:'no-store'}});const j=await r.json();if(j.state==='running')return location.reload();const m=document.getElementById('msg');if(j.error)m.textContent=j.error;else if(j.state==='queued')m.textContent='The grid is busy right now. You’re next in line: it opens as soon as there’s room.';}}catch{{}}setTimeout(()=>poll(n+1),n<20?700:2000)}})(0)</script>"#,
        esc(&user.handle)
    );
    app_page(&AppPage { narrow: true, ..AppPage::new(cfg, "Waking up", &body) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PageCfg {
        PageCfg { name: "wisp Grid".into(), domain: "grid.test".into(), public_url: "https://grid.test".into() }
    }

    #[test]
    fn a_code_to_type_then_allow() {
        let u = PageUser { handle: "ada".into(), ..PageUser::default() };
        let ask = activate_page(&cfg(), &u, &ActivatePage { code: "<x>".into(), ..ActivatePage::default() });
        assert!(ask.contains("Type the code wisp shows"));
        assert!(ask.contains(r#"value="&#60;x&#62;""#));
        let allow = activate_page(
            &cfg(),
            &u,
            &ActivatePage {
                device: Some(DeviceAsk { name: "Pixel".into(), user_code: "ABCD-EFGH".into() }),
                app: true,
                csrf: "t".into(),
                ..ActivatePage::default()
            },
        );
        assert!(allow.contains("<b>Pixel</b> asks to use your wisp as <b>ada</b>"));
        assert!(allow.contains("/signout?return=%2Factivate%3Fcode%3DABCD-EFGH%26app%3Dandroid"));
    }

    #[test]
    fn a_bad_message_is_a_flash() {
        let p = message_page(
            &cfg(),
            &MessagePage { title: "Slow down".into(), text: "Too many".into(), link: Some(("/".into(), "Back".into())), tone: Tone::Bad },
        );
        assert!(p.contains(r#"<div class="flash bad">Too many</div>"#));
        assert!(p.contains(r#"<a class="primary tall" href="/">Back</a>"#));
        assert!(site_not_found(&cfg()).contains("This app was unpublished"));
        assert!(waking_page(&cfg(), &PageUser { handle: "ada".into(), ..PageUser::default() }).contains("ada’s computer was asleep"));
    }
}
