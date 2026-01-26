use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use regex::Regex;
use dirs;
use rusqlite;



use super::paths::{get_claude_dir, get_codex_dir};
use super::platform;
use crate::commands::permission_config::{
    ClaudeExecutionConfig, ClaudePermissionConfig, PermissionMode,
    DEVELOPMENT_TOOLS, SAFE_TOOLS, ALL_TOOLS
};
use super::{ClaudeMdFile, ClaudeSettings, ClaudeVersionStatus};

#[tauri::command]
pub async fn get_claude_settings() -> Result<ClaudeSettings, String> {
    log::info!("Reading Claude settings");

    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let settings_path = claude_dir.join("settings.json");

    if !settings_path.exists() {
        log::warn!("Settings file not found, returning empty settings");
        return Ok(ClaudeSettings {
            data: serde_json::json!({}),
        });
    }

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings JSON: {}", e))?;

    Ok(ClaudeSettings { data })
}

/// Opens a new Claude Code session by executing the claude command
#[tauri::command]
pub async fn open_new_session(app: AppHandle, path: Option<String>) -> Result<String, String> {
    log::info!("Opening new Claude Code session at path: {:?}", path);

    #[cfg(not(debug_assertions))]
    let _claude_path = crate::claude_binary::find_claude_binary(&app)?;

    #[cfg(debug_assertions)]
    let claude_path = crate::claude_binary::find_claude_binary(&app)?;

    // In production, we can't use std::process::Command directly
    // The user should launch Claude Code through other means or use the execute_claude_code command
    #[cfg(not(debug_assertions))]
    {
        log::error!("Cannot spawn processes directly in production builds");
        return Err("Direct process spawning is not available in production builds. Please use Claude Code directly or use the integrated execution commands.".to_string());
    }

    #[cfg(debug_assertions)]
    {
        let mut cmd = std::process::Command::new(claude_path);

        // If a path is provided, use it; otherwise use current directory
        if let Some(project_path) = path {
            cmd.current_dir(&project_path);
        }

        // 🔥 Fix: Apply platform-specific no-window configuration to hide console
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        // Execute the command
        match cmd.spawn() {
            Ok(_) => {
                log::info!("Successfully launched Claude Code");
                Ok("Claude Code session started".to_string())
            }
            Err(e) => {
                log::error!("Failed to launch Claude Code: {}", e);
                Err(format!("Failed to launch Claude Code: {}", e))
            }
        }
    }
}

/// Reads the CLAUDE.md system prompt file
#[tauri::command]
pub async fn get_system_prompt() -> Result<String, String> {
    log::info!("Reading CLAUDE.md system prompt");

    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let claude_md_path = claude_dir.join("CLAUDE.md");

    if !claude_md_path.exists() {
        log::warn!("CLAUDE.md not found");
        return Ok(String::new());
    }

    fs::read_to_string(&claude_md_path).map_err(|e| format!("Failed to read CLAUDE.md: {}", e))
}

/// Checks if Claude Code is installed and gets its version
#[tauri::command]
pub async fn check_claude_version(app: AppHandle) -> Result<ClaudeVersionStatus, String> {
    log::info!("Checking Claude Code version");

    let claude_path = match crate::claude_binary::find_claude_binary(&app) {
        Ok(path) => path,
        Err(e) => {
            return Ok(ClaudeVersionStatus {
                is_installed: false,
                version: None,
                output: e,
            });
        }
    };

    // If the selected path is the special sidecar identifier, execute it to get version
    if claude_path == "claude-code" {
        use tauri_plugin_shell::process::CommandEvent;
        
        // Create a temporary directory for the sidecar to run in
        let temp_dir = std::env::temp_dir();
        
        // Create sidecar command with --version flag
        let sidecar_cmd = match app
            .shell()
            .sidecar("claude-code") {
            Ok(cmd) => cmd.args(["--version"]).current_dir(&temp_dir),
            Err(e) => {
                log::error!("Failed to create sidecar command: {}", e);
                return Ok(ClaudeVersionStatus {
                    is_installed: true, // We know it exists, just couldn't create command
                    version: None,
                    output: format!("Using bundled Claude Code sidecar (command creation failed: {})", e),
                });
            }
        };
        
        // Spawn the sidecar and collect output
        match sidecar_cmd.spawn() {
            Ok((mut rx, _child)) => {
                let mut stdout_output = String::new();
                let mut stderr_output = String::new();
                let mut exit_success = false;
                
                // Collect output from the sidecar
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(data) => {
                            let line = String::from_utf8_lossy(&data);
                            stdout_output.push_str(&line);
                        }
                        CommandEvent::Stderr(data) => {
                            let line = String::from_utf8_lossy(&data);
                            stderr_output.push_str(&line);
                        }
                        CommandEvent::Terminated(payload) => {
                            exit_success = payload.code.unwrap_or(-1) == 0;
                            break;
                        }
                        _ => {}
                    }
                }
                
                // Use regex to directly extract version pattern (e.g., "1.0.41")
                let version_regex = Regex::new(r"(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)").ok();
                
                let version = if let Some(regex) = version_regex {
                    regex.captures(&stdout_output)
                        .and_then(|captures| captures.get(1))
                        .map(|m| m.as_str().to_string())
                } else {
                    None
                };
                
                let full_output = if stderr_output.is_empty() {
                    stdout_output.clone()
                } else {
                    format!("{}\n{}", stdout_output, stderr_output)
                };

                // Check if the output matches the expected format
                let is_valid = stdout_output.contains("(Claude Code)") || stdout_output.contains("Claude Code") || version.is_some();

                return Ok(ClaudeVersionStatus {
                    is_installed: is_valid && exit_success,
                    version,
                    output: full_output.trim().to_string(),
                });
            }
            Err(e) => {
                log::error!("Failed to execute sidecar: {}", e);
                return Ok(ClaudeVersionStatus {
                    is_installed: true, // We know it exists, just couldn't get version
                    version: None,
                    output: format!("Using bundled Claude Code sidecar (version check failed: {})", e),
                });
            }
        }
    }

    use log::debug;
    debug!("Claude path: {}", claude_path);

    // For system installations, try to check version
    let mut cmd = std::process::Command::new(&claude_path);
    cmd.arg("--version");
    
    // On Windows, ensure the command runs without creating a console window
    #[cfg(target_os = "windows")]
    {
        platform::apply_no_window(&mut cmd);
    }
    
    let output = cmd.output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            
            // Use regex to directly extract version pattern (e.g., "1.0.41")
            let version_regex = Regex::new(r"(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)").ok();
            
            let version = if let Some(regex) = version_regex {
                regex.captures(&stdout)
                    .and_then(|captures| captures.get(1))
                    .map(|m| m.as_str().to_string())
            } else {
                None
            };
            let full_output = if stderr.is_empty() {
                stdout.clone()
            } else {
                format!("{}\n{}", stdout, stderr)
            };

            // Check if the output matches the expected format
            // Expected format: "1.0.17 (Claude Code)" or similar
            let is_valid = stdout.contains("(Claude Code)") || stdout.contains("Claude Code");

            Ok(ClaudeVersionStatus {
                is_installed: is_valid && output.status.success(),
                version,
                output: full_output.trim().to_string(),
            })
        }
        Err(e) => {
            log::error!("Failed to run claude command: {}", e);
            Ok(ClaudeVersionStatus {
                is_installed: false,
                version: None,
                output: format!("Command not found: {}", e),
            })
        }
    }
}

