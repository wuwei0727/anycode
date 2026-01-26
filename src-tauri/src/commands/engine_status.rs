/**
 * 统一的引擎状态检查模块
 * 
 * 提供统一的接口来检查 Claude、Codex、Gemini 引擎的状态
 * 支持 Native 和 WSL 环境检测
 */

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use rusqlite::Connection;

// 导入各引擎的检查函数
use crate::commands::claude::check_claude_version;
use crate::commands::codex::check_codex_availability;
use crate::commands::gemini::check_gemini_installed;

// ============================================================================
// 类型定义
// ============================================================================

/// 统一的引擎状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedEngineStatus {
    /// 引擎名称 ("claude" | "codex" | "gemini")
    pub engine: String,
    
    /// 是否已安装
    pub is_installed: bool,
    
    /// 版本号
    pub version: Option<String>,
    
    /// 运行环境 ("native" | "wsl")
    pub environment: String,
    
    /// WSL 发行版名称 (仅 WSL 环境)
    pub wsl_distro: Option<String>,
    
    /// 可执行文件路径
    pub path: Option<String>,
    
    /// 错误信息
    pub error: Option<String>,
    
    /// 最后检查时间戳
    pub last_checked: Option<i64>,
}

/// 引擎检测结果
#[derive(Debug, Clone)]
pub struct EngineDetectionResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: String,  // "native" | "wsl" | "custom"
}

/// 引擎更新结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineUpdateResult {
    /// 是否成功
    pub success: bool,
    
    /// 更新前的版本
    pub old_version: Option<String>,
    
    /// 更新后的版本
    pub new_version: Option<String>,
    
    /// 更新输出信息
    pub output: String,
    
    /// 错误信息
    pub error: Option<String>,
}

/// 检查更新结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdateResult {
    /// 当前版本
    pub current_version: Option<String>,
    
    /// 最新版本（从 npm/pip 查询）
    pub latest_version: Option<String>,
    
    /// 是否有更新可用
    pub update_available: bool,
    
    /// 错误信息
    pub error: Option<String>,
}

// ============================================================================
// 主要命令
// ============================================================================

/// 检查指定引擎的状态
#[tauri::command]
pub async fn check_engine_status(
    app: AppHandle,
    engine: String
) -> Result<UnifiedEngineStatus, String> {
    log::info!("[EngineStatus] Checking status for engine: {}", engine);
    
    // 清除 Claude 二进制路径缓存，强制重新检测
    if engine.to_lowercase() == "claude" {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            let db_path = app_data_dir.join("agents.db");
            if db_path.exists() {
                if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                    let _ = conn.execute(
                        "DELETE FROM app_settings WHERE key = 'claude_binary_path'",
                        [],
                    );
                    log::info!("[EngineStatus] Cleared Claude binary path cache");
                }
            }
        }
    }
    
    let now = chrono::Utc::now().timestamp();
    
    match engine.to_lowercase().as_str() {
        "claude" => check_claude_status(app, now).await,
        "codex" => check_codex_status(now).await,
        "gemini" => check_gemini_status(now).await,
        _ => Err(format!("Unknown engine: {}", engine))
    }
}

/// 更新指定引擎
#[tauri::command]
pub async fn update_engine(
    app: AppHandle,
    engine: String,
    environment: String,
    wsl_distro: Option<String>
) -> Result<EngineUpdateResult, String> {
    log::info!("[EngineStatus] Updating engine: {} in {} environment", engine, environment);
    
    // 先获取当前版本
    let old_status = check_engine_status(app.clone(), engine.clone()).await?;
    let old_version = old_status.version.clone();
    
    // 执行更新
    let update_result = match engine.to_lowercase().as_str() {
        "claude" => update_claude(&environment, wsl_distro.as_deref()).await,
        "codex" => update_codex(&environment, wsl_distro.as_deref()).await,
        "gemini" => update_gemini(&environment, wsl_distro.as_deref()).await,
        _ => return Err(format!("Unknown engine: {}", engine))
    };
    
    // 更新后重新检查版本
    let new_status = check_engine_status(app, engine).await?;
    let new_version = new_status.version;
    
    match update_result {
        Ok(output) => {
            Ok(EngineUpdateResult {
                success: true,
                old_version,
                new_version,
                output,
                error: None,
            })
        }
        Err(e) => {
            Ok(EngineUpdateResult {
                success: false,
                old_version,
                new_version,
                output: String::new(),
                error: Some(e),
            })
        }
    }
}

