/**
 * IDE 集成模块
 *
 * 提供在外部 IDE（如 IntelliJ IDEA、VSCode）中打开文件的功能。
 * 支持：
 * - 多种 IDE 类型（IDEA、VSCode、自定义）
 * - 自定义 IDE 可执行文件路径
 * - URL 协议和命令行两种打开方式
 * - 跨平台路径处理（Windows、Unix、WSL）
 * - IDE 自动检测
 */

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

// ================================
// 数据结构定义
// ================================

/// IDE 类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum IDEType {
    Idea,
    Vscode,
    Custom,
}

impl Default for IDEType {
    fn default() -> Self {
        IDEType::Idea
    }
}

/// IDE 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IDEConfig {
    /// IDE 类型
    #[serde(default)]
    pub ide_type: IDEType,
    /// IDEA 可执行文件路径
    pub idea_path: Option<String>,
    /// VSCode 可执行文件路径
    pub vscode_path: Option<String>,
    /// 自定义 IDE 可执行文件路径
    pub custom_ide_path: Option<String>,
    /// 自定义 IDE 命令行参数模板
    /// 支持占位符: {file}, {line}, {column}
    pub custom_ide_args: Option<String>,
    /// 是否优先使用 URL 协议
    #[serde(default = "default_use_url_protocol")]
    pub use_url_protocol: bool,
}

fn default_use_url_protocol() -> bool {
    true
}

impl Default for IDEConfig {
    fn default() -> Self {
        Self {
            ide_type: IDEType::Idea,
            idea_path: None,
            vscode_path: None,
            custom_ide_path: None,
            custom_ide_args: None,
            use_url_protocol: true,
        }
    }
}

/// 打开文件选项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileOptions {
    /// 文件路径（可以是相对路径或绝对路径）
    pub file_path: String,
    /// 项目根目录（用于解析相对路径）
    pub project_path: Option<String>,
    /// 行号（从 1 开始）
    pub line: Option<u32>,
    /// 列号（从 1 开始）
    pub column: Option<u32>,
}

/// 检测到的 IDE 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedIDE {
    /// IDE 类型
    pub ide_type: IDEType,
    /// IDE 名称
    pub name: String,
    /// 可执行文件路径
    pub path: String,
    /// 版本信息（如果可获取）
    pub version: Option<String>,
}

/// IDE 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IDEResult {
    pub success: bool,
    pub message: String,
    pub error: Option<String>,
}

// ================================
// 配置存储
// ================================

const IDE_CONFIG_KEY: &str = "ide_config";

/// 获取 IDE 配置
fn load_ide_config(app: &AppHandle) -> Result<IDEConfig, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;

    let db_path = app_data_dir.join("agents.db");

    if !db_path.exists() {
        return Ok(IDEConfig::default());
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("无法打开数据库: {}", e))?;

    // 确保表存在
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| format!("无法创建设置表: {}", e))?;

    // 读取配置
    let config_json: Result<String, _> = conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![IDE_CONFIG_KEY],
        |row| row.get(0),
    );

    match config_json {
        Ok(json) => serde_json::from_str(&json)
            .map_err(|e| format!("无法解析 IDE 配置: {}", e)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(IDEConfig::default()),
        Err(e) => Err(format!("无法读取 IDE 配置: {}", e)),
    }
}

/// 保存 IDE 配置
fn save_ide_config(app: &AppHandle, config: &IDEConfig) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("无法创建应用数据目录: {}", e))?;

    let db_path = app_data_dir.join("agents.db");

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("无法打开数据库: {}", e))?;

    // 确保表存在
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| format!("无法创建设置表: {}", e))?;

    // 序列化并保存配置
    let config_json = serde_json::to_string(config)
        .map_err(|e| format!("无法序列化 IDE 配置: {}", e))?;

    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![IDE_CONFIG_KEY, config_json],
    )
    .map_err(|e| format!("无法保存 IDE 配置: {}", e))?;

    log::info!("IDE 配置已保存: {:?}", config.ide_type);
    Ok(())
}

// ================================
// 路径处理
// ================================

/// 规范化路径（统一使用系统路径分隔符）
pub fn normalize_path(path: &str) -> String {
    #[cfg(windows)]
    {
        path.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        path.replace('\\', "/")
    }
}