/// Saves the CLAUDE.md system prompt file
#[tauri::command]
pub async fn save_system_prompt(content: String) -> Result<String, String> {
    log::info!("Saving CLAUDE.md system prompt");

    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let claude_md_path = claude_dir.join("CLAUDE.md");

    fs::write(&claude_md_path, content).map_err(|e| format!("Failed to write CLAUDE.md: {}", e))?;

    Ok("System prompt saved successfully".to_string())
}

/// Saves the Claude settings file
#[tauri::command]
pub async fn save_claude_settings(settings: serde_json::Value) -> Result<String, String> {
    log::info!("Saving Claude settings - received data: {}", settings.to_string());

    let claude_dir = get_claude_dir().map_err(|e| {
        let error_msg = format!("Failed to get claude dir: {}", e);
        log::error!("{}", error_msg);
        error_msg
    })?;
    log::info!("Claude directory: {:?}", claude_dir);

    let settings_path = claude_dir.join("settings.json");
    log::info!("Settings path: {:?}", settings_path);

    // Read existing settings to preserve unknown fields
    let mut existing_settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).ok();
        if let Some(content) = content {
            serde_json::from_str::<serde_json::Value>(&content).ok()
        } else {
            None
        }
    } else {
        None
    }.unwrap_or(serde_json::json!({}));

    log::info!("Existing settings: {}", existing_settings);

    // Use settings directly - no wrapper expected from frontend
    let actual_settings = &settings;
    log::info!("Using settings directly: {}", actual_settings);

    // Merge the new settings with existing settings
    // This preserves unknown fields that the app doesn't manage
    if let (Some(existing_obj), Some(new_obj)) = (existing_settings.as_object_mut(), actual_settings.as_object()) {
        for (key, value) in new_obj {
            existing_obj.insert(key.clone(), value.clone());
        }
        log::info!("Merged settings: {}", existing_settings);
    } else {
        // If either is not an object, just use the new settings
        existing_settings = actual_settings.clone();
    }

    // Pretty print the JSON with 2-space indentation
    let json_string = serde_json::to_string_pretty(&existing_settings)
        .map_err(|e| {
            let error_msg = format!("Failed to serialize settings: {}", e);
            log::error!("{}", error_msg);
            error_msg
        })?;

    log::info!("Serialized JSON length: {} characters", json_string.len());

    fs::write(&settings_path, &json_string)
        .map_err(|e| {
            let error_msg = format!("Failed to write settings file: {}", e);
            log::error!("{}", error_msg);
            error_msg
        })?;

    log::info!("Settings saved successfully to: {:?}", settings_path);
    Ok("Settings saved successfully".to_string())
}

/// Updates the thinking mode in settings.json by modifying the MAX_THINKING_TOKENS env variable
#[tauri::command]
pub async fn update_thinking_mode(enabled: bool, tokens: Option<u32>) -> Result<String, String> {
    log::info!("Updating thinking mode: enabled={}, tokens={:?}", enabled, tokens);

    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let settings_path = claude_dir.join("settings.json");

    // Read existing settings
    let mut settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?
    } else {
        serde_json::json!({})
    };

    // Ensure env object exists
    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    let settings_obj = settings.as_object_mut().unwrap();
    if !settings_obj.contains_key("env") {
        settings_obj.insert("env".to_string(), serde_json::json!({}));
    }

    let env_obj = settings_obj.get_mut("env").unwrap().as_object_mut()
        .ok_or("env is not an object")?;

    // Update MAX_THINKING_TOKENS
    if enabled {
        let token_value = tokens.unwrap_or(31999);
        env_obj.insert("MAX_THINKING_TOKENS".to_string(), serde_json::json!(token_value.to_string()));
        log::info!("Set MAX_THINKING_TOKENS to {}", token_value);
    } else {
        env_obj.remove("MAX_THINKING_TOKENS");
        log::info!("Removed MAX_THINKING_TOKENS from env");
    }

    // Also remove the old alwaysThinkingEnabled field if it exists
    // This field conflicts with the standard MAX_THINKING_TOKENS approach
    if settings_obj.contains_key("alwaysThinkingEnabled") {
        settings_obj.remove("alwaysThinkingEnabled");
        log::info!("Removed deprecated alwaysThinkingEnabled field");
    }

    // Write back to file
    let json_string = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, &json_string)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    log::info!("Thinking mode updated successfully");
    Ok(format!("Thinking mode {} successfully", if enabled { "enabled" } else { "disabled" }))
}

/// Recursively finds all CLAUDE.md files in a project directory
#[tauri::command]
pub async fn find_claude_md_files(project_path: String) -> Result<Vec<ClaudeMdFile>, String> {
    log::info!("Finding CLAUDE.md files in project: {}", project_path);

    let path = PathBuf::from(&project_path);
    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let mut claude_files = Vec::new();
    find_claude_md_recursive(&path, &path, &mut claude_files)?;

    // Sort by relative path
    claude_files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    log::info!("Found {} CLAUDE.md files", claude_files.len());
    Ok(claude_files)
}

/// Helper function to recursively find CLAUDE.md files
fn find_claude_md_recursive(
    current_path: &PathBuf,
    project_root: &PathBuf,
    claude_files: &mut Vec<ClaudeMdFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(current_path)
        .map_err(|e| format!("Failed to read directory {:?}: {}", current_path, e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        // Skip hidden files/directories
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        if path.is_dir() {
            // Skip common directories that shouldn't be searched
            if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                if matches!(
                    dir_name,
                    "node_modules" | "target" | ".git" | "dist" | "build" | ".next" | "__pycache__"
                ) {
                    continue;
                }
            }

            find_claude_md_recursive(&path, project_root, claude_files)?;
        } else if path.is_file() {
            // Check if it's a CLAUDE.md file (case insensitive)
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.eq_ignore_ascii_case("CLAUDE.md") {
                    let metadata = fs::metadata(&path)
                        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

                    let relative_path = path
                        .strip_prefix(project_root)
                        .map_err(|e| format!("Failed to get relative path: {}", e))?
                        .to_string_lossy()
                        .to_string();

                    let modified = metadata
                        .modified()
                        .unwrap_or(SystemTime::UNIX_EPOCH)
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    claude_files.push(ClaudeMdFile {
                        relative_path,
                        absolute_path: path.to_string_lossy().to_string(),
                        size: metadata.len(),
                        modified,
                    });
                }
            }
        }
    }

    Ok(())
}

