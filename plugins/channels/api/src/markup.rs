//! A channel's own markup, gone before the grammar reads a message (v1 grammar.js `stripFormatting`): Telegram's
//! `/new@bot` and `@bot`, Slack's `<…>` and entities, Discord's `<@id>` and `<https://…>`. Pure; in the api so a
//! transport strips its own messages.

/// Which channel's markup to take off (`bot`: its own id or name, said to address it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Markup {
    Plain,
    Telegram,
    Slack,
    Discord,
}

fn after_address(t: &str, mark: &str) -> Option<String> {
    let rest = t.strip_prefix(mark)?;
    if rest.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some(rest.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':').trim().to_owned())
}

/// Slack writes a bare example.com as a link labelled example.com; a label that says something else keeps its
/// URL, so nothing is hidden from the agent.
fn slack_link(url: &str, label: Option<&str>) -> String {
    let bare = url.strip_prefix("mailto:").unwrap_or(url);
    match label {
        None | Some("") => bare.to_owned(),
        Some(l) if l == url || l == bare || Some(l) == url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) => l.to_owned(),
        Some(l) => format!("{l} ({url})"),
    }
}

/// Slack's `<…>`: links, channels, @here and the like.
fn slack_angles(t: &str, bot: &str) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('>') else { break };
        let inner = &rest[i + 1..i + j];
        let (head, label) = inner.split_once('|').map_or((inner, None), |(h, l)| (h, Some(l)));
        let after = &rest[i + j + 1..];
        if !bot.is_empty() && head.strip_prefix('@') == Some(bot) {
            rest = after.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':');
            continue;
        }
        if head.starts_with("http://") || head.starts_with("https://") || head.starts_with("mailto:") {
            out.push_str(&slack_link(head, label));
        } else if let Some(id) = head.strip_prefix('#') {
            out.push('#');
            out.push_str(label.filter(|l| !l.is_empty()).unwrap_or(id));
        } else if let Some(what) = head.strip_prefix('!') {
            let what = what.split(['^', ' ']).next().unwrap_or(what);
            out.push_str(&label.filter(|l| !l.is_empty()).map_or_else(|| format!("@{what}"), str::to_owned));
        } else {
            out.push_str(&rest[i..=i + j]);
        }
        rest = after;
    }
    out.push_str(rest);
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").trim().to_owned()
}

/// A channel's own markup, gone before the grammar reads it. Text stays as written otherwise: an agent should
/// see what you sent, and `__init__.py` isn't bold.
pub fn strip_formatting(text: &str, kind: Markup, bot: &str) -> String {
    let mut t: String = text.replace("\r\n", "\n").chars().filter(|c| !matches!(c, '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}')).map(|c| if c == '\u{a0}' { ' ' } else { c }).collect::<String>().trim().to_owned();
    let bot_word: String = bot.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    match kind {
        Markup::Telegram => {
            // /new@wispbot
            if t.starts_with('/')
                && let Some(at) = t.find('@').filter(|&at| t[1..at].chars().all(|c| c.is_alphanumeric() || c == '_') && at > 1)
            {
                let end = t[at + 1..].find(|c: char| !(c.is_alphanumeric() || c == '_')).map_or(t.len(), |e| at + 1 + e);
                t = format!("{}{}", &t[..at], &t[end..]);
            }
            if !bot_word.is_empty() {
                let lower_t = t.to_lowercase();
                let mark = format!("@{}", bot_word.to_lowercase());
                if let Some(rest) = after_address(&lower_t, &mark) {
                    let kept = t[t.len() - rest.len()..].trim().to_owned();
                    t = kept;
                }
            }
        }
        Markup::Slack => t = slack_angles(&t, &bot_word),
        Markup::Discord => {
            let digits: String = bot.chars().filter(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                for mark in [format!("<@{digits}>"), format!("<@!{digits}>")] {
                    while let Some(i) = t.find(&mark) {
                        let after = t[i + mark.len()..].trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':').to_owned();
                        let joined = format!("{}{after}", &t[..i]);
                        joined.trim().clone_into(&mut t);
                    }
                }
            }
            // <https://…>: the brackets only turn its preview off
            let mut out = String::new();
            let mut rest = t.as_str();
            while let Some(i) = rest.find("<http") {
                out.push_str(&rest[..i]);
                match rest[i..].find('>') {
                    Some(j) if !rest[i + 1..i + j].contains(char::is_whitespace) => {
                        out.push_str(&rest[i + 1..i + j]);
                        rest = &rest[i + j + 1..];
                    }
                    _ => {
                        out.push('<');
                        rest = &rest[i + 1..];
                    }
                }
            }
            out.push_str(rest);
            t = out;
        }
        Markup::Plain => {}
    }
    t
}
