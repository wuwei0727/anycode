use anyhow::{Context, Result};
use dirs;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

/// Helper function to create a std::process::Command with proper environment variables
/// This ensures commands like Claude can find Node.js and other dependencies
fn create_command_with_env(program: &str) -> Command {
    crate::claude_binary::create_command_with_env(program)
}

/// Finds the full path to the claude binary
/// This is necessary because Windows apps may have limited PATH environment
fn find_claude_binary(app_handle: &AppHandle) -> Result<String> {
    crate::claude_binary::find_claude_binary(app_handle).map_err(|e| anyhow::anyhow!(e))
}

/// Represents an MCP server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPServer {
    /// Server name/identifier
    pub name: String,
    /// Transport type: "stdio" or "sse"
    pub transport: String,
    /// Command to execute (for stdio)
    pub command: Option<String>,
    /// Command arguments (for stdio)
    pub args: Vec<String>,
    /// Environment variables
    pub env: HashMap<String, String>,
    /// URL endpoint (for SSE)
    pub url: Option<String>,
    /// Configuration scope: "local", "project", or "user"
    pub scope: String,
    /// Whether the server is currently active
    pub is_active: bool,
    /// Server status
    pub status: ServerStatus,
}

/// Server status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStatus {
    /// Whether the server is running
    pub running: bool,
    /// Last error message if any
    pub error: Option<String>,
    /// Last checked timestamp
    pub last_checked: Option<u64>,
}

/// MCP configuration for project scope (.mcp.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPProjectConfig {
    #[serde(rename = "mcpServers")]
    pub mcp_servers: HashMap<String, MCPServerConfig>,
}

/// Individual server configuration in .mcp.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Result of adding a server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddServerResult {
    pub success: bool,
    pub message: String,
    pub server_name: Option<String>,
}

/// Import result for multiple servers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported_count: u32,
    pub failed_count: u32,
    pub servers: Vec<ImportServerResult>,
}

/// Result for individual server import
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportServerResult {
    pub name: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Executes a claude mcp command
fn execute_claude_mcp_command(app_handle: &AppHandle, args: Vec<&str>) -> Result<String> {
    info!("Executing claude mcp command with args: {:?}", args);

    let claude_path = find_claude_binary(app_handle)?;
    let mut cmd = create_command_with_env(&claude_path);
    cmd.arg("mcp");
    for arg in args {
        cmd.arg(arg);
    }

    // Add CREATE_NO_WINDOW flag on Windows to prevent terminal window popup
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().context("Failed to execute claude command")?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(anyhow::anyhow!("Command failed: {}", stderr))
    }
}

/// Adds a new MCP server
#[tauri::command]
pub async fn mcp_add(
    app: AppHandle,
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    scope: String,
) -> Result<AddServerResult, String> {
    info!("Adding MCP server: {} with transport: {}", name, transport);

    // Prepare owned strings for environment variables
    let env_args: Vec<String> = env
        .iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect();

    let mut cmd_args = vec!["add"];

    // Add scope flag
    cmd_args.push("-s");
    cmd_args.push(&scope);

    // Add transport flag for SSE
    if transport == "sse" {
        cmd_args.push("--transport");
        cmd_args.push("sse");
    }

    // Add environment variables
    for (i, _) in env.iter().enumerate() {
        cmd_args.push("-e");
        cmd_args.push(&env_args[i]);
    }

    // Add name
    cmd_args.push(&name);

    // Add command/URL based on transport
    if transport == "stdio" {
        if let Some(cmd) = &command {
            // Add "--" separator before command to prevent argument parsing issues
            if !args.is_empty() || cmd.contains('-') {
                cmd_args.push("--");
            }
            cmd_args.push(cmd);
            // Add arguments
            for arg in &args {
                cmd_args.push(arg);
            }
        } else {
            return Ok(AddServerResult {
                success: false,
                message: "Command is required for stdio transport".to_string(),
                server_name: None,
            });
        }
    } else if transport == "sse" {
        if let Some(url_str) = &url {
            cmd_args.push(url_str);
        } else {
            return Ok(AddServerResult {
                success: false,
                message: "URL is required for SSE transport".to_string(),
                server_name: None,
            });
        }
    }

    match execute_claude_mcp_command(&app, cmd_args) {
        Ok(output) => {
            info!("Successfully added MCP server: {}", name);
            Ok(AddServerResult {
                success: true,
                message: output.trim().to_string(),
                server_name: Some(name),
            })
        }
        Err(e) => {
            error!("Failed to add MCP server: {}", e);
            Ok(AddServerResult {
                success: false,
                message: e.to_string(),
                server_name: None,
            })
        }
    }
}