/// 检查引擎更新
#[tauri::command]
pub async fn check_engine_update(
    app: AppHandle,
    engine: String,
    environment: String,
    wsl_distro: Option<String>
) -> Result<CheckUpdateResult, String> {
    log::info!("[EngineStatus] Checking update for engine: {} in {} environment", engine, environment);
    
    // 清除 Claude 二进制路径缓存，强制重新检测
    if engine.to_lowercase() == "claude" {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            let db_path = app_data_dir.join("agents.db");
            if db_path.exists() {
                if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                    let _ = conn.execute(
                        "DELETE FROM app_settings WHERE key = 'claude_binary_path'",
                        [],
                    );
                    log::info!("[EngineStatus] Cleared Claude binary path cache");
                }
            }
        }
    }
    
    // 获取当前版本
    let current_status = check_engine_status(app, engine.clone()).await?;
    let current_version = current_status.version.clone();
    
    // 查询最新版本
    let latest_version_result = match engine.to_lowercase().as_str() {
        "claude" => check_latest_version_npm("@anthropic-ai/claude-code", &environment, wsl_distro.as_deref()).await,
        "codex" => check_latest_version_npm("@openai/codex", &environment, wsl_distro.as_deref()).await,
        "gemini" => check_latest_version_pip("google-generativeai", &environment, wsl_distro.as_deref()).await,
        _ => return Err(format!("Unknown engine: {}", engine))
    };
    
    match latest_version_result {
        Ok(latest_version) => {
            let update_available = if let Some(ref current) = current_version {
                // 清理版本号，只保留数字和点
                let clean_current = extract_version_number(current);
                let clean_latest = extract_version_number(&latest_version);
                clean_current != clean_latest
            } else {
                false
            };
            
            Ok(CheckUpdateResult {
                current_version,
                latest_version: Some(latest_version),
                update_available,
                error: None,
            })
        }
        Err(e) => {
            Ok(CheckUpdateResult {
                current_version,
                latest_version: None,
                update_available: false,
                error: Some(e),
            })
        }
    }
}

// ============================================================================
// Claude 状态检查
// ============================================================================

async fn check_claude_status(app: AppHandle, timestamp: i64) -> Result<UnifiedEngineStatus, String> {
    log::info!("[EngineStatus] Checking Claude status...");
    
    // 调用现有的 Claude 版本检查
    match check_claude_version(app).await {
        Ok(claude_status) => {
            let environment = if claude_status.output.contains("WSL") || claude_status.output.contains("wsl") {
                "wsl".to_string()
            } else {
                "native".to_string()
            };
            
            let wsl_distro = if environment == "wsl" {
                // 尝试从输出中提取 WSL 发行版名称
                extract_wsl_distro(&claude_status.output)
            } else {
                None
            };
            
            Ok(UnifiedEngineStatus {
                engine: "claude".to_string(),
                is_installed: claude_status.is_installed,
                version: claude_status.version,
                environment,
                wsl_distro,
                path: None, // TODO: 从 claude_status 中提取路径
                error: if !claude_status.is_installed {
                    Some(claude_status.output)
                } else {
                    None
                },
                last_checked: Some(timestamp),
            })
        }
        Err(e) => {
            log::error!("[EngineStatus] Claude check failed: {}", e);
            Ok(UnifiedEngineStatus {
                engine: "claude".to_string(),
                is_installed: false,
                version: None,
                environment: "native".to_string(),
                wsl_distro: None,
                path: None,
                error: Some(e),
                last_checked: Some(timestamp),
            })
        }
    }
}

// ============================================================================
// Codex 状态检查
// ============================================================================

