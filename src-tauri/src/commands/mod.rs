pub mod acemcp;
pub mod claude;
pub mod clipboard;
pub mod codex;  // OpenAI Codex integration
pub mod engine_status;  // 统一的引擎状态检查
pub mod gemini;  // Google Gemini CLI integration
pub mod context_commands;
pub mod context_manager;
pub mod enhanced_hooks;
pub mod extensions;
pub mod file_operations;
pub mod git_stats;
pub mod ide;  // IDE 集成（文件跳转）
pub mod mcp;
pub mod permission_config;
pub mod prompt_tracker;
pub mod provider;
pub mod session_watcher;  // 会话文件监听（实时同步外部工具的消息）
pub mod simple_git;
pub mod storage;
pub mod translator;
pub mod url_utils;  // API URL 规范化工具
pub mod usage;
pub mod window;  // 多窗口管理
pub mod wsl_utils;  // WSL 兼容性工具
