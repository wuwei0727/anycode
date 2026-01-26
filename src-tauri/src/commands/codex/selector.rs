/**
 * Codex 模型和推理模式选择器模块
 *
 * 处理 Codex 模型和推理模式的选择、配置管理和能力检测
 */

use serde::{Deserialize, Serialize};

use tokio::process::Command;
use dirs;
use std::path::PathBuf;
use toml;

// 导入现有的 Codex 工具
use crate::commands::claude::apply_no_window_async;
use crate::claude_binary::detect_binary_for_tool;
use super::super::wsl_utils;

// ============================================================================
// 数据结构定义
// ============================================================================

/// 推理模式选项
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningModeOption {
    /// 推理模式值
    pub value: String,
    /// 显示标签
    pub label: String,
    /// 描述信息
    pub description: String,
    /// 排序顺序
    pub order: i32,
}

/// Codex 模型选项
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelOption {
    /// 模型值
    pub value: String,
    /// 显示标签
    pub label: String,
    /// 描述信息
    pub description: String,
    /// 模型类别
    pub category: Option<String>,
    /// 是否可用
    pub is_available: bool,
    /// 排序顺序
    pub order: i32,
    /// 该模型支持的推理模式
    pub supported_reasoning_modes: Vec<String>,
}

/// Codex 选择配置
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSelectionConfig {
    /// 推理模式
    pub reasoning_mode: String,
    /// 模型
    pub model: String,
    /// 时间戳
    pub timestamp: u64,
}

/// Codex 能力信息
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCapabilities {
    /// 可用的推理模式
    pub reasoning_modes: Vec<ReasoningModeOption>,
    /// 可用的模型
    pub models: Vec<CodexModelOption>,
    /// 默认配置
    pub defaults: CodexDefaults,
    /// 最后更新时间
    pub last_updated: String,
    /// Codex 版本
    pub codex_version: Option<String>,
}

/// 默认配置
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDefaults {
    /// 默认推理模式
    pub reasoning_mode: String,
    /// 默认模型
    pub model: String,
}

/// Codex CLI 模型输出
#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexModelOutput {
    models: Vec<CodexModelInfo>,
}

/// Codex CLI 模型信息
#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexModelInfo {
    id: String,
    name: String,
    description: Option<String>,
    #[serde(rename = "type")]
    model_type: Option<String>,
    available: Option<bool>,
}

/// Codex CLI 推理模式输出
#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexReasoningModeOutput {
    reasoning_modes: Vec<CodexReasoningModeInfo>,
}

/// Codex CLI 推理模式信息
#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexReasoningModeInfo {
    id: String,
    name: String,
    description: Option<String>,
}

// ============================================================================
// 常量定义
// ============================================================================

/// 默认推理模式
const DEFAULT_REASONING_MODE: &str = "medium";

/// 默认模型（基于官方文档，gpt-5.2-codex 是当前默认）
const DEFAULT_MODEL: &str = "gpt-5.2-codex";

/// 配置文件名
const CONFIG_FILE_NAME: &str = "codex-selector-config.json";

/// 能力缓存文件名
const CAPABILITIES_CACHE_FILE_NAME: &str = "codex-capabilities-cache.json";

/// 缓存有效期（秒）
const CACHE_VALIDITY_SECONDS: u64 = 24 * 60 * 60; // 24小时

// ============================================================================
// 内置默认值
// ============================================================================

/// 获取内置的默认推理模式
fn get_builtin_reasoning_modes() -> Vec<ReasoningModeOption> {
    vec![
        ReasoningModeOption {
            value: "low".to_string(),
            label: "Low".to_string(),
            description: "快速响应模式".to_string(),
            order: 1,
        },
        ReasoningModeOption {
            value: "medium".to_string(),
            label: "Medium".to_string(),
            description: "平衡性能模式".to_string(),
            order: 2,
        },
        ReasoningModeOption {
            value: "high".to_string(),
            label: "High".to_string(),
            description: "深度思考模式".to_string(),
            order: 3,
        },
        ReasoningModeOption {
            value: "xhigh".to_string(),
            label: "Extra High".to_string(),
            description: "最深度分析模式".to_string(),
            order: 4,
        },
    ]
}

