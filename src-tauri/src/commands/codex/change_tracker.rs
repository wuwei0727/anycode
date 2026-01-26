//! Codex 代码变更追踪模块
//!
//! 负责记录 Codex 会话中的所有文件变更，支持：
//! - 自动记录文件创建、修改、删除
//! - 通过 git status 检测命令执行的副作用
//! - 导出为 patch 文件（可在 IDEA 中打开）
//! - 持久化存储到 JSON 文件

use chrono::Utc;
use log;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use super::git_ops::load_codex_git_records;
use super::super::wsl_utils;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 单个文件变更记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexFileChange {
    /// 唯一标识
    pub id: String,
    /// 会话 ID
    pub session_id: String,
    /// 对应的 prompt 索引
    pub prompt_index: i32,
    /// ISO 时间戳
    pub timestamp: String,
    /// 文件路径
    pub file_path: String,
    /// 变更类型
    pub change_type: ChangeType,
    /// 变更来源
    pub source: ChangeSource,

    /// 修改前内容（update/delete）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_content: Option<String>,
    /// 修改后内容（create/update）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_content: Option<String>,

    /// unified diff 格式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unified_diff: Option<String>,
    /// 添加的行数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<i32>,
    /// 删除的行数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<i32>,

    /// 触发变更的工具名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// 工具调用 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 如果是命令执行，记录命令
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// 变更类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Create,
    Update,
    Delete,
}

/// 变更来源
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeSource {
    /// 工具调用（edit, write, create_file 等）
    Tool,
    /// 命令执行（shell_command）
    Command,
}

/// 会话变更记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexChangeRecords {
    /// 会话 ID
    pub session_id: String,
    /// 项目路径
    pub project_path: String,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
    /// 变更列表
    pub changes: Vec<CodexFileChange>,
}

/// 内存中的变更追踪器（按会话 ID 索引）
static CHANGE_TRACKERS: Lazy<Mutex<HashMap<String, CodexChangeRecords>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 文件快照缓存（用于命令执行前后对比）
static FILE_SNAPSHOTS: Lazy<Mutex<HashMap<String, HashMap<String, String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 获取变更记录存储目录
fn get_change_records_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法获取用户目录")?;
    let dir = home.join(".codex").join("change-records");

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    Ok(dir)
}

/// 获取会话变更记录文件路径
fn get_change_records_path(session_id: &str) -> Result<PathBuf, String> {
    let dir = get_change_records_dir()?;
    Ok(dir.join(format!("{}.json", session_id)))
}

// ============================================================================
// Path & Git Helpers (for full-context diffs)
// ============================================================================

#[cfg(target_os = "windows")]
fn maybe_convert_wsl_unc_mnt_to_windows(path: &str) -> Option<String> {
    // Example:
    //   \\wsl.localhost\\Ubuntu\\mnt\\d\\work\\proj
    // -> D:\\work\\proj
    let p = path;
    if !(p.starts_with("\\\\wsl.localhost\\") || p.starts_with("\\\\wsl$\\")) {
        return None;
    }

    let lower = p.to_lowercase();
    let needle = "\\\\mnt\\\\";
    let idx = lower.find(needle)?;
    let after = &p[idx + needle.len()..];
    let drive = after.chars().next()?;
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    let rest = &after[1..];
    let rest = if rest.starts_with('\\') { rest } else { "" };

    Some(format!("{}:{}", drive.to_ascii_uppercase(), rest))
}

#[cfg(target_os = "windows")]
fn normalize_project_path_for_windows(project_path: &str) -> String {
    if let Some(win) = maybe_convert_wsl_unc_mnt_to_windows(project_path) {
        return win;
    }
    // Convert /mnt/<drive>/... -> <Drive>:\...  (Windows only)
    if project_path.starts_with("/mnt/") {
        return wsl_utils::wsl_to_windows_path(project_path);
    }
    project_path.to_string()
}

#[cfg(target_os = "windows")]
fn resolve_wsl_path_to_unc(wsl_path: &str) -> Option<PathBuf> {
    let cfg = wsl_utils::get_wsl_config();
    let distro = cfg.distro.as_deref()?;
    Some(wsl_utils::build_wsl_unc_path(wsl_path, distro))
}

fn normalize_separators_to_slash(value: &str) -> String {
    value.replace('\\', "/").replace("//", "/")
}