async fn check_codex_status(timestamp: i64) -> Result<UnifiedEngineStatus, String> {
    log::info!("[EngineStatus] Checking Codex status...");
    
    // 调用现有的 Codex 可用性检查
    match check_codex_availability().await {
        Ok(codex_status) => {
            // 检查是否在 WSL 环境
            let environment = if codex_status.version.as_ref()
                .map(|v| v.contains("WSL") || v.contains("wsl"))
                .unwrap_or(false) {
                "wsl".to_string()
            } else {
                "native".to_string()
            };
            
            let wsl_distro = if environment == "wsl" {
                // 尝试从版本信息中提取 WSL 发行版
                codex_status.version.as_ref().and_then(|v| extract_wsl_distro(v))
            } else {
                None
            };
            
            Ok(UnifiedEngineStatus {
                engine: "codex".to_string(),
                is_installed: codex_status.available,
                version: codex_status.version,
                environment,
                wsl_distro,
                path: None, // TODO: 从 codex_status 中提取路径
                error: codex_status.error,
                last_checked: Some(timestamp),
            })
        }
        Err(e) => {
            log::error!("[EngineStatus] Codex check failed: {}", e);
            Ok(UnifiedEngineStatus {
                engine: "codex".to_string(),
                is_installed: false,
                version: None,
                environment: "native".to_string(),
                wsl_distro: None,
                path: None,
                error: Some(e),
                last_checked: Some(timestamp),
            })
        }
    }
}

// ============================================================================
// Gemini 状态检查
// ============================================================================

async fn check_gemini_status(timestamp: i64) -> Result<UnifiedEngineStatus, String> {
    log::info!("[EngineStatus] Checking Gemini status...");
    
    // 调用现有的 Gemini 安装检查
    match check_gemini_installed().await {
        Ok(gemini_status) => {
            let environment = if gemini_status.path.as_ref()
                .map(|p| p.contains("WSL") || p.contains("wsl") || p.starts_with("\\\\wsl"))
                .unwrap_or(false) {
                "wsl".to_string()
            } else {
                "native".to_string()
            };
            
            let wsl_distro = if environment == "wsl" {
                gemini_status.path.as_ref().and_then(|p| extract_wsl_distro(p))
            } else {
                None
            };
            
            Ok(UnifiedEngineStatus {
                engine: "gemini".to_string(),
                is_installed: gemini_status.installed,
                version: gemini_status.version,
                environment,
                wsl_distro,
                path: gemini_status.path,
                error: gemini_status.error,
                last_checked: Some(timestamp),
            })
        }
        Err(e) => {
            log::error!("[EngineStatus] Gemini check failed: {}", e);
            Ok(UnifiedEngineStatus {
                engine: "gemini".to_string(),
                is_installed: false,
                version: None,
                environment: "native".to_string(),
                wsl_distro: None,
                path: None,
                error: Some(e),
                last_checked: Some(timestamp),
            })
        }
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 更新 Claude
async fn update_claude(environment: &str, wsl_distro: Option<&str>) -> Result<String, String> {
    log::info!("[EngineStatus] Updating Claude in {} environment", environment);
    
    let command = if environment == "wsl" {
        if let Some(distro) = wsl_distro {
            format!("wsl -d {} npm install -g @anthropic-ai/claude-code", distro)
        } else {
            "wsl npm install -g @anthropic-ai/claude-code".to_string()
        }
    } else {
        "npm install -g @anthropic-ai/claude-code".to_string()
    };
    
    execute_update_command(&command).await
}

/// 更新 Codex
async fn update_codex(environment: &str, wsl_distro: Option<&str>) -> Result<String, String> {
    log::info!("[EngineStatus] Updating Codex in {} environment", environment);
    
    let command = if environment == "wsl" {
        if let Some(distro) = wsl_distro {
            format!("wsl -d {} npm install -g @openai/codex", distro)
        } else {
            "wsl npm install -g @openai/codex".to_string()
        }
    } else {
        "npm install -g @openai/codex".to_string()
    };
    
    execute_update_command(&command).await
}

/// 更新 Gemini
async fn update_gemini(environment: &str, wsl_distro: Option<&str>) -> Result<String, String> {
    log::info!("[EngineStatus] Updating Gemini in {} environment", environment);
    
    let command = if environment == "wsl" {
        if let Some(distro) = wsl_distro {
            format!("wsl -d {} pip install --upgrade google-generativeai", distro)
        } else {
            "wsl pip install --upgrade google-generativeai".to_string()
        }
    } else {
        "pip install --upgrade google-generativeai".to_string()
    };
    
    execute_update_command(&command).await
}

/// 执行更新命令
async fn execute_update_command(command: &str) -> Result<String, String> {
    use std::process::Command;
    
    log::info!("[EngineStatus] Executing: {}", command);
    
    // 在 Windows 上使用 cmd /C
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(&["/C", command])
            .output()
    } else {
        Command::new("sh")
            .args(&["-c", command])
            .output()
    };
    
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            
            if output.status.success() {
                log::info!("[EngineStatus] Update successful: {}", stdout);
                Ok(format!("{}\n{}", stdout, stderr))
            } else {
                log::error!("[EngineStatus] Update failed: {}", stderr);
                Err(format!("更新失败: {}", stderr))
            }
        }
        Err(e) => {
            log::error!("[EngineStatus] Failed to execute command: {}", e);
            Err(format!("执行命令失败: {}", e))
        }
    }
}

