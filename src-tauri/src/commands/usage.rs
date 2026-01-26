// Simplified usage tracking from opcode project
// Source: https://github.com/meistrari/opcode

use chrono::{DateTime, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::{async_runtime, command};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageEntry {
    timestamp: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    cost: f64,
    session_id: String,
    project_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageStats {
    total_cost: f64,
    total_tokens: u64,
    total_input_tokens: u64,
    total_output_tokens: u64,
    total_cache_creation_tokens: u64,
    total_cache_read_tokens: u64,
    total_sessions: u64,
    by_model: Vec<ModelUsage>,
    by_date: Vec<DailyUsage>,
    by_project: Vec<ProjectUsage>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelUsage {
    model: String,
    total_cost: f64,
    total_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    session_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DailyUsage {
    date: String,
    total_cost: f64,
    total_tokens: u64,
    models_used: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectUsage {
    project_path: String,
    project_name: String,
    total_cost: f64,
    total_tokens: u64,
    session_count: u64,
    last_used: String,
}

// ============================================================================
// Multi-Engine Usage Stats - Support for Claude, Codex, and Gemini
// ============================================================================

/// Multi-engine usage statistics
#[derive(Debug, Serialize, Deserialize)]
pub struct MultiEngineUsageStats {
    // Summary data
    pub total_cost: f64,
    pub total_tokens: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_sessions: u64,
    
    // Grouped by engine
    pub by_engine: Vec<EngineUsage>,
    
    // Grouped by model (with engine info)
    pub by_model: Vec<ModelUsageWithEngine>,
    
    // Grouped by date (with engine info)
    pub by_date: Vec<DailyUsageWithEngine>,
    
    // Grouped by project
    pub by_project: Vec<ProjectUsageWithEngine>,
}

/// Usage statistics for a single engine
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EngineUsage {
    pub engine: String,  // "claude", "codex", "gemini"
    pub total_cost: f64,
    pub total_tokens: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_sessions: u64,
}

/// Model usage with engine information
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelUsageWithEngine {
    pub engine: String,
    pub model: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub session_count: u64,
}

/// Daily usage with engine information
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailyUsageWithEngine {
    pub date: String,
    pub engine: String,
    pub total_cost: f64,
    pub total_tokens: u64,
}

/// Project usage with engine information
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectUsageWithEngine {
    pub engine: String,
    pub project_path: String,
    pub project_name: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub session_count: u64,
    pub last_used: String,
}

/// Usage entry with engine information (internal use)
#[derive(Debug, Clone)]
pub struct UsageEntryWithEngine {
    pub engine: String,
    pub timestamp: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost: f64,
    pub session_id: String,
    pub project_path: String,
}

// ============================================================================
// Claude Model Pricing - Single Source of Truth
// Source: https://platform.claude.com/docs/en/about-claude/pricing
// Last Updated: December 2025
// ============================================================================

/// Model pricing structure (prices per million tokens)
#[derive(Debug, Clone, Copy)]
struct ModelPricing {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

/// Model family enumeration for categorization
#[derive(Debug, Clone, Copy, PartialEq)]
enum ModelFamily {
    Opus45,      // Claude 4.5 Opus
    Opus41,      // Claude 4.1 Opus
    Sonnet45,    // Claude 4.5 Sonnet
    Haiku45,     // Claude 4.5 Haiku
    Unknown,     // Unknown model
}

impl ModelPricing {
    /// Get pricing for a specific model family
    const fn for_family(family: ModelFamily) -> Self {
        match family {
            // Claude 4.5 Series (Latest - December 2025)
            ModelFamily::Opus45 => ModelPricing {
                input: 5.0,
                output: 25.0,
                cache_write: 6.25,
                cache_read: 0.50,
            },
            ModelFamily::Sonnet45 => ModelPricing {
                input: 3.0,
                output: 15.0,
                cache_write: 3.75,
                cache_read: 0.30,
            },
            ModelFamily::Haiku45 => ModelPricing {
                input: 1.0,
                output: 5.0,
                cache_write: 1.25,
                cache_read: 0.10,
            },
            // Claude 4.1 Series
            ModelFamily::Opus41 => ModelPricing {
                input: 15.0,
                output: 75.0,
                cache_write: 18.75,
                cache_read: 1.50,
            },
            ModelFamily::Unknown => ModelPricing {
                input: 0.0,
                output: 0.0,
                cache_write: 0.0,
                cache_read: 0.0,
            },
        }
    }
}

/// Parse model name and determine its family
///
/// This function handles various model name formats including:
/// - Full names: claude-sonnet-4-5-20250929
/// - Aliases: claude-sonnet-4-5
/// - Short names: sonnet-4-5
/// - Bedrock format: anthropic.claude-sonnet-4-5-20250929-v1:0
/// - Vertex AI format: claude-sonnet-4-5@20250929
fn parse_model_family(model: &str) -> ModelFamily {
    // Normalize the model name (lowercase + remove common prefixes/suffixes)
    let mut normalized = model.to_lowercase();
    normalized = normalized.replace("anthropic.", "");
    normalized = normalized.replace("-v1:0", "");

    // Handle @ symbol for Vertex AI format
    if let Some(pos) = normalized.find('@') {
        normalized = normalized[..pos].to_string();
    }

    // Priority-based matching (order matters!)
    // Check for specific model families in order from most to least specific

    // Claude 4.5 Series (Latest)
    if normalized.contains("opus") && (normalized.contains("4.5") || normalized.contains("4-5")) {
        return ModelFamily::Opus45;
    }
    if normalized.contains("haiku") && (normalized.contains("4.5") || normalized.contains("4-5")) {
        return ModelFamily::Haiku45;
    }
    if normalized.contains("sonnet") && (normalized.contains("4.5") || normalized.contains("4-5")) {
        return ModelFamily::Sonnet45;
    }

    // Claude 4.1 Series
    if normalized.contains("opus") && (normalized.contains("4.1") || normalized.contains("4-1")) {
        return ModelFamily::Opus41;
    }

    // Generic family detection (fallback)
    if normalized.contains("haiku") {
        return ModelFamily::Haiku45; // Default to latest Haiku
    }
    if normalized.contains("opus") {
        return ModelFamily::Opus45; // Default to latest Opus
    }
    if normalized.contains("sonnet") {
        return ModelFamily::Sonnet45; // Default to latest Sonnet
    }

    ModelFamily::Unknown
}

#[derive(Debug, Deserialize)]
struct JsonlEntry {
    timestamp: String,
    message: Option<MessageData>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct MessageData {
    id: Option<String>,
    model: Option<String>,
    usage: Option<UsageData>,
}

#[derive(Debug, Deserialize)]
struct UsageData {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

/// Calculate cost for a model usage
///
/// This is the single source of truth for cost calculations.
/// All cost computations in the application should ultimately use this function.
fn calculate_cost(model: &str, usage: &UsageData) -> f64 {
    let input_tokens = usage.input_tokens.unwrap_or(0) as f64;
    let output_tokens = usage.output_tokens.unwrap_or(0) as f64;
    let cache_creation_tokens = usage.cache_creation_input_tokens.unwrap_or(0) as f64;
    let cache_read_tokens = usage.cache_read_input_tokens.unwrap_or(0) as f64;

    // Parse model and get pricing
    let family = parse_model_family(model);
    let pricing = ModelPricing::for_family(family);

    // Log unrecognized models for debugging
    if family == ModelFamily::Unknown {
        log::warn!("Unknown model detected: '{}'. Cost calculation will return 0.", model);
    }

    // Calculate cost (prices are per million tokens)
    let cost = (input_tokens * pricing.input / 1_000_000.0)
        + (output_tokens * pricing.output / 1_000_000.0)
        + (cache_creation_tokens * pricing.cache_write / 1_000_000.0)
        + (cache_read_tokens * pricing.cache_read / 1_000_000.0);

    cost
}

fn parse_jsonl_file(
    path: &PathBuf,
    encoded_project_name: &str,
    processed_hashes: &mut HashSet<String>,
) -> Vec<UsageEntry> {
    let mut entries = Vec::new();
    let mut actual_project_path: Option<String> = None;

    if let Ok(content) = fs::read_to_string(path) {
        // Extract session ID from the file path
        let session_id = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }

            if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(line) {
                // Extract the actual project path from cwd if we haven't already
                if actual_project_path.is_none() {
                    if let Some(cwd) = json_value.get("cwd").and_then(|v| v.as_str()) {
                        actual_project_path = Some(cwd.to_string());
                    }
                }

                // Try to parse as JsonlEntry for usage data
                if let Ok(entry) = serde_json::from_value::<JsonlEntry>(json_value) {
                    if let Some(message) = &entry.message {
                        // Deduplication based on message ID and request ID
                        if let (Some(msg_id), Some(req_id)) = (&message.id, &entry.request_id) {
                            let unique_hash = format!("{}:{}", msg_id, req_id);
                            if processed_hashes.contains(&unique_hash) {
                                continue; // Skip duplicate entry
                            }
                            processed_hashes.insert(unique_hash);
                        }

                        if let Some(usage) = &message.usage {
                            // Skip entries without meaningful token usage
                            if usage.input_tokens.unwrap_or(0) == 0
                                && usage.output_tokens.unwrap_or(0) == 0
                                && usage.cache_creation_input_tokens.unwrap_or(0) == 0
                                && usage.cache_read_input_tokens.unwrap_or(0) == 0
                            {
                                continue;
                            }

                            let cost = entry.cost_usd.unwrap_or_else(|| {
                                if let Some(model_str) = &message.model {
                                    calculate_cost(model_str, usage)
                                } else {
                                    0.0
                                }
                            });

                            // Use actual project path if found, otherwise use encoded name
                            let project_path = actual_project_path
                                .clone()
                                .unwrap_or_else(|| encoded_project_name.to_string());

                            entries.push(UsageEntry {
                                timestamp: entry.timestamp,
                                model: message
                                    .model
                                    .clone()
                                    .unwrap_or_else(|| "unknown".to_string()),
                                input_tokens: usage.input_tokens.unwrap_or(0),
                                output_tokens: usage.output_tokens.unwrap_or(0),
                                cache_creation_tokens: usage
                                    .cache_creation_input_tokens
                                    .unwrap_or(0),
                                cache_read_tokens: usage.cache_read_input_tokens.unwrap_or(0),
                                cost,
                                session_id: entry.session_id.unwrap_or_else(|| session_id.clone()),
                                project_path,
                            });
                        }
                    }
                }
            }
        }
    }

    entries
}

fn get_earliest_timestamp(path: &PathBuf) -> Option<String> {
    if let Ok(content) = fs::read_to_string(path) {
        let mut earliest_timestamp: Option<String> = None;
        for line in content.lines() {
            if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(timestamp_str) = json_value.get("timestamp").and_then(|v| v.as_str()) {
                    if let Some(current_earliest) = &earliest_timestamp {
                        if timestamp_str < current_earliest.as_str() {
                            earliest_timestamp = Some(timestamp_str.to_string());
                        }
                    } else {
                        earliest_timestamp = Some(timestamp_str.to_string());
                    }
                }
            }
        }
        return earliest_timestamp;
    }
    None
}

fn get_all_usage_entries(claude_path: &PathBuf) -> Vec<UsageEntry> {
    let mut all_entries = Vec::new();
    let mut processed_hashes = HashSet::new();
    let projects_dir = claude_path.join("projects");

    let mut files_to_process: Vec<(PathBuf, String)> = Vec::new();

    if let Ok(projects) = fs::read_dir(&projects_dir) {
        for project in projects.flatten() {
            if project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let project_name = project.file_name().to_string_lossy().to_string();
                let project_path = project.path();

                walkdir::WalkDir::new(&project_path)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
                    .for_each(|entry| {
                        files_to_process.push((entry.path().to_path_buf(), project_name.clone()));
                    });
            }
        }
    }

    // Sort files by their earliest timestamp to ensure chronological processing
    // and deterministic deduplication
    files_to_process.sort_by_cached_key(|(path, _)| get_earliest_timestamp(path));

    for (path, project_name) in files_to_process {
        let entries = parse_jsonl_file(&path, &project_name, &mut processed_hashes);
        all_entries.extend(entries);
    }

    // Sort by timestamp
    all_entries.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    all_entries
}

fn get_usage_stats_sync(days: Option<u32>) -> Result<UsageStats, String> {
    let claude_path = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude");

    let all_entries = get_all_usage_entries(&claude_path);

    if all_entries.is_empty() {
        return Ok(UsageStats {
            total_cost: 0.0,
            total_tokens: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_creation_tokens: 0,
            total_cache_read_tokens: 0,
            total_sessions: 0,
            by_model: vec![],
            by_date: vec![],
            by_project: vec![],
        });
    }

    // Filter by days if specified
    // 🚀 修复时区问题：使用本地时区进行日期比较
    let filtered_entries = if let Some(days) = days {
        let cutoff = Local::now().date_naive() - chrono::Duration::days(days as i64);
        all_entries
            .into_iter()
            .filter(|e| {
                if let Ok(dt) = DateTime::parse_from_rfc3339(&e.timestamp) {
                    // 转换为本地时区后提取日期进行比较
                    dt.with_timezone(&Local).date_naive() >= cutoff
                } else {
                    false
                }
            })
            .collect()
    } else {
        all_entries
    };

    // Calculate aggregated stats
    let mut total_cost = 0.0;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    let mut total_cache_creation_tokens = 0u64;
    let mut total_cache_read_tokens = 0u64;

    let mut model_stats: HashMap<String, ModelUsage> = HashMap::new();
    let mut daily_stats: HashMap<String, DailyUsage> = HashMap::new();
    let mut project_stats: HashMap<String, ProjectUsage> = HashMap::new();

    for entry in &filtered_entries {
        // Update totals
        total_cost += entry.cost;
        total_input_tokens += entry.input_tokens;
        total_output_tokens += entry.output_tokens;
        total_cache_creation_tokens += entry.cache_creation_tokens;
        total_cache_read_tokens += entry.cache_read_tokens;

        // Update model stats
        let model_stat = model_stats
            .entry(entry.model.clone())
            .or_insert(ModelUsage {
                model: entry.model.clone(),
                total_cost: 0.0,
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                session_count: 0,
            });
        model_stat.total_cost += entry.cost;
        model_stat.input_tokens += entry.input_tokens;
        model_stat.output_tokens += entry.output_tokens;
        model_stat.cache_creation_tokens += entry.cache_creation_tokens;
        model_stat.cache_read_tokens += entry.cache_read_tokens;
        model_stat.total_tokens = model_stat.input_tokens + model_stat.output_tokens;
        model_stat.session_count += 1;

        // Update daily stats
        // 🚀 修复时区问题：使用本地日期而不是 UTC 日期
        let date = if let Ok(dt) = DateTime::parse_from_rfc3339(&entry.timestamp) {
            // 转换为本地时间后提取日期
            dt.with_timezone(&Local).format("%Y-%m-%d").to_string()
        } else {
            // 降级：直接从字符串提取（可能不准确）
            entry.timestamp
                .split('T')
                .next()
                .unwrap_or(&entry.timestamp)
                .to_string()
        };
        let daily_stat = daily_stats.entry(date.clone()).or_insert(DailyUsage {
            date,
            total_cost: 0.0,
            total_tokens: 0,
            models_used: vec![],
        });
        daily_stat.total_cost += entry.cost;
        daily_stat.total_tokens += entry.input_tokens
            + entry.output_tokens
            + entry.cache_creation_tokens
            + entry.cache_read_tokens;
        if !daily_stat.models_used.contains(&entry.model) {
            daily_stat.models_used.push(entry.model.clone());
        }

        // Update project stats
        let project_stat =
            project_stats
                .entry(entry.project_path.clone())
                .or_insert(ProjectUsage {
                    project_path: entry.project_path.clone(),
                    project_name: entry
                        .project_path
                        .split('/')
                        .last()
                        .unwrap_or(&entry.project_path)
                        .to_string(),
                    total_cost: 0.0,
                    total_tokens: 0,
                    session_count: 0,
                    last_used: entry.timestamp.clone(),
                });
        project_stat.total_cost += entry.cost;
        project_stat.total_tokens += entry.input_tokens
            + entry.output_tokens
            + entry.cache_creation_tokens
            + entry.cache_read_tokens;
        project_stat.session_count += 1;
        if entry.timestamp > project_stat.last_used {
            project_stat.last_used = entry.timestamp.clone();
        }
    }

    let total_tokens = total_input_tokens
        + total_output_tokens
        + total_cache_creation_tokens
        + total_cache_read_tokens;
    let total_sessions = filtered_entries.len() as u64;

    // Convert hashmaps to sorted vectors
    let mut by_model: Vec<ModelUsage> = model_stats.into_values().collect();
    by_model.sort_by(|a, b| b.total_cost.partial_cmp(&a.total_cost).unwrap());

    let mut by_date: Vec<DailyUsage> = daily_stats.into_values().collect();
    by_date.sort_by(|a, b| b.date.cmp(&a.date));

    let mut by_project: Vec<ProjectUsage> = project_stats.into_values().collect();
    by_project.sort_by(|a, b| b.total_cost.partial_cmp(&a.total_cost).unwrap());

    Ok(UsageStats {
        total_cost,
        total_tokens,
        total_input_tokens,
        total_output_tokens,
        total_cache_creation_tokens,
        total_cache_read_tokens,
        total_sessions,
        by_model,
        by_date,
        by_project,
    })
}

#[command]
pub async fn get_usage_stats(days: Option<u32>) -> Result<UsageStats, String> {
    async_runtime::spawn_blocking(move || get_usage_stats_sync(days))
        .await
        .map_err(|e| format!("获取使用统计失败: {}", e))?
}

fn get_usage_by_date_range_sync(start_date: String, end_date: String) -> Result<UsageStats, String> {
    let claude_path = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude");

    let all_entries = get_all_usage_entries(&claude_path);

    // Parse dates
    let start = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d").or_else(|_| {
        DateTime::parse_from_rfc3339(&start_date)
            .map(|dt| dt.naive_local().date())
            .map_err(|e| format!("Invalid start date: {}", e))
    })?;
    let end = NaiveDate::parse_from_str(&end_date, "%Y-%m-%d").or_else(|_| {
        DateTime::parse_from_rfc3339(&end_date)
            .map(|dt| dt.naive_local().date())
            .map_err(|e| format!("Invalid end date: {}", e))
    })?;

    // Filter entries by date range
    // 🚀 修复时区问题：转换为本地时区后进行日期比较
    let filtered_entries: Vec<_> = all_entries
        .into_iter()
        .filter(|e| {
            if let Ok(dt) = DateTime::parse_from_rfc3339(&e.timestamp) {
                // 先转换为本地时区，再提取日期进行比较
                let date = dt.with_timezone(&Local).date_naive();
                date >= start && date <= end
            } else {
                false
            }
        })
        .collect();

    if filtered_entries.is_empty() {
        return Ok(UsageStats {
            total_cost: 0.0,
            total_tokens: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_creation_tokens: 0,
            total_cache_read_tokens: 0,
            total_sessions: 0,
            by_model: vec![],
            by_date: vec![],
            by_project: vec![],
        });
    }

    // Calculate aggregated stats from filtered entries
    let mut total_cost = 0.0;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    let mut total_cache_creation_tokens = 0u64;
    let mut total_cache_read_tokens = 0u64;

    let mut model_stats: HashMap<String, ModelUsage> = HashMap::new();
    let mut daily_stats: HashMap<String, DailyUsage> = HashMap::new();
    let mut project_stats: HashMap<String, ProjectUsage> = HashMap::new();

    for entry in &filtered_entries {
        // Update totals
        total_cost += entry.cost;
        total_input_tokens += entry.input_tokens;
        total_output_tokens += entry.output_tokens;
        total_cache_creation_tokens += entry.cache_creation_tokens;
        total_cache_read_tokens += entry.cache_read_tokens;

        // Update model stats
        let model_stat = model_stats
            .entry(entry.model.clone())
            .or_insert(ModelUsage {
                model: entry.model.clone(),
                total_cost: 0.0,
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                session_count: 0,
            });
        model_stat.total_cost += entry.cost;
        model_stat.input_tokens += entry.input_tokens;
        model_stat.output_tokens += entry.output_tokens;
        model_stat.cache_creation_tokens += entry.cache_creation_tokens;
        model_stat.cache_read_tokens += entry.cache_read_tokens;
        model_stat.total_tokens = model_stat.input_tokens + model_stat.output_tokens;
        model_stat.session_count += 1;

        // Update daily stats
        // 🚀 修复时区问题：使用本地日期而不是 UTC 日期
        let date = if let Ok(dt) = DateTime::parse_from_rfc3339(&entry.timestamp) {
            // 转换为本地时间后提取日期
            dt.with_timezone(&Local).format("%Y-%m-%d").to_string()
        } else {
            // 降级：直接从字符串提取（可能不准确）
            entry.timestamp
                .split('T')
                .next()
                .unwrap_or(&entry.timestamp)
                .to_string()
        };
        let daily_stat = daily_stats.entry(date.clone()).or_insert(DailyUsage {
            date,
            total_cost: 0.0,
            total_tokens: 0,
            models_used: vec![],
        });
        daily_stat.total_cost += entry.cost;
        daily_stat.total_tokens += entry.input_tokens
            + entry.output_tokens
            + entry.cache_creation_tokens
            + entry.cache_read_tokens;
        if !daily_stat.models_used.contains(&entry.model) {
            daily_stat.models_used.push(entry.model.clone());
        }

        // Update project stats
        let project_stat =
            project_stats
                .entry(entry.project_path.clone())
                .or_insert(ProjectUsage {
                    project_path: entry.project_path.clone(),
                    project_name: entry
                        .project_path
                        .split('/')
                        .last()
                        .unwrap_or(&entry.project_path)
                        .to_string(),
                    total_cost: 0.0,
                    total_tokens: 0,
                    session_count: 0,
                    last_used: entry.timestamp.clone(),
                });
        project_stat.total_cost += entry.cost;
        project_stat.total_tokens += entry.input_tokens
            + entry.output_tokens
            + entry.cache_creation_tokens
            + entry.cache_read_tokens;
        project_stat.session_count += 1;
        if entry.timestamp > project_stat.last_used {
            project_stat.last_used = entry.timestamp.clone();
        }
    }

    let unique_sessions: HashSet<_> = filtered_entries.iter().map(|e| &e.session_id).collect();

    Ok(UsageStats {
        total_cost,
        total_tokens: total_input_tokens
            + total_output_tokens
            + total_cache_creation_tokens
            + total_cache_read_tokens,
        total_input_tokens,
        total_output_tokens,
        total_cache_creation_tokens,
        total_cache_read_tokens,
        total_sessions: unique_sessions.len() as u64,
        by_model: model_stats.into_values().collect(),
        by_date: daily_stats.into_values().collect(),
        by_project: project_stats.into_values().collect(),
    })
}

#[command]
pub async fn get_usage_by_date_range(start_date: String, end_date: String) -> Result<UsageStats, String> {
    async_runtime::spawn_blocking(move || get_usage_by_date_range_sync(start_date, end_date))
        .await
        .map_err(|e| format!("获取使用统计失败: {}", e))?
}

fn get_session_stats_sync(
    since: Option<String>,
    until: Option<String>,
    order: Option<String>,
) -> Result<Vec<ProjectUsage>, String> {
    let claude_path = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude");

    let all_entries = get_all_usage_entries(&claude_path);

    // Filter by date range if provided
    // 🚀 修复时区问题：转换为本地时区后进行日期比较
    let filtered_entries: Vec<_> = all_entries
        .into_iter()
        .filter(|e| {
            if let (Some(since_str), Some(until_str)) = (&since, &until) {
                if let (Ok(since_date), Ok(until_date)) = (
                    NaiveDate::parse_from_str(since_str, "%Y%m%d"),
                    NaiveDate::parse_from_str(until_str, "%Y%m%d"),
                ) {
                    if let Ok(dt) = DateTime::parse_from_rfc3339(&e.timestamp) {
                        // 先转换为本地时区，再提取日期进行比较
                        let date = dt.with_timezone(&Local).date_naive();
                        return date >= since_date && date <= until_date;
                    }
                }
            }
            true
        })
        .collect();

    // Group by project
    let mut project_stats: HashMap<String, ProjectUsage> = HashMap::new();
    for entry in filtered_entries {
        let project_stat =
            project_stats
                .entry(entry.project_path.clone())
                .or_insert(ProjectUsage {
                    project_path: entry.project_path.clone(),
                    project_name: entry
                        .project_path
                        .split('/')
                        .last()
                        .unwrap_or(&entry.project_path)
                        .to_string(),
                    total_cost: 0.0,
                    total_tokens: 0,
                    session_count: 0,
                    last_used: entry.timestamp.clone(),
                });
        project_stat.total_cost += entry.cost;
        project_stat.total_tokens += entry.input_tokens
            + entry.output_tokens
            + entry.cache_creation_tokens
            + entry.cache_read_tokens;
        project_stat.session_count += 1;
        if entry.timestamp > project_stat.last_used {
            project_stat.last_used = entry.timestamp.clone();
        }
    }

    let mut by_session: Vec<ProjectUsage> = project_stats.into_values().collect();

    // Sort by order
    let order_str = order.unwrap_or_else(|| "desc".to_string());
    if order_str == "asc" {
        by_session.sort_by(|a, b| a.total_cost.partial_cmp(&b.total_cost).unwrap());
    } else {
        by_session.sort_by(|a, b| b.total_cost.partial_cmp(&a.total_cost).unwrap());
    }

    Ok(by_session)
}

#[command]
pub async fn get_session_stats(
    since: Option<String>,
    until: Option<String>,
    order: Option<String>,
) -> Result<Vec<ProjectUsage>, String> {
    async_runtime::spawn_blocking(move || get_session_stats_sync(since, until, order))
        .await
        .map_err(|e| format!("获取会话统计失败: {}", e))?
}

// ============================================================================
// Codex Usage Data Parsing
// ============================================================================

/// Codex model pricing (OpenAI GPT-4o pricing)
/// Prices per million tokens
#[derive(Debug, Clone, Copy)]
struct CodexPricing {
    input: f64,
    output: f64,
    cached_input: f64,
}

impl CodexPricing {
    const fn default() -> Self {
        CodexPricing {
            input: 2.50,       // $2.50 per 1M input tokens
            output: 10.00,     // $10.00 per 1M output tokens
            cached_input: 1.25, // $1.25 per 1M cached input tokens
        }
    }
}

/// Calculate cost for Codex usage
fn calculate_codex_cost(input_tokens: u64, output_tokens: u64, cached_tokens: u64) -> f64 {
    let pricing = CodexPricing::default();
    let input = input_tokens as f64;
    let output = output_tokens as f64;
    let cached = cached_tokens as f64;
    
    (input * pricing.input / 1_000_000.0)
        + (output * pricing.output / 1_000_000.0)
        + (cached * pricing.cached_input / 1_000_000.0)
}

/// Codex JSONL entry structure (for event_msg with token_count)
#[derive(Debug, Deserialize)]
struct CodexJsonlEntry {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    timestamp: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Debug, Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    payload_type: Option<String>,
    info: Option<CodexTokenInfo>,
}

#[derive(Debug, Deserialize)]
struct CodexTokenInfo {
    total_token_usage: Option<CodexUsageData>,
    last_token_usage: Option<CodexUsageData>,
}

#[derive(Debug, Deserialize)]
struct CodexUsageData {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
}

/// Codex session meta entry (for extracting cwd and model)
#[derive(Debug, Deserialize)]
struct CodexSessionMeta {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    timestamp: Option<String>,
    payload: Option<CodexSessionMetaPayload>,
}

#[derive(Debug, Deserialize)]
struct CodexSessionMetaPayload {
    id: Option<String>,
    cwd: Option<String>,
    model_provider: Option<String>,
}

/// Get Codex usage entries from ~/.codex/sessions/
/// Codex stores token usage in event_msg entries with type="token_count"
fn get_codex_usage_entries() -> Vec<UsageEntryWithEngine> {
    let mut entries = Vec::new();
    
    // Get Codex sessions directory
    let sessions_dir = match get_codex_sessions_dir() {
        Ok(dir) => {
            log::info!("[Codex Usage] Sessions directory: {:?}", dir);
            dir
        },
        Err(e) => {
            log::warn!("[Codex Usage] Failed to get sessions directory: {}", e);
            return entries;
        }
    };
    
    if !sessions_dir.exists() {
        log::warn!("[Codex Usage] Sessions directory does not exist: {:?}", sessions_dir);
        return entries;
    }
    
    log::info!("[Codex Usage] Found sessions directory, scanning for JSONL files...");
    
    // Walk through all JSONL files
    for file_entry in walkdir::WalkDir::new(&sessions_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
    {
        let path = file_entry.path();
        // Extract session ID from filename (e.g., rollout-2025-12-04T14-04-29-019ae7f6-...)
        let session_id = path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        
        if let Ok(content) = fs::read_to_string(path) {
            let mut project_path = String::new();
            let mut model_provider = String::from("openai");
            let mut last_total_input: u64 = 0;
            let mut last_total_output: u64 = 0;
            let mut last_timestamp = String::new();
            
            for line in content.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                
                // Parse as generic JSON first to check type
                if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(line) {
                    let entry_type = json_value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    
                    // Extract session metadata (cwd, model_provider)
                    if entry_type == "session_meta" {
                        if let Some(payload) = json_value.get("payload") {
                            if let Some(cwd) = payload.get("cwd").and_then(|v| v.as_str()) {
                                project_path = cwd.to_string();
                            }
                            if let Some(provider) = payload.get("model_provider").and_then(|v| v.as_str()) {
                                model_provider = provider.to_string();
                            }
                        }
                    }
                    
                    // Extract token usage from event_msg with type="token_count"
                    if entry_type == "event_msg" {
                        if let Some(payload) = json_value.get("payload") {
                            let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if payload_type == "token_count" {
                                if let Some(info) = payload.get("info") {
                                    // Use total_token_usage for cumulative stats
                                    if let Some(total_usage) = info.get("total_token_usage") {
                                        let input_tokens = total_usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                        let output_tokens = total_usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                        let cached_tokens = total_usage.get("cached_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                        
                                        // Update last known totals
                                        last_total_input = input_tokens;
                                        last_total_output = output_tokens;
                                        if let Some(ts) = json_value.get("timestamp").and_then(|v| v.as_str()) {
                                            last_timestamp = ts.to_string();
                                        }
                                        
                                        // We'll create one entry per session with the final totals
                                        // So we just track the latest values here
                                        let _ = cached_tokens; // Will use in final entry
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            // Create one entry per session file with the final token totals
            if last_total_input > 0 || last_total_output > 0 {
                let cost = calculate_codex_cost(last_total_input, last_total_output, 0);
                let model = format!("gpt-5.1-{}", model_provider); // e.g., gpt-5.1-openai
                
                entries.push(UsageEntryWithEngine {
                    engine: "codex".to_string(),
                    timestamp: if last_timestamp.is_empty() {
                        chrono::Utc::now().to_rfc3339()
                    } else {
                        last_timestamp
                    },
                    model,
                    input_tokens: last_total_input,
                    output_tokens: last_total_output,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 0,
                    cost,
                    session_id: session_id.clone(),
                    project_path: if project_path.is_empty() {
                        "unknown".to_string()
                    } else {
                        project_path
                    },
                });
            }
        }
    }
    
    log::info!("[Codex Usage] Found {} session entries", entries.len());
    entries
}

/// Get Codex sessions directory (wrapper for cross-platform support)
fn get_codex_sessions_dir() -> Result<PathBuf, String> {
    // Check for WSL mode on Windows
    #[cfg(target_os = "windows")]
    {
        use super::wsl_utils;
        let codex_config = wsl_utils::get_codex_config();
        log::info!("[Codex Sessions] Codex config: mode={:?}, wsl_distro={:?}", 
            codex_config.mode, codex_config.wsl_distro);
        
        let wsl_config = wsl_utils::get_wsl_config();
        log::info!("[Codex Sessions] WSL config: enabled={}, distro={:?}, codex_dir_unc={:?}", 
            wsl_config.enabled, wsl_config.distro, wsl_config.codex_dir_unc);
        
        if wsl_config.enabled {
            if let Some(sessions_dir) = wsl_utils::get_wsl_codex_sessions_dir() {
                log::info!("[Codex Sessions] Using WSL sessions directory: {:?}", sessions_dir);
                return Ok(sessions_dir);
            } else {
                log::warn!("[Codex Sessions] WSL enabled but sessions dir not found");
            }
        } else {
            // WSL config not enabled, but check if user explicitly configured WSL mode
            if codex_config.mode == wsl_utils::CodexMode::Wsl {
                log::warn!("[Codex Sessions] User configured WSL mode but WSL config not enabled, trying manual path...");
                // Try to build WSL path manually
                if let Some(distro) = &codex_config.wsl_distro {
                    let wsl_home = wsl_utils::get_wsl_home_dir(Some(distro));
                    if let Some(home) = wsl_home {
                        let wsl_sessions_path = format!("{}/.codex/sessions", home);
                        let unc_path = wsl_utils::build_wsl_unc_path(&wsl_sessions_path, distro);
                        log::info!("[Codex Sessions] Trying manual WSL path: {:?}", unc_path);
                        if unc_path.exists() {
                            return Ok(unc_path);
                        }
                    }
                }
            }
        }
    }
    
    // Native mode
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;
    let native_path = home_dir.join(".codex").join("sessions");
    log::info!("[Codex Sessions] Using native sessions directory: {:?}", native_path);
    Ok(native_path)
}

// ============================================================================
// Gemini Usage Data Parsing
// ============================================================================

/// Gemini model pricing
/// Prices per million tokens
#[derive(Debug, Clone, Copy)]
struct GeminiPricing {
    input: f64,
    output: f64,
}

impl GeminiPricing {
    fn for_model(model: &str) -> Self {
        let model_lower = model.to_lowercase();
        if model_lower.contains("flash") {
            // Gemini 2.5 Flash
            GeminiPricing {
                input: 0.075,
                output: 0.30,
            }
        } else {
            // Gemini 2.5 Pro (default)
            GeminiPricing {
                input: 1.25,
                output: 5.00,
            }
        }
    }
}

/// Calculate cost for Gemini usage
fn calculate_gemini_cost(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    let pricing = GeminiPricing::for_model(model);
    let input = input_tokens as f64;
    let output = output_tokens as f64;
    
    (input * pricing.input / 1_000_000.0) + (output * pricing.output / 1_000_000.0)
}

/// Gemini session file structure
#[derive(Debug, Deserialize)]
struct GeminiSessionFile {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    model: Option<String>,
    stats: Option<GeminiStatsData>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiStatsData {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

/// Get Gemini usage entries from ~/.gemini/tmp/
fn get_gemini_usage_entries() -> Vec<UsageEntryWithEngine> {
    let mut entries = Vec::new();
    
    let gemini_dir = match dirs::home_dir() {
        Some(home) => {
            let dir = home.join(".gemini").join("tmp");
            log::info!("[Gemini Usage] Checking directory: {:?}", dir);
            dir
        },
        None => {
            log::warn!("[Gemini Usage] Failed to get home directory");
            return entries;
        }
    };
    
    if !gemini_dir.exists() {
        log::warn!("[Gemini Usage] Tmp directory does not exist: {:?}", gemini_dir);
        return entries;
    }
    
    log::info!("[Gemini Usage] Found tmp directory, scanning for session files...");
    
    // Walk through all project directories
    if let Ok(project_dirs) = fs::read_dir(&gemini_dir) {
        for project_entry in project_dirs.flatten() {
            if !project_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            
            let chats_dir = project_entry.path().join("chats");
            if !chats_dir.exists() {
                continue;
            }
            
            // Read all session JSON files
            if let Ok(chat_files) = fs::read_dir(&chats_dir) {
                for chat_entry in chat_files.flatten() {
                    let path = chat_entry.path();
                    if path.extension().and_then(|s| s.to_str()) != Some("json") {
                        continue;
                    }
                    
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(session) = serde_json::from_str::<GeminiSessionFile>(&content) {
                            if let Some(stats) = session.stats {
                                let input_tokens = stats.input_tokens.unwrap_or(0);
                                let output_tokens = stats.output_tokens.unwrap_or(0);
                                
                                // Skip entries without meaningful usage
                                if input_tokens == 0 && output_tokens == 0 {
                                    continue;
                                }
                                
                                let model = session.model.unwrap_or_else(|| "gemini-2.5-pro".to_string());
                                let cost = calculate_gemini_cost(&model, input_tokens, output_tokens);
                                let session_id = session.session_id.unwrap_or_else(|| "unknown".to_string());
                                let timestamp = session.created_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                                
                                // Extract project path from directory name (it's a hash, so we use it as-is)
                                let project_hash = project_entry.file_name().to_string_lossy().to_string();
                                
                                entries.push(UsageEntryWithEngine {
                                    engine: "gemini".to_string(),
                                    timestamp,
                                    model,
                                    input_tokens,
                                    output_tokens,
                                    cache_creation_tokens: 0,
                                    cache_read_tokens: 0,
                                    cost,
                                    session_id,
                                    project_path: project_hash,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    
    entries
}

// ============================================================================
// Multi-Engine Usage Stats API
// ============================================================================

/// Get Claude usage entries with engine tag
fn get_claude_usage_entries_with_engine() -> Vec<UsageEntryWithEngine> {
    let claude_path = match dirs::home_dir() {
        Some(home) => home.join(".claude"),
        None => return Vec::new(),
    };
    
    get_all_usage_entries(&claude_path)
        .into_iter()
        .map(|e| UsageEntryWithEngine {
            engine: "claude".to_string(),
            timestamp: e.timestamp,
            model: e.model,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            cache_creation_tokens: e.cache_creation_tokens,
            cache_read_tokens: e.cache_read_tokens,
            cost: e.cost,
            session_id: e.session_id,
            project_path: e.project_path,
        })
        .collect()
}

/// Get multi-engine usage statistics
fn get_multi_engine_usage_stats_sync(
    engine: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<MultiEngineUsageStats, String> {
    let engine_filter = engine.as_deref().unwrap_or("all");
    log::info!("[Multi-Engine Usage] Getting stats for engine filter: {}", engine_filter);
    
    // Collect entries from all engines based on filter
    let mut all_entries: Vec<UsageEntryWithEngine> = Vec::new();
    
    if engine_filter == "all" || engine_filter == "claude" {
        let claude_entries = get_claude_usage_entries_with_engine();
        log::info!("[Multi-Engine Usage] Claude entries: {}", claude_entries.len());
        all_entries.extend(claude_entries);
    }
    if engine_filter == "all" || engine_filter == "codex" {
        let codex_entries = get_codex_usage_entries();
        log::info!("[Multi-Engine Usage] Codex entries: {}", codex_entries.len());
        all_entries.extend(codex_entries);
    }
    if engine_filter == "all" || engine_filter == "gemini" {
        let gemini_entries = get_gemini_usage_entries();
        log::info!("[Multi-Engine Usage] Gemini entries: {}", gemini_entries.len());
        all_entries.extend(gemini_entries);
    }
    
    log::info!("[Multi-Engine Usage] Total entries: {}", all_entries.len());
    
    // Filter by date range if provided
    let filtered_entries: Vec<_> = if let (Some(start), Some(end)) = (&start_date, &end_date) {
        let start_naive = NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|e| format!("Invalid start date: {}", e))?;
        let end_naive = NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .map_err(|e| format!("Invalid end date: {}", e))?;
        
        all_entries
            .into_iter()
            .filter(|e| {
                if let Ok(dt) = DateTime::parse_from_rfc3339(&e.timestamp) {
                    let date = dt.with_timezone(&Local).date_naive();
                    date >= start_naive && date <= end_naive
                } else {
                    false
                }
            })
            .collect()
    } else {
        all_entries
    };
    
    // Aggregate statistics
    let mut total_cost = 0.0;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    
    let mut engine_stats: HashMap<String, EngineUsage> = HashMap::new();
    let mut model_stats: HashMap<(String, String), ModelUsageWithEngine> = HashMap::new();
    let mut daily_stats: HashMap<(String, String), DailyUsageWithEngine> = HashMap::new();
    let mut project_stats: HashMap<(String, String), ProjectUsageWithEngine> = HashMap::new();
    
    for entry in &filtered_entries {
        total_cost += entry.cost;
        total_input_tokens += entry.input_tokens;
        total_output_tokens += entry.output_tokens;
        
        // Engine stats
        let engine_stat = engine_stats
            .entry(entry.engine.clone())
            .or_insert(EngineUsage {
                engine: entry.engine.clone(),
                total_cost: 0.0,
                total_tokens: 0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_sessions: 0,
            });
        engine_stat.total_cost += entry.cost;
        engine_stat.total_input_tokens += entry.input_tokens;
        engine_stat.total_output_tokens += entry.output_tokens;
        engine_stat.total_tokens = engine_stat.total_input_tokens + engine_stat.total_output_tokens;
        engine_stat.total_sessions += 1;
        
        // Model stats
        let model_key = (entry.engine.clone(), entry.model.clone());
        let model_stat = model_stats
            .entry(model_key)
            .or_insert(ModelUsageWithEngine {
                engine: entry.engine.clone(),
                model: entry.model.clone(),
                total_cost: 0.0,
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                session_count: 0,
            });
        model_stat.total_cost += entry.cost;
        model_stat.input_tokens += entry.input_tokens;
        model_stat.output_tokens += entry.output_tokens;
        model_stat.total_tokens = model_stat.input_tokens + model_stat.output_tokens;
        model_stat.session_count += 1;
        
        // Daily stats
        let date = if let Ok(dt) = DateTime::parse_from_rfc3339(&entry.timestamp) {
            dt.with_timezone(&Local).format("%Y-%m-%d").to_string()
        } else {
            entry.timestamp.split('T').next().unwrap_or(&entry.timestamp).to_string()
        };
        let daily_key = (date.clone(), entry.engine.clone());
        let daily_stat = daily_stats
            .entry(daily_key)
            .or_insert(DailyUsageWithEngine {
                date: date.clone(),
                engine: entry.engine.clone(),
                total_cost: 0.0,
                total_tokens: 0,
            });
        daily_stat.total_cost += entry.cost;
        daily_stat.total_tokens += entry.input_tokens + entry.output_tokens;
        
        // Project stats
        let project_key = (entry.engine.clone(), entry.project_path.clone());
        let project_stat = project_stats
            .entry(project_key)
            .or_insert(ProjectUsageWithEngine {
                engine: entry.engine.clone(),
                project_path: entry.project_path.clone(),
                project_name: entry.project_path.split('/').last()
                    .or_else(|| entry.project_path.split('\\').last())
                    .unwrap_or(&entry.project_path)
                    .to_string(),
                total_cost: 0.0,
                total_tokens: 0,
                session_count: 0,
                last_used: entry.timestamp.clone(),
            });
        project_stat.total_cost += entry.cost;
        project_stat.total_tokens += entry.input_tokens + entry.output_tokens;
        project_stat.session_count += 1;
        if entry.timestamp > project_stat.last_used {
            project_stat.last_used = entry.timestamp.clone();
        }
    }
    
    // Convert to vectors and sort
    let mut by_engine: Vec<EngineUsage> = engine_stats.into_values().collect();
    by_engine.sort_by(|a, b| b.total_cost.partial_cmp(&a.total_cost).unwrap_or(std::cmp::Ordering::Equal));
    
    let mut by_model: Vec<ModelUsageWithEngine> = model_stats.into_values().collect();
    by_model.sort_by(|a, b| b.total_cost.partial_cmp(&a.total_cost).unwrap_or(std::cmp::Ordering::Equal));
    
    let mut by_date: Vec<DailyUsageWithEngine> = daily_stats.into_values().collect();
    by_date.sort_by(|a, b| b.date.cmp(&a.date));
    
    let mut by_project: Vec<ProjectUsageWithEngine> = project_stats.into_values().collect();
    by_project.sort_by(|a, b| b.total_cost.partial_cmp(&a.total_cost).unwrap_or(std::cmp::Ordering::Equal));
    
    let unique_sessions: HashSet<_> = filtered_entries.iter().map(|e| &e.session_id).collect();
    
    Ok(MultiEngineUsageStats {
        total_cost,
        total_tokens: total_input_tokens + total_output_tokens,
        total_input_tokens,
        total_output_tokens,
        total_sessions: unique_sessions.len() as u64,
        by_engine,
        by_model,
        by_date,
        by_project,
    })
}

#[command]
pub async fn get_multi_engine_usage_stats(
    engine: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<MultiEngineUsageStats, String> {
    async_runtime::spawn_blocking(move || get_multi_engine_usage_stats_sync(engine, start_date, end_date))
        .await
        .map_err(|e| format!("获取使用统计失败: {}", e))?
}

// ============================================================================
// Codex Rate Limits API
// ============================================================================

/// Codex rate limit information
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexRateLimits {
    /// Primary rate limit (5-hour window)
    pub primary: Option<RateLimitInfo>,
    /// Secondary rate limit (weekly window)
    pub secondary: Option<RateLimitInfo>,
    /// Credits information
    pub credits: Option<CreditsInfo>,
}

/// Rate limit details
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RateLimitInfo {
    /// Percentage of rate limit used (0-100)
    pub used_percent: f64,
    /// Percentage of rate limit remaining (0-100)
    pub remaining_percent: f64,
    /// Window duration in minutes
    pub window_minutes: u64,
    /// Unix timestamp when the rate limit resets
    pub resets_at: u64,
    /// Human-readable reset time
    pub resets_at_formatted: String,
}

/// Credits information
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CreditsInfo {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<f64>,
}

/// Get Codex rate limits from the latest session file
#[command]
pub fn get_codex_rate_limits() -> Result<CodexRateLimits, String> {
    log::info!("[Codex Rate Limits] Getting rate limits...");
    
    // Get Codex sessions directory
    let sessions_dir = get_codex_sessions_dir()?;
    
    if !sessions_dir.exists() {
        log::warn!("[Codex Rate Limits] Sessions directory does not exist: {:?}", sessions_dir);
        return Ok(CodexRateLimits {
            primary: None,
            secondary: None,
            credits: None,
        });
    }
    
    // Find the most recent JSONL file
    let mut latest_file: Option<(PathBuf, std::time::SystemTime)> = None;
    
    for entry in walkdir::WalkDir::new(&sessions_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
    {
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                if latest_file.is_none() || modified > latest_file.as_ref().unwrap().1 {
                    latest_file = Some((entry.path().to_path_buf(), modified));
                }
            }
        }
    }
    
    let latest_path = match latest_file {
        Some((path, _)) => path,
        None => {
            log::warn!("[Codex Rate Limits] No JSONL files found");
            return Ok(CodexRateLimits {
                primary: None,
                secondary: None,
                credits: None,
            });
        }
    };
    
    log::info!("[Codex Rate Limits] Reading from: {:?}", latest_path);
    
    // Read the file and find the latest rate_limits entry
    let content = fs::read_to_string(&latest_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    let mut latest_rate_limits: Option<serde_json::Value> = None;
    
    for line in content.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(line) {
            // Check if this entry has rate_limits
            if let Some(payload) = json_value.get("payload") {
                if let Some(rate_limits) = payload.get("rate_limits") {
                    latest_rate_limits = Some(rate_limits.clone());
                    break;
                }
            }
        }
    }
    
    let rate_limits_json = match latest_rate_limits {
        Some(rl) => rl,
        None => {
            log::warn!("[Codex Rate Limits] No rate_limits found in session file");
            return Ok(CodexRateLimits {
                primary: None,
                secondary: None,
                credits: None,
            });
        }
    };
    
    // Parse primary rate limit
    let primary = rate_limits_json.get("primary").and_then(|p| {
        let used_percent = p.get("used_percent")?.as_f64()?;
        let window_minutes = p.get("window_minutes")?.as_u64()?;
        let resets_at = p.get("resets_at")?.as_u64()?;
        
        // Format reset time
        let resets_at_formatted = chrono::DateTime::from_timestamp(resets_at as i64, 0)
            .map(|dt| dt.with_timezone(&Local).format("%H:%M").to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        
        Some(RateLimitInfo {
            used_percent,
            remaining_percent: 100.0 - used_percent,
            window_minutes,
            resets_at,
            resets_at_formatted,
        })
    });
    
    // Parse secondary rate limit
    let secondary = rate_limits_json.get("secondary").and_then(|s| {
        let used_percent = s.get("used_percent")?.as_f64()?;
        let window_minutes = s.get("window_minutes")?.as_u64()?;
        let resets_at = s.get("resets_at")?.as_u64()?;
        
        // Format reset time (for weekly, show date)
        let resets_at_formatted = chrono::DateTime::from_timestamp(resets_at as i64, 0)
            .map(|dt| dt.with_timezone(&Local).format("%m月%d日").to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        
        Some(RateLimitInfo {
            used_percent,
            remaining_percent: 100.0 - used_percent,
            window_minutes,
            resets_at,
            resets_at_formatted,
        })
    });
    
    // Parse credits
    let credits = rate_limits_json.get("credits").and_then(|c| {
        Some(CreditsInfo {
            has_credits: c.get("has_credits")?.as_bool()?,
            unlimited: c.get("unlimited")?.as_bool()?,
            balance: c.get("balance").and_then(|b| b.as_f64()),
        })
    });
    
    log::info!("[Codex Rate Limits] Primary: {:?}, Secondary: {:?}", primary, secondary);
    
    Ok(CodexRateLimits {
        primary,
        secondary,
        credits,
    })
}
