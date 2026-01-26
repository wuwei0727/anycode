use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{command, AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineConfigType {
    Codex,
    Claude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfigProfile {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub engine: EngineConfigType,
    /// User-provided path. Can be a file path or a directory.
    pub config_path: String,
    /// Full file content that will be written when applying the profile.
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEngineConfigFile {
    pub resolved_path: String,
    pub content: String,
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

fn default_engine_config_file(engine: &EngineConfigType) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(match engine {
        EngineConfigType::Codex => home.join(".codex").join("config.toml"),
        EngineConfigType::Claude => home.join(".claude").join("settings.json"),
    })
}

fn resolve_engine_config_path(engine: &EngineConfigType, user_path: &str) -> Result<PathBuf, String> {
    // Empty path => default location
    if user_path.trim().is_empty() {
        return default_engine_config_file(engine);
    }

    let mut path = expand_user_path(user_path)?;

    // If the user points to an existing directory, append default filename.
    if path.exists() && path.is_dir() {
        path = match engine {
            EngineConfigType::Codex => path.join("config.toml"),
            EngineConfigType::Claude => path.join("settings.json"),
        };
        return Ok(path);
    }

    // Heuristic: if path ends with a separator, treat it as directory even if it doesn't exist yet.
    if user_path.ends_with('/') || user_path.ends_with('\\') {
        path = match engine {
            EngineConfigType::Codex => path.join("config.toml"),
            EngineConfigType::Claude => path.join("settings.json"),
        };
        return Ok(path);
    }

    // Otherwise treat as file path.
    Ok(path)
}

fn validate_engine_config_content(engine: &EngineConfigType, content: &str) -> Result<(), String> {
    match engine {
        EngineConfigType::Claude => {
            serde_json::from_str::<serde_json::Value>(content)
                .map_err(|e| format!("settings.json 不是有效 JSON: {}", e))?;
            Ok(())
        }
        EngineConfigType::Codex => {
            toml::from_str::<toml::Value>(content)
                .map_err(|e| format!("config.toml 不是有效 TOML: {}", e))?;
            Ok(())
        }
    }
}

fn get_profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(dir.join("engine_config_profiles.json"))
}

fn load_profiles(app: &AppHandle) -> Result<Vec<EngineConfigProfile>, String> {
    let path = get_profiles_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read profiles: {}", e))?;
    if content.trim().is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str::<Vec<EngineConfigProfile>>(&content)
        .map_err(|e| format!("Failed to parse profiles: {}", e))
}

fn save_profiles(app: &AppHandle, profiles: &[EngineConfigProfile]) -> Result<(), String> {
    let path = get_profiles_path(app)?;
    let content = serde_json::to_string_pretty(profiles)
        .map_err(|e| format!("Failed to serialize profiles: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write profiles: {}", e))?;
    Ok(())
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    Ok(())
}

#[command]
pub async fn get_engine_config_profiles(app: AppHandle) -> Result<Vec<EngineConfigProfile>, String> {
    load_profiles(&app)
}

#[command]
pub async fn add_engine_config_profile(app: AppHandle, profile: EngineConfigProfile) -> Result<String, String> {
    let mut profiles = load_profiles(&app)?;

    if profiles.iter().any(|p| p.id == profile.id) {
        return Err(format!("ID '{}' 已存在，请使用不同的名称/ID", profile.id));
    }

    // Validate content early to prevent persisting invalid configs.
    validate_engine_config_content(&profile.engine, &profile.content)?;

    profiles.push(profile.clone());
    save_profiles(&app, &profiles)?;

    Ok(format!("成功添加配置：{}", profile.name))
}

#[command]
pub async fn update_engine_config_profile(app: AppHandle, profile: EngineConfigProfile) -> Result<String, String> {
    let mut profiles = load_profiles(&app)?;
    let idx = profiles
        .iter()
        .position(|p| p.id == profile.id)
        .ok_or_else(|| format!("未找到ID为 '{}' 的配置", profile.id))?;

    validate_engine_config_content(&profile.engine, &profile.content)?;

    profiles[idx] = profile.clone();
    save_profiles(&app, &profiles)?;

    Ok(format!("成功更新配置：{}", profile.name))
}

#[command]
pub async fn delete_engine_config_profile(app: AppHandle, id: String) -> Result<String, String> {
    let mut profiles = load_profiles(&app)?;
    let idx = profiles
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| format!("未找到ID为 '{}' 的配置", id))?;
    let deleted = profiles.remove(idx);
    save_profiles(&app, &profiles)?;
    Ok(format!("成功删除配置：{}", deleted.name))
}

#[command]
pub async fn read_engine_config_file(
    engine: EngineConfigType,
    config_path: String,
) -> Result<ResolvedEngineConfigFile, String> {
    let resolved = resolve_engine_config_path(&engine, &config_path)?;
    let content = if resolved.exists() {
        fs::read_to_string(&resolved).map_err(|e| format!("读取文件失败: {}", e))?
    } else {
        String::new()
    };
    Ok(ResolvedEngineConfigFile {
        resolved_path: resolved.to_string_lossy().to_string(),
        content,
    })
}

#[command]
pub async fn apply_engine_config_profile(
    engine: EngineConfigType,
    config_path: String,
    content: String,
) -> Result<String, String> {
    validate_engine_config_content(&engine, &content)?;
    let resolved = resolve_engine_config_path(&engine, &config_path)?;
    ensure_parent_dir(&resolved)?;
    fs::write(&resolved, content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(format!(
        "✅ 已写入 {} 配置：{}",
        match engine {
            EngineConfigType::Codex => "Codex",
            EngineConfigType::Claude => "Claude",
        },
        resolved.to_string_lossy()
    ))
}

