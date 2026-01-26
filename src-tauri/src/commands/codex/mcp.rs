//! Codex MCP Configuration Parser
//!
//! Parses MCP server configurations from Codex's TOML config file (~/.codex/config.toml).
//! Supports the [mcp_servers.xxx] format used by Codex CLI.
//! Supports both Windows native and WSL modes.

use anyhow::{Context, Result};
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use super::super::wsl_utils::{get_wsl_codex_dir, get_wsl_config};

/// Represents an MCP server configuration parsed from Codex TOML
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexMCPServer {
    /// Server name/identifier
    pub name: String,
    /// Transport type: "stdio" or "sse" (inferred from config)
    pub transport: String,
    /// Type field from config (optional, defaults to "stdio")
    #[serde(rename = "type", default)]
    pub server_type: Option<String>,
    /// Command to execute (for stdio)
    pub command: Option<String>,
    /// Command arguments (for stdio)
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// URL endpoint (for SSE/HTTP)
    pub url: Option<String>,
    /// Startup timeout in seconds
    pub startup_timeout_sec: Option<u64>,
    /// Tool timeout in seconds
    pub tool_timeout_sec: Option<u64>,
    /// Whether the server is disabled
    #[serde(default)]
    pub disabled: bool,
}

/// Raw TOML structure for a single MCP server
#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawMCPServerConfig {
    #[serde(rename = "type")]
    server_type: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    url: Option<String>,
    startup_timeout_sec: Option<u64>,
    tool_timeout_sec: Option<u64>,
    #[serde(default)]
    disabled: bool,
}

/// Raw TOML structure for the mcp_servers section
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct RawMCPServersSection {
    #[serde(flatten)]
    servers: HashMap<String, RawMCPServerConfig>,
}

/// Raw TOML structure for the entire config file
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct RawCodexConfig {
    #[serde(default)]
    mcp_servers: RawMCPServersSection,
    // Other fields are ignored
    #[serde(flatten)]
    _other: HashMap<String, toml::Value>,
}

/// Gets the Codex config directory path (~/.codex)
/// On Windows, checks WSL mode and returns appropriate path
pub fn get_codex_config_dir() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let wsl_config = get_wsl_config();
        if wsl_config.enabled {
            // WSL mode - use WSL .codex directory
            if let Some(wsl_dir) = get_wsl_codex_dir() {
                info!("[Codex MCP] Using WSL config dir: {:?}", wsl_dir);
                return Ok(wsl_dir);
            }
        }
    }
    
    // Native mode or non-Windows
    let home_dir = dirs::home_dir().context("Could not find home directory")?;
    Ok(home_dir.join(".codex"))
}

/// Gets the Codex config file path (~/.codex/config.toml)
pub fn get_codex_config_path() -> Result<PathBuf> {
    Ok(get_codex_config_dir()?.join("config.toml"))
}

/// Checks if currently using WSL mode
#[cfg(target_os = "windows")]
pub fn is_wsl_mode() -> bool {
    get_wsl_config().enabled
}

#[cfg(not(target_os = "windows"))]
pub fn is_wsl_mode() -> bool {
    false
}

/// Parses MCP servers from Codex config.toml
pub fn parse_codex_mcp_config() -> Result<Vec<CodexMCPServer>> {
    let config_path = get_codex_config_path()?;
    
    info!("[Codex MCP] Reading config from: {:?} (WSL mode: {})", config_path, is_wsl_mode());
    
    if !config_path.exists() {
        info!("[Codex MCP] Config file not found: {:?}", config_path);
        return Ok(vec![]);
    }
    
    let content = fs::read_to_string(&config_path)
        .context("Failed to read Codex config file")?;
    
    parse_codex_mcp_from_string(&content)
}

/// Parses MCP servers from a TOML string (for testing)
pub fn parse_codex_mcp_from_string(content: &str) -> Result<Vec<CodexMCPServer>> {
    // Parse the TOML content
    let config: RawCodexConfig = toml::from_str(content)
        .context("Failed to parse Codex config TOML")?;
    
    let mut servers = Vec::new();
    
    for (name, raw_config) in config.mcp_servers.servers {
        // Determine transport type
        let transport = if raw_config.url.is_some() {
            "sse".to_string()
        } else {
            raw_config.server_type.clone().unwrap_or_else(|| "stdio".to_string())
        };
        
        let server = CodexMCPServer {
            name,
            transport,
            server_type: raw_config.server_type,
            command: raw_config.command,
            args: raw_config.args,
            env: raw_config.env,
            url: raw_config.url,
            startup_timeout_sec: raw_config.startup_timeout_sec,
            tool_timeout_sec: raw_config.tool_timeout_sec,
            disabled: raw_config.disabled,
        };
        
        servers.push(server);
    }
    
    info!("[Codex MCP] Parsed {} MCP servers", servers.len());
    Ok(servers)
}