/// 将 WSL 路径转换为 Windows 路径
/// 例如: /mnt/c/Users/... -> C:\Users\...
pub fn wsl_to_windows_path(wsl_path: &str) -> Option<String> {
    if wsl_path.starts_with("/mnt/") && wsl_path.len() > 6 {
        let drive_letter = wsl_path.chars().nth(5)?;
        if drive_letter.is_ascii_alphabetic() {
            let rest = &wsl_path[6..];
            let windows_path = format!("{}:{}", drive_letter.to_ascii_uppercase(), rest);
            return Some(normalize_path(&windows_path));
        }
    }
    None
}

/// 将 Windows 路径转换为 WSL 路径
/// 例如: C:\Users\... -> /mnt/c/Users/...
pub fn windows_to_wsl_path(windows_path: &str) -> Option<String> {
    if windows_path.len() >= 2 {
        let chars: Vec<char> = windows_path.chars().collect();
        if chars[0].is_ascii_alphabetic() && chars[1] == ':' {
            let drive_letter = chars[0].to_ascii_lowercase();
            let rest = &windows_path[2..];
            let wsl_path = format!("/mnt/{}{}", drive_letter, rest.replace('\\', "/"));
            return Some(wsl_path);
        }
    }
    None
}

/// 解析文件路径（处理相对路径和 WSL 路径）
fn resolve_file_path(file_path: &str, project_path: Option<&str>) -> Result<String, String> {
    let path = Path::new(file_path);

    // 如果是绝对路径，直接使用
    if path.is_absolute() {
        return Ok(normalize_path(file_path));
    }

    // 检查是否是 WSL 路径
    if file_path.starts_with("/mnt/") {
        if let Some(windows_path) = wsl_to_windows_path(file_path) {
            return Ok(windows_path);
        }
    }

    // 相对路径处理
    if let Some(base_path) = project_path {
        // 处理项目路径（可能也是 WSL 路径）
        let resolved_base = if base_path.starts_with("/mnt/") {
            wsl_to_windows_path(base_path).unwrap_or_else(|| base_path.to_string())
        } else {
            base_path.to_string()
        };

        let full_path = PathBuf::from(&resolved_base).join(file_path);
        return Ok(normalize_path(&full_path.to_string_lossy()));
    }

    // 没有项目路径时，尝试使用当前工作目录
    if let Ok(cwd) = std::env::current_dir() {
        let full_path = cwd.join(file_path);
        if full_path.exists() {
            return Ok(normalize_path(&full_path.to_string_lossy()));
        }
    }

    // 最后尝试直接使用相对路径（可能在某些情况下有效）
    Ok(normalize_path(file_path))
}

/// 检查文件是否存在
fn file_exists(path: &str) -> bool {
    Path::new(path).exists()
}

// ================================
// IDE 打开逻辑
// ================================