/// 根据模型获取支持的推理模式
/// 基于 OpenAI Codex CLI 实际行为（用户截图验证）
/// 
/// 推理模式说明：
/// - low: 快速响应模式
/// - medium: 平衡性能模式（推荐日常使用）
/// - high: 深度思考模式
/// - xhigh: 最深度分析模式（Extra High）
/// 
/// 模型支持情况（基于 Codex CLI 实际显示）：
/// - 大多数模型支持全部 4 种推理模式（low/medium/high/xhigh）
/// - mini 系列轻量模型仅支持 low/medium
fn get_supported_reasoning_modes_for_model(model_id: &str) -> Vec<String> {
    // mini 系列轻量模型仅支持 low/medium
    if model_id.contains("mini") {
        return vec![
            "low".to_string(), 
            "medium".to_string()
        ];
    }
    
    // 其他所有模型支持全部 4 种推理模式
    vec![
        "low".to_string(), 
        "medium".to_string(), 
        "high".to_string(), 
        "xhigh".to_string()
    ]
}

/// 获取内置的默认模型
/// 基于 Codex CLI /model 命令显示的模型列表
fn get_builtin_models() -> Vec<CodexModelOption> {
    vec![
        CodexModelOption {
            value: "gpt-5.2-codex".to_string(),
            label: "GPT-5.2-Codex".to_string(),
            description: "最新前沿代理编码模型（默认）".to_string(),
            category: Some("codex".to_string()),
            is_available: true,
            order: 1,
            supported_reasoning_modes: get_supported_reasoning_modes_for_model("gpt-5.2-codex"),
        },
        CodexModelOption {
            value: "gpt-5.1-codex-max".to_string(),
            label: "GPT-5.1-Codex-Max".to_string(),
            description: "Codex 优化旗舰模型，支持 xhigh 深度推理".to_string(),
            category: Some("codex".to_string()),
            is_available: true,
            order: 2,
            supported_reasoning_modes: get_supported_reasoning_modes_for_model("gpt-5.1-codex-max"),
        },
        CodexModelOption {
            value: "gpt-5.1-codex-mini".to_string(),
            label: "GPT-5.1-Codex-Mini".to_string(),
            description: "轻量模型，更便宜更快（仅支持 Low/Medium）".to_string(),
            category: Some("codex".to_string()),
            is_available: true,
            order: 3,
            supported_reasoning_modes: get_supported_reasoning_modes_for_model("gpt-5.1-codex-mini"),
        },
        CodexModelOption {
            value: "gpt-5.2".to_string(),
            label: "GPT-5.2".to_string(),
            description: "最新前沿通用模型".to_string(),
            category: Some("general".to_string()),
            is_available: true,
            order: 4,
            supported_reasoning_modes: get_supported_reasoning_modes_for_model("gpt-5.2"),
        },
    ]
}

/// 获取内置的默认能力
fn get_builtin_capabilities() -> CodexCapabilities {
    CodexCapabilities {
        reasoning_modes: get_builtin_reasoning_modes(),
        models: get_builtin_models(),
        defaults: CodexDefaults {
            reasoning_mode: DEFAULT_REASONING_MODE.to_string(),
            model: DEFAULT_MODEL.to_string(),
        },
        last_updated: chrono::Utc::now().to_rfc3339(),
        codex_version: None,
    }
}

// ============================================================================
// 配置文件路径工具
// ============================================================================

/// 获取配置目录路径
fn get_config_dir() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "无法获取用户主目录".to_string())?;
    
    Ok(home_dir.join(".kiro"))
}