/// Reads a specific CLAUDE.md file by its absolute path
#[tauri::command]
pub async fn read_claude_md_file(file_path: String) -> Result<String, String> {
    log::info!("Reading CLAUDE.md file: {}", file_path);

    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

/// Saves a specific CLAUDE.md file by its absolute path
#[tauri::command]
pub async fn save_claude_md_file(file_path: String, content: String) -> Result<String, String> {
    log::info!("Saving CLAUDE.md file: {}", file_path);

    let path = PathBuf::from(&file_path);

    // Ensure the parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok("File saved successfully".to_string())
}
#[tauri::command]
pub async fn set_custom_claude_path(app: AppHandle, custom_path: String) -> Result<(), String> {
    log::info!("Setting custom Claude CLI path: {}", custom_path);

    let expanded_path = expand_user_path(&custom_path)?;

    // Validate the path exists and is executable
    if !expanded_path.exists() {
        return Err("File does not exist".to_string());
    }

    if !expanded_path.is_file() {
        return Err("Path is not a file".to_string());
    }

    let path_str = expanded_path
        .to_str()
        .ok_or_else(|| "Invalid path encoding".to_string())?
        .to_string();

    // Test if it's actually Claude CLI by running --version
    let mut cmd = std::process::Command::new(&path_str);
    cmd.arg("--version");

    #[cfg(target_os = "windows")]
    {
        platform::apply_no_window(&mut cmd);
    }

    match cmd.output() {
        Ok(output) => {
            if !output.status.success() {
                return Err("File is not a valid Claude CLI executable".to_string());
            }
        }
        Err(e) => {
            return Err(format!("Failed to test Claude CLI: {}", e));
        }
    }

    // Store the custom path in database
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
            return Err(format!("Failed to create app data directory: {}", e));
        }

        let db_path = app_data_dir.join("agents.db");
        match rusqlite::Connection::open(&db_path) {
            Ok(conn) => {
                if let Err(e) = conn.execute(
                    "CREATE TABLE IF NOT EXISTS app_settings (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    )",
                    [],
                ) {
                    return Err(format!("Failed to create settings table: {}", e));
                }

                if let Err(e) = conn.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                    rusqlite::params!["claude_binary_path", path_str],
                ) {
                    return Err(format!("Failed to store custom Claude path: {}", e));
                }

                log::info!("Successfully stored custom Claude CLI path: {}", path_str);
            }
            Err(e) => return Err(format!("Failed to open database: {}", e)),
        }
    } else {
        return Err("Failed to get app data directory".to_string());
    }

    // 记录到 binaries.json 供跨平台检测复用
    if let Err(e) = update_binary_override("claude", &path_str) {
        log::warn!("Failed to update binaries.json: {}", e);
    }

    Ok(())
}

/// Get current Claude CLI path (custom or auto-detected)
#[tauri::command]
pub async fn get_claude_path(app: AppHandle) -> Result<String, String> {
    log::info!("Getting current Claude CLI path");
    
    // Try to get from database first
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let db_path = app_data_dir.join("agents.db");
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(stored_path) = conn.query_row(
                    "SELECT value FROM app_settings WHERE key = 'claude_binary_path'",
                    [],
                    |row| row.get::<_, String>(0),
                ) {
                    log::info!("Found stored Claude path: {}", stored_path);
                    return Ok(stored_path);
                }
            }
        }
    }
    
    // Fall back to auto-detection
    match crate::claude_binary::find_claude_binary(&app) {
        Ok(path) => {
            log::info!("Auto-detected Claude path: {}", path);
            Ok(path)
        }
        Err(e) => Err(e),
    }
}

/// Clear custom Claude CLI path and revert to auto-detection
#[tauri::command]
pub async fn clear_custom_claude_path(app: AppHandle) -> Result<(), String> {
    log::info!("Clearing custom Claude CLI path");
    
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let db_path = app_data_dir.join("agents.db");
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Err(e) = conn.execute(
                    "DELETE FROM app_settings WHERE key = 'claude_binary_path'",
                    [],
                ) {
                    return Err(format!("Failed to clear custom Claude path: {}", e));
                }
            }
        }

        // 清理 binaries.json 覆盖记录（忽略错误）
        if let Err(e) = clear_binary_override("claude") {
            log::warn!("Failed to clear binaries.json override: {}", e);
        }

        log::info!("Successfully cleared custom Claude CLI path");
        return Ok(());
    }

    Err("Failed to get app data directory".to_string())
}

fn expand_user_path(input: &str) -> Result<PathBuf, String> {
    if input.trim().is_empty() {
        return Err("Path is empty".to_string());
    }

    let path = if input == "~" || input.starts_with("~/") {
        let home = dirs::home_dir().ok_or("Cannot find home directory".to_string())?;
        if input == "~" {
            home
        } else {
            home.join(input.trim_start_matches("~/"))
        }
    } else {
        PathBuf::from(input)
    };

    let path = if path.is_relative() {
        std::env::current_dir()
            .map_err(|e| format!("Failed to get current dir: {}", e))?
            .join(path)
    } else {
        path
    };

    Ok(path)
}

fn update_binary_override(tool: &str, override_path: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory".to_string())?;
    let config_path = home.join(".claude").join("binaries.json");

    // Ensure parent dir exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let mut json: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read binaries.json: {}", e))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let section = json
        .as_object_mut()
        .ok_or("Invalid binaries.json format (not an object)".to_string())?;

    let entry = section
        .entry(tool.to_string())
        .or_insert_with(|| serde_json::json!({}));

    if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "override_path".to_string(),
            serde_json::Value::String(override_path.to_string()),
        );
    }

    let serialized = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize binaries.json: {}", e))?;
    std::fs::write(&config_path, serialized)
        .map_err(|e| format!("Failed to write binaries.json: {}", e))?;

    Ok(())
}

