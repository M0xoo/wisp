//! The TUI's colours: `@wisp/tokens`, generated into `tokens.rs` by `tools/gen-tui-theme.ts` (dark and light), a
//! high-contrast variant, and a 256-colour fallback mapped by nearest for terminals without true colour. A test
//! reads color.json, so the two can't drift apart.

use ratatui::style::{Color, Modifier, Style};

pub use crate::tokens::{Tokens, hex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Dark,
    Light,
    Contrast,
}

/// The tokens the TUI draws with (names as in color.json).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub mode: Mode,
    pub bg: Color,
    pub bg2: Color,
    pub rail: Color,
    pub panel: Color,
    pub surface: Color,
    pub ink: Color,
    pub ink2: Color,
    pub muted: Color,
    pub faint: Color,
    pub line: Color,
    pub line2: Color,
    pub accent: Color,
    pub accent_ink: Color,
    pub accent_soft: Color,
    pub on_accent: Color,
    pub good: Color,
    pub warn: Color,
    pub bad: Color,
    pub info: Color,
    pub add: Color,
    pub del: Color,
    pub add_bg: Color,
    pub del_bg: Color,
    pub term_bg: Color,
    pub term_ink: Color,
    /// syntax: keyword, string, comment, number, type
    pub tk: [Color; 5],
}

impl Theme {
    pub const fn from_tokens(mode: Mode, t: &Tokens) -> Self {
        Self {
            mode,
            bg: t.bg,
            bg2: t.bg_2,
            rail: t.rail,
            panel: t.panel,
            surface: t.surface,
            ink: t.ink,
            ink2: t.ink_2,
            muted: t.muted,
            faint: t.faint,
            line: t.line,
            line2: t.line_2,
            accent: t.accent,
            accent_ink: t.accent_ink,
            accent_soft: t.accent_soft,
            on_accent: t.on_accent,
            good: t.good,
            warn: t.warn,
            bad: t.bad,
            info: t.info,
            add: t.add,
            del: t.del,
            add_bg: t.add_bg,
            del_bg: t.del_bg,
            term_bg: t.term_bg,
            term_ink: t.term_ink,
            tk: [t.tk_k, t.tk_s, t.tk_c, t.tk_n, t.tk_t],
        }
    }

    pub const DARK: Self = Self::from_tokens(Mode::Dark, &crate::tokens::DARK);
    pub const LIGHT: Self = Self::from_tokens(Mode::Light, &crate::tokens::LIGHT);

    /// Dark with the text at full strength and the lines lifted: for low vision and bright rooms.
    pub const CONTRAST: Self = Self {
        mode: Mode::Contrast,
        ink: hex(0xff_ffff),
        ink2: hex(0xff_ffff),
        muted: hex(0xd4_d4d4),
        faint: hex(0xbd_bdbd),
        line: hex(0x8a_8a8a),
        line2: hex(0xbd_bdbd),
        bg: hex(0x00_0000),
        ..Self::DARK
    };

    pub fn of(mode: Mode) -> Self {
        match mode {
            Mode::Dark => Self::DARK,
            Mode::Light => Self::LIGHT,
            Mode::Contrast => Self::CONTRAST,
        }
    }

    /// Every colour as the nearest of the 256 (a terminal without true colour: no `COLORTERM=truecolor`).
    #[must_use]
    pub fn indexed(mut self) -> Self {
        let f = to_256;
        for c in [
            &mut self.bg,
            &mut self.bg2,
            &mut self.rail,
            &mut self.panel,
            &mut self.surface,
            &mut self.accent_soft,
            &mut self.add_bg,
            &mut self.del_bg,
            &mut self.term_bg,
            &mut self.term_ink,
            &mut self.ink,
            &mut self.ink2,
            &mut self.muted,
            &mut self.faint,
            &mut self.line,
            &mut self.line2,
            &mut self.accent,
            &mut self.accent_ink,
            &mut self.on_accent,
            &mut self.good,
            &mut self.warn,
            &mut self.bad,
            &mut self.info,
            &mut self.add,
            &mut self.del,
        ] {
            *c = f(*c);
        }
        for c in &mut self.tk {
            *c = f(*c);
        }
        self
    }