/// 获取配置文件路径
fn get_config_file_path() -> Result<PathBuf, String> {
    Ok(get_config_dir()?.join(CONFIG_FILE_NAME))
}

/// 获取能力缓存文件路径
fn get_capabilities_cache_path() -> Result<PathBuf, String> {
    Ok(get_config_dir()?.join(CAPABILITIES_CACHE_FILE_NAME))
}

// ============================================================================
// 配置管理函数
// ============================================================================

/// 加载配置文件
fn load_config_from_file() -> Result<Option<CodexSelectionConfig>, String> {
    let config_path = get_config_file_path()?;
    
    if !config_path.exists() {
        return Ok(None);
    }
    
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取配置文件失败: {}", e))?;
    
    let config: CodexSelectionConfig = serde_json::from_str(&content)
        .map_err(|e| format!("解析配置文件失败: {}", e))?;
    
    Ok(Some(config))
}

/// 获取 Windows 本地 Codex config.toml 路径
fn get_native_codex_config_toml_path() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(home_dir.join(".codex").join("config.toml"))
}

/// 根据当前运行模式获取 Codex config.toml 路径
fn get_codex_config_toml_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let wsl_config = wsl_utils::get_wsl_config();
        if wsl_config.enabled {
            // WSL 模式：使用 WSL 中的 .codex 目录
            if let Some(wsl_codex_dir) = wsl_utils::get_wsl_codex_dir() {
                log::info!("[Codex Selector] 使用 WSL 配置路径: {:?}", wsl_codex_dir);
                return Ok(wsl_codex_dir.join("config.toml"));
            }
        }
    }
    // Windows native 模式或非 Windows 系统
    get_native_codex_config_toml_path()
}

/// 保存配置到文件
fn save_config_to_file(config: &CodexSelectionConfig) -> Result<(), String> {
    let config_dir = get_config_dir()?;
    
    // 确保配置目录存在
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    
    let config_path = get_config_file_path()?;
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    
    std::fs::write(&config_path, content)
        .map_err(|e| format!("写入配置文件失败: {}", e))?;
    
    log::info!("配置已保存到: {:?}", config_path);
    
    // 同步更新 Codex config.toml（根据当前运行模式选择 Windows 或 WSL）
    if let Err(e) = update_codex_config_toml(config) {
        log::warn!("更新 Codex config.toml 失败: {}", e);
    }
    
    Ok(())
}

/// 更新 Codex config.toml 中的 model 和 model_reasoning_effort
/// 根据当前运行模式自动选择 Windows 本地或 WSL 的配置文件
fn update_codex_config_toml(config: &CodexSelectionConfig) -> Result<(), String> {
    let config_path = get_codex_config_toml_path()?;
    log::info!("[Codex Selector] 更新配置文件: {:?}", config_path);
    
    // 如果配置文件不存在，创建一个新的
    if !config_path.exists() {
        let codex_dir = config_path.parent()
            .ok_or_else(|| "无法获取 Codex 配置目录".to_string())?;
        if !codex_dir.exists() {
            std::fs::create_dir_all(codex_dir)
                .map_err(|e| format!("创建 Codex 配置目录失败: {}", e))?;
        }
        
        let new_content = format!(
            "model = \"{}\"\nmodel_reasoning_effort = \"{}\"\n",
            config.model, config.reasoning_mode
        );
        std::fs::write(&config_path, new_content)
            .map_err(|e| format!("写入 Codex config.toml 失败: {}", e))?;
        log::info!("[Codex Selector] 创建新的 Codex config.toml: {:?}", config_path);
        return Ok(());
    }
    
    // 读取现有配置
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取 Codex config.toml 失败: {}", e))?;
    
    // 解析为 TOML table
    let mut table: toml::Table = toml::from_str(&content)
        .map_err(|e| format!("解析 Codex config.toml 失败: {}", e))?;
    
    // 更新 model 和 model_reasoning_effort
    table.insert("model".to_string(), toml::Value::String(config.model.clone()));
    table.insert("model_reasoning_effort".to_string(), toml::Value::String(config.reasoning_mode.clone()));
    
    // 序列化并写回
    let new_content = toml::to_string_pretty(&table)
        .map_err(|e| format!("序列化 Codex config.toml 失败: {}", e))?;
    
    std::fs::write(&config_path, new_content)
        .map_err(|e| format!("写入 Codex config.toml 失败: {}", e))?;
    
    log::info!("[Codex Selector] 已更新 Codex config.toml: model={}, model_reasoning_effort={}", 
        config.model, config.reasoning_mode);
    
    Ok(())
}

