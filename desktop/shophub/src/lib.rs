//! JZD Shop Hub.
//!
//! One computer in the shop holds the authoritative shop book; every JZD Shop
//! Manager in the building - that computer included - works from it over the
//! shop's own network. No cloud, no shared files.

pub mod flat;
pub mod store;
pub mod util;
pub mod crypto;
pub mod engine;
pub mod secrets;
pub mod server;
pub mod client;
pub mod backup;
pub mod app;
pub mod shell;
pub mod phone;
