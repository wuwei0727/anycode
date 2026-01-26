/**
 * Codex Session Management Module
 *
 * Handles session lifecycle operations including:
 * - Session execution (execute, resume, cancel)
 * - Session listing and history
 * - Session deletion
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

// Import platform-specific utilities for window hiding
use crate::commands::claude::apply_no_window_async;
use crate::claude_binary::detect_binary_for_tool;
// Import WSL utilities for Windows + WSL Codex support
use super::super::wsl_utils;
// Import config module for sessions directory
use super::config::get_codex_sessions_dir;

// ============================================================================
// Type Definitions
// ============================================================================

/// Codex execution mode
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexExecutionMode {
    /// Read-only mode (default, safe)
    ReadOnly,
    /// Allow file edits
    FullAuto,
    /// Full access including network
    DangerFullAccess,
}

impl Default for CodexExecutionMode {
    fn default() -> Self {
        Self::ReadOnly
    }
}

/// Codex execution options
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexExecutionOptions {
    /// Project path
    pub project_path: String,

    /// User prompt
    pub prompt: String,

    /// Execution mode
    #[serde(default)]
    pub mode: CodexExecutionMode,

    /// Model to use (e.g., "gpt-5.1-codex-max")
    pub model: Option<String>,

    /// Reasoning mode to use (e.g., "medium", "high")
    pub reasoning_mode: Option<String>,

    /// Enable JSON output mode
    #[serde(default = "default_json_mode")]
    pub json: bool,

    /// Output schema for structured output (JSON Schema)
    pub output_schema: Option<String>,

    /// Output file path
    pub output_file: Option<String>,

    /// Skip Git repository check
    #[serde(default)]
    pub skip_git_repo_check: bool,

    /// API key (overrides default)
    pub api_key: Option<String>,

    /// Session ID for resuming
    pub session_id: Option<String>,

    /// Resume last session
    #[serde(default)]
    pub resume_last: bool,
}

fn default_json_mode() -> bool {
    true
}

/// Codex project metadata (grouped by project path)
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProject {
    /// Project path
    pub project_path: String,

    /// Session IDs in this project
    pub sessions: Vec<String>,

    /// Session count
    pub session_count: usize,

    /// Last activity timestamp (most recent session update)
    pub last_activity: u64,
}

/// Codex session metadata
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSession {
    /// Session/thread ID
    pub id: String,

    /// Project path
    pub project_path: String,

    /// Creation timestamp
    pub created_at: u64,

    /// Last updated timestamp
    pub updated_at: u64,

    /// Execution mode used
    pub mode: CodexExecutionMode,

    /// Model used
    pub model: Option<String>,

    /// Session status
    pub status: String,

    /// First user message
    pub first_message: Option<String>,

    /// Last assistant message (AI response summary)
    pub last_assistant_message: Option<String>,

    /// Last message timestamp (ISO string)
    pub last_message_timestamp: Option<String>,
}

/// Global state to track Codex processes
pub struct CodexProcessState {
    pub processes: Arc<Mutex<HashMap<String, Child>>>,
    pub last_session_id: Arc<Mutex<Option<String>>>,
}

impl Default for CodexProcessState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            last_session_id: Arc::new(Mutex::new(None)),
        }
    }
}

// ============================================================================
// Core Execution Methods
// ============================================================================

/// Executes a Codex task in non-interactive mode with streaming output
#[tauri::command]
pub async fn execute_codex(
    options: CodexExecutionOptions,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("execute_codex called with options: {:?}", options);

    // Build codex exec command
    let (cmd, prompt) = build_codex_command(&options, false, None)?;

    // Execute and stream output
    execute_codex_process(cmd, prompt, options.project_path.clone(), app_handle).await
}

/// Resumes a previous Codex session
#[tauri::command]
pub async fn resume_codex(
    session_id: String,
    options: CodexExecutionOptions,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("resume_codex called for session: {}", session_id);

    // Build codex exec resume command (session_id added inside build function)
    let (cmd, prompt) = build_codex_command(&options, true, Some(&session_id))?;

    // Execute and stream output
    execute_codex_process(cmd, prompt, options.project_path.clone(), app_handle).await
}

/// Resumes the last Codex session
#[tauri::command]
pub async fn resume_last_codex(
    options: CodexExecutionOptions,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("resume_last_codex called");

    // Build codex exec resume --last command
    let (cmd, prompt) = build_codex_command(&options, true, Some("--last"))?;

    // Execute and stream output
    execute_codex_process(cmd, prompt, options.project_path.clone(), app_handle).await
}

/// Cancels a running Codex execution
#[tauri::command]
pub async fn cancel_codex(
    session_id: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("cancel_codex called for session: {:?}", session_id);

    let state: tauri::State<'_, CodexProcessState> = app_handle.state();
    let mut processes = state.processes.lock().await;

    if let Some(sid) = session_id {
        // Cancel specific session
        if let Some(mut child) = processes.remove(&sid) {
            child.kill().await.map_err(|e| format!("Failed to kill process: {}", e))?;
            log::info!("Killed Codex process for session: {}", sid);
        } else {
            log::warn!("No running process found for session: {}", sid);
        }
    } else {
        // Cancel all processes
        for (sid, mut child) in processes.drain() {
            if let Err(e) = child.kill().await {
                log::error!("Failed to kill process for session {}: {}", sid, e);
            } else {
                log::info!("Killed Codex process for session: {}", sid);
            }
        }
    }

    Ok(())
}

// ============================================================================
// Session Management
// ============================================================================

/// Lists all Codex sessions by reading ~/.codex/sessions directory
/// On Windows with WSL mode, reads from WSL filesystem via UNC path
/// Optimized: Uses walkdir for efficient directory traversal
#[tauri::command]
pub async fn list_codex_sessions() -> Result<Vec<CodexSession>, String> {
    log::info!("list_codex_sessions called");

    // Use unified sessions directory function (supports WSL)
    let sessions_dir = get_codex_sessions_dir()?;
    log::info!("Looking for Codex sessions in: {:?}", sessions_dir);

    if !sessions_dir.exists() {
        log::warn!("Codex sessions directory does not exist: {:?}", sessions_dir);
        return Ok(Vec::new());
    }

    // Use walkdir for efficient recursive directory traversal
    let mut sessions: Vec<CodexSession> = walkdir::WalkDir::new(&sessions_dir)
        .min_depth(4) // Skip year/month/day directories, go directly to files
        .max_depth(4) // Don't go deeper than needed
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
        })
        .filter_map(|e| {
            let path = e.path();
            match parse_codex_session_file(path) {
                Some(session) => {
                    log::debug!("Found session: {} ({})", session.id, session.project_path);
                    Some(session)
                }
                None => {
                    log::debug!("Failed to parse: {:?}", path);
                    None
                }
            }
        })
        .collect();

    // Sort by creation time (newest first)
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    log::info!("Found {} Codex sessions", sessions.len());
    Ok(sessions)
}

/// Lists Codex sessions filtered by project path
/// Optimized: Only parses session files that match the target project path
/// This avoids loading all sessions when only one project's sessions are needed
#[tauri::command]
pub async fn list_codex_sessions_for_project(project_path: String) -> Result<Vec<CodexSession>, String> {
    log::info!("list_codex_sessions_for_project called for: {}", project_path);

    let sessions_dir = get_codex_sessions_dir()?;
    
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    // Normalize target path for comparison
    let normalize_path = |p: &str| -> String {
        p.replace('\\', "/").trim_end_matches('/').to_lowercase()
    };
    let target_path_norm = normalize_path(&project_path);

    let mut sessions: Vec<CodexSession> = walkdir::WalkDir::new(&sessions_dir)
        .min_depth(4)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .filter_map(|e| {
            let path = e.path();
            // Quick check: read only first line to get project path
            if let Some(session_path) = quick_extract_project_path(path) {
                let session_path_norm = normalize_path(&session_path);
                if session_path_norm == target_path_norm {
                    // Full parse only if path matches
                    return parse_codex_session_file(path);
                }
            }
            None
        })
        .collect();

    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    log::info!("Found {} Codex sessions for project {}", sessions.len(), project_path);
    Ok(sessions)
}

/// Lists all Codex projects by grouping sessions by project path
/// Returns a list of projects with session counts and last activity timestamps
#[tauri::command]
pub async fn list_codex_projects() -> Result<Vec<CodexProject>, String> {
    log::info!("list_codex_projects called");

    let sessions_dir = get_codex_sessions_dir()?;
    log::info!("Looking for Codex projects in: {:?}", sessions_dir);

    if !sessions_dir.exists() {
        log::warn!("Codex sessions directory does not exist: {:?}", sessions_dir);
        return Ok(Vec::new());
    }

    // Collect all sessions and group by project path
    let mut projects_map: std::collections::HashMap<String, CodexProject> = std::collections::HashMap::new();

    // Helper to normalize path for grouping
    let normalize_path = |p: &str| -> String {
        p.replace('\\', "/").trim_end_matches('/').to_lowercase()
    };

    // Filter out clearly-noisy "projects" that users don't consider real projects.
    // These often come from clipboard/temp workflows and pollute the project list.
    let should_exclude_project_path = |p: &str| -> bool {
        let norm = normalize_path(p);
        norm.contains("claude_workbench_clipboard_images")
            || norm.contains("appdata/local/temp")
            || norm.contains("/tmp/")
    };

    for entry in walkdir::WalkDir::new(&sessions_dir)
        .min_depth(4)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
    {
        let path = entry.path();
        
        // Quick extract project path and session info
        if let Some((project_path, session_id, updated_at)) = quick_extract_project_info(path) {
            // Skip noise paths and non-existing directories
            if should_exclude_project_path(&project_path) {
                continue;
            }
            if !std::path::Path::new(&project_path).exists() {
                continue;
            }

            let normalized = normalize_path(&project_path);
            
            let project = projects_map.entry(normalized).or_insert_with(|| CodexProject {
                project_path: project_path.clone(),
                sessions: Vec::new(),
                session_count: 0,
                last_activity: 0,
            });
            
            project.sessions.push(session_id);
            project.session_count += 1;
            if updated_at > project.last_activity {
                project.last_activity = updated_at;
            }
        }
    }

    // Convert to vector and sort by last activity (newest first)
    let mut projects: Vec<CodexProject> = projects_map.into_values().collect();
    projects.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    log::info!("Found {} Codex projects", projects.len());
    Ok(projects)
}

/// Quick extraction of project info from session file (reads only first few lines)
/// Returns (project_path, session_id, updated_at)
fn quick_extract_project_info(path: &std::path::Path) -> Option<(String, String, u64)> {
    use std::io::{BufRead, BufReader};
    
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let first_line = reader.lines().next()?.ok()?;
    let meta: serde_json::Value = serde_json::from_str(&first_line).ok()?;
    
    if meta["type"].as_str()? != "session_meta" {
        return None;
    }
    
    let payload = &meta["payload"];
    let session_id = payload["id"].as_str()?.to_string();
    let timestamp_str = payload["timestamp"].as_str()?;
    let created_at = chrono::DateTime::parse_from_rfc3339(timestamp_str)
        .ok()?
        .timestamp() as u64;
    
    let cwd_raw = payload["cwd"].as_str()?;
    
    #[cfg(target_os = "windows")]
    let project_path = {
        if cwd_raw.starts_with("/mnt/") {
            wsl_utils::wsl_to_windows_path(cwd_raw)
        } else {
            cwd_raw.to_string()
        }
    };
    #[cfg(not(target_os = "windows"))]
    let project_path = cwd_raw.to_string();
    
    // Get file modification time as updated_at (more accurate than parsing all events)
    let updated_at = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(created_at);
    
    Some((project_path, session_id, updated_at))
}

/// Quick extraction of project path from session file (reads only first line)
fn quick_extract_project_path(path: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let first_line = reader.lines().next()?.ok()?;
    let meta: serde_json::Value = serde_json::from_str(&first_line).ok()?;
    
    if meta["type"].as_str()? != "session_meta" {
        return None;
    }
    
    let cwd_raw = meta["payload"]["cwd"].as_str()?;
    
    #[cfg(target_os = "windows")]
    {
        if cwd_raw.starts_with("/mnt/") {
            Some(wsl_utils::wsl_to_windows_path(cwd_raw))
        } else {
            Some(cwd_raw.to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(cwd_raw.to_string())
    }
}

/// Parses a Codex session JSONL file to extract metadata
/// Optimized: Reads first 50 lines for first_message, last 100 lines for last_assistant_message
pub fn parse_codex_session_file(path: &std::path::Path) -> Option<CodexSession> {
    use std::io::{BufRead, BufReader};

    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();

    // Read first line (session_meta)
    let first_line = lines.next()?.ok()?;
    let meta: serde_json::Value = serde_json::from_str(&first_line).ok()?;

    if meta["type"].as_str()? != "session_meta" {
        return None;
    }

    let payload = &meta["payload"];
    let session_id = payload["id"].as_str()?.to_string();
    let timestamp_str = payload["timestamp"].as_str()?;
    let created_at = chrono::DateTime::parse_from_rfc3339(timestamp_str)
        .ok()?
        .timestamp() as u64;

    // Get cwd and convert from WSL path format if needed
    let cwd_raw = payload["cwd"].as_str().unwrap_or("");
    #[cfg(target_os = "windows")]
    let cwd = {
        if cwd_raw.starts_with("/mnt/") {
            wsl_utils::wsl_to_windows_path(cwd_raw)
        } else {
            cwd_raw.to_string()
        }
    };
    #[cfg(not(target_os = "windows"))]
    let cwd = cwd_raw.to_string();

    // Extract first user message (read first 50 lines)
    let mut first_message: Option<String> = None;
    let mut last_timestamp: Option<String> = None;
    let mut model: Option<String> = None;
    let mut line_count = 0;
    const MAX_LINES_FOR_FIRST_MSG: usize = 50;

    for line_result in lines {
        line_count += 1;
        if first_message.is_some() || line_count > MAX_LINES_FOR_FIRST_MSG {
            break;
        }
        
        if let Ok(line) = line_result {
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(ts) = event["timestamp"].as_str() {
                    last_timestamp = Some(ts.to_string());
                }

                if event["type"].as_str() == Some("session_meta") {
                    if let Some(m) = event["payload"]["model"].as_str() {
                        model = Some(m.to_string());
                    }
                }

                if event["type"].as_str() == Some("response_item") {
                    if let Some(payload_obj) = event["payload"].as_object() {
                        let role = payload_obj.get("role").and_then(|r| r.as_str());
                        
                        if first_message.is_none() && role == Some("user") {
                            if let Some(content) = payload_obj.get("content").and_then(|c| c.as_array()) {
                                for item in content {
                                    if item["type"].as_str() == Some("input_text") {
                                        if let Some(text) = item["text"].as_str() {
	                                            // Skip IDE context and system content
	                                            if text.contains("<environment_context>")
	                                                || text.contains("# AGENTS.md instructions")
	                                                || text.contains("<permissions instructions>")
	                                                || text.is_empty()
	                                                || text.trim().is_empty() {
	                                                continue;
	                                            }
                                            
                                            // If text contains IDE context header, try to extract actual request
                                            if text.starts_with("# Context from my IDE setup:") {
                                                // Try to find "## My request for Codex:" section
                                                if let Some(request_start) = text.find("## My request for Codex:") {
                                                    let request_text = &text[request_start + "## My request for Codex:".len()..];
                                                    let request_text = request_text.trim();
                                                    if !request_text.is_empty() {
                                                        first_message = Some(request_text.to_string());
                                                        break;
                                                    }
                                                }
                                                continue;
                                            }
                                            
                                            first_message = Some(text.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Read last part of file for last_assistant_message and last_timestamp
    // Seek to end minus ~64KB to read last portion efficiently
    let last_assistant_message = extract_last_assistant_message_from_tail(path);
    let final_timestamp = extract_last_timestamp_from_tail(path).or(last_timestamp.clone());

    let updated_at = final_timestamp
        .as_ref()
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|dt| dt.timestamp() as u64)
        .unwrap_or(created_at);

    Some(CodexSession {
        id: session_id,
        project_path: cwd,
        created_at,
        updated_at,
        mode: CodexExecutionMode::ReadOnly,
        model,
        status: "completed".to_string(),
        first_message,
        last_assistant_message,
        last_message_timestamp: final_timestamp,
    })
}

/// Extracts the last assistant message by reading the tail of the file
fn extract_last_assistant_message_from_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    
    let file = std::fs::File::open(path).ok()?;
    let file_size = file.metadata().ok()?.len();
    let mut reader = BufReader::new(file);
    
    // Read last 64KB of file (should contain recent messages)
    let seek_pos = if file_size > 65536 { file_size - 65536 } else { 0 };
    reader.seek(SeekFrom::Start(seek_pos)).ok()?;
    
    // Skip partial first line if we seeked
    if seek_pos > 0 {
        let mut _skip = String::new();
        reader.read_line(&mut _skip).ok()?;
    }
    
    let mut last_assistant_message: Option<String> = None;
    
    for line_result in reader.lines() {
        if let Ok(line) = line_result {
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if event["type"].as_str() == Some("response_item") {
                    if let Some(payload_obj) = event["payload"].as_object() {
                        if payload_obj.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                            if let Some(content) = payload_obj.get("content").and_then(|c| c.as_array()) {
                                for item in content {
                                    if item["type"].as_str() == Some("output_text") {
                                        if let Some(text) = item["text"].as_str() {
                                            if !text.is_empty() && text.trim().len() > 0 {
                                                // Truncate to 500 chars (UTF-8 safe)
                                                let summary: String = text.chars().take(500).collect();
                                                let summary = if text.chars().count() > 500 {
                                                    format!("{}...", summary)
                                                } else {
                                                    summary
                                                };
                                                last_assistant_message = Some(summary);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    last_assistant_message
}

/// Extracts the last timestamp from the tail of the file
fn extract_last_timestamp_from_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    
    let file = std::fs::File::open(path).ok()?;
    let file_size = file.metadata().ok()?.len();
    let mut reader = BufReader::new(file);
    
    // Read last 16KB for timestamp
    let seek_pos = if file_size > 16384 { file_size - 16384 } else { 0 };
    reader.seek(SeekFrom::Start(seek_pos)).ok()?;
    
    if seek_pos > 0 {
        let mut _skip = String::new();
        reader.read_line(&mut _skip).ok()?;
    }
    
    let mut last_timestamp: Option<String> = None;
    
    for line_result in reader.lines() {
        if let Ok(line) = line_result {
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(ts) = event["timestamp"].as_str() {
                    last_timestamp = Some(ts.to_string());
                }
            }
        }
    }
    
    last_timestamp
}

/// Loads Codex session history from JSONL file
/// On Windows with WSL mode, reads from WSL filesystem via UNC path
#[tauri::command]
pub async fn load_codex_session_history(session_id: String) -> Result<Vec<serde_json::Value>, String> {
    log::info!("load_codex_session_history called for: {}", session_id);

    // Use unified sessions directory function (supports WSL)
    let sessions_dir = get_codex_sessions_dir()?;

    // Search for file containing this session_id
    let session_file = find_session_file(&sessions_dir, &session_id)?;

    // Read and parse JSONL file
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(&session_file)
        .map_err(|e| format!("Failed to open session file: {}", e))?;

    let reader = BufReader::new(file);
    let mut events = Vec::new();
    let mut line_count = 0;
    let mut parse_errors = 0;

    for line_result in reader.lines() {
        line_count += 1;
        match line_result {
            Ok(line) => {
                if line.trim().is_empty() {
                    continue; // Skip empty lines
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(event) => {
                        events.push(event);
                    }
                    Err(e) => {
                        parse_errors += 1;
                        log::warn!("Failed to parse line {} in session {}: {}", line_count, session_id, e);
                        log::debug!("Problematic line content: {}", line);
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to read line {} in session {}: {}", line_count, session_id, e);
            }
        }
    }

    log::info!("Loaded {} events from Codex session {} (total lines: {}, parse errors: {})",
        events.len(), session_id, line_count, parse_errors);
    Ok(events)
}

/// Finds the JSONL file for a given session ID
pub fn find_session_file(
    sessions_dir: &std::path::Path,
    session_id: &str,
) -> Result<std::path::PathBuf, String> {
    use walkdir::WalkDir;
    use std::io::{BufRead, BufReader};

    log::info!(
        "[find_session_file] Searching for session {} in {:?}",
        session_id,
        sessions_dir
    );

    // 验证目录存在
    if !sessions_dir.exists() {
        let err = format!(
            "Sessions directory does not exist: {:?}. Please ensure Codex has been run at least once.",
            sessions_dir
        );
        log::error!("[find_session_file] {}", err);
        return Err(err);
    }

    // 验证目录可访问
    if let Err(e) = std::fs::read_dir(sessions_dir) {
        let err = format!(
            "Cannot access sessions directory: {:?}. Error: {}",
            sessions_dir, e
        );
        log::error!("[find_session_file] {}", err);
        return Err(err);
    }

    let mut files_searched = 0;
    let mut jsonl_files = 0;

    for entry in WalkDir::new(sessions_dir).into_iter().flatten() {
        let path = entry.path();
        
        if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            jsonl_files += 1;
            files_searched += 1;

            log::debug!("[find_session_file] Checking file: {:?}", path);

            match std::fs::File::open(path) {
                Ok(file) => {
                    let reader = BufReader::new(file);
                    if let Some(Ok(first_line)) = reader.lines().next() {
                        match serde_json::from_str::<serde_json::Value>(&first_line) {
                            Ok(meta) => {
                                if meta["type"].as_str() == Some("session_meta") {
                                    if let Some(id) = meta["payload"]["id"].as_str() {
                                        if id == session_id {
                                            log::info!(
                                                "[find_session_file] Found session file: {:?}",
                                                path
                                            );
                                            return Ok(path.to_path_buf());
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                log::debug!(
                                    "[find_session_file] Failed to parse first line of {:?}: {}",
                                    path,
                                    e
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    log::debug!(
                        "[find_session_file] Failed to open file {:?}: {}",
                        path,
                        e
                    );
                }
            }
        }
    }

    let err = format!(
        "Session file not found for ID: {}. Searched {} JSONL files in {:?}. \
        The session may have been deleted or the session ID is incorrect.",
        session_id,
        jsonl_files,
        sessions_dir
    );
    log::warn!("[find_session_file] {}", err);
    Err(err)
}

/// Deletes a Codex session
/// On Windows with WSL mode, deletes from WSL filesystem via UNC path
#[tauri::command]
pub async fn delete_codex_session(session_id: String) -> Result<String, String> {
    log::info!("delete_codex_session called for: {}", session_id);

    // Use unified sessions directory function (supports WSL)
    let sessions_dir = get_codex_sessions_dir()?;

    // Find the session file
    let session_file = find_session_file(&sessions_dir, &session_id)?;

    // Delete the file
    std::fs::remove_file(&session_file)
        .map_err(|e| format!("Failed to delete session file: {}", e))?;

    log::info!("Successfully deleted Codex session file: {:?}", session_file);
    Ok(format!("Session {} deleted", session_id))
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Builds a Codex command with the given options
/// Returns (Command, Option<String>) where the String is the prompt to be passed via stdin
/// Supports both native execution and WSL mode on Windows
fn build_codex_command(
    options: &CodexExecutionOptions,
    is_resume: bool,
    session_id: Option<&str>,
) -> Result<(Command, Option<String>), String> {
    // Check if we should use WSL mode on Windows
    #[cfg(target_os = "windows")]
    {
        let wsl_config = wsl_utils::get_wsl_config();
        if wsl_config.enabled {
            log::info!("[Codex] Using WSL mode (distro: {:?})", wsl_config.distro);
            return build_wsl_codex_command(options, is_resume, session_id, &wsl_config);
        }
    }

    // Native mode: Use system-installed Codex
    let (_env_info, detected) = detect_binary_for_tool("codex", "CODEX_PATH", "codex");
    let codex_cmd = if let Some(inst) = detected {
        log::info!(
            "[Codex] Using detected binary: {} (source: {}, version: {:?})",
            inst.path,
            inst.source,
            inst.version
        );
        inst.path
    } else {
        log::warn!("[Codex] No detected binary, fallback to 'codex' in PATH");
        "codex".to_string()
    };

    let mut cmd = Command::new(&codex_cmd);
    cmd.arg("exec");

    // CRITICAL: --json MUST come before 'resume' (if used)
    // Correct order: codex exec --json resume <SESSION_ID> <PROMPT>
    // This enables JSON output for both new and resume sessions

    // Add --json flag first (works for both new and resume)
    if options.json {
        cmd.arg("--json");
    }

    // Allow bypassing git/trust checks (works for both new and resume sessions)
    // IMPORTANT: This must be placed before 'resume' subcommand.
    if options.skip_git_repo_check {
        cmd.arg("--skip-git-repo-check");
    }

    if is_resume {
        // Add 'resume' after --json
        cmd.arg("resume");

        // Add session_id
        if let Some(sid) = session_id {
            cmd.arg(sid);
        }

        // Resume mode: other options are NOT supported
        // The session retains its original mode/model configuration
    } else {
        // For new sessions: add other options
        // (--json already added above)

        match options.mode {
            CodexExecutionMode::FullAuto => {
                cmd.arg("--full-auto");
            }
            CodexExecutionMode::DangerFullAccess => {
                cmd.arg("--sandbox");
                cmd.arg("danger-full-access");
            }
            CodexExecutionMode::ReadOnly => {
                // Read-only is default
            }
        }

        if let Some(ref model) = options.model {
            cmd.arg("--model");
            cmd.arg(model);
        }

        if let Some(ref schema) = options.output_schema {
            cmd.arg("--output-schema");
            cmd.arg(schema);
        }

        if let Some(ref file) = options.output_file {
            cmd.arg("-o");
            cmd.arg(file);
        }

    }

    // Set working directory
    cmd.current_dir(&options.project_path);

    // Set API key environment variable if provided
    if let Some(ref api_key) = options.api_key {
        cmd.env("CODEX_API_KEY", api_key);
    }

    // FIX: Pass prompt via stdin instead of command line argument
    // This fixes issues with:
    // 1. Command line length limits (Windows: ~8191 chars)
    // 2. Special characters (newlines, quotes, etc.)
    // 3. Formatted text (markdown, code blocks)

    // Add "-" to indicate reading from stdin (common CLI convention)
    cmd.arg("-");

    let prompt_for_stdin = if is_resume {
        // For resume mode, prompt is still needed but passed via stdin
        Some(options.prompt.clone())
    } else {
        // For new sessions, pass prompt via stdin
        Some(options.prompt.clone())
    };

    Ok((cmd, prompt_for_stdin))
}

/// Builds a Codex command for WSL mode
/// This is used when Codex is installed in WSL and we're running on Windows
#[cfg(target_os = "windows")]
fn build_wsl_codex_command(
    options: &CodexExecutionOptions,
    is_resume: bool,
    session_id: Option<&str>,
    wsl_config: &wsl_utils::WslConfig,
) -> Result<(Command, Option<String>), String> {
    // Build arguments for codex command
    let mut args: Vec<String> = vec!["exec".to_string()];

    // Add --json flag first (must come before 'resume')
    if options.json {
        args.push("--json".to_string());
    }

    // Allow bypassing git/trust checks (must come before 'resume')
    if options.skip_git_repo_check {
        args.push("--skip-git-repo-check".to_string());
    }

    if is_resume {
        args.push("resume".to_string());
        if let Some(sid) = session_id {
            args.push(sid.to_string());
        }
    } else {
        match options.mode {
            CodexExecutionMode::FullAuto => {
                args.push("--full-auto".to_string());
            }
            CodexExecutionMode::DangerFullAccess => {
                args.push("--sandbox".to_string());
                args.push("danger-full-access".to_string());
            }
            CodexExecutionMode::ReadOnly => {}
        }

        if let Some(ref model) = options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(ref schema) = options.output_schema {
            args.push("--output-schema".to_string());
            args.push(schema.clone());
        }

        if let Some(ref file) = options.output_file {
            args.push("-o".to_string());
            // Convert output file path to WSL format
            args.push(wsl_utils::windows_to_wsl_path(file));
        }

    }

    // Add stdin indicator
    args.push("-".to_string());

    // Build WSL command with path conversion
    // project_path is Windows format (C:\...), will be converted to WSL format (/mnt/c/...)
    let mut cmd = wsl_utils::build_wsl_command_async(
        "codex",
        &args,
        Some(&options.project_path),
        wsl_config.distro.as_deref(),
    );

    // Set API key environment variable if provided
    // Note: This will be passed to WSL environment
    if let Some(ref api_key) = options.api_key {
        cmd.env("CODEX_API_KEY", api_key);
    }

    log::info!(
        "[Codex WSL] Command built: wsl -d {:?} --cd {} -- codex {:?}",
        wsl_config.distro,
        wsl_utils::windows_to_wsl_path(&options.project_path),
        args
    );

    Ok((cmd, Some(options.prompt.clone())))
}

/// Executes a Codex process and streams output to frontend
async fn execute_codex_process(
    mut cmd: Command,
    prompt: Option<String>,
    project_path: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    // Setup stdio
    cmd.stdin(Stdio::piped());   // Enable stdin to pass prompt
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Fix: Apply platform-specific no-window configuration to hide console
    // This prevents the terminal window from flashing when starting Codex sessions
    apply_no_window_async(&mut cmd);

    // Spawn process
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex: {}", e))?;

    // FIX: Write prompt to stdin if provided
    // This avoids command line length limits and special character issues
    if let Some(prompt_text) = prompt {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;

            log::debug!("Writing prompt to stdin ({} bytes)", prompt_text.len());

            if let Err(e) = stdin.write_all(prompt_text.as_bytes()).await {
                log::error!("Failed to write prompt to stdin: {}", e);
                return Err(format!("Failed to write prompt to stdin: {}", e));
            }

            // Close stdin to signal end of input
            drop(stdin);
            log::debug!("Stdin closed successfully");
        } else {
            log::error!("Failed to get stdin handle");
            return Err("Failed to get stdin handle".to_string());
        }
    }

    // Extract stdout and stderr
    let stdout = child.stdout.take()
        .ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take()
        .ok_or("Failed to capture stderr")?;

    // Generate session ID for tracking
    let session_id = format!("codex-{}", uuid::Uuid::new_v4());

    // 🆕 Initialize change tracker for this session
    super::change_tracker::init_change_tracker(&session_id, &project_path);
    log::info!("[ChangeTracker] Initialized for session: {}", session_id);

    // Store process in state
    let state: tauri::State<'_, CodexProcessState> = app_handle.state();
    {
        let mut processes = state.processes.lock().await;
        processes.insert(session_id.clone(), child);

        let mut last_session = state.last_session_id.lock().await;
        *last_session = Some(session_id.clone());
    }

    // Clone handles for async tasks
    let app_handle_stdout = app_handle.clone();
    let app_handle_stderr = app_handle.clone();
    let app_handle_complete = app_handle.clone();
    let session_id_stdout = session_id.clone();  // Clone for stdout task
    let session_id_stderr = session_id.clone();
    let session_id_complete = session_id.clone();

    // FIX: Emit session init event immediately so frontend can subscribe to the correct channel
    // This event is sent on the global channel, frontend will use this to switch to session-specific listeners
    let init_payload = serde_json::json!({
        "type": "session_init",
        "session_id": session_id
    });
    if let Err(e) = app_handle.emit("codex-session-init", init_payload) {
        log::error!("Failed to emit codex-session-init: {}", e);
    }
    log::info!("Codex session initialized with ID: {}", session_id);

    // Spawn task to read stdout (JSONL events)
    // FIX: Emit to both session-specific and global channels for proper multi-tab isolation
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.trim().is_empty() {
                log::debug!("Codex output: {}", line);
                // Emit to session-specific channel first (for multi-tab isolation)
                if let Err(e) = app_handle_stdout.emit(&format!("codex-output:{}", session_id_stdout), &line) {
                    log::error!("Failed to emit codex-output (session-specific): {}", e);
                }
                // Also emit to global channel for backward compatibility
                if let Err(e) = app_handle_stdout.emit("codex-output", &line) {
                    log::error!("Failed to emit codex-output (global): {}", e);
                }
            }
        }
    });

    // Spawn task to read stderr (log errors, suppress debug output)
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // Log error messages for debugging
            if !line.trim().is_empty() {
                log::warn!("Codex stderr: {}", line);

                // Emit stderr lines so frontend can surface failures (e.g., git/trust checks)
                if let Err(e) = app_handle_stderr.emit(
                    &format!("codex-error:{}", session_id_stderr),
                    &line,
                ) {
                    log::error!("Failed to emit codex-error (session-specific): {}", e);
                }

                // Global fallback for backward compatibility
                if let Err(e) = app_handle_stderr.emit("codex-error", &line) {
                    log::error!("Failed to emit codex-error (global): {}", e);
                }
            }
        }
    });

    // Spawn task to wait for process completion
    // FIX: Use polling with try_wait() instead of removing process before wait()
    // This ensures the process stays in the HashMap while running, allowing cancel_codex to find and kill it
    tokio::spawn(async move {
        let state: tauri::State<'_, CodexProcessState> = app_handle_complete.state();

        // Poll for process completion without removing it from the HashMap
        // This allows cancel_codex to find and kill the process at any time
        let exit_status: Option<std::process::ExitStatus> = loop {
            let mut processes = state.processes.lock().await;

            if let Some(child) = processes.get_mut(&session_id_complete) {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // Process has completed, now remove it from HashMap
                        processes.remove(&session_id_complete);
                        break Some(status);
                    }
                    Ok(None) => {
                        // Process still running, release lock and wait before polling again
                        drop(processes);
                        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                    }
                    Err(e) => {
                        log::error!("Error checking process status: {}", e);
                        processes.remove(&session_id_complete);
                        break None;
                    }
                }
            } else {
                // Process was removed by cancel_codex, stop polling
                log::info!("Process {} was cancelled, stopping wait task", session_id_complete);
                break None;
            }
        };

        if let Some(status) = exit_status {
            log::info!("Codex process exited with status: {}", status);
        }

        // Emit completion event
        // FIX: Emit to both session-specific and global channels for proper multi-tab isolation
        if let Err(e) = app_handle_complete.emit(&format!("codex-complete:{}", session_id_complete), true) {
            log::error!("Failed to emit codex-complete (session-specific): {}", e);
        }
        // Also emit to global channel for backward compatibility
        if let Err(e) = app_handle_complete.emit("codex-complete", true) {
            log::error!("Failed to emit codex-complete (global): {}", e);
        }
    });

    Ok(())
}