    /// Every colour as the nearest of the 16 ANSI ones (`WISP_TUI_COLOR=16`); the page's own background stays
    /// the terminal's, so the near-black and near-white surfaces don't turn into grey slabs.
    #[must_use]
    pub fn basic(mut self) -> Self {
        let f = to_16;
        for c in [
            &mut self.ink,
            &mut self.ink2,
            &mut self.muted,
            &mut self.faint,
            &mut self.line,
            &mut self.line2,
            &mut self.accent,
            &mut self.accent_ink,
            &mut self.on_accent,
            &mut self.good,
            &mut self.warn,
            &mut self.bad,
            &mut self.info,
            &mut self.add,
            &mut self.del,
            &mut self.term_ink,
        ] {
            *c = f(*c);
        }
        for c in &mut self.tk {
            *c = f(*c);
        }
        for c in [
            &mut self.bg,
            &mut self.rail,
            &mut self.panel,
            &mut self.surface,
            &mut self.term_bg,
            &mut self.add_bg,
            &mut self.del_bg,
            &mut self.accent_soft,
        ] {
            *c = Color::Reset;
        }
        self.bg2 = if self.mode == Mode::Light { Color::Gray } else { Color::Black };
        self
    }

    pub fn text(&self) -> Style {
        Style::default().fg(self.ink)
    }
    pub fn dim(&self) -> Style {
        Style::default().fg(self.muted)
    }
    pub fn faint(&self) -> Style {
        Style::default().fg(self.faint)
    }
    pub fn strong(&self) -> Style {
        Style::default().fg(self.ink).add_modifier(Modifier::BOLD)
    }
    pub fn accent(&self) -> Style {
        Style::default().fg(self.accent_ink)
    }
    pub fn selected(&self) -> Style {
        Style::default().bg(self.bg2).fg(self.ink).add_modifier(Modifier::BOLD)
    }
    pub fn border(&self, focused: bool) -> Style {
        Style::default().fg(if focused { self.accent } else { self.line2 })
    }
    /// A task state's colour (running, waiting, review, done, error).
    pub fn state(&self, state: &str) -> Style {
        Style::default().fg(match state {
            "running" => self.accent,
            "waiting" | "asking" => self.warn,
            "review" => self.info,
            "done" => self.good,
            "error" => self.bad,
            _ => self.muted,
        })
    }
}

/// The nearest xterm-256 colour: the 6×6×6 cube or the grey ramp, whichever is closer.
#[allow(clippy::many_single_char_names)] // r g b, and the cube's indices
pub fn to_256(c: Color) -> Color {
    let Color::Rgb(r, g, b) = c else { return c };
    let cube = |v: u8| -> (u8, u8) {
        let steps = [0u8, 95, 135, 175, 215, 255];
        let (i, s) = steps.iter().enumerate().min_by_key(|(_, s)| (i32::from(**s) - i32::from(v)).abs()).unwrap_or((0, &0));
        (u8::try_from(i).unwrap_or(0), *s)
    };
    let ((ri, rv), (gi, gv), (bi, bv)) = (cube(r), cube(g), cube(b));
    let d = |a: (u8, u8, u8)| {
        (i32::from(a.0) - i32::from(r)).pow(2) + (i32::from(a.1) - i32::from(g)).pow(2) + (i32::from(a.2) - i32::from(b)).pow(2)
    };
    let cube_d = d((rv, gv, bv));
    let avg = (u16::from(r) + u16::from(g) + u16::from(b)) / 3;
    let gi2 = u8::try_from(((avg.saturating_sub(8)) / 10).min(23)).unwrap_or(23);
    let gv2 = 8 + 10 * gi2;
    let grey_d = d((gv2, gv2, gv2));
    if grey_d < cube_d { Color::Indexed(232 + gi2) } else { Color::Indexed(16 + 36 * ri + 6 * gi + bi) }
}