/// Lists all configured MCP servers
#[tauri::command]
pub async fn mcp_list(app: AppHandle) -> Result<Vec<MCPServer>, String> {
    info!("Listing MCP servers");

    match execute_claude_mcp_command(&app, vec!["list"]) {
        Ok(output) => {
            info!("Raw output from 'claude mcp list': {:?}", output);
            let trimmed = output.trim();
            info!("Trimmed output: {:?}", trimmed);

            // Check if no servers are configured
            if trimmed.contains("No MCP servers configured") || trimmed.is_empty() {
                info!("No servers found - empty or 'No MCP servers' message");
                return Ok(vec![]);
            }

            // Parse the text output, handling multi-line commands
            let mut servers = Vec::new();
            let lines: Vec<&str> = trimmed.lines().collect();
            info!("Total lines in output: {}", lines.len());
            for (idx, line) in lines.iter().enumerate() {
                info!("Line {}: {:?}", idx, line);
            }

            let mut i = 0;

            while i < lines.len() {
                let line = lines[i];
                info!("Processing line {}: {:?}", i, line);

                // Check if this line starts a new server entry
                if let Some(colon_pos) = line.find(':') {
                    info!("Found colon at position {} in line: {:?}", colon_pos, line);
                    // Make sure this is a server name line (not part of a path)
                    // Server names typically don't contain '/' or '\'
                    let potential_name = line[..colon_pos].trim();
                    info!("Potential server name: {:?}", potential_name);

                    if !potential_name.contains('/') && !potential_name.contains('\\') {
                        info!("Valid server name detected: {:?}", potential_name);
                        let name = potential_name.to_string();
                        let mut command_parts = vec![line[colon_pos + 1..].trim().to_string()];
                        info!("Initial command part: {:?}", command_parts[0]);

                        // Check if command continues on next lines
                        i += 1;
                        while i < lines.len() {
                            let next_line = lines[i];
                            info!("Checking next line {} for continuation: {:?}", i, next_line);

                            // If the next line starts with a server name pattern, break
                            if next_line.contains(':') {
                                let potential_next_name =
                                    next_line.split(':').next().unwrap_or("").trim();
                                info!(
                                    "Found colon in next line, potential name: {:?}",
                                    potential_next_name
                                );
                                if !potential_next_name.is_empty()
                                    && !potential_next_name.contains('/')
                                    && !potential_next_name.contains('\\')
                                {
                                    info!("Next line is a new server, breaking");
                                    break;
                                }
                            }
                            // Otherwise, this line is a continuation of the command
                            info!("Line {} is a continuation", i);
                            command_parts.push(next_line.trim().to_string());
                            i += 1;
                        }

                        // Join all command parts
                        let full_command = command_parts.join(" ");
                        info!("Full command for server '{}': {:?}", name, full_command);

                        // For now, we'll create a basic server entry
                        servers.push(MCPServer {
                            name: name.clone(),
                            transport: "stdio".to_string(), // Default assumption
                            command: Some(full_command),
                            args: vec![],
                            env: HashMap::new(),
                            url: None,
                            scope: "local".to_string(), // Default assumption
                            is_active: false,
                            status: ServerStatus {
                                running: false,
                                error: None,
                                last_checked: None,
                            },
                        });
                        info!("Added server: {:?}", name);

                        continue;
                    } else {
                        info!("Skipping line - name contains path separators");
                    }
                } else {
                    info!("No colon found in line {}", i);
                }

                i += 1;
            }

            info!("Found {} MCP servers total", servers.len());
            for (idx, server) in servers.iter().enumerate() {
                info!(
                    "Server {}: name='{}', command={:?}",
                    idx, server.name, server.command
                );
            }
            Ok(servers)
        }
        Err(e) => {
            error!("Failed to list MCP servers: {}", e);
            Err(e.to_string())
        }
    }
}

/// Gets details for a specific MCP server
#[tauri::command]
pub async fn mcp_get(app: AppHandle, name: String) -> Result<MCPServer, String> {
    info!("Getting MCP server details for: {}", name);

    match execute_claude_mcp_command(&app, vec!["get", &name]) {
        Ok(output) => {
            // Parse the structured text output
            let mut scope = "local".to_string();
            let mut transport = "stdio".to_string();
            let mut command = None;
            let mut args = vec![];
            let env = HashMap::new();
            let mut url = None;

            for line in output.lines() {
                let line = line.trim();

                if line.starts_with("Scope:") {
                    let scope_part = line.replace("Scope:", "").trim().to_string();
                    if scope_part.to_lowercase().contains("local") {
                        scope = "local".to_string();
                    } else if scope_part.to_lowercase().contains("project") {
                        scope = "project".to_string();
                    } else if scope_part.to_lowercase().contains("user")
                        || scope_part.to_lowercase().contains("global")
                    {
                        scope = "user".to_string();
                    }
                } else if line.starts_with("Type:") {
                    transport = line.replace("Type:", "").trim().to_string();
                } else if line.starts_with("Command:") {
                    command = Some(line.replace("Command:", "").trim().to_string());
                } else if line.starts_with("Args:") {
                    let args_str = line.replace("Args:", "").trim().to_string();
                    if !args_str.is_empty() {
                        args = args_str.split_whitespace().map(|s| s.to_string()).collect();
                    }
                } else if line.starts_with("URL:") {
                    url = Some(line.replace("URL:", "").trim().to_string());
                } else if line.starts_with("Environment:") {
                    // TODO: Parse environment variables if they're listed
                    // For now, we'll leave it empty
                }
            }

            Ok(MCPServer {
                name,
                transport,
                command,
                args,
                env,
                url,
                scope,
                is_active: false,
                status: ServerStatus {
                    running: false,
                    error: None,
                    last_checked: None,
                },
            })
        }
        Err(e) => {
            error!("Failed to get MCP server: {}", e);
            Err(e.to_string())
        }
    }
}

/// Removes an MCP server
#[tauri::command]
pub async fn mcp_remove(app: AppHandle, name: String) -> Result<String, String> {
    info!("Removing MCP server: {}", name);

    match execute_claude_mcp_command(&app, vec!["remove", &name]) {
        Ok(output) => {
            info!("Successfully removed MCP server: {}", name);
            Ok(output.trim().to_string())
        }
        Err(e) => {
            error!("Failed to remove MCP server: {}", e);
            Err(e.to_string())
        }
    }
}

/// Adds an MCP server from JSON configuration
#[tauri::command]
pub async fn mcp_add_json(
    app: AppHandle,
    name: String,
    json_config: String,
    scope: String,
) -> Result<AddServerResult, String> {
    info!(
        "Adding MCP server from JSON: {} with scope: {}",
        name, scope
    );

    // Build command args
    let mut cmd_args = vec!["add-json", &name, &json_config];

    // Add scope flag
    let scope_flag = "-s";
    cmd_args.push(scope_flag);
    cmd_args.push(&scope);

    match execute_claude_mcp_command(&app, cmd_args) {
        Ok(output) => {
            info!("Successfully added MCP server from JSON: {}", name);
            Ok(AddServerResult {
                success: true,
                message: output.trim().to_string(),
                server_name: Some(name),
            })
        }
        Err(e) => {
            error!("Failed to add MCP server from JSON: {}", e);
            Ok(AddServerResult {
                success: false,
                message: e.to_string(),
                server_name: None,
            })
        }
    }
}

