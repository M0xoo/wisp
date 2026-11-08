//! "Add a cloud machine": one cloud wisp per account for now, so adding opens the waitlist for
//! more, bigger and GPU machines (v1 `grid/accounts.js` `MACHINE_WANTS`), and says when you're on it.

use std::fmt::Write as _;

use super::icons::{CHECK, CHEV, CLOUD, PLUS, X, named};
use super::{PageUser, esc};

/// What the grid's box gives and what this account asked for next.
#[derive(Debug, Clone, Default)]
pub struct MachineView {
    /// hostd's `container.cpus`.
    pub cpus: Option<f64>,
    /// hostd's `container.memory` (`4g`, `512m`, `2147483648`).
    pub memory: Option<String>,
    pub wish: Option<Wish>,
}

/// On the waitlist for these (`more`, `bigger`, `gpu`), with a note.
#[derive(Debug, Clone, Default)]
pub struct Wish {
    pub wants: Vec<String>,
    pub note: Option<String>,
}

/// key, icon, name, short name, what it is, and how a sentence says it.
const WANTS: [(&str, &str, &str, &str, &str, &str); 3] = [
    ("more", "stack", "More machines", "More", "Several cloud wisps side by side: one per project, or one per teammate.", "more machines"),
    ("bigger", "bolt", "A bigger machine", "Bigger", "More CPU and memory, for big repos, long builds and full test suites.", "a bigger machine"),
    ("gpu", "gpu", "GPUs", "GPU", "Run local models, fine-tune, or let your agents use CUDA.", "GPUs"),
];

fn icon(name: &str) -> &'static str {
    named(name).unwrap_or_default()
}

/// "a, b and c"
fn and(xs: &[&str]) -> String {
    match xs {
        [] => String::new(),
        [one] => (*one).to_string(),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    }
}

pub(super) fn wish_line<S: AsRef<str>>(wants: &[S]) -> String {
    if wants.is_empty() {
        return "One comes with your account for now. More machines, bigger ones and GPUs are on the way.".into();
    }
    let has = |k: &str| wants.iter().any(|w| w.as_ref() == k);
    let said: Vec<&str> = WANTS.iter().filter(|w| has(w.0)).map(|w| w.5).collect();
    format!("On the waitlist for {}. We’ll write when it’s ready.", and(&said))
}