fn clear_binary_override(tool: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory".to_string())?;
    let config_path = home.join(".claude").join("binaries.json");
    if !config_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read binaries.json: {}", e))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

    if let Some(section) = json.as_object_mut() {
        if let Some(entry) = section.get_mut(tool) {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("override_path");
            }
        }
    }

    let serialized = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize binaries.json: {}", e))?;
    std::fs::write(&config_path, serialized)
        .map_err(|e| format!("Failed to write binaries.json: {}", e))?;

    Ok(())
}
/// 获取当前Claude执行配置
#[tauri::command]
pub async fn get_claude_execution_config(_app: AppHandle) -> Result<ClaudeExecutionConfig, String> {
    let claude_dir = get_claude_dir()
        .map_err(|e| format!("Failed to get Claude directory: {}", e))?;
    let config_file = claude_dir.join("execution_config.json");
    
    if config_file.exists() {
        match fs::read_to_string(&config_file) {
            Ok(content) => {
                match serde_json::from_str::<ClaudeExecutionConfig>(&content) {
                    Ok(config) => {
                        log::info!("Loaded Claude execution config");
                        Ok(config)
                    }
                    Err(e) => {
                        log::warn!("Failed to parse execution config: {}, using default", e);
                        Ok(ClaudeExecutionConfig::default())
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to read execution config: {}, using default", e);
                Ok(ClaudeExecutionConfig::default())
            }
        }
    } else {
        log::info!("No execution config file found, using default");
        Ok(ClaudeExecutionConfig::default())
    }
}

/// 更新Claude执行配置
#[tauri::command]
pub async fn update_claude_execution_config(
    _app: AppHandle,
    config: ClaudeExecutionConfig,
) -> Result<(), String> {
    let claude_dir = get_claude_dir()
        .map_err(|e| format!("Failed to get Claude directory: {}", e))?;
    let config_file = claude_dir.join("execution_config.json");
    
    let json_string = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
        
    fs::write(&config_file, json_string)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
        
    log::info!("Updated Claude execution config");
    Ok(())
}

/// 重置Claude执行配置为默认值
#[tauri::command]
pub async fn reset_claude_execution_config(app: AppHandle) -> Result<(), String> {
    let config = ClaudeExecutionConfig::default();
    update_claude_execution_config(app, config).await
}

/// 获取当前权限配置
#[tauri::command]
pub async fn get_claude_permission_config(app: AppHandle) -> Result<ClaudePermissionConfig, String> {
    let execution_config = get_claude_execution_config(app).await?;
    Ok(execution_config.permissions)
}

/// 更新权限配置
#[tauri::command]
pub async fn update_claude_permission_config(
    app: AppHandle,
    permission_config: ClaudePermissionConfig,
) -> Result<(), String> {
    let mut execution_config = get_claude_execution_config(app.clone()).await?;
    execution_config.permissions = permission_config;
    update_claude_execution_config(app, execution_config).await
}

/// 获取预设权限配置选项
#[tauri::command]
pub async fn get_permission_presets() -> Result<serde_json::Value, String> {
    let presets = serde_json::json!({
        "development": {
            "name": "开发模式",
            "description": "允许所有开发工具，自动接受编辑",
            "config": ClaudePermissionConfig::development_mode()
        },
        "safe": {
            "name": "安全模式", 
            "description": "只允许读取操作，禁用危险工具",
            "config": ClaudePermissionConfig::safe_mode()
        },
        "interactive": {
            "name": "交互模式",
            "description": "平衡的权限设置，需要确认编辑",
            "config": ClaudePermissionConfig::interactive_mode()
        },
        "legacy": {
            "name": "向后兼容",
            "description": "保持原有的权限跳过行为",
            "config": ClaudePermissionConfig::legacy_mode()
        }
    });
    
    Ok(presets)
}

/// 获取可用工具列表
#[tauri::command]
pub async fn get_available_tools() -> Result<serde_json::Value, String> {
    let tools = serde_json::json!({
        "development_tools": DEVELOPMENT_TOOLS,
        "safe_tools": SAFE_TOOLS,
        "all_tools": ALL_TOOLS
    });
    
    Ok(tools)
}

/// 验证权限配置
#[tauri::command]
pub async fn validate_permission_config(
    config: ClaudePermissionConfig,
) -> Result<serde_json::Value, String> {
    let mut validation_result = serde_json::json!({
        "valid": true,
        "warnings": [],
        "errors": []
    });
    
    // 检查工具列表冲突
    let allowed_set: std::collections::HashSet<_> = config.allowed_tools.iter().collect();
    let disallowed_set: std::collections::HashSet<_> = config.disallowed_tools.iter().collect();
    
    let conflicts: Vec<_> = allowed_set.intersection(&disallowed_set).collect();
    if !conflicts.is_empty() {
        validation_result["valid"] = serde_json::Value::Bool(false);
        validation_result["errors"].as_array_mut().unwrap().push(
            serde_json::json!(format!("工具冲突: {} 同时在允许和禁止列表中", conflicts.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")))
        );
    }
    
    // 检查是否启用了危险跳过模式
    if config.enable_dangerous_skip {
        validation_result["warnings"].as_array_mut().unwrap().push(
            serde_json::json!("已启用危险权限跳过模式，这会绕过所有安全检查")
        );
    }
    
    // 检查读写权限组合
    if config.permission_mode == PermissionMode::ReadOnly && 
       (config.allowed_tools.contains(&"Write".to_string()) || 
        config.allowed_tools.contains(&"Edit".to_string())) {
        validation_result["warnings"].as_array_mut().unwrap().push(
            serde_json::json!("只读模式下允许写入工具可能导致冲突")
        );
    }
    
    Ok(validation_result)
}

/// Gets the effective Codex directory based on current mode (Windows native or WSL)
/// Returns (codex_dir_path, is_wsl_mode)
fn get_effective_codex_dir() -> Result<(std::path::PathBuf, bool), String> {
    #[cfg(target_os = "windows")]
    {
        use super::super::wsl_utils::get_wsl_config;
        
        let wsl_config = get_wsl_config();
        if wsl_config.enabled {
            // WSL 模式：使用 WSL 中的 .codex 目录
            if let Some(ref wsl_codex_dir) = wsl_config.codex_dir_unc {
                log::info!("Using WSL Codex directory: {:?}", wsl_codex_dir);
                return Ok((wsl_codex_dir.clone(), true));
            } else {
                return Err("WSL 模式已启用，但无法访问 WSL 中的 .codex 目录".to_string());
            }
        }
    }
    
    // Windows 原生模式或非 Windows 系统：使用本地 .codex 目录
    let codex_dir = get_codex_dir().map_err(|e| {
        format!("无法访问 Codex 目录: {}。请确保已安装 Codex CLI。", e)
    })?;
    
    Ok((codex_dir, false))
}

/// Reads the AGENTS.md system prompt file from Codex directory
/// Automatically selects Windows native or WSL path based on current Codex mode
#[tauri::command]
pub async fn get_codex_system_prompt() -> Result<String, String> {
    log::info!("Reading AGENTS.md system prompt from Codex directory");

    let (codex_dir, is_wsl) = get_effective_codex_dir().map_err(|e| {
        log::error!("Failed to get Codex directory: {}", e);
        e
    })?;
    
    log::info!("Using Codex directory: {:?} (WSL mode: {})", codex_dir, is_wsl);

    let agents_md_path = codex_dir.join("AGENTS.md");

    if !agents_md_path.exists() {
        log::warn!("AGENTS.md not found at {:?}", agents_md_path);
        return Ok(String::new());
    }

    fs::read_to_string(&agents_md_path).map_err(|e| {
        log::error!("Failed to read AGENTS.md: {}", e);
        format!("读取 AGENTS.md 失败: {}", e)
    })
}

/// Saves the AGENTS.md system prompt file to Codex directory
/// Automatically selects Windows native or WSL path based on current Codex mode
#[tauri::command]
pub async fn save_codex_system_prompt(content: String) -> Result<String, String> {
    log::info!("Saving AGENTS.md system prompt to Codex directory");

    let (codex_dir, is_wsl) = get_effective_codex_dir().map_err(|e| {
        log::error!("Failed to get Codex directory: {}", e);
        e
    })?;
    
    log::info!("Using Codex directory: {:?} (WSL mode: {})", codex_dir, is_wsl);

    let agents_md_path = codex_dir.join("AGENTS.md");

    fs::write(&agents_md_path, content).map_err(|e| {
        log::error!("Failed to write AGENTS.md: {}", e);
        format!("保存 AGENTS.md 失败: {}", e)
    })?;

    log::info!("Successfully saved AGENTS.md to {:?}", agents_md_path);
    
    let mode_hint = if is_wsl { " (WSL)" } else { "" };
    Ok(format!("Codex 系统提示词保存成功{}", mode_hint))
}


// ============================================================================
// Multi-Prompt Management for Codex
// ============================================================================

/// Codex prompt template metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPromptTemplate {
    /// Unique identifier (filename without extension)
    pub id: String,
    /// Display name
    pub name: String,
    /// Description
    pub description: Option<String>,
    /// Whether this template is currently active
    pub is_active: bool,
    /// Creation timestamp
    pub created_at: u64,
    /// Last modified timestamp
    pub updated_at: u64,
}

/// Codex prompts configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CodexPromptsConfig {
    /// Currently active prompt template ID
    active_prompt_id: Option<String>,
}

/// Gets the prompts directory path
fn get_codex_prompts_dir() -> Result<(std::path::PathBuf, bool), String> {
    let (codex_dir, is_wsl) = get_effective_codex_dir()?;
    let prompts_dir = codex_dir.join("prompts");
    
    // Create directory if it doesn't exist
    if !prompts_dir.exists() {
        fs::create_dir_all(&prompts_dir).map_err(|e| {
            format!("无法创建提示词目录: {}", e)
        })?;
    }
    
    Ok((prompts_dir, is_wsl))
}

/// Gets the prompts config file path
fn get_codex_prompts_config_path() -> Result<std::path::PathBuf, String> {
    let (codex_dir, _) = get_effective_codex_dir()?;
    Ok(codex_dir.join("prompts_config.json"))
}

/// Loads the prompts configuration
fn load_prompts_config() -> Result<CodexPromptsConfig, String> {
    let config_path = get_codex_prompts_config_path()?;
    
    if !config_path.exists() {
        return Ok(CodexPromptsConfig::default());
    }
    
    let content = fs::read_to_string(&config_path).map_err(|e| {
        format!("读取提示词配置失败: {}", e)
    })?;
    
    serde_json::from_str(&content).map_err(|e| {
        format!("解析提示词配置失败: {}", e)
    })
}

/// Saves the prompts configuration
fn save_prompts_config(config: &CodexPromptsConfig) -> Result<(), String> {
    let config_path = get_codex_prompts_config_path()?;
    
    let content = serde_json::to_string_pretty(config).map_err(|e| {
        format!("序列化提示词配置失败: {}", e)
    })?;
    
    fs::write(&config_path, content).map_err(|e| {
        format!("保存提示词配置失败: {}", e)
    })
}

/// Lists all Codex prompt templates
#[tauri::command]
pub async fn list_codex_prompts() -> Result<Vec<CodexPromptTemplate>, String> {
    log::info!("Listing Codex prompt templates");
    
    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let config = load_prompts_config()?;
    
    let mut templates = Vec::new();
    
    if let Ok(entries) = fs::read_dir(&prompts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let metadata = fs::metadata(&path).ok();
                    let created_at = metadata.as_ref()
                        .and_then(|m| m.created().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let updated_at = metadata.as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    
                    // Read first line as description
                    let description = fs::read_to_string(&path).ok()
                        .and_then(|content| {
                            content.lines().next()
                                .filter(|line| line.starts_with("# ") || line.starts_with("## "))
                                .map(|line| line.trim_start_matches('#').trim().to_string())
                        });
                    
                    let is_active = config.active_prompt_id.as_deref() == Some(stem);
                    
                    templates.push(CodexPromptTemplate {
                        id: stem.to_string(),
                        name: stem.to_string(),
                        description,
                        is_active,
                        created_at,
                        updated_at,
                    });
                }
            }
        }
    }
    
    // Sort by updated_at descending
    templates.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    
    log::info!("Found {} Codex prompt templates", templates.len());
    Ok(templates)
}