/// Imports MCP servers from Claude Desktop
#[tauri::command]
pub async fn mcp_add_from_claude_desktop(
    app: AppHandle,
    scope: String,
) -> Result<ImportResult, String> {
    info!(
        "Importing MCP servers from Claude Desktop with scope: {}",
        scope
    );

    // ⚡ 正确修复：所有平台的 Claude Code CLI 配置都在同一位置
    // Windows, macOS, Linux 都使用 ~/.claude/ 目录
    let home_dir = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;

    let possible_paths = vec![
        // Claude Code CLI 配置文件（所有平台统一）
        home_dir.join(".claude").join("settings.json"), // 主配置文件
        home_dir.join(".claude.json"),                  // 旧版配置文件
    ];

    let config_path = possible_paths
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            "Claude Code configuration not found. Please make sure Claude Code is installed and configured.\n\
             Expected: ~/.claude/settings.json or ~/.claude.json".to_string()
        })?;

    // Read and parse the config file
    let config_content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Claude Desktop config: {}", e))?;

    let config: serde_json::Value = serde_json::from_str(&config_content)
        .map_err(|e| format!("Failed to parse Claude Desktop config: {}", e))?;

    // Extract MCP servers
    let mcp_servers = config
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "No MCP servers found in Claude Desktop config".to_string())?;

    let mut imported_count = 0;
    let mut failed_count = 0;
    let mut server_results = Vec::new();

    // Import each server using add-json
    for (name, server_config) in mcp_servers {
        info!("Importing server: {}", name);

        // Convert Claude Desktop format to add-json format
        let mut json_config = serde_json::Map::new();

        // All Claude Desktop servers are stdio type
        json_config.insert(
            "type".to_string(),
            serde_json::Value::String("stdio".to_string()),
        );

        // Add command
        if let Some(command) = server_config.get("command").and_then(|v| v.as_str()) {
            json_config.insert(
                "command".to_string(),
                serde_json::Value::String(command.to_string()),
            );
        } else {
            failed_count += 1;
            server_results.push(ImportServerResult {
                name: name.clone(),
                success: false,
                error: Some("Missing command field".to_string()),
            });
            continue;
        }

        // Add args if present
        if let Some(args) = server_config.get("args").and_then(|v| v.as_array()) {
            json_config.insert("args".to_string(), args.clone().into());
        } else {
            json_config.insert("args".to_string(), serde_json::Value::Array(vec![]));
        }

        // Add env if present
        if let Some(env) = server_config.get("env").and_then(|v| v.as_object()) {
            json_config.insert("env".to_string(), env.clone().into());
        } else {
            json_config.insert(
                "env".to_string(),
                serde_json::Value::Object(serde_json::Map::new()),
            );
        }

        // Convert to JSON string
        let json_str = serde_json::to_string(&json_config)
            .map_err(|e| format!("Failed to serialize config for {}: {}", name, e))?;

        // Call add-json command
        match mcp_add_json(app.clone(), name.clone(), json_str, scope.clone()).await {
            Ok(result) => {
                if result.success {
                    imported_count += 1;
                    server_results.push(ImportServerResult {
                        name: name.clone(),
                        success: true,
                        error: None,
                    });
                    info!("Successfully imported server: {}", name);
                } else {
                    failed_count += 1;
                    let error_msg = result.message.clone();
                    server_results.push(ImportServerResult {
                        name: name.clone(),
                        success: false,
                        error: Some(result.message),
                    });
                    error!("Failed to import server {}: {}", name, error_msg);
                }
            }
            Err(e) => {
                failed_count += 1;
                let error_msg = e.clone();
                server_results.push(ImportServerResult {
                    name: name.clone(),
                    success: false,
                    error: Some(e),
                });
                error!("Error importing server {}: {}", name, error_msg);
            }
        }
    }

    info!(
        "Import complete: {} imported, {} failed",
        imported_count, failed_count
    );

    Ok(ImportResult {
        imported_count,
        failed_count,
        servers: server_results,
    })
}

/// Starts Claude Code as an MCP server
#[tauri::command]
pub async fn mcp_serve(app: AppHandle) -> Result<String, String> {
    info!("Starting Claude Code as MCP server");

    // Start the server in a separate process
    let claude_path = match find_claude_binary(&app) {
        Ok(path) => path,
        Err(e) => {
            error!("Failed to find claude binary: {}", e);
            return Err(e.to_string());
        }
    };

    let mut cmd = create_command_with_env(&claude_path);
    cmd.arg("mcp").arg("serve");

    match cmd.spawn() {
        Ok(_) => {
            info!("Successfully started Claude Code MCP server");
            Ok("Claude Code MCP server started".to_string())
        }
        Err(e) => {
            error!("Failed to start MCP server: {}", e);
            Err(e.to_string())
        }
    }
}

/// Tests connection to an MCP server
#[tauri::command]
pub async fn mcp_test_connection(app: AppHandle, name: String) -> Result<String, String> {
    info!("Testing connection to MCP server: {}", name);

    // For now, we'll use the get command to test if the server exists
    match execute_claude_mcp_command(&app, vec!["get", &name]) {
        Ok(_) => Ok(format!("Connection to {} successful", name)),
        Err(e) => Err(e.to_string()),
    }
}

/// Resets project-scoped server approval choices
#[tauri::command]
pub async fn mcp_reset_project_choices(app: AppHandle) -> Result<String, String> {
    info!("Resetting MCP project choices");

    match execute_claude_mcp_command(&app, vec!["reset-project-choices"]) {
        Ok(output) => {
            info!("Successfully reset MCP project choices");
            Ok(output.trim().to_string())
        }
        Err(e) => {
            error!("Failed to reset project choices: {}", e);
            Err(e.to_string())
        }
    }
}

/// Gets the status of MCP servers
#[tauri::command]
pub async fn mcp_get_server_status() -> Result<HashMap<String, ServerStatus>, String> {
    info!("Getting MCP server status");

    // TODO: Implement actual status checking
    // For now, return empty status
    Ok(HashMap::new())
}