fn normalize_possible_wsl_mount_path(value: &str) -> Cow<'_, str> {
    // Some environments return "mnt/d/..." instead of "/mnt/d/...".
    // Treat that as an absolute WSL mount path to keep normalization + file reads correct.
    if value.starts_with("mnt/") {
        let bytes = value.as_bytes();
        if bytes.len() >= 6 {
            let drive = bytes[4] as char;
            if bytes[5] == b'/' && drive.is_ascii_alphabetic() {
                return Cow::Owned(format!("/{}", value));
            }
        }
    }
    Cow::Borrowed(value)
}

fn normalize_relative_for_storage(project_root: &str, full_path: &str) -> String {
    let proj = normalize_separators_to_slash(project_root).trim_end_matches('/').to_string();
    let full = normalize_separators_to_slash(full_path);

    #[cfg(target_os = "windows")]
    {
        let proj_l = proj.to_lowercase();
        let full_l = full.to_lowercase();
        if full_l == proj_l {
            return String::new();
        }
        if full_l.starts_with(&(proj_l.clone() + "/")) {
            return full[proj.len() + 1..].trim_start_matches("./").to_string();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if full == proj {
            return String::new();
        }
        if full.starts_with(&(proj.clone() + "/")) {
            return full[proj.len() + 1..].trim_start_matches("./").to_string();
        }
    }

    full.trim_start_matches("./").to_string()
}

fn resolve_full_path(project_path: &str, file_path: &str) -> PathBuf {
    let file_path = normalize_possible_wsl_mount_path(file_path);
    let file_path = file_path.as_ref();

    #[cfg(target_os = "windows")]
    {
        let project_win = normalize_project_path_for_windows(project_path);

        // If project path is an absolute WSL path (e.g. /home/user/proj),
        // convert to UNC so Windows can actually read it.
        let project_base: PathBuf = if project_win.starts_with('/') {
            resolve_wsl_path_to_unc(&project_win).unwrap_or_else(|| PathBuf::from(&project_win))
        } else {
            PathBuf::from(&project_win)
        };

        // Absolute file path cases
        if file_path.starts_with("/mnt/") {
            return PathBuf::from(wsl_utils::wsl_to_windows_path(file_path));
        }
        if file_path.starts_with('/') {
            if let Some(unc) = resolve_wsl_path_to_unc(file_path) {
                return unc;
            }
            return PathBuf::from(file_path);
        }
        if file_path.starts_with("\\\\") {
            if let Some(win) = maybe_convert_wsl_unc_mnt_to_windows(file_path) {
                return PathBuf::from(win);
            }
            return PathBuf::from(file_path);
        }

        let p = Path::new(file_path);
        if p.is_absolute() {
            return PathBuf::from(file_path);
        }

        return project_base.join(file_path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let p = Path::new(file_path);
        if p.is_absolute() {
            return PathBuf::from(file_path);
        }
        Path::new(project_path).join(file_path)
    }
}

fn read_text_best_effort(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn normalize_file_path_for_record(project_path: &str, file_path: &str) -> String {
    // Ensure project root uses the same "host" path style as resolve_full_path().
    // This avoids cases where project_path is a WSL path but full_path is a Windows path,
    // which would make relative path calculation fail and create duplicate entries.
    #[cfg(target_os = "windows")]
    let project_root = {
        let p = normalize_project_path_for_windows(project_path);
        if p.starts_with('/') {
            resolve_wsl_path_to_unc(&p)
                .map(|pb| pb.to_string_lossy().to_string())
                .unwrap_or(p)
        } else {
            p
        }
    };
    #[cfg(not(target_os = "windows"))]
    let project_root = project_path.to_string();

    let full = resolve_full_path(project_path, file_path);
    let full_str = full.to_string_lossy();

    let rel = normalize_relative_for_storage(&project_root, &full_str);
    normalize_separators_to_slash(&rel).trim_start_matches("./").to_string()
}

fn git_show_file(project_path: &str, commit: &str, file_path: &str) -> Option<String> {
    if commit.is_empty() || file_path.is_empty() {
        return None;
    }

    let spec = format!("{}:{}", commit, file_path.replace('\\', "/"));
    let mut cmd = Command::new("git");
    cmd.args(["show", &spec]);
    #[cfg(target_os = "windows")]
    {
        let p = normalize_project_path_for_windows(project_path);
        if p.starts_with('/') {
            if let Some(unc) = resolve_wsl_path_to_unc(&p) {
                cmd.current_dir(unc);
            } else {
                cmd.current_dir(p);
            }
        } else {
            cmd.current_dir(p);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        cmd.current_dir(project_path);
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn get_commit_before_for_prompt(session_id: &str, prompt_index: i32) -> Option<String> {
    let records = load_codex_git_records(session_id).ok()?;
    let idx = prompt_index as usize;
    let rec = records.records.iter().find(|r| r.prompt_index == idx)?;
    Some(rec.commit_before.clone())
}

fn get_commit_after_for_prompt(session_id: &str, prompt_index: i32) -> Option<String> {
    let records = load_codex_git_records(session_id).ok()?;
    let idx = prompt_index as usize;
    let rec = records.records.iter().find(|r| r.prompt_index == idx)?;
    rec.commit_after.clone()
}

/// 初始化会话的变更追踪
pub fn init_change_tracker(session_id: &str, project_path: &str) {
    let mut trackers = CHANGE_TRACKERS.lock().unwrap();

    // 尝试从文件加载已有记录
    if let Ok(path) = get_change_records_path(session_id) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(mut records) = serde_json::from_str::<CodexChangeRecords>(&content) {
                    // Upgrade legacy records (normalize paths / merge duplicates / backfill diff context)
                    let upgraded = upgrade_change_records(session_id, &mut records);

                    if upgraded {
                        if let Ok(pretty) = serde_json::to_string_pretty(&records) {
                            if let Err(e) = fs::write(&path, pretty) {
                                log::warn!(
                                    "[ChangeTracker] Failed to persist upgraded records on init ({}): {}",
                                    session_id,
                                    e
                                );
                            }
                        }
                    }

                    log::info!("[ChangeTracker] 加载已有记录: {} 条变更", records.changes.len());
                    trackers.insert(session_id.to_string(), records);
                    return;
                }
            }
        }
    }

    // 创建新记录
    let now = Utc::now().to_rfc3339();
    let records = CodexChangeRecords {
        session_id: session_id.to_string(),
        project_path: project_path.to_string(),
        created_at: now.clone(),
        updated_at: now,
        changes: Vec::new(),
    };

    trackers.insert(session_id.to_string(), records);
    log::info!("[ChangeTracker] 初始化会话变更追踪: {}", session_id);
}

/// 记录文件变更
pub fn record_file_change(
    session_id: &str,
    prompt_index: i32,
    file_path: &str,
    change_type: ChangeType,
    source: ChangeSource,
    old_content: Option<String>,
    new_content: Option<String>,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    let mut trackers = CHANGE_TRACKERS.lock().unwrap();

    let records = trackers
        .get_mut(session_id)
        .ok_or_else(|| format!("会话 {} 未初始化变更追踪", session_id))?;

    // Normalize path for stable history + dedupe (store project-relative when possible)
    let normalized_file_path = normalize_file_path_for_record(&records.project_path, file_path);

    // Prefer Git commit snapshot for "before" content so diffs are stable even if we missed timing.
    let old_from_git = get_commit_before_for_prompt(session_id, prompt_index)
        .and_then(|commit| git_show_file(&records.project_path, &commit, &normalized_file_path));

    // Prefer disk read for "after" content; fallback to provided payload.
    let new_from_disk = if change_type == ChangeType::Delete {
        None
    } else {
        let full = resolve_full_path(&records.project_path, &normalized_file_path);
        read_text_best_effort(&full)
    };

    let final_old = old_from_git.or(old_content);
    let final_new = new_from_disk.or(new_content);

    // Recalculate change_type based on final old/new (fixes misclassified "auto" writes).
    let effective_change_type = match (&final_old, &final_new) {
        (None, Some(_)) => ChangeType::Create,
        (Some(_), Some(_)) => ChangeType::Update,
        (Some(_), None) => ChangeType::Delete,
        (None, None) => change_type,
    };

    // =========================================================================
    // Merge duplicate records (same prompt + same file + same source)
    // =========================================================================
    //
    // Codex may touch the same file multiple times within one prompt (multiple tool calls).
    // For history UX, we want a single "before -> after" diff per file per prompt.
    // So we merge subsequent changes into the latest matching record.
    if let Some(existing) = records
        .changes
        .iter_mut()
        .rev()
        .find(|c| c.prompt_index == prompt_index && c.file_path == normalized_file_path && c.source == source)
    {
        let now = Utc::now().to_rfc3339();

        // Preserve the earliest old_content; always update to the latest new_content.
        let mut merged_old = if existing.old_content.is_some() {
            existing.old_content.clone()
        } else {
            final_old.clone()
        };
        let mut merged_new = final_new.clone();

        // Decide final change type for the merged record.
        let mut merged_type = existing.change_type.clone();
        match (&existing.change_type, &effective_change_type) {
            (ChangeType::Create, ChangeType::Update) => merged_type = ChangeType::Create,
            (ChangeType::Create, ChangeType::Delete) => {
                // Create -> Delete within the same prompt: treat as Delete (best-effort).
                // Use the created content as old_content so diff is viewable.
                merged_type = ChangeType::Delete;
                if merged_old.is_none() {
                    merged_old = existing.new_content.clone().or(final_old.clone());
                }
                merged_new = None;
            }
            (_, ChangeType::Delete) => {
                merged_type = ChangeType::Delete;
                merged_new = None;
            }
            (ChangeType::Delete, _) => merged_type = ChangeType::Delete,
            _ => {
                // Update stays Update, Create stays Create
                merged_type = existing.change_type.clone();
            }
        }

        // Recompute diff stats based on merged old/new.
        let (unified_diff, lines_added, lines_removed) = match (&merged_old, &merged_new) {
            (Some(old), Some(new)) => {
                let diff = generate_unified_diff(&normalized_file_path, old, new);
                let (added, removed) = count_diff_lines(&diff);
                (Some(diff), Some(added), Some(removed))
            }
            (None, Some(new)) => {
                let lines = new.lines().count() as i32;
                let diff = generate_create_diff(&normalized_file_path, new);
                (Some(diff), Some(lines), Some(0))
            }
            (Some(old), None) => {
                let lines = old.lines().count() as i32;
                let diff = generate_delete_diff(&normalized_file_path, old);
                (Some(diff), Some(0), Some(lines))
            }
            (None, None) => (None, None, None),
        };

        existing.timestamp = now.clone();
        existing.change_type = merged_type;
        existing.old_content = merged_old;
        existing.new_content = merged_new;
        existing.unified_diff = unified_diff;
        existing.lines_added = lines_added;
        existing.lines_removed = lines_removed;
        // Prefer latest metadata if provided
        if tool_name.is_some() {
            existing.tool_name = tool_name;
        }
        if tool_call_id.is_some() {
            existing.tool_call_id = tool_call_id;
        }
        if command.is_some() {
            existing.command = command;
        }

        records.updated_at = now;

        let existing_id = existing.id.clone();

        // Persist
        drop(trackers);
        save_change_records(session_id)?;

        log::info!("[ChangeTracker] 合并文件变更: {} ({})", file_path, existing_id);
        return Ok(existing_id);
    }

    // 生成 unified diff
    let (unified_diff, lines_added, lines_removed) = match (&final_old, &final_new) {
        (Some(old), Some(new)) => {
            let diff = generate_unified_diff(&normalized_file_path, old, new);
            let (added, removed) = count_diff_lines(&diff);
            (Some(diff), Some(added), Some(removed))
        }
        (None, Some(new)) => {
            // 新建文件
            let lines = new.lines().count() as i32;
            let diff = generate_create_diff(&normalized_file_path, new);
            (Some(diff), Some(lines), Some(0))
        }
        (Some(old), None) => {
            // 删除文件
            let lines = old.lines().count() as i32;
            let diff = generate_delete_diff(&normalized_file_path, old);
            (Some(diff), Some(0), Some(lines))
        }
        (None, None) => (None, None, None),
    };

    // 生成唯一 ID
    let id = format!("change_{}_{}", session_id, records.changes.len());
    let now = Utc::now().to_rfc3339();

    let change = CodexFileChange {
        id: id.clone(),
        session_id: session_id.to_string(),
        prompt_index,
        timestamp: now.clone(),
        file_path: normalized_file_path,
        change_type: effective_change_type,
        source,
        old_content: final_old,
        new_content: final_new,
        unified_diff,
        lines_added,
        lines_removed,
        tool_name,
        tool_call_id,
        command,
    };

    records.changes.push(change);
    records.updated_at = now;

    // 持久化到文件
    drop(trackers);
    save_change_records(session_id)?;

    log::info!("[ChangeTracker] 记录文件变更: {} ({})", file_path, id);
    Ok(id)
}

fn option_string_is_empty(value: &Option<String>) -> bool {
    match value {
        None => true,
        Some(v) => v.trim().is_empty(),
    }
}

fn recompute_change_diff_fields(
    file_path: &str,
    old_content: &Option<String>,
    new_content: &Option<String>,
) -> (Option<String>, Option<i32>, Option<i32>) {
    match (old_content, new_content) {
        (Some(old), Some(new)) => {
            let diff = generate_unified_diff(file_path, old, new);
            let (added, removed) = count_diff_lines(&diff);
            (Some(diff), Some(added), Some(removed))
        }
        (None, Some(new)) => {
            let lines = new.lines().count() as i32;
            let diff = generate_create_diff(file_path, new);
            (Some(diff), Some(lines), Some(0))
        }
        (Some(old), None) => {
            let lines = old.lines().count() as i32;
            let diff = generate_delete_diff(file_path, old);
            (Some(diff), Some(0), Some(lines))
        }
        (None, None) => (None, None, None),
    }
}

fn recalc_change_type(old_content: &Option<String>, new_content: &Option<String>) -> ChangeType {
    match (old_content, new_content) {
        (None, Some(_)) => ChangeType::Create,
        (Some(_), Some(_)) => ChangeType::Update,
        (Some(_), None) => ChangeType::Delete,
        (None, None) => ChangeType::Update,
    }
}

fn merge_duplicate_change(base: &mut CodexFileChange, incoming: CodexFileChange) {
    // Keep the earliest old_content; always take the latest new_content when available.
    if option_string_is_empty(&base.old_content) && !option_string_is_empty(&incoming.old_content) {
        base.old_content = incoming.old_content.clone();
    }

    match incoming.change_type {
        ChangeType::Delete => {
            base.new_content = None;
        }
        _ => {
            if !option_string_is_empty(&incoming.new_content) {
                base.new_content = incoming.new_content.clone();
            }
        }
    }

    // Prefer latest metadata
    if incoming.tool_name.is_some() {
        base.tool_name = incoming.tool_name;
    }
    if incoming.tool_call_id.is_some() {
        base.tool_call_id = incoming.tool_call_id;
    }
    if incoming.command.is_some() {
        base.command = incoming.command;
    }

    // Latest timestamp wins (records are append-only; still keep it explicit)
    base.timestamp = incoming.timestamp;

    // Recalculate type/diff after merge
    base.change_type = recalc_change_type(&base.old_content, &base.new_content);
    let (diff, added, removed) = recompute_change_diff_fields(&base.file_path, &base.old_content, &base.new_content);
    base.unified_diff = diff;
    base.lines_added = added;
    base.lines_removed = removed;
}

fn backfill_change_content(session_id: &str, project_path: &str, change: &mut CodexFileChange) -> bool {
    let mut mutated = false;

    // Normalize file path (dedupe + better patch paths)
    let normalized_path = normalize_file_path_for_record(project_path, &change.file_path);
    if change.file_path != normalized_path {
        change.file_path = normalized_path.clone();
        mutated = true;
    }

    // Backfill old/new content when missing (or accidentally recorded as empty).
    if option_string_is_empty(&change.old_content) {
        if let Some(commit_before) = get_commit_before_for_prompt(session_id, change.prompt_index) {
            if let Some(old) = git_show_file(project_path, &commit_before, &normalized_path) {
                change.old_content = Some(old);
                mutated = true;
            }
        }
    }

    if change.change_type != ChangeType::Delete && option_string_is_empty(&change.new_content) {
        if let Some(commit_after) = get_commit_after_for_prompt(session_id, change.prompt_index) {
            if let Some(new) = git_show_file(project_path, &commit_after, &normalized_path) {
                change.new_content = Some(new);
                mutated = true;
            }
        }

        if option_string_is_empty(&change.new_content) {
            let full = resolve_full_path(project_path, &normalized_path);
            if let Some(new) = read_text_best_effort(&full) {
                change.new_content = Some(new);
                mutated = true;
            }
        }
    }

    if change.change_type == ChangeType::Delete && change.new_content.is_some() {
        change.new_content = None;
        mutated = true;
    }

    // Recalculate change type + diff fields if content changed or fields look suspicious.
    let recalced_type = recalc_change_type(&change.old_content, &change.new_content);
    if change.change_type != recalced_type {
        change.change_type = recalced_type;
        mutated = true;
    }

    let (diff, added, removed) = recompute_change_diff_fields(&change.file_path, &change.old_content, &change.new_content);
    if change.unified_diff != diff || change.lines_added != added || change.lines_removed != removed {
        change.unified_diff = diff;
        change.lines_added = added;
        change.lines_removed = removed;
        mutated = true;
    }

    mutated
}

fn upgrade_change_records(session_id: &str, records: &mut CodexChangeRecords) -> bool {
    let mut mutated = false;

    // 1) Normalize paths first (helps merge keys)
    for change in records.changes.iter_mut() {
        let normalized_path = normalize_file_path_for_record(&records.project_path, &change.file_path);
        if change.file_path != normalized_path {
            change.file_path = normalized_path;
            mutated = true;
        }
    }

    // 2) Merge duplicates: same prompt + same file + same source
    let mut key_index: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<CodexFileChange> = Vec::with_capacity(records.changes.len());

    for change in std::mem::take(&mut records.changes) {
        let source_key = match change.source {
            ChangeSource::Tool => "tool",
            ChangeSource::Command => "command",
        };
        let key = format!("{}|{}|{}", change.prompt_index, source_key, change.file_path);
        if let Some(&idx) = key_index.get(&key) {
            merge_duplicate_change(&mut merged[idx], change);
            mutated = true;
        } else {
            key_index.insert(key, merged.len());
            merged.push(change);
        }
    }

    records.changes = merged;

    // 3) Backfill missing content/diff for history display
    for change in records.changes.iter_mut() {
        if backfill_change_content(session_id, &records.project_path, change) {
            mutated = true;
        }
    }

    if mutated {
        records.updated_at = Utc::now().to_rfc3339();
    }

    mutated
}

/// 保存变更记录到文件
fn save_change_records(session_id: &str) -> Result<(), String> {
    let trackers = CHANGE_TRACKERS.lock().unwrap();

    let records = trackers
        .get(session_id)
        .ok_or_else(|| format!("会话 {} 未初始化", session_id))?;

    let path = get_change_records_path(session_id)?;
    let content = serde_json::to_string_pretty(records)
        .map_err(|e| format!("序列化失败: {}", e))?;

    fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))?;

    log::debug!("[ChangeTracker] 保存变更记录到: {:?}", path);
    Ok(())
}

/// 获取文件修改前的内容（用于 edit 操作）
pub fn get_file_content_before(project_path: &str, file_path: &str) -> Option<String> {
    let full_path = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        Path::new(project_path).join(file_path)
    };

    fs::read_to_string(&full_path).ok()
}

