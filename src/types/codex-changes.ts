/**
 * Codex 代码变更追踪类型定义
 *
 * 与后端 change_tracker.rs 保持同步
 */

/**
 * 变更类型
 */
export type ChangeType = 'create' | 'update' | 'delete';

/**
 * 变更来源
 */
export type ChangeSource = 'tool' | 'command';

/**
 * 单个文件变更记录
 */
export interface CodexFileChange {
  /** 唯一标识 */
  id: string;
  /** 会话 ID */
  session_id: string;
  /** 对应的 prompt 索引 */
  prompt_index: number;
  /** ISO 时间戳 */
  timestamp: string;
  /** 文件路径 */
  file_path: string;
  /** 变更类型 */
  change_type: ChangeType;
  /** 变更来源 */
  source: ChangeSource;

  /** 修改前内容（update/delete） */
  old_content?: string;
  /** 修改后内容（create/update） */
  new_content?: string;

  /** unified diff 格式 */
  unified_diff?: string;
  /** 添加的行数 */
  lines_added?: number;
  /** 删除的行数 */
  lines_removed?: number;

  /** 触发变更的工具名 */
  tool_name?: string;
  /** 工具调用 ID */
  tool_call_id?: string;
  /** 如果是命令执行，记录命令 */
  command?: string;
}

/**
 * 会话变更记录
 */
export interface CodexChangeRecords {
  /** 会话 ID */
  session_id: string;
  /** 项目路径 */
  project_path: string;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
  /** 变更列表 */
  changes: CodexFileChange[];
}

/**
 * 按 prompt 分组的变更记录
 */
export interface GroupedChanges {
  /** prompt 索引 */
  promptIndex: number;
  /** prompt 时间戳（使用第一个变更的时间戳） */
  timestamp: string;
  /** prompt 结束时间戳（使用最后一个变更的时间戳，用于排序） */
  endTimestamp: string;
  /** 该 prompt 产生的所有变更 */
  changes: CodexFileChange[];
  /** 统计信息 */
  stats: {
    totalFiles: number;
    created: number;
    updated: number;
    deleted: number;
    linesAdded: number;
    linesRemoved: number;
  };
}

/**
 * 将变更列表按 prompt 索引分组
 */
export function groupChangesByPrompt(changes: CodexFileChange[]): GroupedChanges[] {
  const grouped = new Map<number, CodexFileChange[]>();

  // 按 prompt_index 分组
  for (const change of changes) {
    const key = change.prompt_index;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(change);
  }

  // 转换为数组并计算统计信息
  const result: GroupedChanges[] = [];

  for (const [promptIndex, promptChanges] of grouped.entries()) {
    // 按时间排序
    promptChanges.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const startTimestamp = promptChanges[0]?.timestamp || '';
    const endTimestamp = promptChanges[promptChanges.length - 1]?.timestamp || startTimestamp;

    // Stats are based on "latest per file" to avoid double-counting when
    // the same file is recorded multiple times within one prompt.
    const latestByFile = new Map<string, CodexFileChange>();
    for (const change of promptChanges) {
      const key = (change.file_path || '').replace(/\\/g, '/');
      latestByFile.set(key, change);
    }
    const uniqueChanges = Array.from(latestByFile.values()).sort((a, b) =>
      a.file_path.localeCompare(b.file_path)
    );

    const stats = {
      totalFiles: uniqueChanges.length,
      created: uniqueChanges.filter(c => c.change_type === 'create').length,
      updated: uniqueChanges.filter(c => c.change_type === 'update').length,
      deleted: uniqueChanges.filter(c => c.change_type === 'delete').length,
      linesAdded: uniqueChanges.reduce((sum, c) => sum + (c.lines_added || 0), 0),
      linesRemoved: uniqueChanges.reduce((sum, c) => sum + (c.lines_removed || 0), 0),
    };

    result.push({
      promptIndex,
      // Display start time (closer to "prompt sent"). Ordering uses endTimestamp below.
      timestamp: startTimestamp,
      endTimestamp,
      // Only show the latest change per file to match "files changed" semantics.
      changes: uniqueChanges,
      stats,
    });
  }

  // Sort by timestamp (desc) for a more "latest-first" UX.
  // Prompt indices can become non-monotonic when sessions are replayed / truncated.
  result.sort((a, b) => {
    if (a.endTimestamp && b.endTimestamp) {
      const byTime = b.endTimestamp.localeCompare(a.endTimestamp);
      if (byTime !== 0) return byTime;
    }

    // Fall back to displayed timestamp, then prompt index.
    if (a.timestamp && b.timestamp) {
      const byStart = b.timestamp.localeCompare(a.timestamp);
      if (byStart !== 0) return byStart;
    }

    return b.promptIndex - a.promptIndex;
  });

  return result;
}

/**
 * 获取文件扩展名对应的图标
 */
export function getFileIcon(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();

  const iconMap: Record<string, string> = {
    // 编程语言
    ts: '📘',
    tsx: '📘',
    js: '📒',
    jsx: '📒',
    rs: '🦀',
    py: '🐍',
    go: '🐹',
    java: '☕',
    kt: '🟣',
    swift: '🍎',
    c: '🔵',
    cpp: '🔵',
    h: '🔵',
    cs: '🟢',

    // 配置文件
    json: '📋',
    yaml: '📋',
    yml: '📋',
    toml: '📋',
    xml: '📋',

    // 文档
    md: '📝',
    txt: '📄',

    // 样式
    css: '🎨',
    scss: '🎨',
    less: '🎨',

    // 其他
    html: '🌐',
    sql: '🗃️',
    sh: '🖥️',
    bat: '🖥️',
  };

  return iconMap[ext || ''] || '📄';
}

/**
 * 获取变更类型对应的图标
 */
export function getChangeTypeIcon(changeType: ChangeType): string {
  switch (changeType) {
    case 'create':
      return '➕';
    case 'update':
      return '✏️';
    case 'delete':
      return '🗑️';
    default:
      return '📝';
  }
}

/**
 * 格式化文件路径（只显示文件名）
 */
export function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timestamp;
  }
}