/// Gets a specific Codex prompt template content
#[tauri::command]
pub async fn get_codex_prompt(id: String) -> Result<String, String> {
    log::info!("Getting Codex prompt template: {}", id);
    
    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let prompt_path = prompts_dir.join(format!("{}.md", id));
    
    if !prompt_path.exists() {
        return Err(format!("提示词模板不存在: {}", id));
    }
    
    fs::read_to_string(&prompt_path).map_err(|e| {
        format!("读取提示词模板失败: {}", e)
    })
}

/// Creates or updates a Codex prompt template
#[tauri::command]
pub async fn save_codex_prompt(id: String, content: String) -> Result<String, String> {
    log::info!("Saving Codex prompt template: {}", id);
    
    // Validate ID (only alphanumeric, dash, underscore)
    if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("提示词ID只能包含字母、数字、横线和下划线".to_string());
    }
    
    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let prompt_path = prompts_dir.join(format!("{}.md", id));
    
    fs::write(&prompt_path, content).map_err(|e| {
        format!("保存提示词模板失败: {}", e)
    })?;
    
    log::info!("Successfully saved Codex prompt template: {}", id);
    Ok(format!("提示词模板 '{}' 保存成功", id))
}

/// Renames a Codex prompt template (changes the template ID / filename)
#[tauri::command]
pub async fn rename_codex_prompt(old_id: String, new_id: String) -> Result<String, String> {
    let old_id = old_id.trim().to_string();
    let new_id = new_id.trim().to_string();

    log::info!("Renaming Codex prompt template: {} -> {}", old_id, new_id);

    if old_id.is_empty() || new_id.is_empty() {
        return Err("提示词名称不能为空".to_string());
    }

    if old_id == new_id {
        return Ok(format!("提示词模板 '{}' 名称未变更", old_id));
    }

    // Validate new ID (only alphanumeric, dash, underscore)
    if !new_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("提示词名称只能包含字母、数字、横线和下划线".to_string());
    }

    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let old_path = prompts_dir.join(format!("{}.md", old_id));
    if !old_path.exists() {
        return Err(format!("提示词模板不存在: {}", old_id));
    }

    let new_path = prompts_dir.join(format!("{}.md", new_id));
    let case_only = old_id.eq_ignore_ascii_case(&new_id);

    // Guard against conflicts. On case-insensitive file systems, `new_path` may "exist" but
    // point to the same file when only the casing changes (e.g. a -> A). We allow that case.
    if new_path.exists() {
        let same_file = match (fs::canonicalize(&old_path), fs::canonicalize(&new_path)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !(case_only && same_file) {
            return Err(format!("目标名称已存在: {}", new_id));
        }
    }

    if case_only {
        // Rename via a temporary filename to support case-only renames on case-insensitive FS.
        let ts = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f").to_string();
        let mut temp_path = prompts_dir.join(format!("__rename_tmp_{}.md", ts));
        let mut attempt = 0usize;
        while temp_path.exists() {
            attempt += 1;
            temp_path = prompts_dir.join(format!("__rename_tmp_{}_{}.md", ts, attempt));
        }

        fs::rename(&old_path, &temp_path).map_err(|e| {
            format!("重命名提示词模板失败: {}", e)
        })?;
        fs::rename(&temp_path, &new_path).map_err(|e| {
            format!("重命名提示词模板失败: {}", e)
        })?;
    } else {
        fs::rename(&old_path, &new_path).map_err(|e| {
            format!("重命名提示词模板失败: {}", e)
        })?;
    }

    // Update config if needed
    let mut config = load_prompts_config()?;
    if config.active_prompt_id.as_deref() == Some(&old_id) {
        config.active_prompt_id = Some(new_id.clone());
        save_prompts_config(&config)?;
    }

    log::info!("Successfully renamed Codex prompt template: {} -> {}", old_id, new_id);
    Ok(format!("提示词模板 '{}' 已重命名为 '{}'", old_id, new_id))
}

