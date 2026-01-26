/**
 * Codex 工作过程消息组（折叠/展开）
 *
 * 用于将 Codex 的高频“工具调用 / 思考过程 / 运行元信息”聚合展示，
 * 避免在会话中产生大量气泡占用空间。
 *
 * 设计参考：官方/插件式 “Finished working / 可折叠展开” 交互。
 */

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, ChevronRight, CheckCircle2, Loader2, AlertCircle, FileText, BrainCircuit, Wrench, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityGroup } from "@/lib/subagentGrouping";
import type { ClaudeStreamMessage } from "@/types/claude";
import { ToolCallsGroup } from "./ToolCallsGroup";
import { FilePathLink } from "@/components/common/FilePathLink";
import { parseFileReference } from "@/lib/fileLinkify";
import { useToolResults } from "@/hooks/useToolResults";
import { ChangedFilesSummary, type ChangedFileEntry } from "./ChangedFilesSummary";
import * as Diff from "diff";
import { api } from "@/lib/api";
import { CodexChangeDetailPage } from "@/components/codex/CodexChangeDetailPage";
import type { CodexFileChange } from "@/types/codex-changes";

interface ActivityMessageGroupProps {
  group: ActivityGroup;
  className?: string;
  onLinkDetected?: (url: string) => void;
  projectPath?: string;
  isStreaming?: boolean;
  promptIndex?: number;
  sessionId?: string;
}

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, any>;
};

function extractToolUseBlocks(message: ClaudeStreamMessage): ToolUseBlock[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c: any) => c?.type === "tool_use" && c?.id && c?.name) as ToolUseBlock[];
}

