//! Update channels (Settings → General → Updates, v1 `defaults.updateChannel`). Each follows npm dist-tags;
//! the newest of them wins, so a beta or nightly gives way to the stable release that follows it. The
//! rolling GitHub release `nightly` goes with the last channel. v1's names stay: `stable`, `beta`, `nightly`
//! (npm's `latest`, `next`, `nightly`).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Channel {
    #[default]
    Stable,
    Beta,
    Nightly,
}

/// Every channel with the npm dist-tags it follows, in v1's order.
pub const CHANNELS: [(&str, &[&str]); 3] =
    [("stable", &["latest"]), ("beta", &["latest", "next"]), ("nightly", &["latest", "next", "nightly"])];

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Nightly => "nightly",
        }
    }

    /// The npm dist-tags this channel follows.
    pub fn tags(self) -> &'static [&'static str] {
        CHANNELS[self as usize].1
    }

    /// A known channel name, else stable (v1 `channelOf`).
    pub fn of(name: &str) -> Self {
        Self::parse(name).unwrap_or_default()
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "stable" => Some(Self::Stable),
            "beta" => Some(Self::Beta),
            "nightly" => Some(Self::Nightly),
            _ => None,
        }
    }
}

/// The error v1's PATCH /api/config answered for an unknown channel.
pub fn invalid_channel_message() -> String {
    let names: Vec<&str> = CHANNELS.iter().map(|(n, _)| *n).collect();
    format!("updateChannel must be one of {}", names.join(", "))
}