/// Exports MCP server configuration from .claude.json
#[tauri::command]
pub async fn mcp_export_config() -> Result<String, String> {
    info!("Exporting MCP server configuration from .claude.json");

    // Get the .claude.json path from home directory
    let home_dir = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;

    let claude_config_path = home_dir.join(".claude.json");

    if !claude_config_path.exists() {
        return Err("未找到 .claude.json 配置文件".to_string());
    }

    // Read the .claude.json file
    let config_content = fs::read_to_string(&claude_config_path)
        .map_err(|e| format!("读取 .claude.json 文件失败: {}", e))?;

    // Parse as JSON
    let config: serde_json::Value = serde_json::from_str(&config_content)
        .map_err(|e| format!("解析 .claude.json 文件失败: {}", e))?;

    // Extract mcpServers section
    let mcp_servers = config
        .get("mcpServers")
        .ok_or_else(|| "在 .claude.json 中未找到 mcpServers 配置".to_string())?;

    // Create export format matching Claude Desktop format
    let export_data = serde_json::json!({
        "mcpServers": mcp_servers
    });

    // Convert to pretty JSON string
    let export_json = serde_json::to_string_pretty(&export_data)
        .map_err(|e| format!("序列化导出数据失败: {}", e))?;

    info!("Successfully exported MCP configuration");
    Ok(export_json)
}

/// Reads .mcp.json from the current project
#[tauri::command]
pub async fn mcp_read_project_config(project_path: String) -> Result<MCPProjectConfig, String> {
    info!("Reading .mcp.json from project: {}", project_path);

    let mcp_json_path = PathBuf::from(&project_path).join(".mcp.json");

    if !mcp_json_path.exists() {
        return Ok(MCPProjectConfig {
            mcp_servers: HashMap::new(),
        });
    }

    match fs::read_to_string(&mcp_json_path) {
        Ok(content) => match serde_json::from_str::<MCPProjectConfig>(&content) {
            Ok(config) => Ok(config),
            Err(e) => {
                error!("Failed to parse .mcp.json: {}", e);
                Err(format!("Failed to parse .mcp.json: {}", e))
            }
        },
        Err(e) => {
            error!("Failed to read .mcp.json: {}", e);
            Err(format!("Failed to read .mcp.json: {}", e))
        }
    }
}

/// Saves .mcp.json to the current project
#[tauri::command]
pub async fn mcp_save_project_config(
    project_path: String,
    config: MCPProjectConfig,
) -> Result<String, String> {
    info!("Saving .mcp.json to project: {}", project_path);

    let mcp_json_path = PathBuf::from(&project_path).join(".mcp.json");

    let json_content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&mcp_json_path, json_content)
        .map_err(|e| format!("Failed to write .mcp.json: {}", e))?;

    Ok("Project MCP configuration saved".to_string())
}

// ============================================================================
// Multi-Engine MCP Support
// ============================================================================

/// Extended MCPServer with enabled field for multi-engine support
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPServerExtended {
    /// Server name/identifier
    pub name: String,
    /// Transport type: "stdio" or "sse"
    pub transport: String,
    /// Command to execute (for stdio)
    pub command: Option<String>,
    /// Command arguments (for stdio)
    pub args: Vec<String>,
    /// Environment variables
    pub env: HashMap<String, String>,
    /// URL endpoint (for SSE)
    pub url: Option<String>,
    /// Configuration scope: "local", "project", or "user"
    pub scope: String,
    /// Whether the server is currently active
    pub is_active: bool,
    /// Server status
    pub status: ServerStatus,
    /// Whether the server is enabled (not disabled)
    pub enabled: bool,
    /// Which engine this server belongs to
    pub engine: String,
    /// Startup timeout in seconds (Codex specific)
    pub startup_timeout_sec: Option<u64>,
    /// Tool timeout in seconds (Codex specific)
    pub tool_timeout_sec: Option<u64>,
}

/// Lists MCP servers for a specific engine
#[tauri::command]
pub async fn mcp_list_by_engine(
    app: AppHandle,
    engine: String,
) -> Result<Vec<MCPServerExtended>, String> {
    info!("[MCP] Listing servers for engine: {}", engine);
    
    match engine.as_str() {
        "claude" => list_claude_mcp_servers(&app).await,
        "codex" => list_codex_mcp_servers().await,
        "gemini" => list_gemini_mcp_servers().await,
        _ => Err(format!("Unknown engine: {}", engine)),
    }
}

/// Lists Claude MCP servers by directly reading config files (fast, no CLI call)
async fn list_claude_mcp_servers(_app: &AppHandle) -> Result<Vec<MCPServerExtended>, String> {
    info!("[MCP] Reading Claude MCP servers from config files");
    
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    // Load disabled servers list from settings.json
    let disabled_servers = load_claude_disabled_mcp_servers();
    
    // Read MCP servers from ~/.claude.json
    let claude_json_path = home_dir.join(".claude.json");
    let mut servers = Vec::new();
    
    if claude_json_path.exists() {
        let content = fs::read_to_string(&claude_json_path)
            .map_err(|e| format!("Failed to read .claude.json: {}", e))?;
        
        let config: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse .claude.json: {}", e))?;
        
        // Parse mcpServers section
        if let Some(mcp_servers) = config.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, server_config) in mcp_servers {
                let server = parse_claude_mcp_server_config(name, server_config, "user", &disabled_servers);
                servers.push(server);
            }
        }
        
        info!("[MCP] Loaded {} servers from .claude.json", servers.len());
    }
    
    Ok(servers)
}

