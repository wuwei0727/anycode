/**
 * Codex Configuration Module
 *
 * Handles configuration operations including:
 * - Codex availability checking
 * - Custom binary path management
 * - Mode configuration (Native/WSL)
 * - Provider management (presets, switching, CRUD)
 */

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use dirs;
use rusqlite;

// Import platform-specific utilities for window hiding
use crate::commands::claude::apply_no_window_async;
use crate::claude_binary::detect_binary_for_tool;
// Import WSL utilities
use super::super::wsl_utils;

// ============================================================================
// Type Definitions
// ============================================================================

/// Codex availability status
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CodexAvailability {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Codex mode configuration info (for frontend display)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModeInfo {
    /// Currently configured mode
    pub mode: String,
    /// WSL distro (if configured)
    pub wsl_distro: Option<String>,
    /// Actual mode being used (detection result)
    pub actual_mode: String,
    /// Whether native Windows Codex is available
    pub native_available: bool,
    /// Whether WSL Codex is available
    pub wsl_available: bool,
    /// List of available WSL distros
    pub available_distros: Vec<String>,
}

/// Codex provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderConfig {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub auth: serde_json::Value, // JSON object for auth.json
    pub config: String, // TOML string for config.toml
    pub is_official: Option<bool>,
    pub is_partner: Option<bool>,
    pub created_at: Option<i64>,
}

/// Current Codex configuration (from ~/.codex directory)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentCodexConfig {
    pub auth: serde_json::Value,
    pub config: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

// ============================================================================
// Path Utilities
// ============================================================================

pub fn expand_user_path(input: &str) -> Result<PathBuf, String> {
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

pub fn update_binary_override(tool: &str, override_path: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory".to_string())?;
    let config_path = home.join(".claude").join("binaries.json");

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

pub fn clear_binary_override(tool: &str) -> Result<(), String> {
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

pub fn get_binary_override(tool: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".claude").join("binaries.json");
    if !config_path.exists() {
        return None;
    }

    let content = std::fs::read_to_string(&config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get(tool)?
        .get("override_path")?
        .as_str()
        .map(|s| s.to_string())
}

// ============================================================================
// Sessions Directory
// ============================================================================

/// Get the Codex sessions directory
/// Get the Codex sessions directory
/// On Windows with WSL mode enabled, returns the WSL UNC path
pub fn get_codex_sessions_dir() -> Result<PathBuf, String> {
    log::debug!("[get_codex_sessions_dir] Getting Codex sessions directory");
    
    // Check for WSL mode on Windows
    #[cfg(target_os = "windows")]
    {
        let wsl_config = wsl_utils::get_wsl_config();
        log::debug!("[get_codex_sessions_dir] WSL config: enabled={}", wsl_config.enabled);
        
        if wsl_config.enabled {
            if let Some(sessions_dir) = wsl_utils::get_wsl_codex_sessions_dir() {
                log::info!("[get_codex_sessions_dir] Using WSL sessions directory: {:?}", sessions_dir);
                log::debug!("[get_codex_sessions_dir] Directory exists: {}", sessions_dir.exists());
                return Ok(sessions_dir);
            }
        }
    }

    // Native mode: use local home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;

    let sessions_dir = home_dir.join(".codex").join("sessions");
    log::info!("[get_codex_sessions_dir] Using native sessions directory: {:?}", sessions_dir);
    log::debug!("[get_codex_sessions_dir] Directory exists: {}", sessions_dir.exists());
    
    Ok(sessions_dir)
}

// ============================================================================
// Availability Check
// ============================================================================

/// Checks if Codex is available and properly configured
#[tauri::command]
pub async fn check_codex_availability() -> Result<CodexAvailability, String> {
    log::info!("[Codex] Checking availability...");

    // 1) Windows: Check WSL mode first
    #[cfg(target_os = "windows")]
    {
        let wsl_config = wsl_utils::get_wsl_config();
        if wsl_config.enabled {
            if let Some(ref codex_path) = wsl_config.codex_path_in_wsl {
                let version = wsl_utils::get_wsl_codex_version(wsl_config.distro.as_deref())
                    .unwrap_or_else(|| "Unknown version".to_string());

                log::info!(
                    "[Codex] Available in WSL ({:?}) - path: {}, version: {}",
                    wsl_config.distro,
                    codex_path,
                    version
                );

                return Ok(CodexAvailability {
                    available: true,
                    version: Some(format!("WSL: {}", version)),
                    error: None,
                });
            }
        }
        log::info!("[Codex] WSL mode not available, trying native paths...");
    }

    // 2) Runtime detection (env vars / PATH / registry / common dirs / user config)
    let (_env_info, detected) = detect_binary_for_tool("codex", "CODEX_PATH", "codex");
    if let Some(inst) = detected {
        let mut cmd = Command::new(&inst.path);
        cmd.arg("--version");
        apply_no_window_async(&mut cmd);

        match cmd.output().await {
            Ok(output) => {
                let stdout_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr_str = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let version = if !stdout_str.is_empty() {
                    stdout_str.clone()
                } else if !stderr_str.is_empty() {
                    stderr_str.clone()
                } else {
                    inst.version.clone().unwrap_or_else(|| "Unknown version".to_string())
                };

                if output.status.success() {
                    log::info!(
                        "[Codex] Available - path: {}, source: {}, version: {}",
                        inst.path,
                        inst.source,
                        version
                    );
                    return Ok(CodexAvailability {
                        available: true,
                        version: Some(version),
                        error: None,
                    });
                } else {
                    log::warn!(
                        "[Codex] Version probe failed for {} (status {:?}), stderr: {}",
                        inst.path,
                        output.status.code(),
                        stderr_str
                    );
                }
            }
            Err(e) => {
                log::warn!(
                    "[Codex] Failed to run version check for {}: {}",
                    inst.path,
                    e
                );
            }
        }
    }

    // 3) Fallback: use legacy candidate list
    let codex_commands = get_codex_command_candidates();
    for cmd_path in codex_commands {
        log::info!("[Codex] Fallback trying: {}", cmd_path);

        let mut cmd = Command::new(&cmd_path);
        cmd.arg("--version");
        apply_no_window_async(&mut cmd);

        match cmd.output().await {
            Ok(output) => {
                let stdout_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr_str = String::from_utf8_lossy(&output.stderr).trim().to_string();

                if output.status.success() {
                    let version = if !stdout_str.is_empty() {
                        stdout_str
                    } else if !stderr_str.is_empty() {
                        stderr_str
                    } else {
                        "Unknown version".to_string()
                    };

                    log::info!("[Codex] Available via fallback - version: {}", version);
                    return Ok(CodexAvailability {
                        available: true,
                        version: Some(version),
                        error: None,
                    });
                }
            }
            Err(e) => {
                log::warn!("[Codex] Fallback command '{}' failed: {}", cmd_path, e);
            }
        }
    }

    // 4) Complete failure
    log::error!("[Codex] Codex CLI not found via runtime detection or fallback list");
    Ok(CodexAvailability {
        available: false,
        version: None,
        error: Some("Codex CLI not found. Please set CODEX_PATH or install codex CLI".to_string()),
    })
}

// ============================================================================
// Custom Path Management
// ============================================================================

/// Set custom Codex CLI path, supports ~ expansion and relative paths
#[tauri::command]
pub async fn set_custom_codex_path(app: AppHandle, custom_path: String) -> Result<(), String> {
    log::info!("[Codex] Setting custom path: {}", custom_path);

    let expanded_path = expand_user_path(&custom_path)?;
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

    let mut cmd = Command::new(&path_str);
    cmd.arg("--version");
    apply_no_window_async(&mut cmd);

    match cmd.output().await {
        Ok(output) => {
            if !output.status.success() {
                return Err("File is not a valid Codex CLI executable".to_string());
            }
        }
        Err(e) => return Err(format!("Failed to test Codex CLI: {}", e)),
    }

    // Write to binaries.json for unified detection
    if let Err(e) = update_binary_override("codex", &path_str) {
        log::warn!("[Codex] Failed to update binaries.json: {}", e);
    }

    // Also store in app_settings for compatibility
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let db_path = app_data_dir.join("agents.db");
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let _ = conn.execute(
                "CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )",
                [],
            );
            let _ = conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params!["codex_binary_path", path_str],
            );
        }
    }

    Ok(())
}