/// 加载能力缓存
fn load_capabilities_cache() -> Result<Option<CodexCapabilities>, String> {
    let cache_path = get_capabilities_cache_path()?;
    
    if !cache_path.exists() {
        return Ok(None);
    }
    
    let content = std::fs::read_to_string(&cache_path)
        .map_err(|e| format!("读取能力缓存失败: {}", e))?;
    
    let capabilities: CodexCapabilities = serde_json::from_str(&content)
        .map_err(|e| format!("解析能力缓存失败: {}", e))?;
    
    // 检查缓存是否过期
    let last_updated = chrono::DateTime::parse_from_rfc3339(&capabilities.last_updated)
        .map_err(|e| format!("解析缓存时间失败: {}", e))?;
    
    let now = chrono::Utc::now();
    let age = now.signed_duration_since(last_updated.with_timezone(&chrono::Utc));
    
    if age.num_seconds() > CACHE_VALIDITY_SECONDS as i64 {
        log::info!("能力缓存已过期，将重新获取");
        return Ok(None);
    }
    
    Ok(Some(capabilities))
}

/// 保存能力缓存
fn save_capabilities_cache(capabilities: &CodexCapabilities) -> Result<(), String> {
    let config_dir = get_config_dir()?;
    
    // 确保配置目录存在
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    
    let cache_path = get_capabilities_cache_path()?;
    let content = serde_json::to_string_pretty(capabilities)
        .map_err(|e| format!("序列化能力缓存失败: {}", e))?;
    
    std::fs::write(&cache_path, content)
        .map_err(|e| format!("写入能力缓存失败: {}", e))?;
    
    log::info!("能力缓存已保存到: {:?}", cache_path);
    Ok(())
}

// ============================================================================
// Codex CLI 集成函数
// ============================================================================

/// 执行 Codex 命令
async fn execute_codex_command(args: &[&str]) -> Result<String, String> {
    // 检查是否使用 WSL 模式
    #[cfg(target_os = "windows")]
    {
        let wsl_config = wsl_utils::get_wsl_config();
        if wsl_config.enabled {
            return execute_wsl_codex_command(args, &wsl_config).await;
        }
    }

    // 原生模式：使用系统安装的 Codex
    let (_env_info, detected) = detect_binary_for_tool("codex", "CODEX_PATH", "codex");
    let codex_cmd = if let Some(inst) = detected {
        log::info!("[Codex Selector] 使用检测到的二进制文件: {}", inst.path);
        inst.path
    } else {
        log::warn!("[Codex Selector] 未检测到二进制文件，回退到 PATH 中的 'codex'");
        "codex".to_string()
    };

    let mut cmd = Command::new(&codex_cmd);
    for arg in args {
        cmd.arg(arg);
    }

    apply_no_window_async(&mut cmd);

    match cmd.output().await {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                Ok(stdout.to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Codex 命令执行失败: {}", stderr))
            }
        }
        Err(e) => Err(format!("执行 Codex 命令失败: {}", e)),
    }
}