/// Converts CodexMCPServer to the unified MCPServer format used by the frontend
pub fn to_unified_mcp_server(server: &CodexMCPServer) -> super::super::mcp::MCPServer {
    super::super::mcp::MCPServer {
        name: server.name.clone(),
        transport: server.transport.clone(),
        command: server.command.clone(),
        args: server.args.clone(),
        env: server.env.clone(),
        url: server.url.clone(),
        scope: "user".to_string(), // Codex config is always user-level
        is_active: !server.disabled,
        status: super::super::mcp::ServerStatus {
            running: false,
            error: None,
            last_checked: None,
        },
    }
}

/// Sets the enabled/disabled status for a Codex MCP server
pub fn set_codex_mcp_enabled(server_name: &str, enabled: bool) -> Result<()> {
    let config_path = get_codex_config_path()?;
    
    if !config_path.exists() {
        return Err(anyhow::anyhow!("Codex config file not found"));
    }
    
    let content = fs::read_to_string(&config_path)
        .context("Failed to read Codex config file")?;
    
    // Parse as generic TOML to preserve other settings
    let mut config: toml::Table = toml::from_str(&content)
        .context("Failed to parse Codex config TOML")?;
    
    // Navigate to mcp_servers section
    if let Some(mcp_servers) = config.get_mut("mcp_servers") {
        if let Some(mcp_table) = mcp_servers.as_table_mut() {
            if let Some(server) = mcp_table.get_mut(server_name) {
                if let Some(server_table) = server.as_table_mut() {
                    // Set or remove the disabled field
                    if enabled {
                        server_table.remove("disabled");
                    } else {
                        server_table.insert("disabled".to_string(), toml::Value::Boolean(true));
                    }
                    
                    // Write back to file
                    let new_content = toml::to_string_pretty(&config)
                        .context("Failed to serialize Codex config")?;
                    fs::write(&config_path, new_content)
                        .context("Failed to write Codex config file")?;
                    
                    info!("[Codex MCP] Set server '{}' enabled={}", server_name, enabled);
                    return Ok(());
                }
            }
        }
    }
    
    Err(anyhow::anyhow!("Server '{}' not found in Codex MCP config", server_name))
}

/// Adds a new MCP server to Codex config
pub fn add_codex_mcp_server(server: &CodexMCPServer) -> Result<()> {
    let config_path = get_codex_config_path()?;
    let config_dir = get_codex_config_dir()?;
    
    // Ensure config directory exists
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .context("Failed to create Codex config directory")?;
    }
    
    // Read existing config or create new
    let mut config: toml::Table = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .context("Failed to read Codex config file")?;
        toml::from_str(&content).unwrap_or_default()
    } else {
        toml::Table::new()
    };
    
    // Ensure mcp_servers section exists
    if !config.contains_key("mcp_servers") {
        config.insert("mcp_servers".to_string(), toml::Value::Table(toml::Table::new()));
    }
    
    // Get mcp_servers table
    let mcp_servers = config.get_mut("mcp_servers")
        .and_then(|v| v.as_table_mut())
        .context("Failed to access mcp_servers section")?;
    
    // Check if server already exists
    if mcp_servers.contains_key(&server.name) {
        return Err(anyhow::anyhow!("Server '{}' already exists", server.name));
    }
    
    // Build server config table
    let mut server_table = toml::Table::new();
    
    if let Some(ref server_type) = server.server_type {
        server_table.insert("type".to_string(), toml::Value::String(server_type.clone()));
    }
    
    if let Some(ref command) = server.command {
        server_table.insert("command".to_string(), toml::Value::String(command.clone()));
    }
    
    if !server.args.is_empty() {
        let args: Vec<toml::Value> = server.args.iter()
            .map(|s| toml::Value::String(s.clone()))
            .collect();
        server_table.insert("args".to_string(), toml::Value::Array(args));
    }
    
    if !server.env.is_empty() {
        let mut env_table = toml::Table::new();
        for (k, v) in &server.env {
            env_table.insert(k.clone(), toml::Value::String(v.clone()));
        }
        server_table.insert("env".to_string(), toml::Value::Table(env_table));
    }
    
    if let Some(ref url) = server.url {
        server_table.insert("url".to_string(), toml::Value::String(url.clone()));
    }
    
    if let Some(timeout) = server.startup_timeout_sec {
        server_table.insert("startup_timeout_sec".to_string(), toml::Value::Integer(timeout as i64));
    }
    
    if let Some(timeout) = server.tool_timeout_sec {
        server_table.insert("tool_timeout_sec".to_string(), toml::Value::Integer(timeout as i64));
    }
    
    if server.disabled {
        server_table.insert("disabled".to_string(), toml::Value::Boolean(true));
    }
    
    // Add server to mcp_servers
    mcp_servers.insert(server.name.clone(), toml::Value::Table(server_table));
    
    // Write back to file
    let new_content = toml::to_string_pretty(&config)
        .context("Failed to serialize Codex config")?;
    fs::write(&config_path, new_content)
        .context("Failed to write Codex config file")?;
    
    info!("[Codex MCP] Added server '{}'", server.name);
    Ok(())
}