/// 检查 npm 包的最新版本
async fn check_latest_version_npm(package: &str, environment: &str, wsl_distro: Option<&str>) -> Result<String, String> {
    use std::process::Command;
    
    let command = if environment == "wsl" {
        if let Some(distro) = wsl_distro {
            format!("wsl -d {} npm view {} version", distro, package)
        } else {
            format!("wsl npm view {} version", package)
        }
    } else {
        format!("npm view {} version", package)
    };
    
    log::info!("[EngineStatus] Checking latest version: {}", command);
    
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(&["/C", &command])
            .output()
    } else {
        Command::new("sh")
            .args(&["-c", &command])
            .output()
    };
    
    match output {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // 过滤掉 "Active code page" 等无关信息，只保留版本号
                let version = stdout
                    .lines()
                    .filter(|line| !line.contains("Active code page"))
                    .filter(|line| !line.trim().is_empty())
                    .last()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                
                if version.is_empty() {
                    Err("无法解析版本号".to_string())
                } else {
                    log::info!("[EngineStatus] Latest version: {}", version);
                    Ok(version)
                }
            } else {
                let error = String::from_utf8_lossy(&output.stderr).to_string();
                log::error!("[EngineStatus] Failed to check version: {}", error);
                Err(format!("查询版本失败: {}", error))
            }
        }
        Err(e) => {
            log::error!("[EngineStatus] Failed to execute command: {}", e);
            Err(format!("执行命令失败: {}", e))
        }
    }
}

/// 检查 pip 包的最新版本
async fn check_latest_version_pip(package: &str, environment: &str, wsl_distro: Option<&str>) -> Result<String, String> {
    use std::process::Command;
    
    let command = if environment == "wsl" {
        if let Some(distro) = wsl_distro {
            format!("wsl -d {} pip index versions {}", distro, package)
        } else {
            format!("wsl pip index versions {}", package)
        }
    } else {
        format!("pip index versions {}", package)
    };
    
    log::info!("[EngineStatus] Checking latest version: {}", command);
    
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(&["/C", &command])
            .output()
    } else {
        Command::new("sh")
            .args(&["-c", &command])
            .output()
    };
    
    match output {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // 从输出中提取版本号 (格式: "Available versions: 1.0.0, 0.9.0, ...")
                // 过滤掉 "Active code page" 等无关信息
                for line in stdout.lines() {
                    if line.contains("Active code page") {
                        continue;
                    }
                    if line.contains("Available versions:") {
                        if let Some(versions) = line.split(':').nth(1) {
                            if let Some(latest) = versions.trim().split(',').next() {
                                let version = latest.trim().to_string();
                                log::info!("[EngineStatus] Latest version: {}", version);
                                return Ok(version);
                            }
                        }
                    }
                }
                Err("无法解析版本信息".to_string())
            } else {
                let error = String::from_utf8_lossy(&output.stderr).to_string();
                log::error!("[EngineStatus] Failed to check version: {}", error);
                Err(format!("查询版本失败: {}", error))
            }
        }
        Err(e) => {
            log::error!("[EngineStatus] Failed to execute command: {}", e);
            Err(format!("执行命令失败: {}", e))
        }
    }
}