fn read_custom_codex_path_from_db(app: &AppHandle) -> Option<String> {
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let db_path = app_data_dir.join("agents.db");
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(val) = conn.query_row(
                    "SELECT value FROM app_settings WHERE key = 'codex_binary_path'",
                    [],
                    |row| row.get::<_, String>(0),
                ) {
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Get current Codex path (custom first, then runtime detection)
#[tauri::command]
pub async fn get_codex_path(app: AppHandle) -> Result<String, String> {
    if let Some(override_path) = get_binary_override("codex") {
        return Ok(override_path);
    }
    if let Some(db_path) = read_custom_codex_path_from_db(&app) {
        return Ok(db_path);
    }

    let (_env, detected) = detect_binary_for_tool("codex", "CODEX_PATH", "codex");
    if let Some(inst) = detected {
        return Ok(inst.path);
    }

    Err("Codex CLI not found. Please set CODEX_PATH or install codex CLI".to_string())
}

/// Clear custom Codex path, restore auto detection
#[tauri::command]
pub async fn clear_custom_codex_path(app: AppHandle) -> Result<(), String> {
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let db_path = app_data_dir.join("agents.db");
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                let _ = conn.execute(
                    "DELETE FROM app_settings WHERE key = 'codex_binary_path'",
                    [],
                );
            }
        }
    }

    if let Err(e) = clear_binary_override("codex") {
        log::warn!("[Codex] Failed to clear binaries.json override: {}", e);
    }

    Ok(())
}

// ============================================================================
// Shell Path Utilities (macOS)
// ============================================================================

/// Get the shell's PATH on macOS
/// GUI applications on macOS don't inherit the PATH from shell configuration files
/// This function runs the user's default shell to get the actual PATH
#[cfg(target_os = "macos")]
fn get_shell_path_codex() -> Option<String> {
    use std::process::Command as StdCommand;

    // Get the user's default shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    log::debug!("[Codex] User's default shell: {}", shell);

    // Run shell in login mode to source all profile scripts and get PATH
    let mut cmd = StdCommand::new(&shell);
    cmd.args(["-l", "-c", "echo $PATH"]);

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                log::info!("[Codex] Got shell PATH: {}", path);
                return Some(path);
            }
        }
        Ok(output) => {
            log::debug!(
                "[Codex] Shell command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Err(e) => {
            log::debug!("[Codex] Failed to execute shell: {}", e);
        }
    }

    // Fallback: construct PATH from common locations
    if let Ok(home) = std::env::var("HOME") {
        let common_paths: Vec<String> = vec![
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
            "/usr/bin".to_string(),
            "/bin".to_string(),
            format!("{}/.local/bin", home),
            format!("{}/.npm-global/bin", home),
            format!("{}/.volta/bin", home),
            format!("{}/.fnm", home),
        ];

        let existing_paths: Vec<&str> = common_paths
            .iter()
            .map(|s| s.as_ref())
            .filter(|p| std::path::Path::new(p).exists())
            .collect();

        if !existing_paths.is_empty() {
            let path = existing_paths.join(":");
            log::info!("[Codex] Constructed fallback PATH: {}", path);
            return Some(path);
        }
    }

    None
}

/// Get npm global prefix directory
#[cfg(target_os = "macos")]
fn get_npm_prefix_codex() -> Option<String> {
    use std::process::Command as StdCommand;

    // Try to run `npm config get prefix`
    let mut cmd = StdCommand::new("npm");
    cmd.args(["config", "get", "prefix"]);

    // Also try with common paths in PATH
    if let Some(shell_path) = get_shell_path_codex() {
        cmd.env("PATH", &shell_path);
    }

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !prefix.is_empty() && prefix != "undefined" {
                log::debug!("[Codex] npm prefix: {}", prefix);
                return Some(prefix);
            }
        }
        _ => {}
    }

    // Fallback to common npm prefix locations
    if let Ok(home) = std::env::var("HOME") {
        let common_prefixes = vec![
            format!("{}/.npm-global", home),
            "/usr/local".to_string(),
            "/opt/homebrew".to_string(),
        ];

        for prefix in common_prefixes {
            if std::path::Path::new(&prefix).exists() {
                log::debug!("[Codex] Using fallback npm prefix: {}", prefix);
                return Some(prefix);
            }
        }
    }

    None
}