function hasToolUse(message: ClaudeStreamMessage): boolean {
  return extractToolUseBlocks(message).length > 0;
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function extractFilePathFromTool(tool: ToolUseBlock): string | null {
  const input = tool.input || {};
  const name = (tool.name || "").toLowerCase();

  if (name === "read") {
    return input.file_path || input.path || null;
  }
  if (name === "edit" || name === "multiedit") {
    return input.file_path || null;
  }
  if (name === "write") {
    return input.file_path || input.path || null;
  }

  // 兼容部分 Codex/Gemini 变体
  if (input.file_path) return input.file_path;
  if (input.path && typeof input.path === "string" && input.path.includes(".")) return input.path;
  return null;
}

function extractFilePathsFromCommand(command?: string): string[] {
  if (!command) return [];
  const matches = new Set<string>();

  // 匹配形如:
  // - src/a.tsx
  // - C:\repo\src\a.tsx
  // - src/a.tsx:12:3
  // - src/a.tsx#L10C2
  const candidateRe =
    /(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,8}(?:(?:#L\d+(?:C\d+)?)|(?::\d+(?::\d+)?))?/g;

  const candidates = command.match(candidateRe) || [];
  candidates.forEach((c) => {
    const ref = parseFileReference(c);
    if (ref?.filePath) {
      matches.add(ref.filePath);
    }
  });

  return Array.from(matches);
}

function extractFilePathsFromOutput(output: string): string[] {
  if (!output) return [];
  const matches = new Set<string>();
  const lines = output.split('\n').slice(0, 200); // 避免过大输出

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 格式: path:line:content
    const match = trimmed.match(/^(.+?):\d+:(.*)$/);
    if (match) {
      const ref = parseFileReference(match[1].trim());
      if (ref?.filePath) {
        matches.add(ref.filePath);
      }
      continue;
    }

    // 仅文件路径
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      const possible = trimmed.split(/\s+/)[0];
      const ref = parseFileReference(possible);
      if (ref?.filePath) {
        matches.add(ref.filePath);
      }
    }
  }

  return Array.from(matches);
}

function extractResultText(result: any): string {
  if (!result) return '';
  const content = result.content ?? result;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

export const ActivityMessageGroup: React.FC<ActivityMessageGroupProps> = ({
  group,
  className,
  onLinkDetected,
  projectPath,
  isStreaming = false,
  promptIndex,
  sessionId,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(isStreaming);
  const [openStepKey, setOpenStepKey] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [initialChange, setInitialChange] = useState<CodexFileChange | null>(null);
  const [detailDisableFetch, setDetailDisableFetch] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // 流式输出时自动展开，方便实时查看进度
  useEffect(() => {
    if (isStreaming) {
      setIsExpanded(true);
    }
  }, [isStreaming]);

  const toolUseBlocks = useMemo(() => {
    const blocks: ToolUseBlock[] = [];
    group.messages.forEach((m) => {
      blocks.push(...extractToolUseBlocks(m));
    });
    return blocks;
  }, [group.messages]);

  const { getStatusById, getResultById } = useToolResults();

  const stats = useMemo(() => {
    let pending = 0;
    let success = 0;
    let error = 0;

    toolUseBlocks.forEach((t) => {
      const status = getStatusById(t.id);
      if (status === "pending") pending++;
      else if (status === "error") error++;
      else success++;
    });

    return { pending, success, error, total: toolUseBlocks.length };
  }, [toolUseBlocks, getStatusById]);

  const fileSummary = useMemo(() => {
    const filePaths: string[] = [];
    const readFiles = new Set<string>();
    const editedFiles = new Set<string>();
    const writtenFiles = new Set<string>();

    const normalizeFilePath = (value: string): string => {
      if (!value) return value;

      const norm = value.replace(/\\/g, "/");
      const base = (projectPath || "").replace(/\\/g, "/").replace(/\/+$/, "");

      const isWindowsBase = /^[A-Z]:/i.test(base);
      const toHostPath = (p: string): string => {
        if (!p) return p;
        const np = p.replace(/\\/g, "/");
        if (!isWindowsBase) return np;
        const m = np.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
        if (!m) return np;
        return `${m[1].toUpperCase()}:/${m[2]}`;
      };

      const fp = toHostPath(norm);
      const baseHost = toHostPath(base);

      if (baseHost) {
        const fpLower = fp.toLowerCase();
        const baseLower = baseHost.toLowerCase();
        if (fpLower === baseLower) return "";
        if (fpLower.startsWith(`${baseLower}/`)) {
          return fp.slice(baseHost.length + 1);
        }
      }

      return fp.replace(/^\.\//, "");
    };

    toolUseBlocks.forEach((tool) => {
      const fp = extractFilePathFromTool(tool);
      if (!fp) return;

      const normalized = normalizeFilePath(fp);
      filePaths.push(normalized);

      const name = (tool.name || "").toLowerCase();
      if (name === "read") readFiles.add(normalized);
      else if (name === "edit" || name === "multiedit") editedFiles.add(normalized);
      else if (name === "write") writtenFiles.add(normalized);
    });

    // 补充：bash 命令中的文件路径（如 sed/rg）
    toolUseBlocks.forEach((tool) => {
      const name = (tool.name || "").toLowerCase();
      if (name !== "bash") return;

      const command = tool.input?.command || tool.input?.cmd || '';
      const commandFiles = extractFilePathsFromCommand(command);
      commandFiles.forEach((fp) => {
        const normalized = normalizeFilePath(fp);
        filePaths.push(normalized);
        readFiles.add(normalized);
      });

      const resultEntry = getResultById(tool.id);
      if (resultEntry && resultEntry.content) {
        const outputText = extractResultText(resultEntry);
        const outputFiles = extractFilePathsFromOutput(outputText);
        outputFiles.forEach((fp) => {
          const normalized = normalizeFilePath(fp);
          filePaths.push(normalized);
          readFiles.add(normalized);
        });
      }
    });

    // Dedup strategy:
    // - normalize paths first (done above)
    // - if we have both "Foo.java" and "src/.../Foo.java", prefer the detailed path
    const detailedNames = new Set<string>();
    filePaths.forEach((fp) => {
      if (fp.includes('/') || fp.includes('\\')) {
        detailedNames.add(getFileName(fp));
      }
    });

    const uniqueFiles: string[] = [];
    const seen = new Set<string>();
    filePaths.forEach((fp) => {
      const isBare = !fp.includes('/') && !fp.includes('\\');
      if (isBare && detailedNames.has(getFileName(fp))) return;
      if (seen.has(fp)) return;
      seen.add(fp);
      uniqueFiles.push(fp);
    });
    const touchedFiles = new Set([...readFiles, ...editedFiles, ...writtenFiles]);
    const touchedDetailedNames = new Set<string>();
    touchedFiles.forEach((fp) => {
      if (fp.includes('/') || fp.includes('\\')) {
        touchedDetailedNames.add(getFileName(fp));
      }
    });

    let touchedCount = 0;
    touchedFiles.forEach((fp) => {
      const isBare = !fp.includes('/') && !fp.includes('\\');
      if (isBare && touchedDetailedNames.has(getFileName(fp))) return;
      touchedCount += 1;
    });

    return {
      uniqueFiles,
      readCount: readFiles.size,
      editCount: editedFiles.size,
      writeCount: writtenFiles.size,
      touchedCount,
    };
  }, [toolUseBlocks, getResultById, projectPath]);

  const changedFiles = useMemo((): ChangedFileEntry[] => {
    const acc = new Map<string, { added: number; removed: number }>();

    const normalizeFilePath = (value: string): string => {
      if (!value) return value;

      const norm = value.replace(/\\/g, "/");
      const base = (projectPath || "").replace(/\\/g, "/").replace(/\/+$/, "");

      const isWindowsBase = /^[A-Z]:/i.test(base);
      const toHostPath = (p: string): string => {
        if (!p) return p;
        const np = p.replace(/\\/g, "/");
        if (!isWindowsBase) return np;
        const m = np.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
        if (!m) return np;
        return `${m[1].toUpperCase()}:/${m[2]}`;
      };

      const fp = toHostPath(norm);
      const baseHost = toHostPath(base);

      if (baseHost) {
        const fpLower = fp.toLowerCase();
        const baseLower = baseHost.toLowerCase();
        if (fpLower === baseLower) return "";
        if (fpLower.startsWith(`${baseLower}/`)) {
          return fp.slice(baseHost.length + 1);
        }
      }

      return fp.replace(/^\.\//, "");
    };

    const add = (filePath: string, added: number, removed: number) => {
      const key = normalizeFilePath(filePath).trim();
      if (!key) return;
      const prev = acc.get(key) || { added: 0, removed: 0 };
      prev.added += added;
      prev.removed += removed;
      acc.set(key, prev);
    };

    toolUseBlocks.forEach((tool) => {
      const name = (tool.name || "").toLowerCase();
      const input = tool.input || {};
      const fp = extractFilePathFromTool(tool) || input.file_path || input.path || '';
      if (!fp) return;

      if (name === "edit") {
        const oldStr = String(input.old_string || "");
        const newStr = String(input.new_string || "");

        const diffResult = Diff.diffLines(oldStr, newStr, {
          newlineIsToken: true,
          ignoreWhitespace: false,
        });

        const stats = diffResult.reduce(
          (s, part: any) => {
            if (part.added) s.added += part.count || 0;
            if (part.removed) s.removed += part.count || 0;
            return s;
          },
          { added: 0, removed: 0 }
        );

        add(fp, stats.added, stats.removed);
        return;
      }

      if (name === "multiedit") {
        const edits = Array.isArray(input.edits) ? input.edits : [];
        let added = 0;
        let removed = 0;

        edits.forEach((e: any) => {
          const oldStr = String(e?.old_string || "");
          const newStr = String(e?.new_string || "");
          const diffResult = Diff.diffLines(oldStr, newStr, {
            newlineIsToken: true,
            ignoreWhitespace: false,
          });
          diffResult.forEach((part: any) => {
            if (part.added) added += part.count || 0;
            if (part.removed) removed += part.count || 0;
          });
        });

        add(fp, added, removed);
        return;
      }

      if (name === "write") {
        const content = String(input.content || "");
        add(fp, countLines(content), 0);
        return;
      }
    });

    return Array.from(acc.entries()).map(([filePath, s]) => ({
      filePath,
      added: s.added,
      removed: s.removed,
    }));
  }, [toolUseBlocks, projectPath]);

  const normalizeForCompare = useCallback((value: string): string => {
    if (!value) return value;
    const v = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    const isWindows = /^[A-Z]:/i.test(projectPath || "");
    return isWindows ? v.toLowerCase() : v;
  }, [projectPath]);

  const matchesFile = useCallback((candidatePath: string, wantedPath: string): boolean => {
    const cand = normalizeForCompare(candidatePath);
    const want = normalizeForCompare(wantedPath);
    if (!cand || !want) return false;
    if (cand === want) return true;
    return cand.endsWith(`/${want}`);
  }, [normalizeForCompare]);

  const findLocalToolDiff = useCallback((wantedPath: string): { filePath: string; oldText: string; newText: string } | null => {
    const wanted = normalizeForCompare(wantedPath);
    if (!wanted) return null;

    // Prefer the last edit for this file in the current activity group
    for (let i = toolUseBlocks.length - 1; i >= 0; i--) {
      const tool = toolUseBlocks[i];
      const name = (tool.name || "").toLowerCase();
      const input = tool.input || {};
      const fp = extractFilePathFromTool(tool) || input.file_path || input.path || '';
      if (!fp) continue;
      if (!matchesFile(fp, wanted)) continue;

      if (name === "edit") {
        const oldText = typeof input.old_string === "string" ? input.old_string : "";
        const newText = typeof input.new_string === "string" ? input.new_string : "";
        if (oldText.length > 0 || newText.length > 0) {
          return { filePath: fp, oldText, newText };
        }
      }
    }

    return null;
  }, [matchesFile, normalizeForCompare, toolUseBlocks]);

  const handleViewDiff = useCallback(
    async (filePath: string) => {
      if (!sessionId) {
        setDiffError("缺少 sessionId，无法打开 diff");
        return;
      }

      // 1) Best effort: use the tool-level old/new strings from this activity group.
      // This is the most accurate "IDEA-like" full-context before/after for the current Finished working block.
      const local = findLocalToolDiff(filePath);
      if (local) {
        const now = new Date().toISOString();
        setInitialChange({
          id: `local:${group.id}:${normalizeForCompare(local.filePath)}:${now}`,
          session_id: sessionId,
          prompt_index: promptIndex ?? -1,
          timestamp: now,
          file_path: local.filePath,
          change_type: "update",
          source: "tool",
          old_content: local.oldText,
          new_content: local.newText,
        });
        setSelectedChangeId(`local:${group.id}:${normalizeForCompare(local.filePath)}:${now}`);
        setDetailDisableFetch(true);
        setDiffError(null);
        return;
      }

      setDetailDisableFetch(false);
      if (promptIndex === undefined || promptIndex < 0) {
        // Still allow fallback search across the whole session
        console.warn("[ChangedFilesSummary] Missing promptIndex, will fallback to session-wide search");
      }

      setDiffError(null);
      setDiffLoading(true);
      try {
        const changes = await api.codexListFileChanges(sessionId);
        const wanted = normalizeForCompare(filePath);
        const wantedName = getFileName(wanted);

        const promptChanges =
          promptIndex !== undefined && promptIndex >= 0
            ? changes.filter((c) => c.prompt_index === promptIndex)
            : changes;

        let candidates = promptChanges.filter((c) => matchesFile(c.file_path, wanted));

        // Fallback: if only a bare filename is provided, try to match by basename.
        if (candidates.length === 0 && wantedName) {
          const byName = promptChanges.filter((c) => getFileName(normalizeForCompare(c.file_path)) === wantedName);
          if (byName.length > 0) {
            candidates = byName;
            if (byName.length > 1) {
              setDiffError(`找到多个同名文件的变更记录（${wantedName}），已打开最新一条`);
            }
          }
        }

        // If still not found in current prompt, fallback to session-wide search (latest wins)
        if (candidates.length === 0 && promptIndex !== undefined && promptIndex >= 0) {
          const allByPath = changes.filter((c) => matchesFile(c.file_path, wanted));
          let fallback: typeof allByPath = allByPath;
          if (fallback.length === 0 && wantedName) {
            fallback = changes.filter((c) => getFileName(normalizeForCompare(c.file_path)) === wantedName);
          }
          if (fallback.length > 0) {
            candidates = fallback;
            setDiffError("未在本次 Prompt 找到 diff，已打开该文件最近一次记录");
          }
        }

        const picked =
          candidates.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1) || null;

        if (!picked) {
          setDiffError("未找到该文件的变更记录（可能尚未写入变更追踪）");
          return;
        }

        setInitialChange(picked);
        setSelectedChangeId(picked.id);
      } catch (err) {
        setDiffError(err instanceof Error ? err.message : "加载 diff 记录失败");
      } finally {
        setDiffLoading(false);
      }
    },
    [findLocalToolDiff, group.id, matchesFile, normalizeForCompare, promptIndex, sessionId]
  );

  const summaryTitle = useMemo(() => {
    const { readCount, editCount, writeCount, touchedCount } = fileSummary;
    const hasFileOps = touchedCount > 0;

    if (!hasFileOps) {
      return "工作过程";
    }

    const onlyReads = readCount > 0 && editCount === 0 && writeCount === 0 && stats.total === toolUseBlocks.filter((t) => (t.name || "").toLowerCase() === "read").length;
    if (onlyReads) {
      return `浏览了 ${readCount} 个文件`;
    }

    const hasWritesOrEdits = editCount + writeCount > 0;
    if (hasWritesOrEdits) {
      return `修改了 ${Math.max(1, touchedCount)} 个文件`;
    }

    return "工作过程";
  }, [fileSummary, stats.total, toolUseBlocks]);

  const headerTitle = isStreaming || stats.pending > 0 ? "Working…" : "Finished working";
  const headerText = summaryTitle && summaryTitle !== "工作过程" ? `${headerTitle} • ${summaryTitle}` : headerTitle;

  const headerIcon = isStreaming || stats.pending > 0
    ? <Loader2 className="h-3.5 w-3.5 text-blue-600 animate-spin" />
    : stats.error > 0
      ? <AlertCircle className="h-3.5 w-3.5 text-red-600" />
      : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;

  const toolBadges = (
    <div className="flex items-center gap-1.5">
      {stats.total > 0 && (
        <span className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Wrench className="h-3 w-3 opacity-70" />
          {stats.total}
        </span>
      )}
      {fileSummary.touchedCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <FileText className="h-3 w-3 opacity-70" />
          {fileSummary.touchedCount}
        </span>
      )}
      {group.messages.some((m) => m.type === "thinking") && (
        <span className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <BrainCircuit className="h-3 w-3 opacity-70" />
          思考
        </span>
      )}
    </div>
  );

  const fileChips = useMemo(() => {
    const files = fileSummary.uniqueFiles;
    if (files.length === 0) return null;

    const maxChips = 3;
    const visible = files.slice(0, maxChips);
    const remaining = files.length - visible.length;

    return (
      <div className="flex items-center gap-1.5 min-w-0">
        {visible.map((fp) => (
          <div
            key={fp}
            className="inline-flex items-center rounded-md border border-border/50 bg-background/50 px-2 py-0.5 max-w-[180px]"
          >
            <FilePathLink
              filePath={fp}
              projectPath={projectPath}
              displayText={getFileName(fp)}
              className="text-[11px]"
            />
          </div>
        ))}
        {remaining > 0 && (
          <span className="text-[11px] text-muted-foreground/70 whitespace-nowrap">
            +{remaining}
          </span>
        )}
      </div>
    );
  }, [fileSummary.uniqueFiles, projectPath]);

  type ActivityStep =
    | {
        kind: "thinking";
        key: string;
        label: string;
        content: string;
      }
    | {
        kind: "tools";
        key: string;
        label: string;
        message: ClaudeStreamMessage;
        toolCount: number;
        files: string[];
        status: "pending" | "success" | "error";
      };

  const stripMarkdown = (value: string): string => {
    return value
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .trim();
  };

  const truncate = (value: string, max = 90): string => {
    const v = value.trim();
    if (v.length <= max) return v;
    return `${v.slice(0, max)}…`;
  };

  const summarizeTool = (tool: ToolUseBlock): string => {
    const name = (tool.name || "").toLowerCase();
    const fp = extractFilePathFromTool(tool);
    const displayFile = fp ? getFileName(fp) : null;

    if (name === "read") return displayFile ? `Read ${displayFile}` : "Read file";
    if (name === "edit") return displayFile ? `Edit ${displayFile}` : "Edit file";
    if (name === "multiedit") return displayFile ? `MultiEdit ${displayFile}` : "MultiEdit";
    if (name === "write") return displayFile ? `Write ${displayFile}` : "Write file";

    if (name === "ls") {
      const p = tool.input?.path || tool.input?.directory_path || tool.input?.dir_path || "";
      return p ? `LS ${truncate(p, 60)}` : "LS";
    }
    if (name === "grep") {
      const q = tool.input?.pattern || tool.input?.query || tool.input?.search_term || "";
      return q ? `Grep ${truncate(String(q), 60)}` : "Grep";
    }
    if (name === "glob") {
      const pat = tool.input?.pattern || tool.input?.file_pattern || "";
      return pat ? `Glob ${truncate(String(pat), 60)}` : "Glob";
    }
    if (name === "bash") {
      const cmd = tool.input?.command || tool.input?.cmd || "";
      return cmd ? `$ ${truncate(String(cmd), 80)}` : "Bash";
    }

    return tool.name || "Tool";
  };

  const steps = useMemo((): ActivityStep[] => {
    const result: ActivityStep[] = [];

    group.messages.forEach((m, idx) => {
      if (m.type === "thinking") {
        const content = String((m as any).content || "");
        const firstLine = content.split("\n").find((l) => l.trim()) || "Thinking";
        const label = truncate(stripMarkdown(firstLine), 90) || "Thinking";
        result.push({
          kind: "thinking",
          key: `thinking-${group.startIndex}-${idx}`,
          label,
          content,
        });
        return;
      }

      if (m.type === "assistant" && hasToolUse(m)) {
        const tools = extractToolUseBlocks(m);
        const toolLabels = tools.slice(0, 2).map(summarizeTool);
        const extra = tools.length > 2 ? ` +${tools.length - 2}` : "";
        const label = `${toolLabels.join(" • ")}${extra}`;

        const stepFilesSet = new Set<string>();
        tools.forEach((t) => {
          const direct = extractFilePathFromTool(t);
          if (direct) stepFilesSet.add(direct);

          const name = (t.name || "").toLowerCase();
          if (name === "bash") {
            const cmd = t.input?.command || t.input?.cmd || "";
            extractFilePathsFromCommand(String(cmd)).forEach((fp) => stepFilesSet.add(fp));
          }

          // 从工具输出补提文件（grep/glob/bash 常见）
          const resultEntry = getResultById(t.id);
          if (resultEntry && (resultEntry as any).content) {
            const outputText = extractResultText(resultEntry);
            extractFilePathsFromOutput(outputText).forEach((fp) => stepFilesSet.add(fp));
          }
        });

        let hasPending = false;
        let hasError = false;
        tools.forEach((t) => {
          const s = getStatusById(t.id);
          if (s === "pending") hasPending = true;
          if (s === "error") hasError = true;
        });
        const status: "pending" | "success" | "error" = hasError ? "error" : hasPending ? "pending" : "success";

        result.push({
          kind: "tools",
          key: `tool-${group.startIndex}-${idx}`,
          label: truncate(label, 110),
          message: m,
          toolCount: tools.length,
          files: Array.from(stepFilesSet),
          status,
        });
      }
    });

    return result;
  }, [group.messages, group.startIndex, getResultById, getStatusById]);

  // 流式输出时，默认展开最后一步；完成后默认全收起
  useEffect(() => {
    if (!isStreaming) return;
    if (steps.length === 0) return;
    setOpenStepKey(steps[steps.length - 1].key);
  }, [isStreaming, steps]);

  if (steps.length === 0) {
    return null;
  }

  return (
    <div className={cn("mt-1", className)}>
      <div className="rounded-lg border border-border/50 bg-muted/10 overflow-hidden">
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className={cn(
            "w-full px-3 py-2 text-left",
            "bg-muted/30 hover:bg-muted/50 transition-colors",
            "flex items-center gap-2 select-none"
          )}
        >
          <span className="text-muted-foreground">
            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
          {headerIcon}
          <span className="text-sm font-medium text-foreground/85 truncate">
            {headerText}
          </span>

          {/* 文件标签（可点击打开 IDE） */}
          <div className="hidden sm:flex flex-1 min-w-0">
            {fileChips}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {toolBadges}
          </div>
        </button>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: 'visible' }}
            >
              <div className="p-3 space-y-2 bg-background/30 max-h-[50vh] overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
                {/* 小屏幕下把文件 chips 放到内容区顶部，避免头部换行占空间 */}
                <div className="sm:hidden">
                  {fileChips}
                </div>
                {/* 步骤列表（参考 Finished working 折叠样式） */}
                <div className="space-y-1">
                  {steps.map((step) => {
                    const isOpen = openStepKey === step.key;

                    let statusNode: React.ReactNode = null;
                    if (step.kind === "tools") {
                      statusNode =
                        step.status === "pending"
                          ? <Loader2 className="h-3.5 w-3.5 text-blue-600 animate-spin" />
                          : step.status === "error"
                            ? <AlertCircle className="h-3.5 w-3.5 text-red-600" />
                            : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
                    }

                    return (
                      <div key={step.key} className="rounded-md border border-border/50 bg-muted/10 overflow-hidden">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setOpenStepKey((prev) => (prev === step.key ? null : step.key))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setOpenStepKey((prev) => (prev === step.key ? null : step.key));
                            }
                          }}
                          className={cn(
                            "w-full px-2.5 py-2 text-left",
                            "hover:bg-muted/20 transition-colors",
                            "flex items-center gap-2 select-none cursor-pointer"
                          )}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}

                          {step.kind === "thinking" ? (
                            <BrainCircuit className="h-3.5 w-3.5 text-amber-600 opacity-80" />
                          ) : step.label.startsWith("Edit ") || step.label.startsWith("MultiEdit ") ? (
                            <Pencil className="h-3.5 w-3.5 text-blue-600 opacity-80" />
                          ) : (
                            <Wrench className="h-3.5 w-3.5 text-blue-600 opacity-80" />
                          )}

                          <span className="text-xs font-medium text-foreground/85 truncate flex-1 min-w-0">
                            {step.label}
                          </span>

                          {step.kind === "tools" && step.files.length > 0 && (
                            <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
                              {step.files.slice(0, 2).map((fp) => (
                                <div
                                  key={fp}
                                  className="inline-flex items-center rounded-md border border-border/50 bg-background/50 px-2 py-0.5 max-w-[200px]"
                                >
                                  <FilePathLink
                                    filePath={fp}
                                    projectPath={projectPath}
                                    displayText={getFileName(fp)}
                                    className="text-[11px]"
                                  />
                                </div>
                              ))}
                              {step.files.length > 2 && (
                                <span className="text-[11px] text-muted-foreground/70 whitespace-nowrap">
                                  +{step.files.length - 2}
                                </span>
                              )}
                            </div>
                          )}

                          <span className="flex items-center gap-2 flex-shrink-0">
                            {step.kind === "tools" && (
                              <span className="text-[10px] text-muted-foreground/70">
                                {step.toolCount} tools
                              </span>
                            )}
                            {statusNode}
                          </span>
                        </div>

                        {isOpen && (
                          <div className="px-2.5 pb-2 pt-1 bg-background/30">
                            {step.kind === "thinking" ? (
                              <div className="border-l-2 border-amber-500/30 bg-amber-500/5 rounded-md px-3 py-2">
                                <div className="text-[11px] text-muted-foreground/80 whitespace-pre-wrap font-mono leading-relaxed max-h-[320px] overflow-y-auto">
                                  {step.content}
                                  {isStreaming && (
                                    <span className="inline-block w-1 h-3 ml-1 bg-amber-500 animate-pulse rounded-sm" />
                                  )}
                                </div>
                              </div>
                            ) : (
                              <ToolCallsGroup
                                message={step.message}
                                onLinkDetected={onLinkDetected}
                                projectPath={projectPath}
                                className="mt-0"
                                collapseThreshold={999}
                                defaultCollapsed={false}
                                compact
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* 修改文件汇总（参考官方 files changed 列表样式） */}
                {changedFiles.length > 0 && (
                  <ChangedFilesSummary
                    files={changedFiles}
                    projectPath={projectPath}
                    defaultExpanded={true}
                    onViewDiff={handleViewDiff}
                  />
                )}
                {diffError && (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {diffError}
                  </div>
                )}
                {diffLoading && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    正在加载对比…
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {selectedChangeId && sessionId && (
        <CodexChangeDetailPage
          sessionId={sessionId}
          changeId={selectedChangeId}
          projectPath={projectPath}
          initialChange={initialChange || undefined}
          disableFetch={detailDisableFetch}
          onClose={() => {
            setSelectedChangeId(null);
            setInitialChange(null);
            setDiffError(null);
            setDetailDisableFetch(false);
          }}
        />
      )}
    </div>
  );
};

export default ActivityMessageGroup;