/// 通过 URL 协议打开文件
fn open_via_url_protocol(ide_type: &IDEType, file_path: &str, line: Option<u32>, column: Option<u32>) -> Result<(), String> {
    let url = match ide_type {
        IDEType::Idea => {
            // IDEA URL 格式: idea://open?file={path}&line={line}
            let mut url = format!("idea://open?file={}", urlencoding::encode(file_path));
            if let Some(l) = line {
                url.push_str(&format!("&line={}", l));
            }
            if let Some(c) = column {
                url.push_str(&format!("&column={}", c));
            }
            url
        }
        IDEType::Vscode => {
            // VSCode URL 格式: vscode://file/{path}:{line}:{column}
            let mut url = format!("vscode://file/{}", file_path);
            if let Some(l) = line {
                url.push_str(&format!(":{}", l));
                if let Some(c) = column {
                    url.push_str(&format!(":{}", c));
                }
            }
            url
        }
        IDEType::Custom => {
            return Err("自定义 IDE 不支持 URL 协议".to_string());
        }
    };

    log::info!("通过 URL 协议打开: {}", url);

    // 使用系统默认方式打开 URL
    #[cfg(target_os = "windows")]
    {
        // 使用 explorer.exe 打开 URL 协议，比 cmd /C start 更可靠
        let result = Command::new("explorer.exe")
            .arg(&url)
            .spawn();
        
        match result {
            Ok(_) => {
                log::info!("成功通过 explorer.exe 打开 URL: {}", url);
            }
            Err(e) => {
                log::warn!("explorer.exe 打开失败，尝试 cmd: {}", e);
                // 备选方案：使用 cmd /C start
                Command::new("cmd")
                    .args(["/C", "start", "", &url])
                    .spawn()
                    .map_err(|e| format!("无法打开 URL: {}", e))?;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("无法打开 URL: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("无法打开 URL: {}", e))?;
    }

    Ok(())
}

/// 通过命令行打开文件
fn open_via_command_line(
    ide_type: &IDEType,
    ide_path: &str,
    file_path: &str,
    line: Option<u32>,
    column: Option<u32>,
    custom_args: Option<&str>,
) -> Result<(), String> {
    let mut cmd = Command::new(ide_path);

    match ide_type {
        IDEType::Idea => {
            // IDEA 命令行: idea64.exe --line {line} {file}
            if let Some(l) = line {
                cmd.arg("--line").arg(l.to_string());
            }
            cmd.arg(file_path);
        }
        IDEType::Vscode => {
            // VSCode 命令行: code --goto {file}:{line}:{column}
            let mut goto_arg = file_path.to_string();
            if let Some(l) = line {
                goto_arg.push_str(&format!(":{}", l));
                if let Some(c) = column {
                    goto_arg.push_str(&format!(":{}", c));
                }
            }
            cmd.arg("--goto").arg(goto_arg);
        }
        IDEType::Custom => {
            // 自定义 IDE：使用参数模板
            if let Some(args_template) = custom_args {
                let args = args_template
                    .replace("{file}", file_path)
                    .replace("{line}", &line.unwrap_or(1).to_string())
                    .replace("{column}", &column.unwrap_or(1).to_string());

                // 解析参数（按空格分割，但保留引号内的内容）
                for arg in shell_words::split(&args).unwrap_or_default() {
                    cmd.arg(arg);
                }
            } else {
                cmd.arg(file_path);
            }
        }
    }

    log::info!("通过命令行打开: {:?}", cmd);

    cmd.spawn()
        .map_err(|e| format!("无法启动 IDE: {}", e))?;

    Ok(())
}

// ================================
// IDE 自动检测
// ================================

/// Windows 常见 IDEA 安装路径
#[cfg(target_os = "windows")]
fn get_idea_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // Program Files 路径
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        paths.push(PathBuf::from(&program_files).join("JetBrains"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        paths.push(PathBuf::from(&program_files_x86).join("JetBrains"));
    }

    // 用户本地安装路径
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(&local_app_data).join("JetBrains").join("Toolbox").join("apps"));
    }

    paths
}

/// Windows 常见 VSCode 安装路径
#[cfg(target_os = "windows")]
fn get_vscode_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        paths.push(PathBuf::from(&program_files).join("Microsoft VS Code"));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(&local_app_data).join("Programs").join("Microsoft VS Code"));
    }

    paths
}

#[cfg(not(target_os = "windows"))]
fn get_idea_search_paths() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/idea"),
        PathBuf::from("/usr/local/idea"),
        dirs::home_dir().map(|h| h.join(".local/share/JetBrains/Toolbox/apps")).unwrap_or_default(),
    ]
}

#[cfg(not(target_os = "windows"))]
fn get_vscode_search_paths() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/snap/bin"),
    ]
}

/// 检测已安装的 IDE
fn detect_installed_ides() -> Vec<DetectedIDE> {
    let mut detected = Vec::new();

    // 检测 IDEA
    for search_path in get_idea_search_paths() {
        if !search_path.exists() {
            continue;
        }

        // 查找 idea64.exe 或 idea.sh
        #[cfg(target_os = "windows")]
        let exe_names = ["idea64.exe", "idea.exe"];
        #[cfg(not(target_os = "windows"))]
        let exe_names = ["idea.sh", "idea"];

        for entry in walkdir::WalkDir::new(&search_path)
            .max_depth(5)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let file_name = entry.file_name().to_string_lossy();
            if exe_names.iter().any(|&name| file_name == name) {
                let path = entry.path().to_string_lossy().to_string();
                detected.push(DetectedIDE {
                    ide_type: IDEType::Idea,
                    name: "IntelliJ IDEA".to_string(),
                    path,
                    version: None,
                });
            }
        }
    }

    // 检测 VSCode
    for search_path in get_vscode_search_paths() {
        #[cfg(target_os = "windows")]
        let exe_path = search_path.join("Code.exe");
        #[cfg(not(target_os = "windows"))]
        let exe_path = search_path.join("code");

        if exe_path.exists() {
            detected.push(DetectedIDE {
                ide_type: IDEType::Vscode,
                name: "Visual Studio Code".to_string(),
                path: exe_path.to_string_lossy().to_string(),
                version: None,
            });
        }
    }

    // 检查 PATH 中的 code 命令
    if which::which("code").is_ok() {
        // 避免重复添加
        if !detected.iter().any(|d| d.ide_type == IDEType::Vscode) {
            detected.push(DetectedIDE {
                ide_type: IDEType::Vscode,
                name: "Visual Studio Code (PATH)".to_string(),
                path: "code".to_string(),
                version: None,
            });
        }
    }

    detected
}

