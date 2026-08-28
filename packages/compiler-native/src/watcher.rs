//! Native File Watcher
//!
//! Uses the `notify` crate for cross-platform file watching.
//! Much more reliable and efficient than Node's `fs.watch`.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};
use napi_derive::napi;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// `(event, path) => any` with no Node-style error-first argument.
///
/// The argument type must be `FnArgs<(String, String)>` and not a bare tuple.
/// napi 3 hands a bare tuple to JavaScript as ONE array argument, where napi 2
/// with `ErrorStrategy::Fatal` spread it into two. `FnArgs` is what preserves
/// the spread, and nothing else here would have caught the difference: the
/// callback still fires either way, so only an assertion on the argument shape
/// distinguishes them.
pub type WatchCallback = ThreadsafeFunction<
    FnArgs<(String, String)>,
    UnknownReturnValue,
    FnArgs<(String, String)>,
    Status,
    false,
>;

#[napi]
pub struct WatcherHandle {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

#[napi]
impl WatcherHandle {
    #[napi]
    pub fn stop(&self) -> Result<()> {
        let mut guard = self.watcher.lock().map_err(|e| {
            Error::from_reason(format!("Failed to acquire lock: {}", e))
        })?;
        *guard = None;
        Ok(())
    }
}

pub fn watch(path: &str, callback: WatchCallback) -> anyhow::Result<WatcherHandle> {
    let mut watcher = notify::recommended_watcher(move |res: std::result::Result<Event, notify::Error>| {
        match res {
            Ok(event) => {
                let event_type = match event.kind {
                    EventKind::Create(_) => "create",
                    EventKind::Modify(_) => "modify",
                    EventKind::Remove(_) => "remove",
                    _ => return,
                };

                for path in event.paths {
                    let path_str = path.to_string_lossy().to_string();
                    callback.call(
                        (event_type.to_string(), path_str).into(),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
            Err(e) => {
                eprintln!("[then/compiler-native] Watch error: {:?}", e);
            }
        }
    })?;

    watcher.watch(Path::new(path), RecursiveMode::Recursive)?;

    Ok(WatcherHandle {
        watcher: Arc::new(Mutex::new(Some(watcher))),
    })
}
