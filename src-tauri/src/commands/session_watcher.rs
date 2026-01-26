/**
 * Session File Watcher Module
 *
 * Watches Codex/Claude session files for changes and emits events to the frontend.
 * This enables real-time synchronization when using external tools (e.g., VSCode Codex plugin).
 */

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, Debouncer};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

/// State for managing session file watchers
pub struct SessionWatcherState {
    /// Active watchers by session ID
    watchers: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

enum WatcherKind {
    /// OS file notifications (fast, best-effort)
    Notify(Debouncer<RecommendedWatcher>),
    /// Polling loop (reliable for WSL UNC paths / network FS)
    Poll(tauri::async_runtime::JoinHandle<()>),
}

struct WatcherHandle {
    kind: WatcherKind,
    /// Session file path being watched (kept for debugging/logging)
    file_path: PathBuf,
    /// Last known read offset (for incremental reads)
    last_offset: Arc<Mutex<u64>>,
}

impl Default for SessionWatcherState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Event emitted when session file changes
#[derive(Clone, serde::Serialize)]
pub struct SessionFileChangedEvent {
    /// Session ID
    pub session_id: String,
    /// New lines added to the file
    pub new_lines: Vec<serde_json::Value>,
    /// Engine type (codex, claude, gemini)
    pub engine: String,
}

/// Start watching a session file for changes
#[tauri::command]
pub async fn start_session_watcher(
    session_id: String,
    engine: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("[SessionWatcher] Starting watcher for session: {} (engine: {})", session_id, engine);

    let state: tauri::State<'_, SessionWatcherState> = app_handle.state();
    let mut watchers = state.watchers.lock().await;

    // Check if already watching
    if watchers.contains_key(&session_id) {
        log::info!("[SessionWatcher] Already watching session: {}", session_id);
        return Ok(());
    }

    // Find the session file
    let session_file = find_session_file_path(&session_id, &engine)?;
    log::info!("[SessionWatcher] Found session file: {:?}", session_file);

    // Get initial file size
    let initial_size = std::fs::metadata(&session_file)
        .map(|m| m.len())
        .unwrap_or(0);
    let last_offset = Arc::new(Mutex::new(initial_size));

    // Decide watcher strategy
    let use_polling = should_use_polling(&session_file);

    let kind = if use_polling {
        log::info!(
            "[SessionWatcher] Using polling watcher for session {} (path: {:?})",
            session_id,
            session_file
        );

        let session_id_clone = session_id.clone();
        let engine_clone = engine.clone();
        let session_file_clone = session_file.clone();
        let last_offset_clone = last_offset.clone();
        let app_handle_clone = app_handle.clone();

        let task = tauri::async_runtime::spawn(async move {
            let interval = Duration::from_millis(250);
            loop {
                if let Err(e) = handle_file_change(
                    &session_id_clone,
                    &engine_clone,
                    &session_file_clone,
                    last_offset_clone.clone(),
                    &app_handle_clone,
                )
                .await
                {
                    log::error!("[SessionWatcher] Poll watcher error: {}", e);
                }

                tokio::time::sleep(interval).await;
            }
        });

        WatcherKind::Poll(task)
    } else {
        // Create debounced watcher
        let session_id_clone = session_id.clone();
        let engine_clone = engine.clone();
        let session_file_clone = session_file.clone();
        let last_offset_clone = last_offset.clone();
        let app_handle_clone = app_handle.clone();

        let debouncer = new_debouncer(
            Duration::from_millis(150), // Lower latency for realtime UI
            move |res: Result<Vec<DebouncedEvent>, notify::Error>| match res {
                Ok(events) => {
                    for event in events {
                        log::debug!("[SessionWatcher] File event: {:?}", event.path);

                        let session_id = session_id_clone.clone();
                        let engine = engine_clone.clone();
                        let file_path = session_file_clone.clone();
                        let last_offset = last_offset_clone.clone();
                        let app_handle = app_handle_clone.clone();

                        // Spawn async task to handle the event
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                handle_file_change(&session_id, &engine, &file_path, last_offset, &app_handle).await
                            {
                                log::error!("[SessionWatcher] Error handling file change: {}", e);
                            }
                        });
                    }
                }
                Err(e) => {
                    log::error!("[SessionWatcher] Watch error: {:?}", e);
                }
            },
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // Get the watcher from debouncer and watch the file
        let mut debouncer = debouncer;
        debouncer
            .watcher()
            .watch(&session_file, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch file: {}", e))?;

        WatcherKind::Notify(debouncer)
    };

    // Store the watcher
    watchers.insert(
        session_id.clone(),
        WatcherHandle {
            kind,
            file_path: session_file,
            last_offset,
        },
    );

    log::info!("[SessionWatcher] Successfully started watching session: {}", session_id);
    Ok(())
}

/// Stop watching a session file
#[tauri::command]
pub async fn stop_session_watcher(
    session_id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("[SessionWatcher] Stopping watcher for session: {}", session_id);

    let state: tauri::State<'_, SessionWatcherState> = app_handle.state();
    let mut watchers = state.watchers.lock().await;

    if let Some(handle) = watchers.remove(&session_id) {
        if let WatcherKind::Poll(task) = &handle.kind {
            task.abort();
        }
        log::info!("[SessionWatcher] Successfully stopped watching session: {}", session_id);
    } else {
        log::warn!("[SessionWatcher] No watcher found for session: {}", session_id);
    }

    Ok(())
}

/// Stop all session watchers
#[tauri::command]
pub async fn stop_all_session_watchers(
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("[SessionWatcher] Stopping all watchers");

    let state: tauri::State<'_, SessionWatcherState> = app_handle.state();
    let mut watchers = state.watchers.lock().await;
    
    let count = watchers.len();
    for (_sid, handle) in watchers.drain() {
        if let WatcherKind::Poll(task) = &handle.kind {
            task.abort();
        }
    }
    
    log::info!("[SessionWatcher] Stopped {} watchers", count);
    Ok(())
}

/// Handle file change event - read new lines and emit to frontend
async fn handle_file_change(
    session_id: &str,
    engine: &str,
    file_path: &PathBuf,
    last_offset: Arc<Mutex<u64>>,
    app_handle: &AppHandle,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};

