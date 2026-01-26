/**
 * OpenAI Codex Integration - Backend Commands
 *
 * This module provides Tauri commands for executing Codex tasks,
 * managing sessions, and handling configuration.
 *
 * Module Structure:
 * - session.rs: Session lifecycle management (execute, resume, cancel, list, delete)
 * - git_ops.rs: Git operations for rewind functionality (records, truncate, revert)
 * - config.rs: Configuration management (availability, paths, mode, providers)
 * - change_tracker.rs: Code change tracking and diff export
 */

pub mod change_tracker;  // 代码变更追踪模块
pub mod config;
pub mod git_ops;
pub mod mcp;  // MCP configuration parser for Codex TOML format
pub mod selector;  // Model and reasoning mode selector
pub mod session;
pub mod session_converter;

// ============================================================================
// Re-export Types (allow unused for API compatibility)
// ============================================================================

// Session types
#[allow(unused_imports)]
pub use session::{
    CodexExecutionMode,
    CodexExecutionOptions,
    CodexProject,
    CodexSession,
    CodexProcessState,
};

// Git operations types
#[allow(unused_imports)]
pub use git_ops::{
    CodexPromptRecord,
    CodexPromptGitRecord,
    CodexGitRecords,
    PromptRecord,
};

// Config types
#[allow(unused_imports)]
pub use config::{
    CodexAvailability,
    CodexModeInfo,
    CodexProviderConfig,
    CurrentCodexConfig,
    CodexProviderMode,
};

// Session converter types
#[allow(unused_imports)]
pub use session_converter::{
    ConversionSource,
    ConversionResult,
};

// Selector types
#[allow(unused_imports)]
pub use selector::{
    ReasoningModeOption,
    CodexModelOption,
    CodexSelectionConfig,
    CodexCapabilities,
    CodexDefaults,
};

// ============================================================================
// Re-export Tauri Commands - Session Management
// ============================================================================

pub use session::{
    execute_codex,
    resume_codex,
    resume_last_codex,
    cancel_codex,
    list_codex_sessions,
    list_codex_sessions_for_project,
    list_codex_projects,
    load_codex_session_history,
    delete_codex_session,
};

// ============================================================================
// Re-export Tauri Commands - Git Operations / Rewind
// ============================================================================

pub use git_ops::{
    get_codex_prompt_list,
    check_codex_rewind_capabilities,
    record_codex_prompt_sent,
    record_codex_prompt_completed,
    revert_codex_to_prompt,
};

// ============================================================================
// Re-export Tauri Commands - Configuration
// ============================================================================

pub use config::{
    check_codex_availability,
    set_custom_codex_path,
    get_codex_path,
    clear_custom_codex_path,
    get_codex_mode_config,
    set_codex_mode_config,
};

// ============================================================================
// Re-export Tauri Commands - Provider Management
// ============================================================================

pub use config::{
    get_codex_provider_presets,
    get_current_codex_config,
    switch_codex_provider,
    add_codex_provider_config,
    update_codex_provider_config,
    delete_codex_provider_config,
    clear_codex_provider_config,
    test_codex_provider_connection,
    // Provider mode switching
    get_codex_provider_mode,
    backup_third_party_auth,
    backup_official_auth,
    restore_third_party_auth,
    restore_official_auth,
    switch_to_official_mode,
    switch_to_third_party_mode,
    open_codex_auth_terminal,
    check_codex_auth_status,
    // Config.toml file switching (AnyCode)
    read_codex_config_toml,
    write_codex_config_toml,
    read_codex_auth_json_text,
    write_codex_auth_json_text,
    write_codex_config_files,
    get_codex_config_file_providers,
    add_codex_config_file_provider,
    update_codex_config_file_provider,
    delete_codex_config_file_provider,
};

// ============================================================================
// Re-export Tauri Commands - Session Conversion
// ============================================================================

pub use session_converter::{
    convert_session,
    convert_claude_to_codex,
    convert_codex_to_claude,
};

// ============================================================================
// Re-export Tauri Commands - MCP Configuration
// ============================================================================

pub use mcp::{
    codex_mcp_list,
    codex_mcp_set_enabled,
    codex_mcp_add,
    codex_mcp_remove,
    codex_mcp_get_project_list,
    codex_mcp_set_enabled_for_project,
    codex_mcp_add_project,
    CodexMCPServer,
};

// ============================================================================
// Re-export Tauri Commands - Model and Reasoning Mode Selector
// ============================================================================

pub use selector::{
    get_codex_selection_config,
    save_codex_selection_config,
    get_default_codex_selection_config,
    get_available_reasoning_modes,
    get_available_codex_models,
    refresh_codex_capabilities,
    force_refresh_codex_capabilities,
};

// ============================================================================
// Re-export Tauri Commands - Change Tracker
// ============================================================================

pub use change_tracker::{
    codex_record_file_change,
    codex_list_file_changes,
    codex_get_change_detail,
    codex_export_patch,
    codex_export_single_change,
    codex_clear_change_records,
    // Types
    CodexFileChange,
    ChangeType,
    ChangeSource,
    CodexChangeRecords,
    // Internal functions (for session.rs integration)
    init_change_tracker,
    record_file_change,
    get_file_content_before,
    snapshot_files_before_command,
    detect_changes_after_command,
};

// ============================================================================
// Re-export Helper Functions (for internal use by submodules)
// ============================================================================

#[allow(unused_imports)]
pub use config::{
    get_codex_sessions_dir,
    get_codex_command_candidates,
};

#[allow(unused_imports)]
pub use session::{
    find_session_file,
    parse_codex_session_file,
};

#[allow(unused_imports)]
pub use git_ops::{
    get_codex_git_records_dir,
    load_codex_git_records,
    save_codex_git_records,
    truncate_codex_git_records,
    extract_codex_prompts,
    truncate_codex_session_to_prompt,
};