/// Parses a single MCP server config from Claude's JSON format
fn parse_claude_mcp_server_config(
    name: &str,
    config: &serde_json::Value,
    scope: &str,
    disabled_servers: &[String],
) -> MCPServerExtended {
    let server_type = config.get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("stdio");
    
    let transport = if server_type == "http" || config.get("url").is_some() {
        "sse".to_string()
    } else {
        "stdio".to_string()
    };
    
    let command = config.get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    
    let args: Vec<String> = config.get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    
    let env: HashMap<String, String> = config.get("env")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    v.as_str().map(|s| (k.clone(), s.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    
    let url = config.get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    
    let is_enabled = !disabled_servers.iter().any(|s| s.eq_ignore_ascii_case(name));
    
    MCPServerExtended {
        name: name.to_string(),
        transport,
        command,
        args,
        env,
        url,
        scope: scope.to_string(),
        is_active: is_enabled,
        status: ServerStatus {
            running: false,
            error: None,
            last_checked: None,
        },
        enabled: is_enabled,
        engine: "claude".to_string(),
        startup_timeout_sec: None,
        tool_timeout_sec: None,
    }
}

/// Loads the list of disabled MCP servers from Claude settings
/// Checks both global settings (~/.claude/settings.json) and project settings (~/.claude.json)
fn load_claude_disabled_mcp_servers() -> Vec<String> {
    let home_dir = match dirs::home_dir() {
        Some(dir) => dir,
        None => return vec![],
    };
    
    let mut disabled = Vec::new();
    
    // Load from global settings
    let settings_path = home_dir.join(".claude").join("settings.json");
    if settings_path.exists() {
        if let Ok(content) = fs::read_to_string(&settings_path) {
            if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(arr) = settings.get("disabledMcpServers").and_then(|v| v.as_array()) {
                    disabled.extend(
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    );
                }
            }
        }
    }
    
    // Load from project settings in .claude.json
    let claude_json_path = home_dir.join(".claude.json");
    if claude_json_path.exists() {
        if let Ok(content) = fs::read_to_string(&claude_json_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                // Get current working directory
                if let Ok(cwd) = std::env::current_dir() {
                    let cwd_str = cwd.to_string_lossy().to_string();
                    
                    // Check if there's a project entry for current directory
                    if let Some(projects) = config.get("projects").and_then(|v| v.as_object()) {
                        if let Some(project) = projects.get(&cwd_str) {
                            if let Some(arr) = project.get("disabledMcpServers").and_then(|v| v.as_array()) {
                                disabled.extend(
                                    arr.iter()
                                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    
    disabled
}

/// Gets list of all projects with their MCP server disabled status
#[tauri::command]
pub async fn mcp_get_project_list(server_name: String) -> Result<Vec<serde_json::Value>, String> {
    info!("[MCP] Getting project list for server '{}'", server_name);

    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;

    let claude_json_path = home_dir.join(".claude.json");

    if !claude_json_path.exists() {
        info!("[MCP] .claude.json does not exist, returning empty list");
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&claude_json_path)
        .map_err(|e| format!("Failed to read .claude.json: {}", e))?;

    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse .claude.json: {}", e))?;

    let mut projects = Vec::new();

    if let Some(projects_obj) = config.get("projects").and_then(|v| v.as_object()) {
        for (project_path, project_config) in projects_obj {
            let is_disabled = if let Some(disabled_arr) = project_config.get("disabledMcpServers").and_then(|v| v.as_array()) {
                disabled_arr.iter().any(|v| v.as_str() == Some(&server_name))
            } else {
                false
            };

            projects.push(serde_json::json!({
                "path": project_path,
                "disabled": is_disabled
            }));
        }
    }

    info!("[MCP] Found {} projects total", projects.len());
    Ok(projects)
}

/// Sets enabled/disabled status for an MCP server for a specific project
#[tauri::command]
pub async fn mcp_set_enabled_for_project(
    _engine: String,
    server_name: String,
    project_path: String,
    enabled: bool,
) -> Result<(), String> {
    info!("[MCP] Setting server '{}' enabled={} for project '{}'", server_name, enabled, project_path);

    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;

    let claude_json_path = home_dir.join(".claude.json");

    // Read existing config or create new
    let mut config: serde_json::Value = if claude_json_path.exists() {
        let content = fs::read_to_string(&claude_json_path)
            .map_err(|e| format!("Failed to read .claude.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse .claude.json: {}", e))?
    } else {
        serde_json::json!({})
    };

    // Get or create projects object
    let projects = config
        .as_object_mut()
        .ok_or_else(|| "Config is not an object".to_string())?
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}));

    // Get or create project entry
    let project = projects
        .as_object_mut()
        .ok_or_else(|| "Projects is not an object".to_string())?
        .entry(&project_path)
        .or_insert_with(|| serde_json::json!({}));

    // Get or create disabledMcpServers array for this project
    let disabled_servers = project
        .as_object_mut()
        .ok_or_else(|| "Project is not an object".to_string())?
        .entry("disabledMcpServers")
        .or_insert_with(|| serde_json::json!([]));

    let arr = disabled_servers
        .as_array_mut()
        .ok_or_else(|| "disabledMcpServers is not an array".to_string())?;

    if enabled {
        // Remove from disabled list
        arr.retain(|v| v.as_str() != Some(&server_name));
        info!("[MCP] Enabled '{}' for project '{}'", server_name, project_path);
    } else {
        // Add to disabled list if not already there
        if !arr.iter().any(|v| v.as_str() == Some(&server_name)) {
            arr.push(serde_json::json!(server_name));
            info!("[MCP] Disabled '{}' for project '{}'", server_name, project_path);
        }
    }

    // Write back to .claude.json
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&claude_json_path, content)
        .map_err(|e| format!("Failed to write .claude.json: {}", e))?;

    Ok(())
}

/// Gets the list of disabled MCP servers for a specific project
/// Merges global settings and project-specific settings
///
/// # Arguments
/// * `project_path` - The absolute path to the project directory
///
/// # Returns
/// A deduplicated list of disabled MCP server names
pub fn get_disabled_mcp_servers_for_project(project_path: &str) -> Vec<String> {
    info!("[MCP] Getting disabled servers for project: {}", project_path);
    
    let home_dir = match dirs::home_dir() {
        Some(dir) => dir,
        None => {
            error!("[MCP] Could not find home directory");
            return vec![];
        }
    };
    
    let mut disabled = Vec::new();
    
    // 1. Load from global settings (~/.claude/settings.json)
    let settings_path = home_dir.join(".claude").join("settings.json");
    if settings_path.exists() {
        match fs::read_to_string(&settings_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(settings) => {
                        if let Some(arr) = settings.get("disabledMcpServers").and_then(|v| v.as_array()) {
                            let global_disabled: Vec<String> = arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect();
                            info!("[MCP] Found {} globally disabled servers", global_disabled.len());
                            disabled.extend(global_disabled);
                        }
                    }
                    Err(e) => {
                        error!("[MCP] Failed to parse global settings.json: {}", e);
                    }
                }
            }
            Err(e) => {
                info!("[MCP] Could not read global settings.json: {}", e);
            }
        }
    } else {
        info!("[MCP] Global settings.json does not exist");
    }
    
    // 2. Load from project settings (~/.claude.json)
    let claude_json_path = home_dir.join(".claude.json");
    if claude_json_path.exists() {
        match fs::read_to_string(&claude_json_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(config) => {
                        // Normalize project path for comparison
                        let normalized_path = PathBuf::from(project_path)
                            .to_string_lossy()
                            .to_string();
                        
                        // Check if there's a project entry for this path
                        if let Some(projects) = config.get("projects").and_then(|v| v.as_object()) {
                            if let Some(project) = projects.get(&normalized_path) {
                                if let Some(arr) = project.get("disabledMcpServers").and_then(|v| v.as_array()) {
                                    let project_disabled: Vec<String> = arr.iter()
                                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                        .collect();
                                    info!("[MCP] Found {} project-level disabled servers for {}", 
                                        project_disabled.len(), normalized_path);
                                    disabled.extend(project_disabled);
                                }
                            } else {
                                info!("[MCP] No project-specific disabled servers for {}", normalized_path);
                            }
                        }
                    }
                    Err(e) => {
                        error!("[MCP] Failed to parse .claude.json: {}", e);
                    }
                }
            }
            Err(e) => {
                info!("[MCP] Could not read .claude.json: {}", e);
            }
        }
    } else {
        info!("[MCP] .claude.json does not exist");
    }
    
    // 3. Deduplicate the list
    let mut unique_disabled: Vec<String> = disabled.into_iter().collect();
    unique_disabled.sort();
    unique_disabled.dedup();
    
    info!("[MCP] Total unique disabled servers: {} - {:?}", unique_disabled.len(), unique_disabled);
    
    unique_disabled
}

