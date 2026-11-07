//! The desktop app's self-update (v1 `Updater.fetchApp`): what to check in a download and what to say when
//! a step fails. The host downloads, writes and renames; this decides.

use sha2::{Digest, Sha256};

use crate::updater::{Asset, Updater};
use crate::version::newer;

/// The sha256 of `data`, lower-case hex.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 15), 16).unwrap_or('0'));
    }
    out
}

impl Updater {
    /// The download answered `status` (not 2xx).
    pub fn download_failed(&self, asset: &Asset, status: u16) -> String {
        format!(
            "Couldn't download {} (HTTP {status}). {}",
            asset.name,
            self.later()
        )
    }

    /// Checks a download against the release's sha256, when the release has one.
    pub fn verify_download(&self, asset: &Asset, data: &[u8]) -> Result<(), String> {
        let want = asset.digest.as_deref().unwrap_or("");
        let want = want.strip_prefix("sha256:").unwrap_or(want);
        if !want.is_empty() && !sha256_hex(data).eq_ignore_ascii_case(want) {
            return Err(format!(
                "{} didn't match the release's checksum. {}",
                asset.name,
                self.later()
            ));
        }
        Ok(())
    }

    /// macOS: the unpacked bundle's version (its Contents/Resources/app/package.json, or the launcher's).
    pub fn check_bundle(&self, got: Option<&str>) -> Result<(), String> {
        if got.is_some_and(|g| newer(g, &self.current)) {
            Ok(())
        } else {
            Err(format!(
                "The download isn't newer than wisp {}. {}",
                self.current,
                self.later()
            ))
        }
    }

    /// macOS: the running bundle couldn't be moved aside.
    pub fn cant_replace_bundle(&self, folder: &str) -> String {
        format!(
            "wisp can't replace itself in {folder} (no permission). {}",
            self.later()
        )
    }

    /// macOS: the new bundle couldn't be put in place (the old one went back).
    pub fn cant_place_bundle(&self, why: &str) -> String {
        format!(
            "Couldn't put the new wisp in place: {why}. {}",
            self.later()
        )
    }

    /// Linux: the `AppImage` couldn't be replaced.
    pub fn cant_replace_image(&self, image: &str) -> String {
        format!(
            "wisp can't replace {image} (no permission). {}",
            self.later()
        )
    }
}
