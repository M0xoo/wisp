//! wisp-stuff-api: the contract of `wisp.stuff`, the plugin that owns My Stuff (what you and your
//! agents kept from tasks: pictures, videos, docs, code, files, links and apps), the apps' launches and
//! their databases, and uploads (attachments). Other plugins depend on this crate only (ADR-0003).
//!
//! Shapes follow v1's records (`server/services/stuff.js`, `services/uploads.js`) so v1 clients read
//! the same JSON and the importer maps 1:1. What changed underneath: content lives in wisp-store's CAS
//! (BLAKE3), so an item names its bytes by hash (`blob`, an app's file tree by `tree`) instead of a
//! folder an agent could edit behind wisp's back.

pub mod app;
pub mod commands;
pub mod pane;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use app::{AppManifest, DbSpec, bundle_path, db_spec, private_file, public_file, uses_of};
pub use pane::Grant;

pub const PLUGIN: &str = "wisp.stuff";

/// Every item's page view, one row per item (entity `stuff.item`).
pub const TOPIC: &str = "stuff";
/// Attachments' records (entity `stuff.upload`).
pub const TOPIC_UPLOADS: &str = "uploads";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum StuffKind {
    Image,
    Video,
    Doc,
    Code,
    #[default]
    File,
    Link,
    App,
}

impl StuffKind {
    pub const ALL: [StuffKind; 7] = [
        Self::Image,
        Self::Video,
        Self::Doc,
        Self::Code,
        Self::File,
        Self::Link,
        Self::App,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Doc => "doc",
            Self::Code => "code",
            Self::File => "file",
            Self::Link => "link",
            Self::App => "app",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// Where an item came from: the task (its title as it was then) and turn, plus the page's key for
/// "already saved" (`starter:<id>` for a starter).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StuffFrom {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
}

/// Where an app is published (written by the publisher with `stuff.setPublished`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct Published {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rev: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub at: Option<i64>,
}

/// One file of an app: its path inside the app, its bytes' BLAKE3 hash in the CAS, and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppFile {
    pub rel: String,
    pub hash: String,
    pub size: u64,
}

macro_rules! content_fields {
    ($(#[$m:meta])* pub struct $name:ident { $($extra:tt)* }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            pub kind: StuffKind,
            #[serde(default)]
            pub name: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub mime: Option<String>,
            #[serde(default)]
            pub size: u64,
            /// the file's bytes in the CAS (BLAKE3 hex)
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub blob: Option<String>,
            /// an app's file list (`[AppFile]` as JSON) in the CAS
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub tree: Option<String>,
            /// an app's code hash (v1 `appHash` without the uses): what a write grant is tied to
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub code: Option<String>,
            /// a v1 record's file on this computer, kept until its bytes are in the CAS
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub path: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub source: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub lang: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub excerpt: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub url: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub entry: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub files: Option<u32>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub db: Option<DbSpec>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub uses: Option<Vec<String>>,
            /// what the Allow card warns about in an app's code (`webrtc`), found when it was saved
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub risky: Option<Vec<String>>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub by: Option<String>,
            #[serde(default)]
            pub at: i64,
            $($extra)*
        }
    };
}

content_fields! {
    /// What makes up an item's content, kept whole as the one previous version (`prev`).
    pub struct StuffContent {}
}

content_fields! {
    /// One item as this computer keeps it (v1's `<id>.json`): never sent to a page as is.
    pub struct StuffItem {
        #[serde(default)]
        pub id: String,
        #[serde(default)]
        pub title: String,
        /// what you allowed a pane, as stored; `Grant` says what holds now
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub allowed: Option<Vec<String>>,
        /// the app's code hash a write grant is tied to (sha256 hex, v1 `appHash`)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub grant_hash: Option<String>,
        /// an app's picture: its bytes in the CAS
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cover: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cover_mime: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub from: Option<StuffFrom>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tags: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub starred: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rev: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub updated_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub prev: Option<Box<StuffContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub published: Option<Published>,
    }
}

/// What a page knows of an earlier version: that there is one, not where.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PrevView {
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Running {
    pub port: u16,
}

/// What a page sees of an item (v1 `Stuff.view`): no paths or hashes, the grant as it holds now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StuffView {
    pub id: String,
    pub kind: StuffKind,
    pub name: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime: Option<String>,
    pub size: u64,
    pub at: i64,
    pub by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub files: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub uses: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<StuffFrom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub starred: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rev: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub published: Option<Published>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allowed: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub changed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub risky: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prev: Option<PrevView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover: Option<bool>,
    /// it has a database, and `data` says whether it has any yet (Reset data)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub db: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<bool>,
    /// launched, on this port of 127.0.0.1
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub running: Option<Running>,
}

/// An attachment (v1 services/uploads.js), referenced by id from launches and replies. `path` is a
/// readable copy of its bytes on this computer, for harnesses that take a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Upload {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blob: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}
