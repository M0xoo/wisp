//! Reading a request body with a cap (v1 edge case 2): 2 MB unless the route says otherwise. Past the
//! cap nothing more is kept: the rest is read and dropped as it comes (so the browser hears the 413
//! instead of a reset), up to `DRAIN_MAX`, after which the connection is simply closed. Bytes are
//! kept as bytes and decoded once by whoever parses them: a chunk can end inside a UTF-8 character.
use bytes::{Bytes, BytesMut};
use http_body_util::BodyExt;
use hyper::body::{Body as _, Incoming};

use crate::error::ApiError;

pub const MAX_BODY: usize = 2_000_000;
/// The most a refused body is read (and dropped) for: past it the connection goes.
pub const DRAIN_MAX: usize = 32 * 1024 * 1024;

/// The whole body if it is at most `cap` bytes, else `TooLarge` (after draining what came).
pub async fn read_capped(mut body: Incoming, cap: usize) -> Result<Bytes, ApiError> {
    let declared = body
        .size_hint()
        .exact()
        .and_then(|n| usize::try_from(n).ok());
    if declared.is_some_and(|n| n > cap) {
        drain(body, DRAIN_MAX).await;
        return Err(ApiError::TooLarge);
    }
    let mut buf = BytesMut::with_capacity(declared.unwrap_or(0).min(cap));
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| ApiError::Http(e.to_string()))?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if buf.len() + data.len() > cap {
            drop(buf);
            drain(body, DRAIN_MAX.saturating_sub(cap)).await;
            return Err(ApiError::TooLarge);
        }
        buf.extend_from_slice(&data);
    }
    Ok(buf.freeze())
}

/// Reads and drops up to `max` more bytes.
async fn drain(mut body: Incoming, max: usize) {
    let mut seen = 0usize;
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(d) = frame.into_data() {
            seen += d.len();
            if seen > max {
                return;
            }
        }
    }
}