/// Removes an MCP server from Codex config
pub fn remove_codex_mcp_server(server_name: &str) -> Result<()> {
    let config_path = get_codex_config_path()?;
    
    if !config_path.exists() {
        return Err(anyhow::anyhow!("Codex config file not found"));
    }
    
    let content = fs::read_to_string(&config_path)
        .context("Failed to read Codex config file")?;
    
    let mut config: toml::Table = toml::from_str(&content)
        .context("Failed to parse Codex config TOML")?;
    
    // Navigate to mcp_servers section
    if let Some(mcp_servers) = config.get_mut("mcp_servers") {
        if let Some(mcp_table) = mcp_servers.as_table_mut() {
            if mcp_table.remove(server_name).is_some() {
                // Write back to file
                let new_content = toml::to_string_pretty(&config)
                    .context("Failed to serialize Codex config")?;
                fs::write(&config_path, new_content)
                    .context("Failed to write Codex config file")?;
                
                info!("[Codex MCP] Removed server '{}'", server_name);
                return Ok(());
            }
        }
    }
    
    Err(anyhow::anyhow!("Server '{}' not found in Codex MCP config", server_name))
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Lists all MCP servers from Codex config
#[tauri::command]
pub async fn codex_mcp_list() -> Result<Vec<CodexMCPServer>, String> {
    parse_codex_mcp_config().map_err(|e| e.to_string())
}

/// Sets enabled/disabled status for a Codex MCP server
#[tauri::command]
pub async fn codex_mcp_set_enabled(server_name: String, enabled: bool) -> Result<(), String> {
    set_codex_mcp_enabled(&server_name, enabled).map_err(|e| e.to_string())
}

/// Adds a new MCP server to Codex config
#[tauri::command]
pub async fn codex_mcp_add(server: CodexMCPServer) -> Result<(), String> {
    add_codex_mcp_server(&server).map_err(|e| e.to_string())
}

/// Removes an MCP server from Codex config
#[tauri::command]
pub async fn codex_mcp_remove(server_name: String) -> Result<(), String> {
    remove_codex_mcp_server(&server_name).map_err(|e| e.to_string())
}

// ============================================================================
// Project-Level MCP Configuration (Application-managed)
// ============================================================================
// Since Codex CLI doesn't support project-level MCP config natively,
// we store project-specific disabled servers in ~/.codex/workbench_mcp_projects.json

/// Structure for storing project-level MCP disabled servers
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CodexMCPProjectsConfig {
    /// Map of project path -> list of disabled server names
    #[serde(default)]
    projects: HashMap<String, CodexProjectMCPConfig>,
}

/// Per-project MCP configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CodexProjectMCPConfig {
    /// List of disabled MCP server names for this project
    #[serde(default, rename = "disabledMcpServers")]
    disabled_mcp_servers: Vec<String>,
}

/// Gets the path to the Codex MCP projects config file
fn get_codex_mcp_projects_config_path() -> Result<PathBuf> {
    Ok(get_codex_config_dir()?.join("workbench_mcp_projects.json"))
}

