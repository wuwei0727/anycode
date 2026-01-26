/**
 * ✅ Edit Widget - 文件编辑展示（Diff 视图）
 *
 * 迁移自 ToolWidgets.tsx (原 1466-1568 行)
 * 用于展示文件编辑操作的 Diff 对比
 */

import React, { useState, useMemo } from "react";
import { FileEdit, ChevronUp, ChevronDown, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import * as Diff from 'diff';
import { FilePathLink } from "@/components/common/FilePathLink";

export interface EditWidgetProps {
  /** 文件路径 */
  file_path: string;
  /** 旧字符串 */
  old_string: string;
  /** 新字符串 */
  new_string: string;
  /** 工具结果 */
  result?: any;
  /** 是否仍在流式执行中 */
  isStreaming?: boolean;
  /** 项目路径（用于解析相对文件路径） */
  projectPath?: string;
}

/**
 * 文件编辑 Widget
 *
 * 展示文件编辑的 Diff 对比，支持语法高亮
 */
export const EditWidget: React.FC<EditWidgetProps> = ({
  file_path,
  old_string,
  new_string,
  result,
  isStreaming = false,
  projectPath,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullContext, setShowFullContext] = useState(false);
  const [expandedHunks, setExpandedHunks] = useState<Set<string>>(new Set());
  const normalizedPath = (file_path || '').replace(/\\/g, '/');
  const parts = normalizedPath.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || file_path;
  const dirPath = parts.slice(0, -1).join('/');

  type RawRow = {
    kind: 'context' | 'added' | 'removed' | 'modified';
    left?: string;
    right?: string;
    hasLeft: boolean;
    hasRight: boolean;
  };

  const splitLines = (value: string): string[] => {
    if (!value) return [];
    const lines = value.split('\n');
    // Drop the trailing empty line created by split when the string ends with '\n'
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  };

  const buildRawRows = (oldText: string, newText: string): RawRow[] => {
    const parts = Diff.diffLines(oldText || '', newText || '', {
      ignoreWhitespace: false,
      newlineIsToken: false,
    });

    const rows: RawRow[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as any;
      const next = parts[i + 1] as any;

      if (part?.removed && next?.added) {
        const removedLines = splitLines(part.value || '');
        const addedLines = splitLines(next.value || '');
        const max = Math.max(removedLines.length, addedLines.length);

        for (let j = 0; j < max; j++) {
          const hasLeft = j < removedLines.length;
          const hasRight = j < addedLines.length;
          rows.push({
            kind: 'modified',
            left: hasLeft ? removedLines[j] : '',
            right: hasRight ? addedLines[j] : '',
            hasLeft,
            hasRight,
          });
        }

        i += 1; // skip the "added" part
        continue;
      }

      const lines = splitLines(part?.value || '');
      const isAdded = Boolean(part?.added);
      const isRemoved = Boolean(part?.removed);

      for (const line of lines) {
        if (isAdded) {
          rows.push({ kind: 'added', left: '', right: line, hasLeft: false, hasRight: true });
        } else if (isRemoved) {
          rows.push({ kind: 'removed', left: line, right: '', hasLeft: true, hasRight: false });
        } else {
          rows.push({ kind: 'context', left: line, right: line, hasLeft: true, hasRight: true });
        }
      }
    }

    return rows;
  };

  const rawRows = useMemo(() => buildRawRows(old_string || '', new_string || ''), [old_string, new_string]);

  const stats = useMemo(
    () =>
      rawRows.reduce(
        (acc, row) => {
          if (row.kind === 'added') acc.added += 1;
          if (row.kind === 'removed') acc.removed += 1;
          if (row.kind === 'modified') {
            if (row.hasLeft) acc.removed += 1;
            if (row.hasRight) acc.added += 1;
          }
          return acc;
        },
        { added: 0, removed: 0 }
      ),
    [rawRows]
  );

  const hasDiffContent = stats.added > 0 || stats.removed > 0;

  const numberedRows = useMemo(() => {
    let oldLn = 1;
    let newLn = 1;
    return rawRows.map((r) => {
      const oldLineNumber = r.hasLeft ? oldLn++ : undefined;
      const newLineNumber = r.hasRight ? newLn++ : undefined;
      return { ...r, oldLineNumber, newLineNumber };
    });
  }, [rawRows]);

  const CONTEXT_LINES = 3;
  const displayRows = useMemo(() => {
    if (showFullContext) {
      return numberedRows.map((r) => ({ kind: 'row' as const, row: r }));
    }

    const keep = new Array(numberedRows.length).fill(false);
    numberedRows.forEach((r, idx) => {
      if (r.kind === 'context') return;
      const start = Math.max(0, idx - CONTEXT_LINES);
      const end = Math.min(numberedRows.length - 1, idx + CONTEXT_LINES);
      for (let i = start; i <= end; i++) keep[i] = true;
    });

    const out: Array<
      | { kind: 'row'; row: (typeof numberedRows)[number] }
      | { kind: 'collapse'; id: string; count: number }
    > = [];

    let i = 0;
    while (i < numberedRows.length) {
      if (keep[i]) {
        out.push({ kind: 'row', row: numberedRows[i] });
        i += 1;
        continue;
      }

      const start = i;
      while (i < numberedRows.length && !keep[i]) i += 1;
      const end = i;
      const id = `${start}-${end}`;

      if (expandedHunks.has(id)) {
        for (let j = start; j < end; j++) {
          out.push({ kind: 'row', row: numberedRows[j] });
        }
      } else {
        out.push({ kind: 'collapse', id, count: end - start });
      }
    }

    return out;
  }, [numberedRows, showFullContext, expandedHunks]);

  // Status logic
  const hasResult = result !== undefined;
  const isError = result?.is_error;
  
  const statusIcon = hasResult
    ? isError
      ? <XCircle className="h-3.5 w-3.5 text-red-500" />
      : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
    : <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;

  const statusColor = hasResult ? (isError ? 'text-red-500' : 'text-green-500') : 'text-blue-500';

  return (
    <div className="space-y-2 w-full">
      <div className="ml-1 space-y-2">
        {/* 文件路径和展开按钮 - 可点击区域扩展到整行 */}
        <div 
          className="flex items-center justify-between bg-muted p-2.5 rounded-md border border-border/50 cursor-pointer hover:bg-muted-hover transition-colors group/header select-none"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <FileEdit className="h-4 w-4 text-blue-500 flex-shrink-0" />
              <span className="text-sm font-medium text-muted-foreground">Edit</span>
              <span className="text-muted-foreground/30">|</span>
              <FilePathLink
                filePath={file_path}
                projectPath={projectPath}
                displayText={fileName}
                className="text-sm text-foreground/90 font-medium"
              />
              {dirPath && (
                <span className="text-xs text-muted-foreground truncate max-w-[240px]" title={dirPath}>
                  {dirPath}
                </span>
              )}
            </div>
            
              {/* Diff Stats & Status */}
            <div className="flex items-center gap-3 text-xs font-mono font-medium">
              <div className="flex items-center gap-2">
                {stats.added > 0 && (
                  <span className="text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">
                    +{stats.added}
                  </span>
                )}
                {stats.removed > 0 && (
                  <span className="text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                    -{stats.removed}
                  </span>
                )}
              </div>
              
              {/* Status Badge */}
              <div className="flex items-center gap-1">
                {statusIcon}
                {hasResult && (
                  <span className={cn("font-medium hidden sm:inline", statusColor)}>
                    {isError ? '失败' : '成功'}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="h-6 px-2 ml-2 text-muted-foreground group-hover/header:text-foreground flex items-center gap-1 transition-colors">
            {isExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </div>
        </div>

        {/* Diff 视图 */}
        {isExpanded && (
          <div className="rounded-lg border overflow-hidden text-xs font-mono mt-2 bg-background border-border/50">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-muted">
              <div className="text-[11px] text-muted-foreground">
                {showFullContext ? '完整文件' : `上下文模式（±${CONTEXT_LINES} 行）`}
              </div>
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={() => {
                  setShowFullContext((v) => !v);
                  setExpandedHunks(new Set());
                }}
              >
                {showFullContext ? '切换到上下文' : '显示完整文件'}
              </button>
            </div>

            <div className="max-h-[440px] overflow-auto">
              {!hasDiffContent ? (
                <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground">
                  {isStreaming ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-xs">工具执行中，等待 diff 返回…</span>
                    </>
                  ) : (
                    <span className="text-xs">暂无 diff 内容</span>
                  )}
                </div>
              ) : (
                <table className="w-full border-collapse text-[11px] font-mono">
                  <tbody>
                    {displayRows.map((item) => {
                      if (item.kind === 'collapse') {
                        return (
                          <tr key={`collapse-${item.id}`}>
                            <td colSpan={4} className="border-y border-border/50 bg-secondary">
                              <button
                                type="button"
                                className="w-full px-4 py-1 text-center text-muted-foreground hover:text-foreground text-[11px]"
                                onClick={() => {
                                  setExpandedHunks((prev) => {
                                    const next = new Set(prev);
                                    next.add(item.id);
                                    return next;
                                  });
                                }}
                              >
                                … {item.count} 行未改动（点击展开） …
                              </button>
                            </td>
                          </tr>
                        );
                      }

                      const r = item.row;
                      const leftBg = r.kind === 'removed' || r.kind === 'modified' ? 'bg-red-500/35' : '';
                      const rightBg = r.kind === 'added' || r.kind === 'modified' ? 'bg-green-500/35' : '';
                      const showWordDiff = r.kind === 'modified' && r.hasLeft && r.hasRight;

                      const wordDiff = showWordDiff
                        ? Diff.diffWordsWithSpace(r.left || '', r.right || '')
                        : null;

                      const leftNode = showWordDiff
                        ? wordDiff!
                            .filter((p: any) => !p.added)
                            .map((p: any, idx: number) => (
                              <span
                                key={`l-${idx}`}
                                className={p.removed ? 'bg-red-500/45 text-red-700 dark:text-red-300' : undefined}
                              >
                                {p.value}
                              </span>
                            ))
                        : (r.left ?? '');

                      const rightNode = showWordDiff
                        ? wordDiff!
                            .filter((p: any) => !p.removed)
                            .map((p: any, idx: number) => (
                              <span
                                key={`r-${idx}`}
                                className={p.added ? 'bg-green-500/45 text-green-700 dark:text-green-300' : undefined}
                              >
                                {p.value}
                              </span>
                            ))
                        : (r.right ?? '');

                      return (
                        <tr
                          key={`${r.oldLineNumber ?? 'x'}-${r.newLineNumber ?? 'y'}-${r.kind}`}
                          className="align-top"
                        >
                          <td className="w-10 select-none text-right pr-2 text-muted-foreground bg-muted border-r border-border/50">
                            {r.oldLineNumber ?? ''}
                        </td>
                        <td className={cn('px-2 border-r border-border/50', leftBg)}>
                          <pre className="m-0 whitespace-pre leading-5">{leftNode}</pre>
                        </td>
                          <td className="w-10 select-none text-right pr-2 text-muted-foreground bg-muted border-r border-border/50">
                            {r.newLineNumber ?? ''}
                        </td>
                        <td className={cn('px-2', rightBg)}>
                          <pre className="m-0 whitespace-pre leading-5">{rightNode}</pre>
                        </td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
