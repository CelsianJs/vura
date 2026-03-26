//! Native File Watcher
//!
//! Uses the `notify` crate for cross-platform file watching.
//! Much more reliable and efficient than Node's `fs.watch`.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind};
use std::path::Path;
use std::sync::{Arc, Mutex};

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

pub fn watch(
    path: &str,
    callback: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>,
) -> anyhow::Result<WatcherHandle> {
    let cb = callback.clone();

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
                    cb.call(
                        (event_type.to_string(), path_str),
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