/// Loads the Codex MCP projects config
fn load_codex_mcp_projects_config() -> CodexMCPProjectsConfig {
    let config_path = match get_codex_mcp_projects_config_path() {
        Ok(path) => path,
        Err(_) => return CodexMCPProjectsConfig::default(),
    };
    
    if !config_path.exists() {
        return CodexMCPProjectsConfig::default();
    }
    
    match fs::read_to_string(&config_path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        Err(_) => CodexMCPProjectsConfig::default(),
    }
}

/// Saves the Codex MCP projects config
fn save_codex_mcp_projects_config(config: &CodexMCPProjectsConfig) -> Result<()> {
    let config_path = get_codex_mcp_projects_config_path()?;
    let config_dir = get_codex_config_dir()?;
    
    // Ensure config directory exists
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .context("Failed to create Codex config directory")?;
    }
    
    let content = serde_json::to_string_pretty(config)
        .context("Failed to serialize Codex MCP projects config")?;
    fs::write(&config_path, content)
        .context("Failed to write Codex MCP projects config")?;
    
    Ok(())
}

/// Gets the list of disabled MCP servers for a specific project
pub fn get_codex_disabled_mcp_servers_for_project(project_path: &str) -> Vec<String> {
    let config = load_codex_mcp_projects_config();
    config.projects
        .get(project_path)
        .map(|p| p.disabled_mcp_servers.clone())
        .unwrap_or_default()
}

/// Sets enabled/disabled status for a Codex MCP server for a specific project
pub fn set_codex_mcp_enabled_for_project(
    server_name: &str,
    project_path: &str,
    enabled: bool,
) -> Result<()> {
    let mut config = load_codex_mcp_projects_config();
    
    // Get or create project entry
    let project = config.projects
        .entry(project_path.to_string())
        .or_insert_with(CodexProjectMCPConfig::default);
    
    if enabled {
        // Remove from disabled list
        project.disabled_mcp_servers.retain(|s| s != server_name);
        info!("[Codex MCP] Enabled server '{}' for project '{}'", server_name, project_path);
    } else {
        // Add to disabled list if not already there
        if !project.disabled_mcp_servers.contains(&server_name.to_string()) {
            project.disabled_mcp_servers.push(server_name.to_string());
        }
        info!("[Codex MCP] Disabled server '{}' for project '{}'", server_name, project_path);
    }
    
    save_codex_mcp_projects_config(&config)?;
    Ok(())
}

/// Gets list of all projects with their MCP server disabled status for Codex
pub fn get_codex_project_list(server_name: &str) -> Vec<serde_json::Value> {
    let config = load_codex_mcp_projects_config();
    
    config.projects
        .iter()
        .map(|(path, project_config)| {
            let is_disabled = project_config.disabled_mcp_servers.contains(&server_name.to_string());
            serde_json::json!({
                "path": path,
                "disabled": is_disabled
            })
        })
        .collect()
}

/// Tauri command: Gets project list for Codex MCP server
#[tauri::command]
pub async fn codex_mcp_get_project_list(server_name: String) -> Result<Vec<serde_json::Value>, String> {
    Ok(get_codex_project_list(&server_name))
}

/// Tauri command: Sets enabled/disabled status for a Codex MCP server for a specific project
#[tauri::command]
pub async fn codex_mcp_set_enabled_for_project(
    server_name: String,
    project_path: String,
    enabled: bool,
) -> Result<(), String> {
    set_codex_mcp_enabled_for_project(&server_name, &project_path, enabled)
        .map_err(|e| e.to_string())
}