/// WSL 模式下执行 Codex 命令
#[cfg(target_os = "windows")]
async fn execute_wsl_codex_command(args: &[&str], wsl_config: &wsl_utils::WslConfig) -> Result<String, String> {
    let distro_arg = if let Some(ref distro) = wsl_config.distro {
        vec!["-d", distro]
    } else {
        vec![]
    };

    let codex_path = wsl_config.codex_path_in_wsl.as_deref().unwrap_or("codex");
    
    let mut wsl_args = vec!["wsl"];
    wsl_args.extend(distro_arg);
    wsl_args.push(codex_path);
    wsl_args.extend(args);

    let mut cmd = Command::new("wsl");
    for arg in &wsl_args[1..] {  // 跳过 "wsl"
        cmd.arg(arg);
    }

    apply_no_window_async(&mut cmd);

    match cmd.output().await {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                Ok(stdout.to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("WSL Codex 命令执行失败: {}", stderr))
            }
        }
        Err(e) => Err(format!("执行 WSL Codex 命令失败: {}", e)),
    }
}

/// 解析 Codex 模型输出
/// 根据模型 ID 使用 get_supported_reasoning_modes_for_model 获取支持的推理模式
async fn parse_codex_models(output: &str) -> Result<Vec<CodexModelOption>, String> {
    // 尝试解析 JSON 输出
    if let Ok(model_output) = serde_json::from_str::<CodexModelOutput>(output) {
        let mut models = Vec::new();
        
        for (index, model_info) in model_output.models.iter().enumerate() {
            models.push(CodexModelOption {
                value: model_info.id.clone(),
                label: model_info.name.clone(),
                description: model_info.description.clone().unwrap_or_else(|| "无描述".to_string()),
                category: model_info.model_type.clone(),
                is_available: model_info.available.unwrap_or(true),
                order: index as i32 + 1,
                // 根据模型 ID 获取支持的推理模式
                supported_reasoning_modes: get_supported_reasoning_modes_for_model(&model_info.id),
            });
        }
        
        return Ok(models);
    }
    
    // 如果 JSON 解析失败，尝试解析纯文本输出
    let lines: Vec<&str> = output.lines().collect();
    let mut models = Vec::new();
    
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim();
        if !line.is_empty() && !line.starts_with('#') {
            models.push(CodexModelOption {
                value: line.to_string(),
                label: line.to_string(),
                description: "从 Codex CLI 获取".to_string(),
                category: None,
                is_available: true,
                order: index as i32 + 1,
                // 根据模型 ID 获取支持的推理模式
                supported_reasoning_modes: get_supported_reasoning_modes_for_model(line),
            });
        }
    }
    
    if models.is_empty() {
        return Err("无法解析 Codex 模型输出".to_string());
    }
    
    Ok(models)
}

/// 解析 Codex 推理模式输出
async fn parse_codex_reasoning_modes(output: &str) -> Result<Vec<ReasoningModeOption>, String> {
    // 尝试解析 JSON 输出
    if let Ok(mode_output) = serde_json::from_str::<CodexReasoningModeOutput>(output) {
        let mut modes = Vec::new();
        
        for (index, mode_info) in mode_output.reasoning_modes.iter().enumerate() {
            modes.push(ReasoningModeOption {
                value: mode_info.id.clone(),
                label: mode_info.name.clone(),
                description: mode_info.description.clone().unwrap_or_else(|| "无描述".to_string()),
                order: index as i32 + 1,
            });
        }
        
        return Ok(modes);
    }
    
    // 如果 JSON 解析失败，尝试解析纯文本输出
    let lines: Vec<&str> = output.lines().collect();
    let mut modes = Vec::new();
    
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim();
        if !line.is_empty() && !line.starts_with('#') {
            modes.push(ReasoningModeOption {
                value: line.to_string(),
                label: line.to_string(),
                description: "从 Codex CLI 获取".to_string(),
                order: index as i32 + 1,
            });
        }
    }
    
    if modes.is_empty() {
        return Err("无法解析 Codex 推理模式输出".to_string());
    }
    
    Ok(modes)
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 标准化推理模式值
/// 支持多种格式：extra-high, xhigh, extra_high 等都映射到 xhigh
fn normalize_reasoning_mode(mode: &str) -> String {
    match mode.to_lowercase().as_str() {
        "extra-high" | "extra_high" | "extrahigh" => "xhigh".to_string(),
        other => other.to_string(),
    }
}

