//! Typed ids: `UUIDv7` newtypes (time-sortable, append to the B-tree), origin-prefixed across peers
//! (`<peer>:<uuid>`, plan §7.2.1). Legacy v1 ids import unchanged, so an id is a string underneath.

/// Declares a branded id type: `id_type!(SessionId);` gives `SessionId::new()`, `as_str()`, serde as a
/// plain string, and no conversion from another id type.
#[macro_export]
macro_rules! id_type {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl $name {
            pub fn new() -> Self {
                Self($crate::ids::uuid7())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }
    };
}

pub fn uuid7() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

id_type!(PluginId);
id_type!(PeerId);

/// Splits an origin id `peer:local` (the peer is everything before the first ':'); a bare id is local.
pub fn split_origin(id: &str) -> (Option<&str>, &str) {
    match id.split_once(':') {
        Some((peer, local)) if !peer.is_empty() && !local.is_empty() => (Some(peer), local),
        _ => (None, id),
    }
}