/// Lists Codex MCP servers from TOML config
async fn list_codex_mcp_servers() -> Result<Vec<MCPServerExtended>, String> {
    use super::codex::mcp::parse_codex_mcp_config;
    
    let servers = parse_codex_mcp_config().map_err(|e| e.to_string())?;
    
    let extended: Vec<MCPServerExtended> = servers
        .into_iter()
        .map(|s| MCPServerExtended {
            name: s.name,
            transport: s.transport,
            command: s.command,
            args: s.args,
            env: s.env,
            url: s.url,
            scope: "user".to_string(),
            is_active: !s.disabled,
            status: ServerStatus {
                running: false,
                error: None,
                last_checked: None,
            },
            enabled: !s.disabled,
            engine: "codex".to_string(),
            startup_timeout_sec: s.startup_timeout_sec,
            tool_timeout_sec: s.tool_timeout_sec,
        })
        .collect();
    
    Ok(extended)
}

/// Lists Gemini MCP servers from settings.json
async fn list_gemini_mcp_servers() -> Result<Vec<MCPServerExtended>, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let settings_path = home_dir.join(".gemini").join("settings.json");
    
    if !settings_path.exists() {
        info!("[Gemini MCP] Settings file not found: {:?}", settings_path);
        return Ok(vec![]);
    }
    
    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read Gemini settings: {}", e))?;
    
    let settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Gemini settings: {}", e))?;
    
    // Get disabled servers list
    let disabled_servers: Vec<String> = settings
        .get("disabledMcpServers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    
    // Get MCP servers
    let mcp_servers = match settings.get("mcpServers").and_then(|v| v.as_object()) {
        Some(servers) => servers,
        None => {
            info!("[Gemini MCP] No mcpServers found in settings");
            return Ok(vec![]);
        }
    };
    
    let mut extended = Vec::new();
    
    for (name, config) in mcp_servers {
        let command = config.get("command").and_then(|v| v.as_str()).map(|s| s.to_string());
        let args: Vec<String> = config
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let env: HashMap<String, String> = config
            .get("env")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let url = config.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
        
        let transport = if url.is_some() { "sse" } else { "stdio" }.to_string();
        
        extended.push(MCPServerExtended {
            name: name.clone(),
            transport,
            command,
            args,
            env,
            url,
            scope: "user".to_string(),
            is_active: !disabled_servers.contains(name),
            status: ServerStatus {
                running: false,
                error: None,
                last_checked: None,
            },
            enabled: !disabled_servers.contains(name),
            engine: "gemini".to_string(),
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        });
    }
    
    info!("[Gemini MCP] Found {} servers", extended.len());
    Ok(extended)
}

/// Sets enabled/disabled status for an MCP server
#[tauri::command]
pub async fn mcp_set_enabled(
    app: AppHandle,
    engine: String,
    server_name: String,
    enabled: bool,
) -> Result<(), String> {
    info!("[MCP] Setting {} server '{}' enabled={}", engine, server_name, enabled);
    
    match engine.as_str() {
        "claude" => set_claude_mcp_enabled(&server_name, enabled),
        "codex" => {
            use super::codex::mcp::set_codex_mcp_enabled;
            set_codex_mcp_enabled(&server_name, enabled).map_err(|e| e.to_string())
        }
        "gemini" => set_gemini_mcp_enabled(&server_name, enabled),
        _ => Err(format!("Unknown engine: {}", engine)),
    }
}