/// Deletes a Codex prompt template
#[tauri::command]
pub async fn delete_codex_prompt(id: String) -> Result<String, String> {
    log::info!("Deleting Codex prompt template: {}", id);
    
    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let prompt_path = prompts_dir.join(format!("{}.md", id));
    
    if !prompt_path.exists() {
        return Err(format!("提示词模板不存在: {}", id));
    }
    
    // If this is the active prompt, deactivate it first
    let mut config = load_prompts_config()?;
    if config.active_prompt_id.as_deref() == Some(&id) {
        config.active_prompt_id = None;
        save_prompts_config(&config)?;
        
        // Also clear the AGENTS.md file
        let (codex_dir, _) = get_effective_codex_dir()?;
        let agents_md_path = codex_dir.join("AGENTS.md");
        if agents_md_path.exists() {
            fs::write(&agents_md_path, "").map_err(|e| {
                format!("清空 AGENTS.md 失败: {}", e)
            })?;
        }
    }
    
    fs::remove_file(&prompt_path).map_err(|e| {
        format!("删除提示词模板失败: {}", e)
    })?;
    
    log::info!("Successfully deleted Codex prompt template: {}", id);
    Ok(format!("提示词模板 '{}' 删除成功", id))
}

/// Activates a Codex prompt template (copies it to AGENTS.md)
#[tauri::command]
pub async fn activate_codex_prompt(id: String) -> Result<String, String> {
    log::info!("Activating Codex prompt template: {}", id);
    
    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let prompt_path = prompts_dir.join(format!("{}.md", id));
    
    if !prompt_path.exists() {
        return Err(format!("提示词模板不存在: {}", id));
    }
    
    // Read the template content
    let content = fs::read_to_string(&prompt_path).map_err(|e| {
        format!("读取提示词模板失败: {}", e)
    })?;
    
    // Write to AGENTS.md
    let (codex_dir, _) = get_effective_codex_dir()?;
    let agents_md_path = codex_dir.join("AGENTS.md");
    
    fs::write(&agents_md_path, &content).map_err(|e| {
        format!("写入 AGENTS.md 失败: {}", e)
    })?;
    
    // Update config
    let mut config = load_prompts_config()?;
    config.active_prompt_id = Some(id.clone());
    save_prompts_config(&config)?;
    
    log::info!("Successfully activated Codex prompt template: {}", id);
    Ok(format!("提示词模板 '{}' 已激活", id))
}

/// Deactivates the current Codex prompt (clears AGENTS.md)
#[tauri::command]
pub async fn deactivate_codex_prompt() -> Result<String, String> {
    log::info!("Deactivating current Codex prompt");
    
    // Clear AGENTS.md
    let (codex_dir, _) = get_effective_codex_dir()?;
    let agents_md_path = codex_dir.join("AGENTS.md");
    
    if agents_md_path.exists() {
        fs::write(&agents_md_path, "").map_err(|e| {
            format!("清空 AGENTS.md 失败: {}", e)
        })?;
    }
    
    // Update config
    let mut config = load_prompts_config()?;
    config.active_prompt_id = None;
    save_prompts_config(&config)?;
    
    log::info!("Successfully deactivated Codex prompt");
    Ok("已停用当前提示词".to_string())
}

/// Gets the currently active prompt ID
#[tauri::command]
pub async fn get_active_codex_prompt_id() -> Result<Option<String>, String> {
    let config = load_prompts_config()?;
    Ok(config.active_prompt_id)
}


// ============================================================================
// Project-Level AGENTS.md Management
// ============================================================================

/// Status of AGENTS.md file in a project directory
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsMdStatus {
    /// Whether AGENTS.md exists in the project directory
    pub exists: bool,
    /// Whether a backup file exists
    pub has_backup: bool,
    /// Preview of the first 200 characters of the content
    pub content_preview: Option<String>,
}

/// Result of activating a prompt to a project
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationResult {
    /// Whether the activation was successful
    pub success: bool,
    /// Message describing the result
    pub message: String,
    /// Path to the backup file if one was created
    pub backup_path: Option<String>,
}