/// Returns a list of possible Codex command paths to try
pub fn get_codex_command_candidates() -> Vec<String> {
    let mut candidates = vec!["codex".to_string()];

    // Windows: npm global install paths
    #[cfg(target_os = "windows")]
    {
        // npm global install path (APPDATA - standard location)
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!(r"{}\npm\codex.cmd", appdata));
            candidates.push(format!(r"{}\npm\codex", appdata));
            // nvm-windows installed Node.js versions
            let nvm_dir = format!(r"{}\nvm", appdata);
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        let codex_path = entry.path().join("codex.cmd");
                        if codex_path.exists() {
                            candidates.push(codex_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }

        // npm global install path (LOCALAPPDATA)
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!(r"{}\npm\codex.cmd", localappdata));
            candidates.push(format!(r"{}\npm\codex", localappdata));
            // pnpm global install path
            candidates.push(format!(r"{}\pnpm\codex.cmd", localappdata));
            candidates.push(format!(r"{}\pnpm\codex", localappdata));
            // Yarn global install path
            candidates.push(format!(r"{}\Yarn\bin\codex.cmd", localappdata));
            candidates.push(format!(r"{}\Yarn\bin\codex", localappdata));
        }

        // User directory install paths
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            // Custom npm global directory
            candidates.push(format!(r"{}\.npm-global\bin\codex.cmd", userprofile));
            candidates.push(format!(r"{}\.npm-global\bin\codex", userprofile));
            // Volta install path
            candidates.push(format!(r"{}\.volta\bin\codex.cmd", userprofile));
            candidates.push(format!(r"{}\.volta\bin\codex", userprofile));
            // fnm install path
            candidates.push(format!(r"{}\.fnm\aliases\default\codex.cmd", userprofile));
            // Scoop install path
            candidates.push(format!(r"{}\scoop\shims\codex.cmd", userprofile));
            candidates.push(format!(r"{}\scoop\apps\nodejs\current\codex.cmd", userprofile));
            // Local bin directory
            candidates.push(format!(r"{}\.local\bin\codex.cmd", userprofile));
            candidates.push(format!(r"{}\.local\bin\codex", userprofile));
        }

        // Node.js install path
        if let Ok(programfiles) = std::env::var("ProgramFiles") {
            candidates.push(format!(r"{}\nodejs\codex.cmd", programfiles));
            candidates.push(format!(r"{}\nodejs\codex", programfiles));
        }

        // Chocolatey install path
        if let Ok(programdata) = std::env::var("ProgramData") {
            candidates.push(format!(r"{}\chocolatey\bin\codex.cmd", programdata));
            candidates.push(format!(r"{}\chocolatey\bin\codex", programdata));
        }
    }

    // macOS-specific paths
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            // npm global install paths
            candidates.push(format!("{}/.npm-global/bin/codex", home));
            candidates.push(format!("{}/.npm/bin/codex", home));
            candidates.push(format!("{}/npm/bin/codex", home));

            // pnpm global paths
            candidates.push(format!("{}/Library/pnpm/codex", home));
            candidates.push(format!("{}/.local/share/pnpm/codex", home));
            candidates.push(format!("{}/.pnpm-global/bin/codex", home));

            // Node version managers
            candidates.push(format!("{}/.volta/bin/codex", home));
            candidates.push(format!("{}/.n/bin/codex", home));
            candidates.push(format!("{}/.asdf/shims/codex", home));
            candidates.push(format!("{}/.local/bin/codex", home));

            // fnm (Fast Node Manager) paths
            candidates.push(format!("{}/.fnm/aliases/default/bin/codex", home));
            candidates.push(format!("{}/.local/share/fnm/aliases/default/bin/codex", home));
            candidates.push(format!("{}/Library/Application Support/fnm/aliases/default/bin/codex", home));

            // nvm current symlink
            candidates.push(format!("{}/.nvm/current/bin/codex", home));

            // Dynamically add npm prefix path
            if let Some(npm_prefix) = get_npm_prefix_codex() {
                let npm_bin_path = format!("{}/bin/codex", npm_prefix);
                if !candidates.contains(&npm_bin_path) {
                    log::debug!("[Codex] Adding npm prefix path: {}", npm_bin_path);
                    candidates.push(npm_bin_path);
                }
            }

            // Scan nvm node version directories
            let nvm_versions_dir = format!("{}/.nvm/versions/node", home);
            if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        let codex_path = entry.path().join("bin").join("codex");
                        if codex_path.exists() {
                            candidates.push(codex_path.to_string_lossy().to_string());
                        }
                    }
                }
            }

            // Scan fnm node version directories
            for fnm_base in &[
                format!("{}/.fnm/node-versions", home),
                format!("{}/.local/share/fnm/node-versions", home),
                format!("{}/Library/Application Support/fnm/node-versions", home),
            ] {
                if let Ok(entries) = std::fs::read_dir(fnm_base) {
                    for entry in entries.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let codex_path = entry.path().join("installation").join("bin").join("codex");
                            if codex_path.exists() {
                                candidates.push(codex_path.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }

        // Homebrew paths (Apple Silicon and Intel)
        candidates.push("/opt/homebrew/bin/codex".to_string()); // Apple Silicon (M1/M2/M3)
        candidates.push("/usr/local/bin/codex".to_string());    // Intel Mac / Homebrew legacy

        // NPM global lib paths
        candidates.push("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex".to_string());
        candidates.push("/usr/local/lib/node_modules/@openai/codex/bin/codex".to_string());

        // MacPorts
        candidates.push("/opt/local/bin/codex".to_string());
    }

    // Linux: npm global paths
    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(format!("{}/.npm-global/bin/codex", home));
            candidates.push(format!("{}/.local/bin/codex", home));
            candidates.push(format!("{}/.volta/bin/codex", home));
            candidates.push(format!("{}/.asdf/shims/codex", home));
            candidates.push(format!("{}/.nvm/current/bin/codex", home));
        }
        candidates.push("/usr/local/bin/codex".to_string());
        candidates.push("/usr/bin/codex".to_string());
    }

    candidates
}

// ============================================================================
// Mode Configuration API
// ============================================================================

/// Get Codex mode configuration
#[tauri::command]
pub async fn get_codex_mode_config() -> Result<CodexModeInfo, String> {
    log::info!("[Codex] Getting mode configuration...");

    let config = wsl_utils::get_codex_config();
    let wsl_config = wsl_utils::get_wsl_config();

    // Check availability
    #[cfg(target_os = "windows")]
    let (native_available, wsl_available, available_distros) = {
        let native = wsl_utils::is_native_codex_available();
        let distros = wsl_utils::get_wsl_distros();
        let wsl = !distros.is_empty() && wsl_utils::check_wsl_codex(None).is_some();
        (native, wsl, distros)
    };

    #[cfg(not(target_os = "windows"))]
    let (native_available, wsl_available, available_distros) = (true, false, vec![]);

    let mode_str = match config.mode {
        wsl_utils::CodexMode::Auto => "auto",
        wsl_utils::CodexMode::Native => "native",
        wsl_utils::CodexMode::Wsl => "wsl",
    };

    let actual_mode = if wsl_config.enabled { "wsl" } else { "native" };

    Ok(CodexModeInfo {
        mode: mode_str.to_string(),
        wsl_distro: config.wsl_distro.clone(),
        actual_mode: actual_mode.to_string(),
        native_available,
        wsl_available,
        available_distros,
    })
}

/// Set Codex mode configuration
#[tauri::command]
pub async fn set_codex_mode_config(
    mode: String,
    wsl_distro: Option<String>,
) -> Result<String, String> {
    log::info!("[Codex] Setting mode configuration: mode={}, wsl_distro={:?}", mode, wsl_distro);

    let codex_mode = match mode.to_lowercase().as_str() {
        "auto" => wsl_utils::CodexMode::Auto,
        "native" => wsl_utils::CodexMode::Native,
        "wsl" => wsl_utils::CodexMode::Wsl,
        _ => return Err(format!("Invalid mode: {}. Use 'auto', 'native', or 'wsl'", mode)),
    };

    let config = wsl_utils::CodexConfig {
        mode: codex_mode,
        wsl_distro,
    };

    wsl_utils::save_codex_config(&config)?;

    Ok("Configuration saved. Would you like to restart the app for changes to take effect?".to_string())
}

// ============================================================================
// Provider Configuration Paths
// ============================================================================

/// Get Codex config directory path (supports WSL mode on Windows)
fn get_codex_config_dir() -> Result<PathBuf, String> {
    // Check for WSL mode on Windows
    #[cfg(target_os = "windows")]
    {
        let wsl_config = wsl_utils::get_wsl_config();
        if wsl_config.enabled {
            if let Some(codex_dir) = wsl_utils::get_wsl_codex_dir() {
                log::debug!("[Codex Config] Using WSL config dir: {:?}", codex_dir);
                return Ok(codex_dir);
            }
        }
    }
    
    // Native mode: use local home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Cannot get home directory".to_string())?;
    Ok(home_dir.join(".codex"))
}

/// Get Codex auth.json path
fn get_codex_auth_path() -> Result<PathBuf, String> {
    Ok(get_codex_config_dir()?.join("auth.json"))
}

/// Get Codex config.toml path
fn get_codex_config_path() -> Result<PathBuf, String> {
    Ok(get_codex_config_dir()?.join("config.toml"))
}

/// Get Codex providers.json path (for custom presets)
fn get_codex_providers_path() -> Result<PathBuf, String> {
    Ok(get_codex_config_dir()?.join("providers.json"))
}

/// Get backup path for config.toml (before switching providers)
fn get_config_backup_path() -> Result<PathBuf, String> {
    Ok(get_codex_config_dir()?.join("config.toml.bak"))
}

/// Backup config.toml before modifying
fn backup_config_toml() -> Result<(), String> {
    let config_path = get_codex_config_path()?;
    let backup_path = get_config_backup_path()?;
    
    if config_path.exists() {
        fs::copy(&config_path, &backup_path)
            .map_err(|e| format!("Failed to backup config.toml: {}", e))?;
        log::info!("[Codex Provider] config.toml backed up to {:?}", backup_path);
    }
    Ok(())
}