/// Which theme: `WISP_THEME` (dark, light, contrast), else light on a light terminal (`COLORFGBG`), else dark; indexed when the terminal says no true colour.
pub fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Theme {
    let mode = match get("WISP_THEME").as_deref() {
        Some("light") => Mode::Light,
        Some("contrast" | "high-contrast") => Mode::Contrast,
        Some("dark") => Mode::Dark,
        // no choice made: a terminal that says its background is light (`COLORFGBG=0;15`) gets the light theme
        _ if get("COLORFGBG").and_then(|v| v.rsplit(';').next().map(str::to_owned)).is_some_and(|bg| matches!(bg.as_str(), "7" | "15")) => {
            Mode::Light
        }
        _ => Mode::Dark,
    };
    let t = Theme::of(mode);
    match depth(get) {
        Depth::True => t,
        Depth::C256 => t.indexed(),
        Depth::C16 => t.basic(),
    }
}

/// How many colours the terminal draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    True,
    C256,
    C16,
}

/// `WISP_TUI_COLOR=truecolor|256|16` when set; else Apple's Terminal.app (`TERM_PROGRAM=Apple_Terminal`) gets 256
/// whatever `COLORTERM` says (it shows 24-bit colour as grey: the owner's washed-out TUI, 2026-11-09); else true
/// colour when `COLORTERM` says so; else 256.
pub fn depth(get: &dyn Fn(&str) -> Option<String>) -> Depth {
    match get("WISP_TUI_COLOR").as_deref().map(str::trim) {
        Some("truecolor" | "24bit" | "true") => return Depth::True,
        Some("256") => return Depth::C256,
        Some("16") => return Depth::C16,
        _ => {}
    }
    if get("TERM_PROGRAM").as_deref() == Some("Apple_Terminal") {
        return Depth::C256;
    }
    if get("COLORTERM").is_some_and(|c| c.contains("truecolor") || c.contains("24bit")) { Depth::True } else { Depth::C256 }
}

/// The 16 ANSI colours, as xterm draws them, nearest first by distance.
const ANSI16: [(Color, (u8, u8, u8)); 16] = [
    (Color::Black, (0, 0, 0)),
    (Color::Red, (205, 0, 0)),
    (Color::Green, (0, 205, 0)),
    (Color::Yellow, (205, 205, 0)),
    (Color::Blue, (0, 0, 238)),
    (Color::Magenta, (205, 0, 205)),
    (Color::Cyan, (0, 205, 205)),
    (Color::Gray, (229, 229, 229)),
    (Color::DarkGray, (127, 127, 127)),
    (Color::LightRed, (255, 0, 0)),
    (Color::LightGreen, (0, 255, 0)),
    (Color::LightYellow, (255, 255, 0)),
    (Color::LightBlue, (92, 92, 255)),
    (Color::LightMagenta, (255, 0, 255)),
    (Color::LightCyan, (0, 255, 255)),
    (Color::White, (255, 255, 255)),
];