/// 在命令执行前保存文件快照（用于检测副作用）
pub fn snapshot_files_before_command(session_id: &str, project_path: &str) -> Result<(), String> {
    let changed_files = get_git_changed_files(project_path)?;
    let mut snapshots = FILE_SNAPSHOTS.lock().unwrap();

    let session_snapshots = snapshots.entry(session_id.to_string()).or_insert_with(HashMap::new);
    session_snapshots.clear();

    for file in &changed_files {
        let full_path = Path::new(project_path).join(file);
        if full_path.exists() {
            if let Ok(content) = fs::read_to_string(&full_path) {
                session_snapshots.insert(file.clone(), content);
            }
        }
    }

    // 同时记录所有现有文件的列表（用于检测新建文件）
    // 这里简化处理，只记录 git tracked 的文件

    log::debug!("[ChangeTracker] 保存文件快照: {} 个文件", session_snapshots.len());
    Ok(())
}

/// 在命令执行后检测文件变更
pub fn detect_changes_after_command(
    session_id: &str,
    project_path: &str,
    prompt_index: i32,
    command: &str,
) -> Result<Vec<String>, String> {
    let changed_files = get_git_changed_files(project_path)?;
    let snapshots = FILE_SNAPSHOTS.lock().unwrap();
    let session_snapshots = snapshots.get(session_id);

    let mut change_ids = Vec::new();

    for file in &changed_files {
        let full_path = Path::new(project_path).join(file);
        let old_content = session_snapshots.and_then(|s| s.get(file).cloned());
        let new_content = if full_path.exists() {
            fs::read_to_string(&full_path).ok()
        } else {
            None
        };

        // 确定变更类型
        let change_type = match (&old_content, &new_content) {
            (None, Some(_)) => ChangeType::Create,
            (Some(_), None) => ChangeType::Delete,
            (Some(_), Some(_)) => ChangeType::Update,
            (None, None) => continue, // 不应该发生
        };

        // 记录变更
        let id = record_file_change(
            session_id,
            prompt_index,
            file,
            change_type,
            ChangeSource::Command,
            old_content,
            new_content,
            None,
            None,
            Some(command.to_string()),
        )?;

        change_ids.push(id);
    }

    log::info!("[ChangeTracker] 命令执行后检测到 {} 个文件变更", change_ids.len());
    Ok(change_ids)
}