/// Extract API key from auth JSON
fn extract_api_key_from_auth(auth: &serde_json::Value) -> Option<String> {
    auth.get("OPENAI_API_KEY")
        .or_else(|| auth.get("OPENAI_KEY"))
        .or_else(|| auth.get("API_KEY"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract base_url from config.toml text
fn extract_base_url_from_config(config: &str) -> Option<String> {
    let re = regex::Regex::new(r#"base_url\s*=\s*"([^"]+)""#).ok()?;
    re.captures(config)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Extract model from config.toml text
fn extract_model_from_config(config: &str) -> Option<String> {
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("model =") {
            let re = regex::Regex::new(r#"model\s*=\s*"([^"]+)""#).ok()?;
            return re.captures(trimmed)
                .and_then(|caps| caps.get(1))
                .map(|m| m.as_str().to_string());
        }
    }
    None
}

// ============================================================================
// Provider Management Commands
// ============================================================================

/// Get Codex provider presets (custom user-defined presets)
#[tauri::command]
pub async fn get_codex_provider_presets() -> Result<Vec<CodexProviderConfig>, String> {
    log::info!("[Codex Provider] Getting provider presets");

    let providers_path = get_codex_providers_path()?;

    if !providers_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;

    let providers: Vec<CodexProviderConfig> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;

    Ok(providers)
}

/// Get current Codex configuration
#[tauri::command]
pub async fn get_current_codex_config() -> Result<CurrentCodexConfig, String> {
    log::info!("[Codex Provider] Getting current config");

    let auth_path = get_codex_auth_path()?;
    let config_path = get_codex_config_path()?;

    // Read auth.json
    let auth: serde_json::Value = if auth_path.exists() {
        let content = fs::read_to_string(&auth_path)
            .map_err(|e| format!("Failed to read auth.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse auth.json: {}", e))?
    } else {
        serde_json::json!({})
    };

    // Read config.toml
    let config: String = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.toml: {}", e))?
    } else {
        String::new()
    };

    // Extract values
    let api_key = extract_api_key_from_auth(&auth);
    let base_url = extract_base_url_from_config(&config);
    let model = extract_model_from_config(&config);

    Ok(CurrentCodexConfig {
        auth,
        config,
        api_key,
        base_url,
        model,
    })
}

/// Switch to a Codex provider configuration
/// Preserves user's custom settings and OAuth tokens
#[tauri::command]
pub async fn switch_codex_provider(config: CodexProviderConfig) -> Result<String, String> {
    log::info!("[Codex Provider] Switching to provider: {}", config.name);

    let config_dir = get_codex_config_dir()?;
    let auth_path = get_codex_auth_path()?;
    let config_path = get_codex_config_path()?;

    // Ensure config directory exists
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    // Validate new TOML if not empty
    let new_config_table: Option<toml::Table> = if !config.config.trim().is_empty() {
        Some(toml::from_str(&config.config)
            .map_err(|e| format!("Invalid TOML configuration: {}", e))?)
    } else {
        None
    };

    // Merge auth.json - preserve existing OAuth tokens and other credentials
    // API key related fields that should be cleared when switching to official auth
    let api_key_fields = ["OPENAI_API_KEY", "OPENAI_KEY", "API_KEY"];

    let final_auth = if auth_path.exists() {
        let existing_content = fs::read_to_string(&auth_path)
            .map_err(|e| format!("Failed to read existing auth.json: {}", e))?;

        if let Ok(mut existing_auth) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&existing_content) {
            // Merge new auth into existing - new values take precedence
            if let serde_json::Value::Object(new_auth_map) = serde_json::to_value(&config.auth)
                .map_err(|e| format!("Failed to convert auth: {}", e))?
            {
                // Check if new auth has any API key set (non-empty value)
                let new_auth_has_api_key = api_key_fields.iter().any(|key| {
                    new_auth_map.get(*key).map_or(false, |v| {
                        !v.is_null() && v != &serde_json::Value::String(String::new())
                    })
                });

                // If new auth doesn't have API key (e.g., switching to official OAuth),
                // clear existing API key fields to avoid using stale credentials
                if !new_auth_has_api_key {
                    for key in &api_key_fields {
                        existing_auth.remove(*key);
                    }
                    log::info!("[Codex Provider] Cleared API key fields for official auth mode");
                }

                for (key, value) in new_auth_map {
                    // Only update if the new value is not empty/null
                    if !value.is_null() && value != serde_json::Value::String(String::new()) {
                        existing_auth.insert(key, value);
                    }
                }
            }
            serde_json::Value::Object(existing_auth)
        } else {
            // Existing auth is invalid, use new auth directly
            serde_json::to_value(&config.auth)
                .map_err(|e| format!("Failed to convert auth: {}", e))?
        }
    } else {
        // No existing auth, use new auth directly
        serde_json::to_value(&config.auth)
            .map_err(|e| format!("Failed to convert auth: {}", e))?
    };

    // Write merged auth.json
    let auth_content = serde_json::to_string_pretty(&final_auth)
        .map_err(|e| format!("Failed to serialize auth: {}", e))?;
    fs::write(&auth_path, auth_content)
        .map_err(|e| format!("Failed to write auth.json: {}", e))?;

    // Merge config.toml - preserve user's custom settings using string-level operations
    // to keep comments, formatting, and other user customizations
    let final_config = if config_path.exists() {
        // IMPORTANT: Backup FIRST before any processing
        backup_config_toml()?;
        
        let existing_content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read existing config.toml: {}", e))?;
        
        log::info!("[Codex Provider] Original config.toml content:\n{}", existing_content);

        // Provider-specific key patterns to be replaced (matched at line start)
        let provider_key_patterns = [
            "model_provider",
            "model_reasoning_effort",
            "disable_response_storage",
        ];

        if let Some(_new_table) = new_config_table {
            // Use string-level merge to preserve user's original formatting
            let mut user_config_lines: Vec<String> = Vec::new();
            let mut skip_until_next_section = false;

            for line in existing_content.lines() {
                let trimmed = line.trim();
                let uncommented = trimmed.trim_start_matches('#').trim();
                
                // Skip legacy marker comments (from previous versions)
                if trimmed == "# === Provider Configuration (auto-managed) ===" 
                    || trimmed == "# === User Configuration ===" {
                    continue;
                }
                
                // Check if entering [model_providers.*] section
                if uncommented.starts_with("[model_providers") {
                    skip_until_next_section = true;
                    continue;
                }
                
                // Check if leaving model_providers section (new section starts)
                if skip_until_next_section && uncommented.starts_with('[') && !uncommented.starts_with("[model_providers") {
                    skip_until_next_section = false;
                }
                
                // Skip lines in model_providers section
                if skip_until_next_section {
                    continue;
                }
                
                // Check if this is a top-level "model = " line (not model_provider)
                let is_model_line = {
                    let re = regex::Regex::new(r"^model\s*=").unwrap();
                    re.is_match(uncommented) && !uncommented.starts_with("model_provider")
                };
                
                // Check if this line is a provider-specific key (skip it)
                let is_provider_key = provider_key_patterns.iter().any(|pattern| {
                    uncommented.starts_with(pattern)
                });
                
                // Keep user's original line as-is
                if !is_provider_key && !is_model_line {
                    user_config_lines.push(line.to_string());
                }
            }
            
            // Build final config: provider config FIRST (use original text), then user config
            // Use the raw config string from the provider preset, not the parsed TOML
            let new_config_str = config.config.trim();
            
            let mut final_lines: Vec<String> = Vec::new();
            // Provider config at the top (no marker comment)
            final_lines.push(new_config_str.to_string());
            
            // Add user's other config after provider config (preserve original formatting)
            // Skip leading empty lines from user config
            let user_lines: Vec<String> = user_config_lines.into_iter()
                .skip_while(|l| l.trim().is_empty())
                .collect();
            if !user_lines.is_empty() {
                final_lines.push(String::new()); // Empty line separator
                final_lines.extend(user_lines);
            }
            
            final_lines.join("\n")
        } else {
            // New config is empty (official OpenAI), just remove provider keys
            let mut result_lines: Vec<String> = Vec::new();
            let mut skip_until_next_section = false;

            for line in existing_content.lines() {
                let trimmed = line.trim();
                let uncommented = trimmed.trim_start_matches('#').trim();
                
                // Skip legacy marker comments
                if trimmed == "# === Provider Configuration (auto-managed) ===" 
                    || trimmed == "# === User Configuration ===" {
                    continue;
                }
                
                // Check if entering [model_providers.*] section
                if uncommented.starts_with("[model_providers") {
                    skip_until_next_section = true;
                    continue;
                }
                
                // Check if leaving model_providers section
                if skip_until_next_section && uncommented.starts_with('[') && !uncommented.starts_with("[model_providers") {
                    skip_until_next_section = false;
                }
                
                if skip_until_next_section {
                    continue;
                }
                
                // Check if this is a top-level "model = " line
                let is_model_line = {
                    let re = regex::Regex::new(r"^model\s*=").unwrap();
                    re.is_match(uncommented) && !uncommented.starts_with("model_provider")
                };
                
                // Check if this line is a provider-specific key
                let is_provider_key = provider_key_patterns.iter().any(|pattern| {
                    uncommented.starts_with(pattern)
                });
                
                if !is_provider_key && !is_model_line {
                    result_lines.push(line.to_string());
                }
            }
            
            // Clean up: skip leading empty lines
            let final_lines: Vec<String> = result_lines.into_iter()
                .skip_while(|l| l.trim().is_empty())
                .collect();
            
            final_lines.join("\n")
        }
    } else {
        // No existing config, use new config directly
        config.config.clone()
    };

    // Write merged config.toml (backup already done above)
    fs::write(&config_path, &final_config)
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;

    log::info!("[Codex Provider] Successfully switched to: {}", config.name);
    Ok(format!("Successfully switched to Codex provider: {}", config.name))
}

/// Add a new Codex provider configuration
#[tauri::command]
pub async fn add_codex_provider_config(config: CodexProviderConfig) -> Result<String, String> {
    log::info!("[Codex Provider] Adding provider: {}", config.name);

    let providers_path = get_codex_providers_path()?;

    // Ensure parent directory exists
    if let Some(parent) = providers_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    // Load existing providers
    let mut providers: Vec<CodexProviderConfig> = if providers_path.exists() {
        let content = fs::read_to_string(&providers_path)
            .map_err(|e| format!("Failed to read providers.json: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    // Check for duplicate ID
    if providers.iter().any(|p| p.id == config.id) {
        return Err(format!("Provider with ID '{}' already exists", config.id));
    }

    providers.push(config.clone());

    // Save providers
    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    log::info!("[Codex Provider] Successfully added provider: {}", config.name);
    Ok(format!("Successfully added Codex provider: {}", config.name))
}

/// Update an existing Codex provider configuration
#[tauri::command]
pub async fn update_codex_provider_config(config: CodexProviderConfig) -> Result<String, String> {
    log::info!("[Codex Provider] Updating provider: {}", config.name);

    let providers_path = get_codex_providers_path()?;

    if !providers_path.exists() {
        return Err(format!("Provider with ID '{}' not found", config.id));
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let mut providers: Vec<CodexProviderConfig> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;

    // Find and update the provider
    let index = providers.iter().position(|p| p.id == config.id)
        .ok_or_else(|| format!("Provider with ID '{}' not found", config.id))?;

    providers[index] = config.clone();

    // Save providers
    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    log::info!("[Codex Provider] Successfully updated provider: {}", config.name);
    Ok(format!("Successfully updated Codex provider: {}", config.name))
}

/// Delete a Codex provider configuration
#[tauri::command]
pub async fn delete_codex_provider_config(id: String) -> Result<String, String> {
    log::info!("[Codex Provider] Deleting provider: {}", id);

    let providers_path = get_codex_providers_path()?;

    if !providers_path.exists() {
        return Err(format!("Provider with ID '{}' not found", id));
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let mut providers: Vec<CodexProviderConfig> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;

    // Find and remove the provider
    let initial_len = providers.len();
    providers.retain(|p| p.id != id);

    if providers.len() == initial_len {
        return Err(format!("Provider with ID '{}' not found", id));
    }

    // Save providers
    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    log::info!("[Codex Provider] Successfully deleted provider: {}", id);
    Ok(format!("Successfully deleted Codex provider: {}", id))
}

/// Clear Codex provider configuration (reset to official)
#[tauri::command]
pub async fn clear_codex_provider_config() -> Result<String, String> {
    log::info!("[Codex Provider] Clearing config");

    let auth_path = get_codex_auth_path()?;
    let config_path = get_codex_config_path()?;

    // Remove auth.json if exists
    if auth_path.exists() {
        fs::remove_file(&auth_path)
            .map_err(|e| format!("Failed to remove auth.json: {}", e))?;
    }

    // Remove config.toml if exists
    if config_path.exists() {
        fs::remove_file(&config_path)
            .map_err(|e| format!("Failed to remove config.toml: {}", e))?;
    }

    log::info!("[Codex Provider] Successfully cleared config");
    Ok("Successfully cleared Codex configuration. Now using official OpenAI.".to_string())
}

/// Test Codex provider connection
#[tauri::command]
pub async fn test_codex_provider_connection(base_url: String, api_key: Option<String>) -> Result<String, String> {
    log::info!("[Codex Provider] Testing connection to: {}", base_url);

    // Simple connectivity test - just try to reach the endpoint
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let test_url = format!("{}/models", base_url.trim_end_matches('/'));

    let mut request = client.get(&test_url);

    if let Some(key) = api_key {
        request = request.header("Authorization", format!("Bearer {}", key));
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if status.is_success() || status.as_u16() == 401 {
                // 401 means the endpoint exists but auth is required
                Ok(format!("Connection test successful: endpoint is reachable (status: {})", status))
            } else {
                Ok(format!("Connection test completed with status: {}", status))
            }
        }
        Err(e) => {
            Err(format!("Connection test failed: {}", e))
        }
    }
}

// ============================================================================
// Provider Mode Switching (Official vs Third-Party)
// ============================================================================

/// Provider mode type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderMode {
    /// Current mode: "official" or "third_party"
    pub mode: String,
    /// Whether official OAuth tokens exist
    pub has_official_tokens: bool,
    /// Whether third-party backup exists
    pub has_third_party_backup: bool,
    /// Current API key (masked) if in third-party mode
    pub current_api_key_masked: Option<String>,
    /// Current model provider name
    pub current_provider: Option<String>,
    /// Current model name
    pub current_model: Option<String>,
}

/// Get backup path for third-party auth.json
fn get_third_party_auth_backup_path() -> Result<PathBuf, String> {
    Ok(get_codex_config_dir()?.join("auth.third_party.json.bak"))
}

/// Get backup path for official auth.json
fn get_official_auth_backup_path() -> Result<PathBuf, String> {
    Ok(get_codex_config_dir()?.join("auth.official.json.bak"))
}

/// Check if auth.json contains official OAuth tokens
fn has_official_oauth_tokens(auth: &serde_json::Value) -> bool {
    // Official auth has tokens object with id_token, access_token, refresh_token
    if let Some(tokens) = auth.get("tokens") {
        return tokens.get("id_token").is_some() 
            || tokens.get("access_token").is_some()
            || tokens.get("refresh_token").is_some();
    }
    false
}

/// Mask API key for display
fn mask_api_key(key: &str) -> String {
    if key.len() <= 10 {
        return "*".repeat(key.len());
    }
    let start = &key[..6];
    let end = &key[key.len()-4..];
    format!("{}...{}", start, end)
}

/// Get current provider mode status
#[tauri::command]
pub async fn get_codex_provider_mode() -> Result<CodexProviderMode, String> {
    log::info!("[Codex Provider] Getting provider mode status");

    let auth_path = get_codex_auth_path()?;
    let config_path = get_codex_config_path()?;
    let third_party_backup_path = get_third_party_auth_backup_path()?;
    let official_backup_path = get_official_auth_backup_path()?;

    // Read current auth.json
    let auth: serde_json::Value = if auth_path.exists() {
        let content = fs::read_to_string(&auth_path)
            .map_err(|e| format!("Failed to read auth.json: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Read current config.toml
    let config: String = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.toml: {}", e))?
    } else {
        String::new()
    };

    // Determine current mode
    let has_official = has_official_oauth_tokens(&auth);
    let has_api_key = extract_api_key_from_auth(&auth).is_some();
    let has_model_provider = config.contains("model_provider");

    let mode = if has_official && !has_model_provider {
        "official"
    } else if has_api_key || has_model_provider {
        "third_party"
    } else {
        "unknown"
    };

    // Extract current values
    let current_api_key_masked = extract_api_key_from_auth(&auth)
        .map(|k| mask_api_key(&k));
    let current_provider = extract_model_provider_from_config(&config);
    let current_model = extract_model_from_config(&config);

    Ok(CodexProviderMode {
        mode: mode.to_string(),
        has_official_tokens: has_official || official_backup_path.exists(),
        has_third_party_backup: third_party_backup_path.exists(),
        current_api_key_masked,
        current_provider,
        current_model,
    })
}

/// Extract model_provider from config.toml
fn extract_model_provider_from_config(config: &str) -> Option<String> {
    let re = regex::Regex::new(r#"model_provider\s*=\s*"([^"]+)""#).ok()?;
    re.captures(config)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Backup current auth.json for third-party mode
#[tauri::command]
pub async fn backup_third_party_auth() -> Result<String, String> {
    log::info!("[Codex Provider] Backing up third-party auth");

    let auth_path = get_codex_auth_path()?;
    let backup_path = get_third_party_auth_backup_path()?;

    if !auth_path.exists() {
        return Err("No auth.json found to backup".to_string());
    }

    fs::copy(&auth_path, &backup_path)
        .map_err(|e| format!("Failed to backup auth.json: {}", e))?;

    log::info!("[Codex Provider] Third-party auth backed up to {:?}", backup_path);
    Ok("Third-party auth.json backed up successfully".to_string())
}

/// Backup current auth.json for official mode (OAuth tokens)
#[tauri::command]
pub async fn backup_official_auth() -> Result<String, String> {
    log::info!("[Codex Provider] Backing up official auth");

    let auth_path = get_codex_auth_path()?;
    let backup_path = get_official_auth_backup_path()?;

    if !auth_path.exists() {
        return Err("No auth.json found to backup".to_string());
    }

    // Check if current auth has OAuth tokens
    let content = fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read auth.json: {}", e))?;
    let auth: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse auth.json: {}", e))?;

    if !has_official_oauth_tokens(&auth) {
        return Err("Current auth.json does not contain official OAuth tokens".to_string());
    }

    fs::copy(&auth_path, &backup_path)
        .map_err(|e| format!("Failed to backup auth.json: {}", e))?;

    log::info!("[Codex Provider] Official auth backed up to {:?}", backup_path);
    Ok("Official auth.json backed up successfully".to_string())
}

/// Restore third-party auth.json from backup
#[tauri::command]
pub async fn restore_third_party_auth() -> Result<String, String> {
    log::info!("[Codex Provider] Restoring third-party auth");

    let auth_path = get_codex_auth_path()?;
    let backup_path = get_third_party_auth_backup_path()?;

    if !backup_path.exists() {
        return Err("No third-party auth backup found".to_string());
    }

    fs::copy(&backup_path, &auth_path)
        .map_err(|e| format!("Failed to restore auth.json: {}", e))?;

    log::info!("[Codex Provider] Third-party auth restored from {:?}", backup_path);
    Ok("Third-party auth.json restored successfully".to_string())
}

/// Restore official auth.json from backup
#[tauri::command]
pub async fn restore_official_auth() -> Result<String, String> {
    log::info!("[Codex Provider] Restoring official auth");

    let auth_path = get_codex_auth_path()?;
    let backup_path = get_official_auth_backup_path()?;

    if !backup_path.exists() {
        return Err("No official auth backup found".to_string());
    }

    fs::copy(&backup_path, &auth_path)
        .map_err(|e| format!("Failed to restore auth.json: {}", e))?;

    log::info!("[Codex Provider] Official auth restored from {:?}", backup_path);
    Ok("Official auth.json restored successfully".to_string())
}

/// Switch to official OpenAI mode
/// This will:
/// 1. Backup current third-party auth.json if it has API key
/// 2. Restore official auth.json if backup exists, or clear auth.json
/// 3. Comment out third-party config in config.toml
#[tauri::command]
pub async fn switch_to_official_mode() -> Result<String, String> {
    log::info!("[Codex Provider] Switching to official mode");

    let auth_path = get_codex_auth_path()?;
    let config_path = get_codex_config_path()?;
    let config_dir = get_codex_config_dir()?;
    let third_party_backup_path = get_third_party_auth_backup_path()?;
    let official_backup_path = get_official_auth_backup_path()?;

    // Ensure config directory exists
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    // Step 1: Backup current auth if it has API key (third-party)
    if auth_path.exists() {
        let content = fs::read_to_string(&auth_path)
            .map_err(|e| format!("Failed to read auth.json: {}", e))?;
        if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&content) {
            if extract_api_key_from_auth(&auth).is_some() && !has_official_oauth_tokens(&auth) {
                fs::copy(&auth_path, &third_party_backup_path)
                    .map_err(|e| format!("Failed to backup third-party auth: {}", e))?;
                log::info!("[Codex Provider] Third-party auth backed up");
            }
        }
    }

    // Step 2: Restore official auth if backup exists, otherwise clear auth
    if official_backup_path.exists() {
        fs::copy(&official_backup_path, &auth_path)
            .map_err(|e| format!("Failed to restore official auth: {}", e))?;
        log::info!("[Codex Provider] Official auth restored from backup");
    } else {
        // Create empty auth for official login
        let empty_auth = serde_json::json!({
            "OPENAI_API_KEY": null
        });
        let content = serde_json::to_string_pretty(&empty_auth)
            .map_err(|e| format!("Failed to serialize auth: {}", e))?;
        fs::write(&auth_path, content)
            .map_err(|e| format!("Failed to write auth.json: {}", e))?;
        log::info!("[Codex Provider] Auth cleared for official login");
    }

    // Step 3: Backup and comment out third-party config in config.toml
    if config_path.exists() {
        // Backup before modifying
        backup_config_toml()?;

        let config_content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.toml: {}", e))?;
        
        let commented_config = comment_third_party_config(&config_content);
        fs::write(&config_path, &commented_config)
            .map_err(|e| format!("Failed to write config.toml: {}", e))?;
        log::info!("[Codex Provider] Third-party config commented out");
    }

    Ok("Switched to official mode. Please run 'codex auth login' in terminal to authenticate.".to_string())
}

/// Comment out third-party specific config lines
fn comment_third_party_config(config: &str) -> String {
    let third_party_keys = ["model_provider", "model =", "model_reasoning_effort", "[model_providers"];
    let mut result = Vec::new();
    let mut in_model_providers_section = false;

    for line in config.lines() {
        let trimmed = line.trim();
        
        // Check if entering model_providers section
        if trimmed.starts_with("[model_providers") {
            in_model_providers_section = true;
            if !trimmed.starts_with('#') {
                result.push(format!("# {}", line));
            } else {
                result.push(line.to_string());
            }
            continue;
        }
        
        // Check if leaving model_providers section
        if in_model_providers_section && trimmed.starts_with('[') && !trimmed.starts_with("[model_providers") {
            in_model_providers_section = false;
        }
        
        // Comment out lines in model_providers section
        if in_model_providers_section {
            if !trimmed.starts_with('#') && !trimmed.is_empty() {
                result.push(format!("# {}", line));
            } else {
                result.push(line.to_string());
            }
            continue;
        }
        
        // Comment out third-party keys at top level
        let should_comment = third_party_keys.iter().any(|key| {
            trimmed.starts_with(key) && !trimmed.starts_with('#')
        });
        
        if should_comment {
            result.push(format!("# {}", line));
        } else {
            result.push(line.to_string());
        }
    }

    result.join("\n")
}

/// Uncomment third-party config lines
fn uncomment_third_party_config(config: &str) -> String {
    let third_party_patterns = ["# model_provider", "# model =", "# model_reasoning_effort", "# [model_providers"];
    let mut result = Vec::new();
    let mut in_commented_model_providers = false;

    for line in config.lines() {
        let trimmed = line.trim();
        
        // Check if entering commented model_providers section
        if trimmed.starts_with("# [model_providers") {
            in_commented_model_providers = true;
            result.push(line.trim_start_matches("# ").to_string());
            continue;
        }
        
        // Check if leaving model_providers section
        if in_commented_model_providers {
            if trimmed.starts_with('[') || (trimmed.starts_with("# [") && !trimmed.starts_with("# [model_providers")) {
                in_commented_model_providers = false;
            }
        }
        
        // Uncomment lines in model_providers section
        if in_commented_model_providers && trimmed.starts_with("# ") {
            result.push(line.trim_start_matches("# ").to_string());
            continue;
        }
        
        // Uncomment third-party keys at top level
        let should_uncomment = third_party_patterns.iter().any(|pattern| trimmed.starts_with(pattern));
        
        if should_uncomment {
            result.push(line.trim_start_matches("# ").to_string());
        } else {
            result.push(line.to_string());
        }
    }

    result.join("\n")
}

/// Switch to third-party mode
/// This will:
/// 1. Backup current official auth.json if it has OAuth tokens
/// 2. Restore third-party auth.json from backup, or use provided config
/// 3. Uncomment third-party config in config.toml
#[tauri::command]
pub async fn switch_to_third_party_mode(
    api_key: Option<String>,
    model_provider: Option<String>,
    model: Option<String>,
    model_reasoning_effort: Option<String>,
) -> Result<String, String> {
    log::info!("[Codex Provider] Switching to third-party mode");

    let auth_path = get_codex_auth_path()?;
    let config_path = get_codex_config_path()?;
    let config_dir = get_codex_config_dir()?;
    let third_party_backup_path = get_third_party_auth_backup_path()?;
    let official_backup_path = get_official_auth_backup_path()?;

    // Ensure config directory exists
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    // Step 1: Backup current auth if it has OAuth tokens (official)
    if auth_path.exists() {
        let content = fs::read_to_string(&auth_path)
            .map_err(|e| format!("Failed to read auth.json: {}", e))?;
        if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&content) {
            if has_official_oauth_tokens(&auth) {
                fs::copy(&auth_path, &official_backup_path)
                    .map_err(|e| format!("Failed to backup official auth: {}", e))?;
                log::info!("[Codex Provider] Official auth backed up");
            }
        }
    }

    // Step 2: Set up third-party auth
    if let Some(key) = api_key {
        // Use provided API key
        let auth = serde_json::json!({
            "OPENAI_API_KEY": key
        });
        let content = serde_json::to_string_pretty(&auth)
            .map_err(|e| format!("Failed to serialize auth: {}", e))?;
        fs::write(&auth_path, content)
            .map_err(|e| format!("Failed to write auth.json: {}", e))?;
        log::info!("[Codex Provider] Third-party auth set with new API key");
    } else if third_party_backup_path.exists() {
        // Restore from backup
        fs::copy(&third_party_backup_path, &auth_path)
            .map_err(|e| format!("Failed to restore third-party auth: {}", e))?;
        log::info!("[Codex Provider] Third-party auth restored from backup");
    } else {
        return Err("No API key provided and no third-party backup found".to_string());
    }

    // Step 3: Update config.toml
    let mut config_content = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.toml: {}", e))?
    } else {
        String::new()
    };

    // First, uncomment any commented third-party config
    config_content = uncomment_third_party_config(&config_content);

    // Backup before modifying
    backup_config_toml()?;

    // Update or add config values
    if let Some(provider) = model_provider {
        config_content = update_or_add_toml_value(&config_content, "model_provider", &provider);
    }
    if let Some(m) = model {
        config_content = update_or_add_toml_value(&config_content, "model", &m);
    }
    if let Some(effort) = model_reasoning_effort {
        config_content = update_or_add_toml_value(&config_content, "model_reasoning_effort", &effort);
    }

    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;

    Ok("Switched to third-party mode successfully".to_string())
}

/// Update or add a TOML value at top level
fn update_or_add_toml_value(config: &str, key: &str, value: &str) -> String {
    let pattern = format!(r#"(?m)^{}\s*=\s*"[^"]*""#, regex::escape(key));
    let replacement = format!("{} = \"{}\"", key, value);
    
    if let Ok(re) = regex::Regex::new(&pattern) {
        if re.is_match(config) {
            return re.replace(config, replacement.as_str()).to_string();
        }
    }
    
    // Key doesn't exist, add at the beginning
    format!("{}\n{}", replacement, config)
}

/// Open terminal for Codex authentication
#[tauri::command]
pub async fn open_codex_auth_terminal() -> Result<String, String> {
    log::info!("[Codex Provider] Opening terminal for Codex auth");

    #[cfg(target_os = "windows")]
    {
        use std::process::Command as StdCommand;
        
        // Try to open PowerShell with wsl codex auth login command (codex is installed in WSL)
        let result = StdCommand::new("cmd")
            .args(["/c", "start", "powershell", "-NoExit", "-Command", "wsl codex auth login"])
            .spawn();

        match result {
            Ok(_) => {
                log::info!("[Codex Provider] PowerShell terminal opened for auth via WSL");
                Ok("Terminal opened. Please complete the authentication in the new window.".to_string())
            }
            Err(e) => {
                log::error!("[Codex Provider] Failed to open terminal: {}", e);
                Err(format!("Failed to open terminal: {}. Please run 'wsl codex auth login' manually.", e))
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command as StdCommand;
        
        // Open Terminal.app with codex auth login command
        let script = r#"tell application "Terminal"
            activate
            do script "codex auth login"
        end tell"#;
        
        let result = StdCommand::new("osascript")
            .args(["-e", script])
            .spawn();

        match result {
            Ok(_) => {
                log::info!("[Codex Provider] Terminal opened for auth");
                Ok("Terminal opened. Please complete the authentication in the new window.".to_string())
            }
            Err(e) => {
                log::error!("[Codex Provider] Failed to open terminal: {}", e);
                Err(format!("Failed to open terminal: {}. Please run 'codex auth login' manually.", e))
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command as StdCommand;
        
        // Try common terminal emulators
        let terminals = [
            ("gnome-terminal", vec!["--", "bash", "-c", "codex auth login; exec bash"]),
            ("konsole", vec!["-e", "bash", "-c", "codex auth login; exec bash"]),
            ("xterm", vec!["-e", "bash", "-c", "codex auth login; exec bash"]),
        ];

        for (terminal, args) in terminals {
            if let Ok(_) = StdCommand::new(terminal).args(&args).spawn() {
                log::info!("[Codex Provider] {} terminal opened for auth", terminal);
                return Ok("Terminal opened. Please complete the authentication in the new window.".to_string());
            }
        }

        Err("Failed to open terminal. Please run 'codex auth login' manually.".to_string())
    }
}

/// Check if Codex authentication is valid
#[tauri::command]
pub async fn check_codex_auth_status() -> Result<bool, String> {
    log::info!("[Codex Provider] Checking auth status");

    let auth_path = get_codex_auth_path()?;
    
    if !auth_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read auth.json: {}", e))?;
    let auth: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse auth.json: {}", e))?;

    // Check for valid OAuth tokens or API key
    let has_tokens = has_official_oauth_tokens(&auth);
    let has_api_key = extract_api_key_from_auth(&auth).is_some();

    Ok(has_tokens || has_api_key)
}

// ============================================================================
// Config.toml File Switching (AnyCode)
// ============================================================================

/// Codex config.toml preset (raw file content)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigFileProvider {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub config_toml: String,
    #[serde(default)]
    pub auth_json: String,
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

fn get_codex_config_file_providers_path() -> Result<PathBuf, String> {
    Ok(get_anycode_dir()?.join("codex_config_providers.json"))
}

/// Read current ~/.codex/config.toml (or WSL path on Windows when enabled)
#[tauri::command]
pub async fn read_codex_config_toml() -> Result<String, String> {
    let config_path = get_codex_config_path()?;
    if !config_path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.toml: {}", e))
}

/// Read current ~/.codex/auth.json (or WSL path on Windows when enabled)
#[tauri::command]
pub async fn read_codex_auth_json_text() -> Result<String, String> {
    let auth_path = get_codex_auth_path()?;
    if !auth_path.exists() {
        return Ok("{\n}\n".to_string());
    }

    let content = fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read auth.json: {}", e))?;

    // Normalize formatting if it's valid JSON; otherwise return raw content for user to fix.
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(value) => Ok(serde_json::to_string_pretty(&value).unwrap_or(content)),
        Err(_) => Ok(content),
    }
}

/// Write ~/.codex/config.toml (or WSL path on Windows when enabled)
/// This replaces the file content. If the file exists, a .bak backup is created first.
#[tauri::command]
pub async fn write_codex_config_toml(content: String) -> Result<String, String> {
    // Validate TOML when not empty
    if !content.trim().is_empty() {
        let _table: toml::Table = toml::from_str(&content)
            .map_err(|e| format!("Invalid TOML configuration: {}", e))?;
    }

    let config_dir = get_codex_config_dir()?;
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    // Backup existing file (if any)
    let config_path = get_codex_config_path()?;
    if config_path.exists() {
        backup_config_toml()?;
    }

    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;

    Ok(format!("✅ 已写入 {}", config_path.display()))
}

/// Write ~/.codex/auth.json (or WSL path on Windows when enabled)
/// This replaces the file content. The content must be a valid JSON object.
#[tauri::command]
pub async fn write_codex_auth_json_text(content: String) -> Result<String, String> {
    let trimmed = content.trim();
    let json_str = if trimmed.is_empty() { "{}" } else { trimmed };

    let value: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    if !value.is_object() {
        return Err("auth.json 必须是 JSON 对象".to_string());
    }

    let config_dir = get_codex_config_dir()?;
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    let auth_path = get_codex_auth_path()?;
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Failed to serialize auth.json: {}", e))?;

    fs::write(&auth_path, pretty)
        .map_err(|e| format!("Failed to write auth.json: {}", e))?;

    Ok(format!("✅ 已写入 {}", auth_path.display()))
}

/// Write both ~/.codex/config.toml and ~/.codex/auth.json (WSL-aware on Windows)
/// This validates both files before writing to reduce partial updates.
#[tauri::command]
pub async fn write_codex_config_files(config_toml: String, auth_json: String) -> Result<String, String> {
    // Validate TOML when not empty
    if !config_toml.trim().is_empty() {
        let _table: toml::Table = toml::from_str(&config_toml)
            .map_err(|e| format!("Invalid TOML configuration: {}", e))?;
    }

    // Validate auth.json (accept empty as {})
    let auth_trimmed = auth_json.trim();
    let auth_str = if auth_trimmed.is_empty() { "{}" } else { auth_trimmed };
    let auth_value: serde_json::Value = serde_json::from_str(auth_str)
        .map_err(|e| format!("Invalid JSON (auth.json): {}", e))?;
    if !auth_value.is_object() {
        return Err("auth.json 必须是 JSON 对象".to_string());
    }

    let config_dir = get_codex_config_dir()?;
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    // Backup existing config.toml (if any)
    let config_path = get_codex_config_path()?;
    if config_path.exists() {
        backup_config_toml()?;
    }

    // Write config.toml (keep user formatting)
    fs::write(&config_path, config_toml)
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;

    // Write auth.json (pretty JSON)
    let auth_path = get_codex_auth_path()?;
    let auth_pretty = serde_json::to_string_pretty(&auth_value)
        .map_err(|e| format!("Failed to serialize auth.json: {}", e))?;
    fs::write(&auth_path, auth_pretty)
        .map_err(|e| format!("Failed to write auth.json: {}", e))?;

    Ok(format!("✅ 已写入 {} 和 {}", config_path.display(), auth_path.display()))
}

/// Get Codex config.toml presets (AnyCode-managed)
#[tauri::command]
pub async fn get_codex_config_file_providers() -> Result<Vec<CodexConfigFileProvider>, String> {
    let providers_path = get_codex_config_file_providers_path()?;
    if !providers_path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let providers: Vec<CodexConfigFileProvider> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;
    Ok(providers)
}

/// Add a Codex config.toml preset (AnyCode-managed)
#[tauri::command]
pub async fn add_codex_config_file_provider(
    config: CodexConfigFileProvider,
) -> Result<String, String> {
    let providers_path = get_codex_config_file_providers_path()?;

    if let Some(parent) = providers_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    let mut providers: Vec<CodexConfigFileProvider> = if providers_path.exists() {
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

    Ok(format!("Successfully added Codex config preset: {}", config.name))
}

/// Update a Codex config.toml preset (AnyCode-managed)
#[tauri::command]
pub async fn update_codex_config_file_provider(
    config: CodexConfigFileProvider,
) -> Result<String, String> {
    let providers_path = get_codex_config_file_providers_path()?;
    if !providers_path.exists() {
        return Err(format!("Provider with ID '{}' not found", config.id));
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let mut providers: Vec<CodexConfigFileProvider> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse providers.json: {}", e))?;

    let index = providers.iter().position(|p| p.id == config.id)
        .ok_or_else(|| format!("Provider with ID '{}' not found", config.id))?;
    providers[index] = config.clone();

    let content = serde_json::to_string_pretty(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))?;
    fs::write(&providers_path, content)
        .map_err(|e| format!("Failed to write providers.json: {}", e))?;

    Ok(format!("Successfully updated Codex config preset: {}", config.name))
}

/// Delete a Codex config.toml preset (AnyCode-managed)
#[tauri::command]
pub async fn delete_codex_config_file_provider(id: String) -> Result<String, String> {
    let providers_path = get_codex_config_file_providers_path()?;
    if !providers_path.exists() {
        return Err(format!("Provider with ID '{}' not found", id));
    }

    let content = fs::read_to_string(&providers_path)
        .map_err(|e| format!("Failed to read providers.json: {}", e))?;
    let mut providers: Vec<CodexConfigFileProvider> = serde_json::from_str(&content)
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

    Ok("Successfully deleted Codex config preset".to_string())
}