/// Check if AGENTS.md exists in the project directory
#[tauri::command]
pub async fn check_project_agents_md(project_path: String) -> Result<AgentsMdStatus, String> {
    log::info!("Checking AGENTS.md status in project: {}", project_path);
    
    // Validate project path
    if project_path.trim().is_empty() {
        return Err("项目路径不能为空".to_string());
    }
    
    let project_dir = std::path::PathBuf::from(&project_path);
    if !project_dir.exists() {
        return Err(format!("项目路径不存在: {}", project_path));
    }
    if !project_dir.is_dir() {
        return Err(format!("项目路径不是目录: {}", project_path));
    }
    
    let agents_md_path = project_dir.join("AGENTS.md");
    let backup_path = project_dir.join("AGENTS.md.backup");
    
    let exists = agents_md_path.exists();
    let has_backup = backup_path.exists() || has_timestamped_backup(&project_dir);
    
    let content_preview = if exists {
        match fs::read_to_string(&agents_md_path) {
            Ok(content) => {
                let preview: String = content.chars().take(200).collect();
                Some(if content.len() > 200 {
                    format!("{}...", preview)
                } else {
                    preview
                })
            }
            Err(_) => None,
        }
    } else {
        None
    };
    
    log::info!("AGENTS.md status - exists: {}, has_backup: {}", exists, has_backup);
    
    Ok(AgentsMdStatus {
        exists,
        has_backup,
        content_preview,
    })
}

/// Check if any timestamped backup file exists
fn has_timestamped_backup(project_dir: &std::path::Path) -> bool {
    if let Ok(entries) = fs::read_dir(project_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("AGENTS.md.backup.") {
                    return true;
                }
            }
        }
    }
    false
}


/// Generate a unique backup filename
/// Returns "AGENTS.md.backup" if it doesn't exist, otherwise "AGENTS.md.backup.{timestamp}"
fn generate_backup_filename(project_dir: &std::path::Path) -> String {
    let default_backup = "AGENTS.md.backup";
    let default_path = project_dir.join(default_backup);
    
    if !default_path.exists() {
        return default_backup.to_string();
    }
    
    // Generate timestamped filename
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    format!("AGENTS.md.backup.{}", timestamp)
}

/// Activate a Codex prompt template to a project directory
#[tauri::command]
pub async fn activate_codex_prompt_to_project(
    id: String,
    project_path: String,
    backup_existing: bool,
) -> Result<ActivationResult, String> {
    log::info!("Activating Codex prompt '{}' to project: {}", id, project_path);
    
    // Validate project path
    if project_path.trim().is_empty() {
        return Err("项目路径不能为空".to_string());
    }
    
    let project_dir = std::path::PathBuf::from(&project_path);
    if !project_dir.exists() {
        return Err(format!("项目路径不存在: {}", project_path));
    }
    if !project_dir.is_dir() {
        return Err(format!("项目路径不是目录: {}", project_path));
    }
    
    // Get the prompt template
    let (prompts_dir, _) = get_codex_prompts_dir()?;
    let prompt_path = prompts_dir.join(format!("{}.md", id));
    
    if !prompt_path.exists() {
        return Err(format!("提示词模板不存在: {}", id));
    }
    
    // Read the template content
    let content = fs::read_to_string(&prompt_path).map_err(|e| {
        format!("读取提示词模板失败: {}", e)
    })?;
    
    let agents_md_path = project_dir.join("AGENTS.md");
    let mut backup_path_result: Option<String> = None;
    
    // Backup existing file if requested and exists
    if backup_existing && agents_md_path.exists() {
        let backup_filename = generate_backup_filename(&project_dir);
        let backup_path = project_dir.join(&backup_filename);
        
        fs::copy(&agents_md_path, &backup_path).map_err(|e| {
            format!("备份文件失败: {}", e)
        })?;
        
        backup_path_result = Some(backup_path.to_string_lossy().to_string());
        log::info!("Created backup at: {:?}", backup_path);
    }
    
    // Write the new content
    fs::write(&agents_md_path, &content).map_err(|e| {
        format!("写入 AGENTS.md 失败: {}", e)
    })?;
    
    let message = if let Some(ref backup) = backup_path_result {
        format!("提示词已激活到项目，原文件已备份到: {}", backup)
    } else {
        "提示词已激活到项目".to_string()
    };
    
    log::info!("Successfully activated prompt '{}' to project: {}", id, project_path);
    
    Ok(ActivationResult {
        success: true,
        message,
        backup_path: backup_path_result,
    })
}


/// Find the most recent backup file in the project directory
fn find_latest_backup(project_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let default_backup = project_dir.join("AGENTS.md.backup");
    
    // First check for the default backup file
    if default_backup.exists() {
        return Some(default_backup);
    }
    
    // Look for timestamped backups and find the most recent one
    let mut latest_backup: Option<(std::path::PathBuf, std::time::SystemTime)> = None;
    
    if let Ok(entries) = fs::read_dir(project_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("AGENTS.md.backup.") {
                    if let Ok(metadata) = entry.metadata() {
                        if let Ok(modified) = metadata.modified() {
                            match &latest_backup {
                                None => {
                                    latest_backup = Some((entry.path(), modified));
                                }
                                Some((_, prev_time)) if modified > *prev_time => {
                                    latest_backup = Some((entry.path(), modified));
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }
    
    latest_backup.map(|(path, _)| path)
}

/// Deactivate Codex prompt from a project directory
#[tauri::command]
pub async fn deactivate_codex_prompt_from_project(
    project_path: String,
    restore_backup: bool,
) -> Result<String, String> {
    log::info!("Deactivating Codex prompt from project: {}, restore_backup: {}", project_path, restore_backup);
    
    // Validate project path
    if project_path.trim().is_empty() {
        return Err("项目路径不能为空".to_string());
    }
    
    let project_dir = std::path::PathBuf::from(&project_path);
    if !project_dir.exists() {
        return Err(format!("项目路径不存在: {}", project_path));
    }
    if !project_dir.is_dir() {
        return Err(format!("项目路径不是目录: {}", project_path));
    }
    
    let agents_md_path = project_dir.join("AGENTS.md");
    
    if restore_backup {
        // Find and restore the backup
        if let Some(backup_path) = find_latest_backup(&project_dir) {
            let backup_content = fs::read_to_string(&backup_path).map_err(|e| {
                format!("读取备份文件失败: {}", e)
            })?;
            
            fs::write(&agents_md_path, &backup_content).map_err(|e| {
                format!("恢复备份失败: {}", e)
            })?;
            
            // Optionally remove the backup file after restoration
            let _ = fs::remove_file(&backup_path);
            
            log::info!("Restored backup from: {:?}", backup_path);
            return Ok("已恢复备份文件".to_string());
        } else {
            return Err("未找到备份文件".to_string());
        }
    } else {
        // Clear the AGENTS.md file
        if agents_md_path.exists() {
            fs::write(&agents_md_path, "").map_err(|e| {
                format!("清空 AGENTS.md 失败: {}", e)
            })?;
        }
        
        log::info!("Cleared AGENTS.md in project: {}", project_path);
        return Ok("已清空 AGENTS.md".to_string());
    }
}

// ============================================================================
// settings.json File Switching (AnyCode)
// ============================================================================

/// Claude settings.json preset (raw file content)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsFileProvider {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub settings_json: String,
    #[serde(default)]
    pub claude_json: String,
    pub created_at: Option<i64>,
}

fn get_anycode_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    let dir = home.join(".anycode");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .anycode directory: {}", e))?;
    }
    Ok(dir)
}

fn get_claude_settings_file_providers_path() -> Result<PathBuf, String> {
    Ok(get_anycode_dir()?.join("claude_settings_providers.json"))
}

/// Read raw ~/.claude/settings.json (creates a minimal default if missing)
#[tauri::command]
pub async fn read_claude_settings_json_text() -> Result<String, String> {
    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let settings_path = claude_dir.join("settings.json");

    if !settings_path.exists() {
        return Ok("{\n  \"env\": {}\n}\n".to_string());
    }

    fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings.json: {}", e))
}

/// Write ~/.claude/settings.json
/// This replaces the file content. The content must be a valid JSON object.
#[tauri::command]
pub async fn write_claude_settings_json_text(content: String) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    if !value.is_object() {
        return Err("settings.json 必须是 JSON 对象".to_string());
    }

    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let settings_path = claude_dir.join("settings.json");

    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, pretty)
        .map_err(|e| format!("Failed to write settings.json: {}", e))?;

    Ok(format!("✅ 已写入 {}", settings_path.display()))
}