    let current_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;

    let mut last = last_offset.lock().await;
    
    if current_size <= *last {
        // File hasn't grown (or was truncated)
        if current_size < *last {
            log::info!("[SessionWatcher] File was truncated, resetting position");
            *last = 0;
        } else {
            return Ok(());
        }
    }

    log::info!("[SessionWatcher] File grew from {} to {} bytes", *last, current_size);

    // Read new content
    let file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut reader = BufReader::new(file);
    
    // Seek to last known position
    reader.seek(SeekFrom::Start(*last))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    // Read new lines
    let mut new_lines = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut new_last = *last;
    let mut parse_errors = 0usize;

    loop {
        buf.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read: {}", e))?;
        if bytes_read == 0 {
            break;
        }

        let has_newline = buf.last() == Some(&b'\n');
        let mut line_bytes = buf.as_slice();
        if has_newline {
            line_bytes = &line_bytes[..line_bytes.len().saturating_sub(1)];
        }
        if line_bytes.last() == Some(&b'\r') {
            line_bytes = &line_bytes[..line_bytes.len().saturating_sub(1)];
        }

        let line_str = match std::str::from_utf8(line_bytes) {
            Ok(s) => s,
            Err(_) => {
                // If this is a partial trailing line, wait for completion
                if !has_newline {
                    break;
                }
                new_last += bytes_read as u64;
                continue;
            }
        };

        if line_str.trim().is_empty() {
            new_last += bytes_read as u64;
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(line_str) {
            Ok(event) => {
                new_lines.push(event);
                new_last += bytes_read as u64;
            }
            Err(e) => {
                parse_errors += 1;
                // If we hit a partial trailing line (no newline at EOF), don't advance.
                if !has_newline {
                    log::debug!(
                        "[SessionWatcher] Partial JSON line (waiting for completion): {}",
                        e
                    );
                    break;
                }
                log::warn!("[SessionWatcher] Failed to parse line: {}", e);
                new_last += bytes_read as u64;
            }
        }
    }

    // Update last known offset (do not advance past partial trailing line)
    *last = new_last;

    // Emit event if we have new lines
    if !new_lines.is_empty() {
        log::info!("[SessionWatcher] Emitting {} new events for session {}", new_lines.len(), session_id);
        
        let event = SessionFileChangedEvent {
            session_id: session_id.to_string(),
            new_lines,
            engine: engine.to_string(),
        };

        app_handle.emit("session-file-changed", event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    if parse_errors > 0 {
        log::debug!("[SessionWatcher] Parse errors while reading session {}: {}", session_id, parse_errors);
    }

    Ok(())
}

/// Find the session file path for a given session ID and engine
fn find_session_file_path(session_id: &str, engine: &str) -> Result<PathBuf, String> {
    match engine {
        "codex" => {
            // Use the existing Codex session finder
            let sessions_dir = super::codex::config::get_codex_sessions_dir()?;
            super::codex::session::find_session_file(&sessions_dir, session_id)
        }
        "claude" => {
            // Claude sessions are stored in ~/.claude/projects/{project_id}/sessions/{session_id}.jsonl
            // We need to search for the file
            let home_dir = dirs::home_dir()
                .ok_or_else(|| "Failed to get home directory".to_string())?;
            let claude_dir = home_dir.join(".claude").join("projects");
            
            if !claude_dir.exists() {
                return Err(format!("Claude projects directory not found: {:?}", claude_dir));
            }

            // Search for the session file
            for entry in walkdir::WalkDir::new(&claude_dir)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                    if let Some(file_name) = path.file_stem().and_then(|s| s.to_str()) {
                        if file_name == session_id {
                            return Ok(path.to_path_buf());
                        }
                    }
                }
            }

            Err(format!("Claude session file not found for ID: {}", session_id))
        }
        "gemini" => {
            // Gemini sessions - similar search pattern
            let home_dir = dirs::home_dir()
                .ok_or_else(|| "Failed to get home directory".to_string())?;
            let gemini_dir = home_dir.join(".gemini").join("sessions");
            
            if !gemini_dir.exists() {
                return Err(format!("Gemini sessions directory not found: {:?}", gemini_dir));
            }

            // Search for the session file
            for entry in walkdir::WalkDir::new(&gemini_dir)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                    if let Some(file_name) = path.file_stem().and_then(|s| s.to_str()) {
                        if file_name == session_id {
                            return Ok(path.to_path_buf());
                        }
                    }
                }
            }

            Err(format!("Gemini session file not found for ID: {}", session_id))
        }
        _ => Err(format!("Unknown engine: {}", engine)),
    }
}

fn should_use_polling(path: &PathBuf) -> bool {
    #[cfg(target_os = "windows")]
    {
        // notify on Windows may not work reliably on \\wsl$ / \\wsl.localhost UNC paths.
        let s = path.to_string_lossy();
        s.starts_with(r"\\wsl")
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        false
    }
}