/// 从 Codex config.toml 读取当前配置
fn read_config_from_codex_toml() -> Result<Option<CodexSelectionConfig>, String> {
    let config_path = get_codex_config_toml_path()?;
    
    if !config_path.exists() {
        log::info!("[Codex Selector] config.toml 不存在: {:?}", config_path);
        return Ok(None);
    }
    
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取 config.toml 失败: {}", e))?;
    
    let table: toml::Table = toml::from_str(&content)
        .map_err(|e| format!("解析 config.toml 失败: {}", e))?;
    
    let model = table.get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    
    let reasoning_mode = table.get("model_reasoning_effort")
        .and_then(|v| v.as_str())
        .map(|s| normalize_reasoning_mode(s));  // 映射 extra-high -> xhigh
    
    log::info!("[Codex Selector] 从 config.toml 读取: model={:?}, reasoning_mode={:?}", model, reasoning_mode);
    
    if model.is_some() || reasoning_mode.is_some() {
        Ok(Some(CodexSelectionConfig {
            model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            reasoning_mode: reasoning_mode.unwrap_or_else(|| DEFAULT_REASONING_MODE.to_string()),
            timestamp: chrono::Utc::now().timestamp() as u64,
        }))
    } else {
        Ok(None)
    }
}

/// 获取 Codex 选择配置
/// 优先从 Codex config.toml 读取，确保与 CLI 配置同步
#[tauri::command]
pub async fn get_codex_selection_config() -> Result<Option<CodexSelectionConfig>, String> {
    log::info!("[Codex Selector] 获取选择配置");
    
    // 优先从 Codex config.toml 读取当前配置
    match read_config_from_codex_toml() {
        Ok(Some(config)) => {
            log::info!("[Codex Selector] 从 config.toml 加载配置成功: model={}, reasoning_mode={}", 
                config.model, config.reasoning_mode);
            return Ok(Some(config));
        }
        Ok(None) => {
            log::info!("[Codex Selector] config.toml 中没有配置，尝试从缓存加载");
        }
        Err(e) => {
            log::warn!("[Codex Selector] 读取 config.toml 失败: {}", e);
        }
    }
    
    // 回退到从我们的 JSON 配置文件读取
    match load_config_from_file() {
        Ok(config) => {
            log::info!("[Codex Selector] 从缓存配置加载成功: {:?}", config.is_some());
            Ok(config)
        }
        Err(e) => {
            log::warn!("[Codex Selector] 配置加载失败: {}", e);
            // 返回 None 而不是错误，让前端使用默认配置
            Ok(None)
        }
    }
}

/// 保存 Codex 选择配置
#[tauri::command]
pub async fn save_codex_selection_config(config: CodexSelectionConfig) -> Result<(), String> {
    log::info!("[Codex Selector] 保存选择配置: {:?}", config);
    
    save_config_to_file(&config)?;
    Ok(())
}

/// 获取默认 Codex 选择配置
#[tauri::command]
pub async fn get_default_codex_selection_config() -> Result<CodexSelectionConfig, String> {
    log::info!("[Codex Selector] 获取默认选择配置");
    
    let config = CodexSelectionConfig {
        reasoning_mode: DEFAULT_REASONING_MODE.to_string(),
        model: DEFAULT_MODEL.to_string(),
        timestamp: chrono::Utc::now().timestamp() as u64,
    };
    
    Ok(config)
}