/// The nearest of the 16 ANSI colours.
#[allow(clippy::many_single_char_names)] // r g b
pub fn to_16(c: Color) -> Color {
    let Color::Rgb(r, g, b) = c else { return c };
    let d = |x: (u8, u8, u8)| {
        (i32::from(x.0) - i32::from(r)).pow(2) + (i32::from(x.1) - i32::from(g)).pow(2) + (i32::from(x.2) - i32::from(b)).pow(2)
    };
    // a colour keeps its hue (a red stays red, not the nearest grey); a grey stays grey
    let grey = |x: &Color| matches!(x, Color::Black | Color::DarkGray | Color::Gray | Color::White);
    let chroma = r.max(g).max(b) - r.min(g).min(b);
    ANSI16.iter().filter(|(x, _)| grey(x) == (chroma < 48)).min_by_key(|(_, rgb)| d(*rgb)).map_or(c, |(c, _)| *c)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    /// A token's value as the generator computes it: hex, or rgba composited over the theme's bg.
    fn token(json: &serde_json::Value, group: &str, name: &str, mode: &str) -> Option<Color> {
        let parse = |v: &str, over: (u8, u8, u8)| -> Color {
            if let Some(h) = v.strip_prefix('#') {
                return hex(u32::from_str_radix(h, 16).unwrap());
            }
            let nums: Vec<f64> = v
                .trim_start_matches("rgba(")
                .trim_start_matches("rgb(")
                .trim_end_matches(')')
                .split(',')
                .map(|x| x.trim().parse().unwrap())
                .collect();
            let a = nums.get(3).copied().unwrap_or(1.0);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let mix = |c: f64, o: u8| (c * a + f64::from(o) * (1.0 - a)).round() as u8;
            Color::Rgb(mix(nums[0], over.0), mix(nums[1], over.1), mix(nums[2], over.2))
        };
        let Color::Rgb(r, g, b) = parse(json["surface"]["bg"][mode].as_str()?, (0, 0, 0)) else { return None };
        Some(parse(json[group][name][mode].as_str()?, (r, g, b)))
    }

    #[test]
    fn the_theme_is_wisps_tokens() {
        let j: serde_json::Value = serde_json::from_str(include_str!("../../../../packages/tokens/tokens/color.json")).unwrap();
        for (t, m) in [(crate::tokens::DARK, "dark"), (crate::tokens::LIGHT, "light")] {
            let pairs = t.pairs();
            assert!(pairs.len() > 40, "every token is generated");
            for (name, have) in pairs {
                let group = j
                    .as_object()
                    .unwrap()
                    .iter()
                    .find(|(_, g)| g.get(name).is_some())
                    .map_or_else(|| panic!("{name} is no longer a token: node tools/gen-tui-theme.ts"), |(g, _)| g.clone());
                assert_eq!(Some(have), token(&j, &group, name, m), "{m} {name}: node tools/gen-tui-theme.ts");
            }
        }
        assert_eq!(Theme::DARK.ink, crate::tokens::DARK.ink);
    }

    /// Terminal.app shows 24-bit colour as grey: it gets 256 even when the shell sets `COLORTERM=truecolor`;
    /// `WISP_TUI_COLOR` overrides either way.
    #[test]
    fn apple_terminal_gets_256_colours_even_with_colorterm_truecolor() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
        };
        let apple = env(&[("TERM_PROGRAM", "Apple_Terminal"), ("COLORTERM", "truecolor")]);
        assert_eq!(depth(&apple), Depth::C256);
        assert!(matches!(from_env(&apple).ink, Color::Indexed(_)));
        assert_eq!(depth(&env(&[("TERM_PROGRAM", "iTerm.app"), ("COLORTERM", "truecolor")])), Depth::True);
        assert_eq!(depth(&env(&[("TERM_PROGRAM", "Apple_Terminal"), ("WISP_TUI_COLOR", "truecolor")])), Depth::True, "the override wins");
        assert_eq!(depth(&env(&[("COLORTERM", "truecolor"), ("WISP_TUI_COLOR", "256")])), Depth::C256);
        let sixteen = from_env(&env(&[("WISP_TUI_COLOR", "16")]));
        assert!(!matches!(sixteen.ink, Color::Rgb(..) | Color::Indexed(_)) && sixteen.bg == Color::Reset, "{sixteen:?}");
        assert_eq!(to_16(hex(0xff_6369)), Color::LightRed);
    }

    #[test]
    fn without_true_colour_every_colour_is_one_of_256() {
        let t = from_env(&|k| (k == "WISP_THEME").then(|| "light".to_owned()));
        assert_eq!(t.mode, Mode::Light);
        assert!(matches!(t.ink, Color::Indexed(_)) && matches!(t.accent, Color::Indexed(_)));
        assert_eq!(to_256(hex(0xff_ffff)), Color::Indexed(231));
        assert_eq!(to_256(hex(0x00_0000)), Color::Indexed(16));
        let tc = from_env(&|k| (k == "COLORTERM").then(|| "truecolor".to_owned()));
        assert_eq!(tc, Theme::DARK);
    }
}
