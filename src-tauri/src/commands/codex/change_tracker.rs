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

/// Truncate change records after a specific prompt index (inclusive).
///
/// This is important when the session is truncated (rewind/revert conversation),
/// otherwise stale change entries for prompts that no longer exist will remain
/// and break "files changed" + history ordering.
pub fn truncate_change_records_after_prompt(session_id: &str, prompt_index: i32) -> Result<usize, String> {
    let path = get_change_records_path(session_id)?;

    // Load records from memory first, then file.
    let mut records: Option<CodexChangeRecords> = {
        let trackers = CHANGE_TRACKERS.lock().unwrap();
        trackers.get(session_id).cloned()
    };

    if records.is_none() && path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
        let parsed: CodexChangeRecords =
            serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {}", e))?;
        records = Some(parsed);
    }

    let Some(mut records) = records else {
        return Ok(0);
    };

    let before_len = records.changes.len();
    records.changes.retain(|c| c.prompt_index <= prompt_index);
    let removed = before_len.saturating_sub(records.changes.len());

    if removed == 0 {
        return Ok(0);
    }

    records.updated_at = Utc::now().to_rfc3339();

    // Persist to disk (even if the tracker wasn't initialized in-memory).
    let content = serde_json::to_string_pretty(&records).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))?;

    // Update in-memory cache.
    let mut trackers = CHANGE_TRACKERS.lock().unwrap();
    trackers.insert(session_id.to_string(), records);

    log::info!(
        "[ChangeTracker] Truncated change records for session {} to prompt_index <= {} (removed {})",
        session_id,
        prompt_index,
        removed
    );

    Ok(removed)
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
    if let Some(after) = rec.commit_after.clone() {
        if !after.trim().is_empty() {
            return Some(after);
        }
    }

    // Fallback: if commit_after is missing (e.g. prompt was interrupted), use the next prompt's
    // commit_before as an approximation of "after". This is usually much closer than reading the
    // current working tree for historical diffs.
    let next_idx = idx.saturating_add(1);
    let next = records.records.iter().find(|r| r.prompt_index == next_idx)?;
    if next.commit_before.trim().is_empty() {
        None
    } else {
        Some(next.commit_before.clone())
    }
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
    diff_hint: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    let mut trackers = CHANGE_TRACKERS.lock().unwrap();

    let records = trackers
        .get_mut(session_id)
        .ok_or_else(|| format!("会话 {} 未初始化变更追踪", session_id))?;

    // Normalize path for stable history + dedupe (store project-relative when possible)
    let normalized_file_path = normalize_file_path_for_record(&records.project_path, file_path);

    // Prefer Git commit snapshot for "before" content so diffs are stable even if we missed timing.
    //
    // NOTE: For tool-based changes the UI may send patch fragments (old_string/new_string). We still
    // store a *net* per-file diff (like the official plugin) by preferring full-context sources:
    // - commit_before (if present)
    // - UI-provided snapshot (usually a disk read taken before tool execution)
    // - HEAD (best-effort fallback when git records are missing or UI only has a fragment)
    let old_from_git = get_commit_before_for_prompt(session_id, prompt_index)
        .and_then(|commit| git_show_file(&records.project_path, &commit, &normalized_file_path));

    // Prefer disk read for "after" content; fallback to provided payload.
    let new_from_disk = if change_type == ChangeType::Delete {
        None
    } else {
        let full = resolve_full_path(&records.project_path, &normalized_file_path);
        read_text_best_effort(&full)
    };

    let normalized_old = old_content.filter(|s| !s.trim().is_empty());
    let normalized_new = new_content.filter(|s| !s.trim().is_empty());

    // If the UI only captured a small fragment for old_content (common for edit tools),
    // prefer reading the full base from HEAD so we don't produce a giant "everything changed" diff.
    //
    // IMPORTANT: the frontend may send `new_content` as a fragment (e.g. edit old_string/new_string)
    // while we can still read the full "after" file from disk here. Use the disk snapshot to detect
    // fragment diffs more reliably.
    let new_for_fragment = new_from_disk.as_ref().or(normalized_new.as_ref());
    let old_is_fragment = source == ChangeSource::Tool
        && match (normalized_old.as_deref(), new_for_fragment.map(|s| s.as_str())) {
            (Some(old), Some(new)) => looks_like_fragment_text(old, new),
            _ => false,
        };
    let old_from_head = if old_from_git.is_none() && (normalized_old.is_none() || old_is_fragment) {
        git_show_file(&records.project_path, "HEAD", &normalized_file_path)
    } else {
        None
    };

    // If we can't compute a reliable full-context diff (e.g. missing old snapshot) but we do have
    // a tool-provided patch/diff hint, prefer that for +/- stats and detail rendering.
    let diff_hint = diff_hint
        .and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });
    let tool_patch_diff = if source == ChangeSource::Tool && change_type == ChangeType::Update {
        if let Some(hint) = diff_hint.clone() {
            Some(hint)
        } else {
            let old_text = normalized_old.as_deref().unwrap_or("");
            let new_text = normalized_new.as_deref().unwrap_or("");
            if old_text.is_empty() && new_text.is_empty() {
                None
            } else {
                Some(generate_unified_diff(&normalized_file_path, old_text, new_text))
            }
        }
    } else {
        diff_hint.clone()
    };
    let tool_patch_available = tool_patch_diff.is_some();

    // Final contents used to generate diff stats.
    //
    // For tool-driven edits, the frontend captures a "before" snapshot from disk right before
    // the tool executes. That snapshot is the most accurate base for "files changed" because:
    // - the working tree may already be dirty (manual edits before the prompt)
    // - git commit_before may not include uncommitted state
    //
    // So we prefer the UI-provided snapshot when it looks like full context.
    // For command-driven changes (shell), we still prefer git snapshots when available.
    let normalized_old_missing = normalized_old.is_none();
    let final_old = if old_is_fragment {
        old_from_git.or(old_from_head).or(normalized_old)
    } else if source == ChangeSource::Tool {
        normalized_old.or(old_from_git).or(old_from_head)
    } else {
        old_from_git.or(normalized_old).or(old_from_head)
    };
    let final_new = new_from_disk.or(normalized_new);

    // Prefer tool patch hints only when we *don't* trust the full-context snapshot.
    //
    // NOTE: `diff_hint` being present is common for apply_patch and should NOT force us to use
    // patch-based +/- counting, otherwise multiple edits within one prompt become cumulative and
    // diverge from "net diff" semantics (official plugin behavior).
    let prefer_tool_patch = source == ChangeSource::Tool
        && change_type == ChangeType::Update
        && tool_patch_available
        && (old_is_fragment || normalized_old_missing || final_new.is_none());

    // For tool changes, the frontend already decides create/update/delete based on tool metadata.
    // Avoid auto-reclassifying updates to "create" when we failed to snapshot old_content.
    let effective_change_type = if source == ChangeSource::Tool {
        change_type
    } else {
        match (&final_old, &final_new) {
            (None, Some(_)) => ChangeType::Create,
            (Some(_), Some(_)) => ChangeType::Update,
            (Some(_), None) => ChangeType::Delete,
            (None, None) => change_type,
        }
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

        // Tool changes may contain multiple tool calls for the same file within one prompt.
        // Keep a comma-separated list of tool_call_id values for reliable UI matching, and
        // avoid double-recording the same tool call.
        if source == ChangeSource::Tool {
            if let Some(incoming_call_id) = tool_call_id.clone() {
                let already_recorded = existing
                    .tool_call_id
                    .as_deref()
                    .map(|s| {
                        s.split(',')
                            .map(|p| p.trim())
                            .filter(|p| !p.is_empty())
                            .any(|p| p == incoming_call_id.as_str())
                    })
                    .unwrap_or(false);

                if already_recorded {
                    return Ok(existing.id.clone());
                }

                existing.tool_call_id = match existing.tool_call_id.as_deref() {
                    None => Some(incoming_call_id.clone()),
                    Some(s) if s.trim().is_empty() => Some(incoming_call_id.clone()),
                    Some(s) => Some(format!("{},{}", s, incoming_call_id)),
                };
            }
        } else if tool_call_id.is_some() {
            existing.tool_call_id = tool_call_id;
        }

        // Preserve the earliest old_content (prompt base); always update to the latest new_content (prompt latest).
        //
        // If existing old_content is clearly a small fragment (legacy), prefer a larger full-context `final_old`.
        if existing.old_content.is_none() {
            existing.old_content = final_old.clone();
        } else if let (Some(prev), Some(next)) = (existing.old_content.as_ref(), final_old.as_ref()) {
            let prev_trim = prev.trim();
            let next_trim = next.trim();
            let prev_len = prev_trim.len();
            let next_len = next_trim.len();
            let should_upgrade_old = prev_len > 0 && next_len > 0 && prev_len < 1_000 && next_len > prev_len * 5;
            if should_upgrade_old {
                existing.old_content = Some(next.clone());
            }
        }
        existing.new_content = final_new.clone();

        // Decide final change type for the merged record.
        // (Create->Update stays Create; any Delete wins.)
        let mut merged_type = existing.change_type.clone();
        match (&existing.change_type, &effective_change_type) {
            (ChangeType::Create, ChangeType::Update) => merged_type = ChangeType::Create,
            (ChangeType::Create, ChangeType::Delete) => merged_type = ChangeType::Delete,
            (_, ChangeType::Delete) => merged_type = ChangeType::Delete,
            (ChangeType::Delete, _) => merged_type = ChangeType::Delete,
            _ => merged_type = existing.change_type.clone(),
        }

        existing.timestamp = now.clone();
        existing.change_type = merged_type;

        // Recompute diff stats based on merged old/new (net diff per file per prompt), but fall back to
        // tool diff hint when we don't have a reliable snapshot.
        let mut has_full_context = match existing.change_type {
            ChangeType::Create => existing.new_content.is_some(),
            ChangeType::Delete => existing.old_content.is_some(),
            ChangeType::Update => existing.old_content.is_some() && existing.new_content.is_some(),
        };
        if source == ChangeSource::Tool && tool_patch_diff.is_some() {
            // When the frontend only captured a small patch fragment (or failed to read disk),
            // full-context diffs become "everything changed". Prefer tool diff hints in that case.
            if prefer_tool_patch {
                has_full_context = false;
            } else if looks_like_fragment_pair(&existing.old_content, &existing.new_content) {
                has_full_context = false;
            }
        }
        if has_full_context {
            let (diff, added, removed) =
                recompute_change_diff_fields(&existing.file_path, &existing.old_content, &existing.new_content);
            existing.unified_diff = diff;
            existing.lines_added = added;
            existing.lines_removed = removed;
        } else if let Some(hint) = tool_patch_diff.clone() {
            let (added, removed) = count_diff_lines(&hint);
            existing.old_content = None;
            existing.new_content = None;
            existing.unified_diff = match existing.unified_diff.take() {
                Some(mut prev) => {
                    if !prev.ends_with('\n') { prev.push('\n'); }
                    prev.push_str(&hint);
                    Some(prev)
                }
                None => Some(hint),
            };
            existing.lines_added = Some(existing.lines_added.unwrap_or(0) + added);
            existing.lines_removed = Some(existing.lines_removed.unwrap_or(0) + removed);
        }

        // Prefer latest metadata if provided
        if tool_name.is_some() {
            existing.tool_name = tool_name;
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

    // Build diff fields.
    //
    // Prefer full-context diffs when possible; otherwise fall back to tool diff hints.
    // For updates without old snapshots, it's better to show the patch the tool applied than
    // to mis-classify the change as a full-file create.
    let mut has_full_context = match effective_change_type {
        ChangeType::Create => final_new.is_some(),
        ChangeType::Delete => final_old.is_some(),
        ChangeType::Update => final_old.is_some() && final_new.is_some(),
    };
    if source == ChangeSource::Tool && tool_patch_diff.is_some() {
        if prefer_tool_patch {
            has_full_context = false;
        } else if effective_change_type == ChangeType::Update && looks_like_fragment_pair(&final_old, &final_new) {
            has_full_context = false;
        }
    }

    let (unified_diff, lines_added, lines_removed, stored_old, stored_new) = if has_full_context {
        match (&final_old, &final_new) {
            (Some(old), Some(new)) => {
                let diff = generate_unified_diff(&normalized_file_path, old, new);
                let (added, removed) = count_diff_lines(&diff);
                (Some(diff), Some(added), Some(removed), final_old, final_new)
            }
            (None, Some(new)) => {
                let lines = new.lines().count() as i32;
                let diff = generate_create_diff(&normalized_file_path, new);
                (Some(diff), Some(lines), Some(0), None, Some(new.clone()))
            }
            (Some(old), None) => {
                let lines = old.lines().count() as i32;
                let diff = generate_delete_diff(&normalized_file_path, old);
                (Some(diff), Some(0), Some(lines), Some(old.clone()), None)
            }
            (None, None) => (None, None, None, None, None),
        }
    } else if let Some(hint) = tool_patch_diff.clone() {
        let (added, removed) = count_diff_lines(&hint);
        (Some(hint), Some(added), Some(removed), None, None)
    } else {
        (None, None, None, None, None)
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
        old_content: stored_old,
        new_content: stored_new,
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
        // Fallback when git records are missing/disabled: use HEAD snapshot.
        if option_string_is_empty(&change.old_content) {
            if let Some(old) = git_show_file(project_path, "HEAD", &normalized_path) {
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

    // 2.5) Repair legacy tool changes where we accidentally stored patch fragments as old_content/new_content.
    // This happens when a single prompt edits the same file multiple times (multiple apply_patch),
    // and the backend merges records by keeping the earliest old + latest new.
    // If old/new are not from the same base revision, diffs become nonsensical ("everything changed").
    if repair_tool_fragment_changes(records) {
        mutated = true;
    }

    // 3) Backfill missing content/diff for history display
    for change in records.changes.iter_mut() {
        if backfill_change_content(session_id, &records.project_path, change) {
            mutated = true;
        }
    }

    // 4) Note: prompt_index re-mapping now happens at the UI layer using tool_call_id matching.
    // Avoid reading session JSONL here to prevent blocking when WSL/UNC paths are unavailable.

    if mutated {
        records.updated_at = Utc::now().to_rfc3339();
    }

    mutated
}

fn looks_like_fragment_pair(old_content: &Option<String>, new_content: &Option<String>) -> bool {
    let (Some(old), Some(new)) = (old_content.as_deref(), new_content.as_deref()) else {
        return false;
    };

    looks_like_fragment_text(old, new)
}

fn looks_like_fragment_text(old: &str, new: &str) -> bool {
    let old_len = old.trim().len();
    let new_len = new.trim().len();
    if old_len == 0 || new_len == 0 {
        return false;
    }

    let old_lines = old.lines().count();
    let new_lines = new.lines().count();

    // Heuristic: old is a small patch fragment while new looks like a full file.
    (old_len < 4_000 && new_len > 10_000 && old_len * 5 < new_len)
        || (old_lines < 80 && new_lines > 300 && old_lines * 5 < new_lines)
}

fn repair_tool_fragment_changes(records: &mut CodexChangeRecords) -> bool {
    let mut mutated = false;

    // Process changes in prompt order so we can use "previous new_content" as the base for the next prompt.
    let mut indices: Vec<usize> = (0..records.changes.len()).collect();
    indices.sort_by(|&a, &b| {
        let ca = &records.changes[a];
        let cb = &records.changes[b];
        ca.prompt_index
            .cmp(&cb.prompt_index)
            .then_with(|| ca.timestamp.cmp(&cb.timestamp))
    });

    let mut last_by_file: HashMap<String, String> = HashMap::new();

    for idx in indices {
        let change = &mut records.changes[idx];
        let key = change.file_path.clone();

        if change.source == ChangeSource::Tool && change.change_type == ChangeType::Update {
            if looks_like_fragment_pair(&change.old_content, &change.new_content) {
                if let Some(prev) = last_by_file.get(&key).cloned() {
                    change.old_content = Some(prev);
                    mutated = true;
                } else if let Some(head) = git_show_file(&records.project_path, "HEAD", &key) {
                    change.old_content = Some(head);
                    mutated = true;
                }
            }
        }

        match change.change_type {
            ChangeType::Delete => {
                last_by_file.remove(&key);
            }
            _ => {
                if let Some(new) = change.new_content.as_ref() {
                    if !new.trim().is_empty() {
                        last_by_file.insert(key, new.clone());
                    }
                }
            }
        }
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
        let mut old_content = session_snapshots.and_then(|s| s.get(file).cloned());
        let new_content = if full_path.exists() {
            fs::read_to_string(&full_path).ok()
        } else {
            None
        };

        // If we didn't snapshot this file before the command (common when the repo was clean),
        // try to read the tracked version from git so we don't mis-classify.
        if old_content.is_none() {
            if new_content.is_some() {
                // Update vs create
                if let Some(head) = git_show_file(project_path, "HEAD", file) {
                    old_content = Some(head);
                }
            } else {
                // Delete: file missing after command but might exist in HEAD
                if let Some(head) = git_show_file(project_path, "HEAD", file) {
                    old_content = Some(head);
                }
            }
        }

        // No net change (very common when running read-only commands in a dirty repo).
        if let (Some(old), Some(new)) = (&old_content, &new_content) {
            if old == new {
                continue;
            }
        }

        // 确定变更类型（based on net before/after)
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
    if let Some(diff) = generate_unified_diff_via_git(file_path, old_content, new_content) {
        return diff;
    }
    generate_unified_diff_naive(file_path, old_content, new_content)
}

fn generate_unified_diff_via_git(
    file_path: &str,
    old_content: &str,
    new_content: &str,
) -> Option<String> {
    let dir = tempfile::tempdir().ok()?;

    let safe_rel = sanitize_relative_path_for_temp(file_path);
    let old_rel = PathBuf::from("old").join(&safe_rel);
    let new_rel = PathBuf::from("new").join(&safe_rel);
    let old_abs = dir.path().join(&old_rel);
    let new_abs = dir.path().join(&new_rel);

    if let Some(parent) = old_abs.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    if let Some(parent) = new_abs.parent() {
        fs::create_dir_all(parent).ok()?;
    }

    fs::write(&old_abs, old_content).ok()?;
    fs::write(&new_abs, new_content).ok()?;

    let mut cmd = Command::new("git");
    cmd.args([
        "diff",
        "--no-index",
        "--text",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
    ]);
    cmd.arg(&old_rel);
    cmd.arg(&new_rel);
    cmd.current_dir(dir.path());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().ok()?;

    // git diff exits with:
    // - 0 when no diff
    // - 1 when diff exists
    // - >1 on error
    let code = output.status.code().unwrap_or(0);
    if code != 0 && code != 1 {
        return None;
    }

    let raw = String::from_utf8(output.stdout).ok()?;
    if raw.trim().is_empty() {
        return Some(format!("--- a/{}\n+++ b/{}\n", file_path, file_path));
    }

    let mut rewritten = String::with_capacity(raw.len());
    for line in raw.lines() {
        if line.starts_with("diff --git ") {
            rewritten.push_str(&format!("diff --git a/{} b/{}", file_path, file_path));
        } else if line.starts_with("--- ") {
            if line.contains("/dev/null") {
                rewritten.push_str(line);
            } else {
                rewritten.push_str(&format!("--- a/{}", file_path));
            }
        } else if line.starts_with("+++ ") {
            if line.contains("/dev/null") {
                rewritten.push_str(line);
            } else {
                rewritten.push_str(&format!("+++ b/{}", file_path));
            }
        } else {
            rewritten.push_str(line);
        }
        rewritten.push('\n');
    }

    Some(rewritten)
}

fn sanitize_relative_path_for_temp(file_path: &str) -> PathBuf {
    let normalized = file_path.replace('\\', "/");
    let mut out = PathBuf::new();

    for raw_part in normalized.split('/') {
        let part = raw_part.trim();
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }

        // Keep the temp dir portable (Windows filename restrictions).
        let cleaned: String = part
            .chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
                _ => c,
            })
            .collect();

        out.push(cleaned);
    }

    if out.as_os_str().is_empty() {
        out.push("file");
    }

    out
}

/// Fallback diff (very naive line-by-line compare). Kept for environments without git.
fn generate_unified_diff_naive(file_path: &str, old_content: &str, new_content: &str) -> String {
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

    // NOTE: git diff may represent "no newline at end of file" as a replace of the last line:
    //   -<line>
    //   \ No newline at end of file
    //   +<line>
    // That shouldn't affect change stats for our UX (official plugin usually reports pure insertions).
    let lines: Vec<&str> = diff.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];

        let is_added = line.starts_with('+') && !line.starts_with("+++ ");
        let is_removed = line.starts_with('-') && !line.starts_with("--- ");

        // Ignore the special no-newline replacement pair when the content is identical.
        if is_removed
            && i + 2 < lines.len()
            && lines[i + 1] == r"\ No newline at end of file"
            && (lines[i + 2].starts_with('+') && !lines[i + 2].starts_with("+++ "))
        {
            let removed_text = &line[1..];
            let added_text = &lines[i + 2][1..];
            if removed_text == added_text {
                i += 3;
                continue;
            }
        }

        // Only ignore the unified diff file headers ("+++ b/file", "--- a/file").
        // Do NOT blanket-ignore lines starting with "+++" / "---" because real file
        // content can start with those characters inside hunks.
        if is_added {
            added += 1;
        } else if is_removed {
            removed += 1;
        }

        i += 1;
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
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    diff_hint: Option<String>,
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
        tool_name,
        tool_call_id,
        diff_hint,
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
    fn to_summary(change: &CodexFileChange) -> CodexFileChange {
        // Keep list payload small (history panel loads fast). Detail API fetches full content on demand.
        let mut c = change.clone();
        c.old_content = None;
        c.new_content = None;
        c.unified_diff = None;
        c
    }

    let trackers = CHANGE_TRACKERS.lock().unwrap();

    // 先尝试从内存获取
    if let Some(records) = trackers.get(&session_id) {
        return Ok(records.changes.iter().map(to_summary).collect());
    }

    drop(trackers);

    // 尝试从文件加载
    let path = get_change_records_path(&session_id)?;
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取文件失败: {}", e))?;
        let mut records: CodexChangeRecords = serde_json::from_str(&content)
            .map_err(|e| format!("解析 JSON 失败: {}", e))?;

        // Upgrade legacy records (normalize paths / merge duplicates / backfill diff context)
        let upgraded = upgrade_change_records(&session_id, &mut records);
        if upgraded {
            if let Ok(pretty) = serde_json::to_string_pretty(&records) {
                if let Err(e) = fs::write(&path, pretty) {
                    log::warn!(
                        "[ChangeTracker] Failed to persist upgraded records on list ({}): {}",
                        session_id,
                        e
                    );
                }
            }
        }

        let summaries: Vec<CodexFileChange> = records.changes.iter().map(to_summary).collect();

        // 缓存到内存（保存完整记录，详情页可直接使用）
        let mut trackers = CHANGE_TRACKERS.lock().unwrap();
        trackers.insert(session_id.clone(), records);
        return Ok(summaries);
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
    // Prefer in-memory full records if available.
    {
        let trackers = CHANGE_TRACKERS.lock().unwrap();
        if let Some(records) = trackers.get(&session_id) {
            if let Some(found) = records.changes.iter().find(|c| c.id == change_id) {
                return Ok(found.clone());
            }
        }
    }

    // Fallback to file (full payload).
    let path = get_change_records_path(&session_id)?;
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
        let mut records: CodexChangeRecords =
            serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {}", e))?;

        // Upgrade legacy records (normalize paths / merge duplicates / backfill diff context)
        let upgraded = upgrade_change_records(&session_id, &mut records);
        if upgraded {
            if let Ok(pretty) = serde_json::to_string_pretty(&records) {
                if let Err(e) = fs::write(&path, pretty) {
                    log::warn!(
                        "[ChangeTracker] Failed to persist upgraded records on get_detail ({}): {}",
                        session_id,
                        e
                    );
                }
            }
        }

        if let Some(found) = records.changes.iter().find(|c| c.id == change_id) {
            let out = found.clone();
            // Cache full records so subsequent detail/list reads are consistent.
            let mut trackers = CHANGE_TRACKERS.lock().unwrap();
            trackers.insert(session_id.clone(), records);
            return Ok(out);
        }
    }

    Err(format!("变更 {} 未找到", change_id))
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

/// 修复/升级会话的变更记录（重新计算 diff、补齐 old/new 内容等）
///
/// 用于：
/// - App 热更新/版本升级后，历史记录仍是旧格式或统计不一致
/// - 记录在内存中已加载，但升级逻辑只在从文件读取时触发
#[tauri::command]
pub async fn codex_repair_change_records(session_id: String) -> Result<bool, String> {
    let path = get_change_records_path(&session_id)?;

    // Load from memory first, then fall back to disk.
    let mut records: Option<CodexChangeRecords> = {
        let trackers = CHANGE_TRACKERS.lock().unwrap();
        trackers.get(&session_id).cloned()
    };

    if records.is_none() && path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
        let parsed: CodexChangeRecords =
            serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {}", e))?;
        records = Some(parsed);
    }

    let Some(mut records) = records else {
        return Err(format!("会话 {} 未找到", session_id));
    };

    let upgraded = upgrade_change_records(&session_id, &mut records);
    if upgraded {
        let content = serde_json::to_string_pretty(&records).map_err(|e| format!("序列化失败: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))?;

        // Update in-memory cache so list/detail reflect the repaired content immediately.
        let mut trackers = CHANGE_TRACKERS.lock().unwrap();
        trackers.insert(session_id.clone(), records);

        log::info!("[ChangeTracker] Repaired change records for session {}", session_id);
    }

    Ok(upgraded)
}
