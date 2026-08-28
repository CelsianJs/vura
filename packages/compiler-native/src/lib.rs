//! @celsian/vura-compiler-native — Rust-powered compiler for Vura
//!
//! Provides AST-based route scanning, JSX transformation, and native file watching.
//! Exposed to Node.js via napi-rs.

mod scanner;
mod jsx;
mod watcher;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ScanResult {
    pub methods: Vec<String>,
    pub kind: String,
    pub has_default_export: bool,
    pub has_get_server_data: bool,
    pub page_mode: Either<String, Null>,
    pub config: serde_json::Value,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformResult {
    pub code: String,
    pub map: Option<String>,
}

/// Scan a route or page file using AST-based analysis.
#[napi]
pub fn scan_route(source: String, file_type: String) -> Result<ScanResult> {
    scanner::scan(&source, &file_type).map_err(|e| Error::from_reason(e.to_string()))
}

/// Transform JSX to What Framework h() calls.
#[napi]
pub fn transform_jsx(
    source: String,
    jsx_import_source: Option<String>,
    production: Option<bool>,
) -> Result<TransformResult> {
    jsx::transform(
        &source,
        jsx_import_source.as_deref().unwrap_or("what-framework"),
        production.unwrap_or(false),
    )
    .map_err(|e| Error::from_reason(e.to_string()))
}

/// Watch a directory for file changes using native OS APIs.
/// Named Rust aliases leak into the .d.ts; pin the JS callback shape instead.
#[napi(ts_args_type = "path: string, callback: (arg0: string, arg1: string) => any")]
pub fn watch_directory(
    path: String,
    callback: watcher::WatchCallback,
) -> Result<watcher::WatcherHandle> {
    watcher::watch(&path, callback).map_err(|e| Error::from_reason(e.to_string()))
}