/// hostd's memory (`4g`, `512m`, `1.5g`, bytes) as `4 GB`, one decimal at most; empty if unreadable.
pub(super) fn size(m: Option<&str>) -> String {
    let m = m.unwrap_or_default();
    let lower = m.to_ascii_lowercase();
    let s = lower.strip_suffix('b').unwrap_or(&lower);
    let (num, div) = match s.char_indices().last() {
        Some((i, 'k')) => (&s[..i], 1_048_576.0),
        Some((i, 'm')) => (&s[..i], 1024.0),
        Some((i, 'g')) => (&s[..i], 1.0),
        _ => (s, 1_073_741_824.0),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let ok = match num.split_once('.') {
        Some((a, b)) => digits(a) && digits(b),
        None => digits(num),
    };
    let Some(n) = num.parse::<f64>().ok().filter(|_| ok) else {
        return String::new();
    };
    let gb = ((n / div) * 10.0 + 0.5).floor() / 10.0;
    format!("{gb} GB")
}

/// `2 vCPU · 4 GB · sleeps when idle`, with `memory_word` after the size in the dialog.
pub(super) fn spec(m: &MachineView, memory_word: bool) -> String {
    let mut parts = Vec::new();
    if let Some(c) = m.cpus.filter(|c| *c != 0.0) {
        parts.push(format!("{c} vCPU"));
    }
    let gb = size(m.memory.as_deref());
    if !gb.is_empty() {
        parts.push(if memory_word { format!("{gb} memory") } else { gb });
    }
    parts.push("sleeps when idle".into());
    parts.join(" · ")
}

/// The cloud section's last row.
pub(super) fn add_machine_row(wish: Option<&Wish>) -> String {
    let wants: &[String] = wish.map_or(&[], |w| &w.wants);
    let pill = if wish.is_some() { format!(r#"<span class="pill listed">{CHECK}On the list</span>"#) } else { r#"<span class="pill soon">Soon</span>"#.into() };
    format!(
        r#"<button type="button" class="w add-m" data-open="machines" aria-haspopup="dialog">
      <span class="w-ic">{PLUS}</span>
      <div class="w-tx"><b>Add a cloud machine</b><small>{}</small></div>
      {pill}<span class="chev">{CHEV}</span>
    </button>"#,
        esc(&wish_line(wants))
    )
}

pub(super) fn machines_dialog(machine: &MachineView, user: &PageUser, hidden: &str) -> String {
    let wish = machine.wish.as_ref();
    let has = |k: &str| wish.is_some_and(|w| w.wants.iter().any(|x| x == k));
    let slots: String = WANTS.iter().map(|(k, ic, _, short, ..)| format!(r#"<div class="slot{}" data-slot="{k}">{}{short}</div>"#, if has(k) { " on" } else { "" }, icon(ic))).collect();
    let opts: String = WANTS
        .iter()
        .map(|(k, ic, name, _, text, _)| {
            let checked = if has(k) { " checked" } else { "" };
            format!(r#"<label class="m-opt"><input type="checkbox" name="want_{k}" value="1"{checked}><span class="m-card"><span class="w-ic">{}</span><div><b>{name}</b><small>{text}</small></div><span class="m-tick">{CHECK}</span></span></label>"#, icon(ic))
        })
        .collect();
    let chips: String = WANTS.iter().filter(|w| has(w.0)).map(|(_, ic, name, ..)| format!("<span>{}{name}</span>", icon(ic))).collect();
    let note = esc(wish.and_then(|w| w.note.as_deref()).unwrap_or_default());
    let to = user.email.as_deref().filter(|e| !e.is_empty()).map(|e| format!(" to <b>{}</b>", esc(e))).unwrap_or_default();
    let (state, other, go_attr, go) = if wish.is_some() {
        ("done", r#"<button type="button" class="ghost danger" data-leave>Leave the list</button>"#, "", "Save")
    } else {
        ("pick", r#"<button type="button" class="ghost" data-close>Not now</button>"#, " disabled", "Join the waitlist")
    };
    format!(
        r#"<dialog class="mdlg" id="machines" aria-labelledby="mTitle" data-state="{state}">
    <form method="post" action="/machines/waitlist" id="mForm">{hidden}
    <button class="m-x" type="button" data-close aria-label="Close">{X}</button>
    <div class="m-hero" aria-hidden="true"><div class="rack">
      <div class="slot mine">{CLOUD}Yours</div>
      {slots}
    </div></div>
    <div class="m-body">
      <div class="m-pick">
        <p class="m-kicker">wisp Cloud · coming soon</p>
        <h2 id="mTitle">One cloud machine per account, for now</h2>
        <p class="m-sub">Your account comes with one cloud wisp. More machines, bigger ones and GPUs are on the way. Pick what you’d use and you’ll be among the first to get it.</p>
        <div class="m-have"><span class="w-ic cloud">{CLOUD}</span><div><b>Your cloud wisp</b><small>{spec}</small></div><span class="pill ok">Included</span></div>
        <fieldset class="m-opts"><legend>What would you use?</legend>
          {opts}
        </fieldset>
        <label class="m-note"><span>What would you run on it? <i>Optional</i></span><textarea name="note" rows="2" maxlength="500" placeholder="A monorepo build, a 70B model, three projects at once…">{note}</textarea></label>
        <div class="m-foot">{other}<button class="primary" type="submit" data-go{go_attr}>{go}</button></div>
      </div>
      <div class="m-done" aria-live="polite">
        <div class="m-ok">{CHECK}</div>
        <h2>You’re on the list</h2>
        <p class="m-sub">We’ll write{to} as soon as it’s ready. Your cloud wisp keeps working as it is meanwhile.</p>
        <div class="m-chips" data-chips>{chips}</div>
        <div class="m-foot"><button type="button" class="ghost line" data-change>Change</button><button type="button" class="primary" data-close>Done</button></div>
      </div>
    </div>
    </form>
  </dialog>"#,
        spec = esc(&spec(machine, true)),
    )
}

fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// Opens and runs the dialog, also from a link (#machines; #machines/bigger ticks that one, as a
/// cloud wisp that ran out of memory links it). Joining shows at once (the row too) and rolls back
/// with a toast if the grid says no; the live sync then brings the row from the server, the same.
pub(super) fn machines_js() -> String {
    let w: Vec<String> = WANTS.iter().map(|(k, _, name, ..)| format!("[{},{}]", js(k), js(name))).collect();
    let mut text = String::new();
    for set in [&[][..], &["more"], &["bigger"], &["gpu"], &["more", "bigger"], &["more", "gpu"], &["bigger", "gpu"], &["more", "bigger", "gpu"]] {
        let _ = write!(text, "{}{}:{}", if text.is_empty() { "" } else { "," }, js(&set.join(",")), js(&wish_line(set)));
    }
    let icons: Vec<String> = WANTS.iter().map(|(k, ic, ..)| format!("{k}:{}", js(icon(ic)))).collect();
    format!(
        "{}\nconst W=[{}],TEXT={{{text}}},ICONS={{{}}};\n{}{}{}",
        MACHINES_JS_HEAD,
        w.join(","),
        icons.join(","),
        MACHINES_JS_MID,
        js(CHECK),
        MACHINES_JS_TAIL
    )
}

const MACHINES_JS_HEAD: &str = "<script>(()=>{const d=document.getElementById('machines'),f=document.getElementById('mForm');if(!d)return;";
const MACHINES_JS_MID: &str = r"const boxes=[...f.querySelectorAll('input[type=checkbox]')],go=f.querySelector('[data-go]');
const picked=()=>boxes.filter((b)=>b.checked).map((b)=>b.name.slice(5));
const paint=()=>{const p=picked();go.disabled=!p.length;for(const s of d.querySelectorAll('[data-slot]'))s.classList.toggle('on',p.includes(s.dataset.slot))};
const chips=(p)=>{d.querySelector('[data-chips]').innerHTML=W.filter(([k])=>p.includes(k)).map(([k,n])=>'<span>'+ICONS[k]+n+'</span>').join('')};
const toast=(t)=>{const n=document.createElement('div');n.className='toast bad';n.setAttribute('role','alert');n.textContent=t;document.body.append(n);setTimeout(()=>n.remove(),4500)};
const row=()=>document.querySelector('[data-open=machines]');
const rowFor=(p)=>{const r=row();if(!r)return;
r.querySelector('small').textContent=TEXT[p.join(',')]||TEXT[''];
const pill=r.querySelector('.pill');pill.className='pill '+(p.length?'listed':'soon');pill.innerHTML=p.length?";
const MACHINES_JS_TAIL: &str = r"+'On the list':'Soon'};
const send=async(wants)=>{const before={state:d.dataset.state,html:row()?.outerHTML};
if(wants.length){chips(wants);d.dataset.fresh='';d.dataset.state='done'}else d.close();rowFor(wants);
try{const r=await fetch('/machines/waitlist',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({csrf:f.csrf.value,wants,note:f.note.value})});
if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'The grid didn’t take it. Try again.')}
catch(e){d.dataset.state=before.state;if(before.html)row()?.replaceWith(Object.assign(document.createElement('div'),{innerHTML:before.html}).firstElementChild);toast(e.message||'You’re offline. Try again.')}};
document.addEventListener('click',(e)=>{if(e.target.closest('[data-open=machines]')){delete d.dataset.fresh;d.showModal()}});
d.addEventListener('click',(e)=>{if(e.target===d||e.target.closest('[data-close]'))d.close();else if(e.target.closest('[data-change]'))d.dataset.state='pick';else if(e.target.closest('[data-leave]')){boxes.forEach((b)=>b.checked=false);paint();send([])}});
f.addEventListener('change',paint);f.addEventListener('submit',(e)=>{e.preventDefault();const p=picked();if(p.length)send(p)});
const link=()=>{const h=/^#machines(?:[/](more|bigger|gpu))?$/.exec(location.hash);if(!h)return;history.replaceState(null,'',location.pathname+location.search);const b=h[1]&&f.querySelector('[name=want_'+h[1]+']');if(b&&!b.checked){b.checked=true;d.dataset.state='pick';paint()}if(!d.open)d.showModal()};
paint();link();addEventListener('hashchange',link)})()</script>";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wish_line_names_what_you_are_waiting_for_in_v1s_order() {
        assert_eq!(wish_line::<&str>(&[]), "One comes with your account for now. More machines, bigger ones and GPUs are on the way.");
        assert_eq!(wish_line(&["gpu", "bigger"]), "On the waitlist for a bigger machine and GPUs. We’ll write when it’s ready.");
        assert_eq!(wish_line(&["gpu", "more", "bigger"]), "On the waitlist for more machines, a bigger machine and GPUs. We’ll write when it’s ready.");
    }

    #[test]
    fn memory_reads_in_gb_like_v1() {
        assert_eq!(size(Some("4g")), "4 GB");
        assert_eq!(size(Some("4GB")), "4 GB");
        assert_eq!(size(Some("1536m")), "1.5 GB");
        assert_eq!(size(Some("2147483648")), "2 GB");
        assert_eq!(size(Some("1048576k")), "1 GB");
        assert_eq!(size(Some("lots")), "");
        assert_eq!(size(Some("")), "");
        assert_eq!(size(None), "");
        assert_eq!(size(Some(".5g")), "");
    }
}