// ================================
// Tauri 命令
// ================================

/// 获取 IDE 配置
#[tauri::command]
pub fn get_ide_config(app: AppHandle) -> Result<IDEConfig, String> {
    load_ide_config(&app)
}

/// 保存 IDE 配置
#[tauri::command]
pub fn save_ide_config_cmd(app: AppHandle, config: IDEConfig) -> Result<(), String> {
    save_ide_config(&app, &config)
}

/// 检测已安装的 IDE
#[tauri::command]
pub fn detect_ides() -> Vec<DetectedIDE> {
    detect_installed_ides()
}

/// 在 IDE 中打开文件
#[tauri::command]
pub fn open_file_in_ide(app: AppHandle, options: OpenFileOptions) -> Result<IDEResult, String> {
    log::info!("open_file_in_ide 被调用: file_path={}, project_path={:?}, line={:?}", 
        options.file_path, options.project_path, options.line);
    
    let config = load_ide_config(&app)?;
    log::info!("IDE 配置: ide_type={:?}, use_url_protocol={}", config.ide_type, config.use_url_protocol);

    // 解析文件路径
    let resolved_path = match resolve_file_path(&options.file_path, options.project_path.as_deref()) {
        Ok(path) => {
            log::info!("解析后的路径: {}", path);
            path
        }
        Err(e) => {
            log::error!("路径解析失败: {}", e);
            return Ok(IDEResult {
                success: false,
                message: format!("路径解析失败: {}", e),
                error: Some("PATH_RESOLVE_ERROR".to_string()),
            });
        }
    };

    // 检查文件是否存在（仅作为警告，不阻止打开）
    if !file_exists(&resolved_path) {
        log::warn!("文件可能不存在: {}，但仍尝试打开", resolved_path);
    }

    // 获取 IDE 路径
    let ide_path = match config.ide_type {
        IDEType::Idea => config.idea_path.clone(),
        IDEType::Vscode => config.vscode_path.clone(),
        IDEType::Custom => config.custom_ide_path.clone(),
    };
    log::info!("IDE 路径: {:?}", ide_path);

    // 尝试打开文件
    let result = if config.use_url_protocol && config.ide_type != IDEType::Custom {
        // 优先使用 URL 协议
        log::info!("使用 URL 协议打开");
        open_via_url_protocol(&config.ide_type, &resolved_path, options.line, options.column)
    } else if let Some(path) = ide_path {
        // 使用命令行方式
        log::info!("使用命令行方式打开: {}", path);
        open_via_command_line(
            &config.ide_type,
            &path,
            &resolved_path,
            options.line,
            options.column,
            config.custom_ide_args.as_deref(),
        )
    } else {
        // 没有配置 IDE 路径，尝试 URL 协议
        if config.ide_type != IDEType::Custom {
            log::info!("没有配置 IDE 路径，尝试 URL 协议");
            open_via_url_protocol(&config.ide_type, &resolved_path, options.line, options.column)
        } else {
            Err("未配置自定义 IDE 路径".to_string())
        }
    };

    match result {
        Ok(()) => {
            log::info!("成功打开文件: {}", resolved_path);
            Ok(IDEResult {
                success: true,
                message: format!("已在 IDE 中打开: {}", resolved_path),
                error: None,
            })
        }
        Err(e) => {
            log::error!("打开文件失败: {}", e);
            Ok(IDEResult {
                success: false,
                message: format!("无法打开文件: {}", e),
                error: Some(e),
            })
        }
    }
}

/// 验证 IDE 路径是否有效
#[tauri::command]
pub fn validate_ide_path(path: String) -> Result<bool, String> {
    let path = Path::new(&path);

    if !path.exists() {
        return Ok(false);
    }

    // 检查是否是文件（而不是目录）
    if !path.is_file() {
        return Ok(false);
    }

    // 在 Windows 上检查是否是可执行文件
    #[cfg(target_os = "windows")]
    {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !["exe", "bat", "cmd"].contains(&ext.to_lowercase().as_str()) {
            return Ok(false);
        }
    }

    Ok(true)
}