/// Sets enabled/disabled status for a Claude MCP server
/// Updates project-level disabledMcpServers list in ~/.claude.json
fn set_claude_mcp_enabled(server_name: &str, enabled: bool) -> Result<(), String> {
    info!("[Claude MCP] Setting server '{}' enabled={} (project-level)", server_name, enabled);

    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;

    // Use .claude.json for project configuration
    let claude_json_path = home_dir.join(".claude.json");

    // Read existing config or create new
    let mut config: serde_json::Value = if claude_json_path.exists() {
        let content = fs::read_to_string(&claude_json_path)
            .map_err(|e| {
                error!("[Claude MCP] Failed to read .claude.json: {}", e);
                format!("Failed to read .claude.json: {}", e)
            })?;
        serde_json::from_str(&content)
            .map_err(|e| {
                error!("[Claude MCP] Failed to parse .claude.json: {}", e);
                format!("Failed to parse .claude.json: {}", e)
            })?
    } else {
        info!("[Claude MCP] .claude.json does not exist, creating new config");
        serde_json::json!({})
    };

    // Get current working directory
    let cwd = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?;
    let cwd_str = cwd.to_string_lossy().to_string();

    // Get or create projects object
    let projects = config
        .as_object_mut()
        .ok_or_else(|| "Config is not an object".to_string())?
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}));

    // Get or create project entry
    let project = projects
        .as_object_mut()
        .ok_or_else(|| "Projects is not an object".to_string())?
        .entry(&cwd_str)
        .or_insert_with(|| serde_json::json!({}));

    // Get or create disabledMcpServers array for this project
    let disabled_servers = project
        .as_object_mut()
        .ok_or_else(|| "Project is not an object".to_string())?
        .entry("disabledMcpServers")
        .or_insert_with(|| serde_json::json!([]));

    let arr = disabled_servers
        .as_array_mut()
        .ok_or_else(|| "disabledMcpServers is not an array".to_string())?;

    let before_count = arr.len();

    if enabled {
        // Remove from disabled list
        arr.retain(|v| v.as_str() != Some(server_name));
        let after_count = arr.len();
        if before_count > after_count {
            info!("[Claude MCP] Removed '{}' from project disabled list (was in list)", server_name);
        } else {
            info!("[Claude MCP] Server '{}' was not in project disabled list (already enabled)", server_name);
        }
    } else {
        // Add to disabled list if not already there
        if !arr.iter().any(|v| v.as_str() == Some(server_name)) {
            arr.push(serde_json::json!(server_name));
            info!("[Claude MCP] Added '{}' to project disabled list", server_name);
        } else {
            info!("[Claude MCP] Server '{}' already in project disabled list", server_name);
        }
    }

    // Write back to .claude.json
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| {
            error!("[Claude MCP] Failed to serialize config: {}", e);
            format!("Failed to serialize config: {}", e)
        })?;
    fs::write(&claude_json_path, content)
        .map_err(|e| {
            error!("[Claude MCP] Failed to write .claude.json: {}", e);
            format!("Failed to write .claude.json: {}", e)
        })?;

    info!("[Claude MCP] Successfully set server '{}' enabled={} for project {}", server_name, enabled, cwd_str);
    Ok(())
}

/// Sets enabled/disabled status for a Gemini MCP server
fn set_gemini_mcp_enabled(server_name: &str, enabled: bool) -> Result<(), String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let settings_path = home_dir.join(".gemini").join("settings.json");
    
    // Read existing settings or create new
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read Gemini settings: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse Gemini settings: {}", e))?
    } else {
        serde_json::json!({})
    };
    
    // Get or create disabledMcpServers array
    let disabled_servers = settings
        .as_object_mut()
        .ok_or_else(|| "Settings is not an object".to_string())?
        .entry("disabledMcpServers")
        .or_insert_with(|| serde_json::json!([]));
    
    let arr = disabled_servers
        .as_array_mut()
        .ok_or_else(|| "disabledMcpServers is not an array".to_string())?;
    
    if enabled {
        // Remove from disabled list
        arr.retain(|v| v.as_str() != Some(server_name));
    } else {
        // Add to disabled list if not already there
        if !arr.iter().any(|v| v.as_str() == Some(server_name)) {
            arr.push(serde_json::json!(server_name));
        }
    }
    
    // Ensure parent directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Gemini config directory: {}", e))?;
    }
    
    // Write back
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write Gemini settings: {}", e))?;
    
    info!("[Gemini MCP] Set server '{}' enabled={}", server_name, enabled);
    Ok(())
}

/// Adds an MCP server for a specific engine
#[tauri::command]
pub async fn mcp_add_by_engine(
    app: AppHandle,
    engine: String,
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    scope: String,
) -> Result<AddServerResult, String> {
    info!("[MCP] Adding server '{}' to engine '{}'", name, engine);
    
    match engine.as_str() {
        "claude" => {
            // Use existing mcp_add function
            mcp_add(app, name, transport, command, args, env, url, scope).await
        }
        "codex" => {
            use super::codex::mcp::{add_codex_mcp_server, CodexMCPServer};
            
            let server = CodexMCPServer {
                name: name.clone(),
                transport: transport.clone(),
                server_type: if transport == "stdio" { Some("stdio".to_string()) } else { None },
                command,
                args,
                env,
                url,
                startup_timeout_sec: Some(20000),
                tool_timeout_sec: Some(20000),
                disabled: false,
            };
            
            match add_codex_mcp_server(&server) {
                Ok(_) => Ok(AddServerResult {
                    success: true,
                    message: format!("Server '{}' added to Codex", name),
                    server_name: Some(name),
                }),
                Err(e) => Ok(AddServerResult {
                    success: false,
                    message: e.to_string(),
                    server_name: None,
                }),
            }
        }
        "gemini" => add_gemini_mcp_server(name, transport, command, args, env, url),
        _ => Err(format!("Unknown engine: {}", engine)),
    }
}

/// Adds an MCP server to Gemini settings
fn add_gemini_mcp_server(
    name: String,
    _transport: String,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
) -> Result<AddServerResult, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let settings_path = home_dir.join(".gemini").join("settings.json");
    
    // Read existing settings or create new
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read Gemini settings: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse Gemini settings: {}", e))?
    } else {
        serde_json::json!({})
    };
    
    // Get or create mcpServers object
    let mcp_servers = settings
        .as_object_mut()
        .ok_or_else(|| "Settings is not an object".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    
    let servers_obj = mcp_servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?;
    
    // Check if server already exists
    if servers_obj.contains_key(&name) {
        return Ok(AddServerResult {
            success: false,
            message: format!("Server '{}' already exists", name),
            server_name: None,
        });
    }
    
    // Build server config
    let mut server_config = serde_json::Map::new();
    if let Some(cmd) = command {
        server_config.insert("command".to_string(), serde_json::json!(cmd));
    }
    if !args.is_empty() {
        server_config.insert("args".to_string(), serde_json::json!(args));
    }
    if !env.is_empty() {
        server_config.insert("env".to_string(), serde_json::json!(env));
    }
    if let Some(u) = url {
        server_config.insert("url".to_string(), serde_json::json!(u));
    }
    
    servers_obj.insert(name.clone(), serde_json::Value::Object(server_config));
    
    // Ensure parent directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Gemini config directory: {}", e))?;
    }
    
    // Write back
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write Gemini settings: {}", e))?;
    
    info!("[Gemini MCP] Added server '{}'", name);
    Ok(AddServerResult {
        success: true,
        message: format!("Server '{}' added to Gemini", name),
        server_name: Some(name),
    })
}

