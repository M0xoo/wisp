//! wisp Grid: wisp for many people on one server (plan §4.7, §7.2.5, ADR-0014). The Rust port of v1's
//! `grid/`, behaviour for behaviour: the edge's routing table (`hosts`), who may reach what (`trust`),
//! the control-plane SQLite (`db`, `migrations`), hostd starting and stopping each user's box
//! (`hostd`, behind `boxhost::BoxHost`), and every part the edge answers with.
//!
//! Layout: foundation modules first (no grid module below depends on one above it), then the parts,
//! then the edge that wires them, then the CLI.

// foundation
pub mod boxhost;
pub mod clock;
pub mod config;
pub mod db;
pub mod error;
pub mod hosts;
pub mod http;
pub mod migrations;
pub mod rows;
pub mod secrets;
pub mod trust;

// accounts and sign-in
pub mod accounts;
pub mod auth;
pub mod seats;

// boxes
pub mod hostd;

// channels: the inbox, `on laptop`, mail
pub mod dkim;
pub mod inbox;
pub mod mail;
pub mod route;

// publishing and reach
pub mod sandboxes;
pub mod shares;
pub mod teams;
pub mod sites;
pub mod telemetry;
pub mod tunnels;

// the edge, its pages, and the CLI
pub mod cli;
pub mod edge;
pub mod pages;

pub use error::{GridError, Result, bad};
