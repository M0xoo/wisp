//! Content-addressed blobs: BLAKE3, zstd, inline ≤ 64 KB, files beyond, refcounts, gc (blob.test.ts).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty, clippy::unnecessary_wraps)]

mod common;

use std::path::Path;

use common::{open, open_disk};
use wisp_store::{Codec, GcResult, INLINE_MAX, StoreError, hash_of};

fn files(home: &Path) -> Vec<String> {
    let Ok(dirs) = std::fs::read_dir(home.join("blobs")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for d in dirs.flatten() {
        for f in std::fs::read_dir(d.path()).unwrap().flatten() {
            out.push(format!("{}/{}", d.file_name().to_string_lossy(), f.file_name().to_string_lossy()));
        }
    }
    out
}

/// bytes zstd can't shrink (an xorshift stream)
fn noise(n: usize) -> Vec<u8> {
    let mut s = 0x9E37_79B9_7F4A_7C15u64;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s.to_le_bytes()[0]
        })
        .collect()
}

fn owner(k: &str, i: &str) -> Option<(String, String)> {
    Some((k.to_owned(), i.to_owned()))
}

#[tokio::test]
async fn small_blobs_are_inline_and_compressed_and_the_same_content_is_stored_once() {
    let f = open_disk(None);
    let text = "diff --git a/x b/x\n".repeat(200).into_bytes();
    let a = f.store.put_blob(text.clone(), owner("turn", "t1")).await.unwrap();
    let b = f.store.write(|w| w.put_blob(&"diff --git a/x b/x\n".repeat(200).into_bytes(), Some(("turn", "t2")))).await.unwrap();
    assert_eq!(a.hash, b.hash);
    assert_eq!(a.hash, hash_of(&text));
    assert!(a.hash.starts_with("blake3:") && a.hash.len() == 7 + 64);
    assert!(a.inline);
    assert_eq!(a.codec, Codec::Zstd);
    assert_eq!(f.store.blob(&a.hash).unwrap(), Some(text));
    assert_eq!(f.store.read(|r| r.blob_refs(&a.hash)).unwrap(), 2);
}

#[tokio::test]
async fn incompressible_content_is_kept_raw() {
    let f = open();
    assert_eq!(f.store.put_blob(noise(2048), None).await.unwrap().codec, Codec::Raw);
}

#[tokio::test]
async fn big_blobs_go_to_blobs_ab_cdef_on_disk_and_read_back() {
    let f = open_disk(None);
    let big = noise(INLINE_MAX + 1);
    let info = f.store.put_blob(big.clone(), owner("shot", "s")).await.unwrap();
    assert!(!info.inline);
    let hex = &info.hash["blake3:".len()..];
    assert_eq!(files(f.home.as_ref().unwrap()), vec![format!("{}/{}", &hex[..2], &hex[2..])]);
    assert_eq!(f.store.blob(&info.hash).unwrap(), Some(big));
}

#[tokio::test]
async fn a_memory_store_keeps_even_big_blobs_inline() {
    let f = open();
    let info = f.store.put_blob(noise(INLINE_MAX * 2), None).await.unwrap();
    assert!(info.inline);
    assert_eq!(f.store.blob(&info.hash).unwrap().map(|b| b.len()), Some(INLINE_MAX * 2));
}

#[tokio::test]
async fn gc_removes_unreferenced_blobs_rows_and_files_and_keeps_referenced_ones() {
    let f = open_disk(None);
    let kept = f.store.put_blob(b"kept".to_vec(), owner("turn", "t1")).await.unwrap();
    let big = f.store.put_blob(noise(INLINE_MAX * 2), owner("turn", "t2")).await.unwrap();
    let loose = f.store.put_blob(b"never referenced".to_vec(), None).await.unwrap();
    assert_eq!(f.store.write(|w| w.blob_unref_owner("turn", "t2")).await.unwrap(), 1);
    let r = f.store.gc_blobs().await.unwrap();
    assert_eq!(r, GcResult { blobs: 2, files: 1, bytes: (INLINE_MAX * 2 + "never referenced".len()) as u64 });
    assert!(f.store.read(|r| r.blob_exists(&kept.hash)).unwrap());
    assert!(!f.store.read(|r| r.blob_exists(&big.hash)).unwrap());
    assert_eq!(f.store.blob(&loose.hash).unwrap(), None);
    assert!(files(f.home.as_ref().unwrap()).is_empty());
}

#[tokio::test]
async fn unref_of_one_owner_leaves_the_others_and_a_ref_to_a_missing_blob_is_refused() {
    let f = open();
    let b = f.store.put_blob(b"x".to_vec(), owner("turn", "a")).await.unwrap();
    let h = b.hash.clone();
    f.store
        .write(move |w| {
            w.blob_ref(&h, "turn", "b")?;
            w.blob_ref(&h, "turn", "b")?; // idempotent
            w.blob_unref(&h, "turn", "a")
        })
        .await
        .unwrap();
    assert_eq!(f.store.read(|r| r.blob_refs(&b.hash)).unwrap(), 1);
    assert_eq!(f.store.gc_blobs().await.unwrap().blobs, 0);
    let err = f.store.write(|w| w.blob_ref(&format!("blake3:{}", "0".repeat(64)), "turn", "a")).await.unwrap_err();
    assert!(matches!(err, StoreError::NotFound(_)));
}

#[tokio::test]
async fn a_put_in_a_transaction_that_rolls_back_leaves_no_row_and_its_file_is_swept_once_old() {
    let f = open_disk(None);
    let home = f.home.clone().unwrap();
    let data = noise(INLINE_MAX * 2);
    let hash = hash_of(&data);
    let out: Result<(), _> = f
        .store
        .write(move |w| {
            w.put_blob(&data, None)?;
            Err(StoreError::Internal("rolled back".into()))
        })
        .await;
    assert!(out.is_err());
    assert!(!f.store.read(|r| r.blob_exists(&hash)).unwrap());
    assert_eq!(files(&home).len(), 1, "the file was written before the row");
    f.clock.set(wisp_kernel::Clock::now_ms(&wisp_store::SystemClock));
    assert_eq!(f.store.gc_blobs().await.unwrap().files, 0, "too young: it might belong to a put still committing");
    f.clock.set(wisp_kernel::Clock::now_ms(&wisp_store::SystemClock) + 11 * 60 * 1000);
    assert_eq!(f.store.gc_blobs().await.unwrap().files, 1);
    assert!(files(&home).is_empty());
}

#[tokio::test]
async fn a_recorded_on_disk_blob_whose_file_is_gone_is_reported_not_returned_empty() {
    let f = open_disk(None);
    let home = f.home.clone().unwrap();
    let info = f.store.put_blob(noise(INLINE_MAX * 2), owner("x", "1")).await.unwrap();
    for file in files(&home) {
        std::fs::remove_file(home.join("blobs").join(file)).unwrap();
    }
    assert!(f.store.blob(&info.hash).unwrap_err().to_string().contains("file is missing"));
}