/// 通过 git status 获取变更文件列表
fn get_git_changed_files(project_path: &str) -> Result<Vec<String>, String> {
    let mut cmd = Command::new("git");
    cmd.args(["status", "--porcelain", "-uall"]);
    cmd.current_dir(project_path);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("执行 git status 失败: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git status 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<String> = stdout
        .lines()
        .filter_map(|line| {
            if line.len() > 3 {
                Some(line[3..].trim().to_string())
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

/// 生成 unified diff 格式
fn generate_unified_diff(file_path: &str, old_content: &str, new_content: &str) -> String {
    use std::fmt::Write;

    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines: Vec<&str> = new_content.lines().collect();

    let mut diff = String::new();
    writeln!(diff, "--- a/{}", file_path).unwrap();
    writeln!(diff, "+++ b/{}", file_path).unwrap();

    // 简单的逐行对比（实际项目中可使用更完善的 diff 算法）
    let max_lines = old_lines.len().max(new_lines.len());
    let old_start = 1;
    let new_start = 1;
    let mut changes = Vec::new();

    for i in 0..max_lines {
        let old_line = old_lines.get(i);
        let new_line = new_lines.get(i);

        match (old_line, new_line) {
            (Some(old), Some(new)) if old == new => {
                changes.push(format!(" {}", old));
            }
            (Some(old), Some(new)) => {
                changes.push(format!("-{}", old));
                changes.push(format!("+{}", new));
            }
            (Some(old), None) => {
                changes.push(format!("-{}", old));
            }
            (None, Some(new)) => {
                changes.push(format!("+{}", new));
            }
            (None, None) => {}
        }
    }

    if !changes.is_empty() {
        writeln!(
            diff,
            "@@ -{},{} +{},{} @@",
            old_start,
            old_lines.len(),
            new_start,
            new_lines.len()
        )
        .unwrap();
        for change in changes {
            writeln!(diff, "{}", change).unwrap();
        }
    }

    diff
}

/// 生成创建文件的 diff
fn generate_create_diff(file_path: &str, content: &str) -> String {
    use std::fmt::Write;

    let mut diff = String::new();
    writeln!(diff, "--- /dev/null").unwrap();
    writeln!(diff, "+++ b/{}", file_path).unwrap();

    let lines: Vec<&str> = content.lines().collect();
    writeln!(diff, "@@ -0,0 +1,{} @@", lines.len()).unwrap();

    for line in lines {
        writeln!(diff, "+{}", line).unwrap();
    }

    diff
}

/// 生成删除文件的 diff
fn generate_delete_diff(file_path: &str, content: &str) -> String {
    use std::fmt::Write;

    let mut diff = String::new();
    writeln!(diff, "--- a/{}", file_path).unwrap();
    writeln!(diff, "+++ /dev/null").unwrap();

    let lines: Vec<&str> = content.lines().collect();
    writeln!(diff, "@@ -1,{} +0,0 @@", lines.len()).unwrap();

    for line in lines {
        writeln!(diff, "-{}", line).unwrap();
    }

    diff
}

/// 统计 diff 中添加和删除的行数
fn count_diff_lines(diff: &str) -> (i32, i32) {
    let mut added = 0;
    let mut removed = 0;

    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }

    (added, removed)
}

/// 导出整个会话的变更为 patch 文件
pub fn export_session_as_patch(session_id: &str) -> Result<String, String> {
    let trackers = CHANGE_TRACKERS.lock().unwrap();

    let records = trackers
        .get(session_id)
        .ok_or_else(|| format!("会话 {} 未找到", session_id))?;

    let mut patch = String::new();

    for change in &records.changes {
        if let Some(diff) = &change.unified_diff {
            patch.push_str(diff);
            patch.push('\n');
        }
    }

    Ok(patch)
}

/// 导出单个变更为 patch 文件
pub fn export_single_change_as_patch(session_id: &str, change_id: &str) -> Result<String, String> {
    let trackers = CHANGE_TRACKERS.lock().unwrap();

    let records = trackers
        .get(session_id)
        .ok_or_else(|| format!("会话 {} 未找到", session_id))?;

    let change = records
        .changes
        .iter()
        .find(|c| c.id == change_id)
        .ok_or_else(|| format!("变更 {} 未找到", change_id))?;

    change
        .unified_diff
        .clone()
        .ok_or_else(|| "该变更没有 diff 内容".to_string())
}

// ===== Tauri 命令 =====

/// 记录文件变更
#[tauri::command]
pub async fn codex_record_file_change(
    session_id: String,
    project_path: String,
    file_path: String,
    change_type: String,
    source: String,
    prompt_index: i32,
    prompt_text: String,
    new_content: String,
    old_content: Option<String>,
    app_handle: AppHandle,
) -> Result<String, String> {
    // Keep for future UI display (avoid unused warnings)
    let _ = prompt_text;

    // 初始化追踪器（如果尚未初始化）
    init_change_tracker(&session_id, &project_path);

    // 解析变更类型
    let change_type_enum = match change_type.as_str() {
        "create" => ChangeType::Create,
        "update" => ChangeType::Update,
        "delete" => ChangeType::Delete,
        _ => return Err(format!("未知的变更类型: {}", change_type)),
    };

    // 解析来源
    let source_enum = match source.as_str() {
        "tool" => ChangeSource::Tool,
        "command" => ChangeSource::Command,
        _ => return Err(format!("未知的变更来源: {}", source)),
    };

    // 记录变更
    let new_content_opt = if change_type_enum == ChangeType::Delete {
        None
    } else {
        Some(new_content)
    };

    let change_id = record_file_change(
        &session_id,
        prompt_index,
        &file_path,
        change_type_enum,
        source_enum,
        old_content,
        new_content_opt,
        None, // tool_name
        None, // tool_call_id
        None, // command
    )?;

    // Notify frontend for real-time refresh
    let session_id_for_evt = session_id.clone();
    let change_id_for_evt = change_id.clone();
    let evt_payload = serde_json::json!({
        "session_id": session_id,
        "change_id": change_id_for_evt,
        "prompt_index": prompt_index,
        "file_path": file_path,
        "change_type": change_type,
        "source": source,
    });

    if let Err(e) = app_handle.emit(
        &format!("codex-change-recorded:{}", session_id_for_evt),
        &evt_payload,
    ) {
        log::warn!(
            "[ChangeTracker] Failed to emit codex-change-recorded (session-specific): {}",
            e
        );
    }

    if let Err(e) = app_handle.emit("codex-change-recorded", &evt_payload) {
        log::warn!(
            "[ChangeTracker] Failed to emit codex-change-recorded (global): {}",
            e
        );
    }

    Ok(change_id)
}

/// 获取会话的所有文件变更
#[tauri::command]
pub async fn codex_list_file_changes(session_id: String) -> Result<Vec<CodexFileChange>, String> {
    let trackers = CHANGE_TRACKERS.lock().unwrap();

    // 先尝试从内存获取
    if let Some(records) = trackers.get(&session_id) {
        return Ok(records.changes.clone());
    }

    drop(trackers);

    // 尝试从文件加载
    let path = get_change_records_path(&session_id)?;
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取文件失败: {}", e))?;
        let mut records: CodexChangeRecords = serde_json::from_str(&content)
            .map_err(|e| format!("解析 JSON 失败: {}", e))?;

        // Upgrade (normalize paths / merge duplicates / backfill missing diff context)
        let upgraded = upgrade_change_records(&session_id, &mut records);

        // 缓存到内存
        let mut trackers = CHANGE_TRACKERS.lock().unwrap();
        trackers.insert(session_id.clone(), records.clone());

        // Persist upgrades so history stays stable
        if upgraded {
            if let Ok(pretty) = serde_json::to_string_pretty(&records) {
                if let Err(e) = fs::write(&path, pretty) {
                    log::warn!(
                        "[ChangeTracker] Failed to persist upgraded change records ({}): {}",
                        session_id,
                        e
                    );
                }
            }
        }

        return Ok(records.changes);
    }

    // 没有记录
    Ok(Vec::new())
}

/// 获取单个变更的详情
#[tauri::command]
pub async fn codex_get_change_detail(
    session_id: String,
    change_id: String,
) -> Result<CodexFileChange, String> {
    let changes = codex_list_file_changes(session_id).await?;

    changes
        .into_iter()
        .find(|c| c.id == change_id)
        .ok_or_else(|| format!("变更 {} 未找到", change_id))
}

/// 导出整个会话的变更为 patch 文件
#[tauri::command]
pub async fn codex_export_patch(
    session_id: String,
    output_path: String,
) -> Result<String, String> {
    let patch = export_session_as_patch(&session_id)?;

    fs::write(&output_path, &patch).map_err(|e| format!("写入文件失败: {}", e))?;

    log::info!("[ChangeTracker] 导出 patch 到: {}", output_path);
    Ok(output_path)
}

/// 导出单个变更为 patch 文件
#[tauri::command]
pub async fn codex_export_single_change(
    session_id: String,
    change_id: String,
    output_path: String,
) -> Result<String, String> {
    let patch = export_single_change_as_patch(&session_id, &change_id)?;

    fs::write(&output_path, &patch).map_err(|e| format!("写入文件失败: {}", e))?;

    log::info!("[ChangeTracker] 导出单个变更 patch 到: {}", output_path);
    Ok(output_path)
}

/// 清理会话的变更记录
#[tauri::command]
pub async fn codex_clear_change_records(session_id: String) -> Result<(), String> {
    // 从内存移除
    let mut trackers = CHANGE_TRACKERS.lock().unwrap();
    trackers.remove(&session_id);

    // 删除文件
    let path = get_change_records_path(&session_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除文件失败: {}", e))?;
    }

    log::info!("[ChangeTracker] 清理会话变更记录: {}", session_id);
    Ok(())
}