/// Adds a project to the Codex MCP projects config (for tracking)
#[tauri::command]
pub async fn codex_mcp_add_project(project_path: String) -> Result<(), String> {
    let mut config = load_codex_mcp_projects_config();
    
    // Add project if not exists
    if !config.projects.contains_key(&project_path) {
        config.projects.insert(project_path.clone(), CodexProjectMCPConfig::default());
        save_codex_mcp_projects_config(&config).map_err(|e| e.to_string())?;
        info!("[Codex MCP] Added project '{}' to tracking", project_path);
    }
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_codex_mcp_config() {
        let toml_content = r#"
[mcp_servers]

[mcp_servers.sequential-thinking]
type = "stdio"
command = "npx"
args = [ "-y", "@modelcontextprotocol/server-sequential-thinking" ]
startup_timeout_sec = 20000
tool_timeout_sec = 20000

[mcp_servers.augment-context-engine]
url = "http://localhost:8765/mcp"
startup_timeout_sec = 20000
tool_timeout_sec = 20000

[mcp_servers.serena]
command = "uvx"
args = [
  "--from", "git+https://github.com/oraios/serena",
  "serena", "start-mcp-server",
  "--context", "codex",
  "--enable-web-dashboard=false"
]
startup_timeout_sec = 20000
tool_timeout_sec = 20000
"#;
        
        let servers = parse_codex_mcp_from_string(toml_content).unwrap();
        assert_eq!(servers.len(), 3);
        
        // Find sequential-thinking server
        let seq = servers.iter().find(|s| s.name == "sequential-thinking").unwrap();
        assert_eq!(seq.transport, "stdio");
        assert_eq!(seq.command, Some("npx".to_string()));
        assert_eq!(seq.args.len(), 2);
        assert_eq!(seq.startup_timeout_sec, Some(20000));
        
        // Find augment-context-engine server (SSE)
        let aug = servers.iter().find(|s| s.name == "augment-context-engine").unwrap();
        assert_eq!(aug.transport, "sse");
        assert_eq!(aug.url, Some("http://localhost:8765/mcp".to_string()));
        
        // Find serena server
        let serena = servers.iter().find(|s| s.name == "serena").unwrap();
        assert_eq!(serena.command, Some("uvx".to_string()));
        assert_eq!(serena.args.len(), 6);
    }
    
    #[test]
    fn test_parse_empty_config() {
        let toml_content = r#"
# Some other config
BASE_URL = "https://api.example.com"
"#;
        
        let servers = parse_codex_mcp_from_string(toml_content).unwrap();
        assert_eq!(servers.len(), 0);
    }
    
    #[test]
    fn test_parse_disabled_server() {
        let toml_content = r#"
[mcp_servers.test-server]
command = "test"
disabled = true
"#;
        
        let servers = parse_codex_mcp_from_string(toml_content).unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers[0].disabled);
    }
}


/// Updates an existing MCP server in Codex config
pub fn update_codex_mcp_server(
    server_name: &str,
    command: Option<String>,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    url: Option<String>,
    enabled: bool,
) -> Result<()> {
    let config_path = get_codex_config_path()?;
    
    if !config_path.exists() {
        return Err(anyhow::anyhow!("Codex config file not found"));
    }
    
    let content = fs::read_to_string(&config_path)
        .context("Failed to read Codex config file")?;
    
    let mut config: toml::Table = toml::from_str(&content)
        .context("Failed to parse Codex config TOML")?;
    
    // Navigate to mcp_servers section
    let mcp_servers = config.get_mut("mcp_servers")
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow::anyhow!("mcp_servers section not found"))?;
    
    // Get server config
    let server_table = mcp_servers.get_mut(server_name)
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow::anyhow!("Server '{}' not found", server_name))?;
    
    // Update fields
    if let Some(cmd) = command {
        server_table.insert("command".to_string(), toml::Value::String(cmd));
    }
    
    if !args.is_empty() {
        let args_array: Vec<toml::Value> = args.iter()
            .map(|s| toml::Value::String(s.clone()))
            .collect();
        server_table.insert("args".to_string(), toml::Value::Array(args_array));
    } else {
        server_table.remove("args");
    }
    
    if !env.is_empty() {
        let mut env_table = toml::Table::new();
        for (k, v) in &env {
            env_table.insert(k.clone(), toml::Value::String(v.clone()));
        }
        server_table.insert("env".to_string(), toml::Value::Table(env_table));
    } else {
        server_table.remove("env");
    }
    
    if let Some(u) = url {
        server_table.insert("url".to_string(), toml::Value::String(u));
    }
    
    // Update disabled status
    if enabled {
        server_table.remove("disabled");
    } else {
        server_table.insert("disabled".to_string(), toml::Value::Boolean(true));
    }
    
    // Write back to file
    let new_content = toml::to_string_pretty(&config)
        .context("Failed to serialize Codex config")?;
    fs::write(&config_path, new_content)
        .context("Failed to write Codex config file")?;
    
    info!("[Codex MCP] Updated server '{}'", server_name);
    Ok(())
}