/// Removes an MCP server for a specific engine
#[tauri::command]
pub async fn mcp_remove_by_engine(
    app: AppHandle,
    engine: String,
    server_name: String,
) -> Result<String, String> {
    info!("[MCP] Removing server '{}' from engine '{}'", server_name, engine);
    
    match engine.as_str() {
        "claude" => mcp_remove(app, server_name).await,
        "codex" => {
            use super::codex::mcp::remove_codex_mcp_server;
            remove_codex_mcp_server(&server_name)
                .map(|_| format!("Server '{}' removed from Codex", server_name))
                .map_err(|e| e.to_string())
        }
        "gemini" => remove_gemini_mcp_server(&server_name),
        _ => Err(format!("Unknown engine: {}", engine)),
    }
}

/// Removes an MCP server from Gemini settings
fn remove_gemini_mcp_server(server_name: &str) -> Result<String, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let settings_path = home_dir.join(".gemini").join("settings.json");
    
    if !settings_path.exists() {
        return Err("Gemini settings file not found".to_string());
    }
    
    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read Gemini settings: {}", e))?;
    
    let mut settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Gemini settings: {}", e))?;
    
    // Get mcpServers object
    let mcp_servers = settings
        .as_object_mut()
        .and_then(|obj| obj.get_mut("mcpServers"))
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "mcpServers not found in settings".to_string())?;
    
    // Remove server
    if mcp_servers.remove(server_name).is_none() {
        return Err(format!("Server '{}' not found", server_name));
    }
    
    // Write back
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write Gemini settings: {}", e))?;
    
    info!("[Gemini MCP] Removed server '{}'", server_name);
    Ok(format!("Server '{}' removed from Gemini", server_name))
}


/// Updates an MCP server configuration for a specific engine
#[tauri::command]
pub async fn mcp_update_by_engine(
    _app: AppHandle,
    engine: String,
    server_name: String,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    info!("[MCP] Updating server '{}' for engine '{}'", server_name, engine);
    
    match engine.as_str() {
        "claude" => update_claude_mcp_server(&server_name, command, args, env, url, enabled),
        "codex" => {
            use super::codex::mcp::update_codex_mcp_server;
            update_codex_mcp_server(&server_name, command, args, env, url, enabled)
                .map_err(|e| e.to_string())
        }
        "gemini" => update_gemini_mcp_server(&server_name, command, args, env, url, enabled),
        _ => Err(format!("Unknown engine: {}", engine)),
    }
}

/// Updates a Claude MCP server configuration
fn update_claude_mcp_server(
    server_name: &str,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let config_path = home_dir.join(".claude.json");
    
    if !config_path.exists() {
        return Err("Claude config file not found".to_string());
    }
    
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Claude config: {}", e))?;
    
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Claude config: {}", e))?;
    
    // Get mcpServers object
    let mcp_servers = config
        .as_object_mut()
        .and_then(|obj| obj.get_mut("mcpServers"))
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "mcpServers not found in config".to_string())?;
    
    // Get server config
    let server_config = mcp_servers
        .get_mut(server_name)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("Server '{}' not found", server_name))?;
    
    // Update fields
    if let Some(cmd) = command {
        server_config.insert("command".to_string(), serde_json::json!(cmd));
    }
    server_config.insert("args".to_string(), serde_json::json!(args));
    if !env.is_empty() {
        server_config.insert("env".to_string(), serde_json::json!(env));
    } else {
        server_config.remove("env");
    }
    if let Some(u) = url {
        server_config.insert("url".to_string(), serde_json::json!(u));
    }
    
    // Write back config
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write Claude config: {}", e))?;
    
    // Update enabled status in settings.json
    set_claude_mcp_enabled(server_name, enabled)?;
    
    info!("[Claude MCP] Updated server '{}'", server_name);
    Ok(())
}

/// Updates a Gemini MCP server configuration
fn update_gemini_mcp_server(
    server_name: &str,
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let settings_path = home_dir.join(".gemini").join("settings.json");
    
    if !settings_path.exists() {
        return Err("Gemini settings file not found".to_string());
    }
    
    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read Gemini settings: {}", e))?;
    
    let mut settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Gemini settings: {}", e))?;
    
    // Get mcpServers object
    let mcp_servers = settings
        .as_object_mut()
        .and_then(|obj| obj.get_mut("mcpServers"))
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "mcpServers not found in settings".to_string())?;
    
    // Get server config
    let server_config = mcp_servers
        .get_mut(server_name)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("Server '{}' not found", server_name))?;
    
    // Update fields
    if let Some(cmd) = command {
        server_config.insert("command".to_string(), serde_json::json!(cmd));
    }
    if !args.is_empty() {
        server_config.insert("args".to_string(), serde_json::json!(args));
    } else {
        server_config.remove("args");
    }
    if !env.is_empty() {
        server_config.insert("env".to_string(), serde_json::json!(env));
    } else {
        server_config.remove("env");
    }
    if let Some(u) = url {
        server_config.insert("url".to_string(), serde_json::json!(u));
    }
    
    // Write back settings
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write Gemini settings: {}", e))?;
    
    // Update enabled status
    set_gemini_mcp_enabled(server_name, enabled)?;
    
    info!("[Gemini MCP] Updated server '{}'", server_name);
    Ok(())
}