/// 获取可用的推理模式
#[tauri::command]
pub async fn get_available_reasoning_modes() -> Result<Vec<ReasoningModeOption>, String> {
    log::info!("[Codex Selector] 获取可用推理模式");
    
    // 尝试从 Codex CLI 获取
    match execute_codex_command(&["--list-reasoning-modes"]).await {
        Ok(output) => {
            match parse_codex_reasoning_modes(&output).await {
                Ok(modes) => {
                    log::info!("[Codex Selector] 从 Codex CLI 获取到 {} 个推理模式", modes.len());
                    return Ok(modes);
                }
                Err(e) => {
                    log::warn!("[Codex Selector] 解析推理模式失败: {}", e);
                }
            }
        }
        Err(e) => {
            log::warn!("[Codex Selector] 执行 Codex 命令失败: {}", e);
        }
    }
    
    // 回退到内置默认值
    log::info!("[Codex Selector] 使用内置默认推理模式");
    Ok(get_builtin_reasoning_modes())
}

/// 获取可用的 Codex 模型
#[tauri::command]
pub async fn get_available_codex_models() -> Result<Vec<CodexModelOption>, String> {
    log::info!("[Codex Selector] 获取可用模型");
    
    // 尝试从 Codex CLI 获取
    match execute_codex_command(&["--list-models"]).await {
        Ok(output) => {
            match parse_codex_models(&output).await {
                Ok(models) => {
                    log::info!("[Codex Selector] 从 Codex CLI 获取到 {} 个模型", models.len());
                    return Ok(models);
                }
                Err(e) => {
                    log::warn!("[Codex Selector] 解析模型失败: {}", e);
                }
            }
        }
        Err(e) => {
            log::warn!("[Codex Selector] 执行 Codex 命令失败: {}", e);
        }
    }
    
    // 回退到内置默认值
    log::info!("[Codex Selector] 使用内置默认模型");
    Ok(get_builtin_models())
}

/// 刷新 Codex 能力（实时获取，不使用缓存）
#[tauri::command]
pub async fn refresh_codex_capabilities() -> Result<CodexCapabilities, String> {
    log::info!("[Codex Selector] 刷新 Codex 能力（实时获取）");
    
    // 直接获取最新能力，不使用缓存
    get_codex_capabilities_internal().await
}

/// 强制刷新 Codex 能力（与 refresh_codex_capabilities 相同，保持 API 兼容）
#[tauri::command]
pub async fn force_refresh_codex_capabilities() -> Result<CodexCapabilities, String> {
    log::info!("[Codex Selector] 强制刷新 Codex 能力");
    
    // 删除现有缓存（如果存在）
    if let Ok(cache_path) = get_capabilities_cache_path() {
        if cache_path.exists() {
            if let Err(e) = std::fs::remove_file(&cache_path) {
                log::warn!("[Codex Selector] 删除缓存文件失败: {}", e);
            } else {
                log::info!("[Codex Selector] 已删除缓存文件: {:?}", cache_path);
            }
        }
    }
    
    get_codex_capabilities_internal().await
}

/// 内部获取能力函数（实时获取，不使用缓存）
async fn get_codex_capabilities_internal() -> Result<CodexCapabilities, String> {
    // 直接使用内置模型定义（因为 Codex CLI 不提供 --list-models 命令）
    let reasoning_modes = get_builtin_reasoning_modes();
    let models = get_builtin_models();
    
    // 尝试获取 Codex 版本
    let codex_version = match execute_codex_command(&["--version"]).await {
        Ok(output) => {
            let version = output.trim().to_string();
            if !version.is_empty() {
                Some(version)
            } else {
                None
            }
        }
        Err(_) => None,
    };
    
    let capabilities = CodexCapabilities {
        reasoning_modes,
        models,
        defaults: CodexDefaults {
            reasoning_mode: DEFAULT_REASONING_MODE.to_string(),
            model: DEFAULT_MODEL.to_string(),
        },
        last_updated: chrono::Utc::now().to_rfc3339(),
        codex_version,
    };
    
    log::info!("[Codex Selector] 能力获取完成，版本: {:?}", capabilities.codex_version);
    Ok(capabilities)
}