/// 从版本字符串中提取纯数字版本号
/// 例如: "2.0.75 (Claude Code)" -> "2.0.75"
///       "WSL: 0.72.0" -> "0.72.0"
fn extract_version_number(version: &str) -> String {
    // 移除 "WSL: " 前缀
    let version = version.trim_start_matches("WSL: ").trim();
    
    // 查找第一个非版本号字符（空格、括号等）
    if let Some(pos) = version.find(|c: char| !c.is_numeric() && c != '.') {
        // 如果第一个字符就不是数字，尝试查找版本号模式
        if pos == 0 {
            // 尝试匹配版本号模式 (数字.数字.数字)
            for word in version.split_whitespace() {
                if word.chars().next().map(|c| c.is_numeric()).unwrap_or(false) {
                    if let Some(end) = word.find(|c: char| !c.is_numeric() && c != '.') {
                        return word[..end].to_string();
                    } else {
                        return word.to_string();
                    }
                }
            }
            version.to_string()
        } else {
            version[..pos].trim().to_string()
        }
    } else {
        version.to_string()
    }
}

/// 从字符串中提取 WSL 发行版名称
fn extract_wsl_distro(text: &str) -> Option<String> {
    // 尝试匹配常见的 WSL 发行版名称
    let distros = ["Ubuntu", "Debian", "Kali", "openSUSE", "Fedora", "Alpine"];
    
    for distro in &distros {
        if text.contains(distro) {
            // 尝试提取完整的发行版名称（如 "Ubuntu-22.04"）
            if let Some(start) = text.find(distro) {
                let remaining = &text[start..];
                if let Some(end) = remaining.find(|c: char| c.is_whitespace() || c == ')' || c == ']') {
                    return Some(remaining[..end].to_string());
                } else {
                    return Some(distro.to_string());
                }
            }
        }
    }
    
    // 尝试从 WSL UNC 路径中提取 (\\wsl$\Ubuntu-22.04\...)
    if text.contains("\\\\wsl") || text.contains("\\\\wsl$") {
        if let Some(start) = text.find("\\\\wsl$\\").or_else(|| text.find("\\\\wsl\\")) {
            let after_wsl = &text[start + 7..]; // Skip "\\wsl$\" or "\\wsl\"
            if let Some(end) = after_wsl.find('\\') {
                return Some(after_wsl[..end].to_string());
            }
        }
    }
    
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_extract_wsl_distro() {
        assert_eq!(
            extract_wsl_distro("Running in WSL (Ubuntu-22.04)"),
            Some("Ubuntu-22.04".to_string())
        );
        
        assert_eq!(
            extract_wsl_distro("\\\\wsl$\\Ubuntu-22.04\\home\\user"),
            Some("Ubuntu-22.04".to_string())
        );
        
        assert_eq!(
            extract_wsl_distro("Native Windows"),
            None
        );
    }
    
    #[test]
    fn test_extract_version_number() {
        // Claude 版本格式
        assert_eq!(
            extract_version_number("2.0.75 (Claude Code)"),
            "2.0.75"
        );
        
        // Codex 版本格式
        assert_eq!(
            extract_version_number("0.72.0"),
            "0.72.0"
        );
        
        // WSL 前缀
        assert_eq!(
            extract_version_number("WSL: 0.72.0"),
            "0.72.0"
        );
        
        // 带其他文本
        assert_eq!(
            extract_version_number("codex-cli 0.72.0"),
            "0.72.0"
        );
        
        // 纯版本号
        assert_eq!(
            extract_version_number("1.2.3"),
            "1.2.3"
        );
    }
}