fn get_claude_json_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    Ok(home.join(".claude.json"))
}

/// Read raw ~/.claude.json (creates a minimal default if missing)
#[tauri::command]
pub async fn read_claude_json_text() -> Result<String, String> {
    let claude_json_path = get_claude_json_path()?;

    if !claude_json_path.exists() {
        return Ok("{\n  \"mcpServers\": {}\n}\n".to_string());
    }

    fs::read_to_string(&claude_json_path)
        .map_err(|e| format!("Failed to read .claude.json: {}", e))
}

/// Write ~/.claude.json
/// This replaces the file content. The content must be a valid JSON object.
#[tauri::command]
pub async fn write_claude_json_text(content: String) -> Result<String, String> {
    let trimmed = content.trim();
    let json_str = if trimmed.is_empty() { "{}" } else { trimmed };

    let value: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    if !value.is_object() {
        return Err(".claude.json 必须是 JSON 对象".to_string());
    }

    let claude_json_path = get_claude_json_path()?;
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Failed to serialize .claude.json: {}", e))?;

    fs::write(&claude_json_path, pretty)
        .map_err(|e| format!("Failed to write .claude.json: {}", e))?;

    Ok(format!("✅ 已写入 {}", claude_json_path.display()))
}

/// Write both ~/.claude/settings.json and ~/.claude.json
/// This validates both files before writing to reduce partial updates.
#[tauri::command]
pub async fn write_claude_config_files(settings_json: String, claude_json: String) -> Result<String, String> {
    // Validate settings.json (accept empty as {})
    let settings_trimmed = settings_json.trim();
    let settings_str = if settings_trimmed.is_empty() { "{}" } else { settings_trimmed };
    let settings_value: serde_json::Value = serde_json::from_str(settings_str)
        .map_err(|e| format!("Invalid JSON (settings.json): {}", e))?;
    if !settings_value.is_object() {
        return Err("settings.json 必须是 JSON 对象".to_string());
    }

    // Validate .claude.json (accept empty as {})
    let claude_trimmed = claude_json.trim();
    let claude_str = if claude_trimmed.is_empty() { "{}" } else { claude_trimmed };
    let claude_value: serde_json::Value = serde_json::from_str(claude_str)
        .map_err(|e| format!("Invalid JSON (.claude.json): {}", e))?;
    if !claude_value.is_object() {
        return Err(".claude.json 必须是 JSON 对象".to_string());
    }

    // Ensure ~/.claude exists and write settings.json
    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let settings_path = claude_dir.join("settings.json");
    let settings_pretty = serde_json::to_string_pretty(&settings_value)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, settings_pretty)
        .map_err(|e| format!("Failed to write settings.json: {}", e))?;

    // Write ~/.claude.json
    let claude_json_path = get_claude_json_path()?;
    let claude_pretty = serde_json::to_string_pretty(&claude_value)
        .map_err(|e| format!("Failed to serialize .claude.json: {}", e))?;
    fs::write(&claude_json_path, claude_pretty)
        .map_err(|e| format!("Failed to write .claude.json: {}", e))?;

    Ok(format!("✅ 已写入 {} 和 {}", settings_path.display(), claude_json_path.display()))
}

/// Get Claude settings.json presets (AnyCode-managed)
#[tauri::command]
pub async fn get_claude_settings_file_providers() -> Result<Vec<ClaudeSettingsFileProvider>, String> {
    let providers_path = get_claude_settings_file_providers_path()?;
    if !providers_path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let providers: Vec<ClaudeSettingsFileProvider> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;
    Ok(providers)
}

/// Add a Claude settings.json preset (AnyCode-managed)
#[tauri::command]
pub async fn add_claude_settings_file_provider(
    config: ClaudeSettingsFileProvider,
) -> Result<String, String> {
    let providers_path = get_claude_settings_file_providers_path()?;

    if let Some(parent) = providers_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    let mut providers: Vec<ClaudeSettingsFileProvider> = if providers_path.exists() {
        let content = fs::read_to_string(&providers_path)
            .map_err(|e| format!("Failed to read providers.json: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    if providers.iter().any(|p| p.id == config.id) {
        return Err(format!("Provider with ID '{}' already exists", config.id));
    }

    providers.push(config.clone());

    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    Ok(format!("Successfully added Claude settings preset: {}", config.name))
}

/// Update a Claude settings.json preset (AnyCode-managed)
#[tauri::command]
pub async fn update_claude_settings_file_provider(
    config: ClaudeSettingsFileProvider,
) -> Result<String, String> {
    let providers_path = get_claude_settings_file_providers_path()?;
    if !providers_path.exists() {
        return Err(format!("Provider with ID '{}' not found", config.id));
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let mut providers: Vec<ClaudeSettingsFileProvider> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;

    let index = providers.iter().position(|p| p.id == config.id)
        .ok_or_else(|| format!("Provider with ID '{}' not found", config.id))?;
    providers[index] = config.clone();

    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    Ok(format!("Successfully updated Claude settings preset: {}", config.name))
}

/// Delete a Claude settings.json preset (AnyCode-managed)
#[tauri::command]
pub async fn delete_claude_settings_file_provider(id: String) -> Result<String, String> {
    let providers_path = get_claude_settings_file_providers_path()?;
    if !providers_path.exists() {
        return Err(format!("Provider with ID '{}' not found", id));
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let mut providers: Vec<ClaudeSettingsFileProvider> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;

    let initial_len = providers.len();
    providers.retain(|p| p.id != id);
    if providers.len() == initial_len {
        return Err(format!("Provider with ID '{}' not found", id));
    }

    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    Ok("Successfully deleted Claude settings preset".to_string())
}
