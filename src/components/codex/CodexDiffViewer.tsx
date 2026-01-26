/**
 * CodexDiffViewer - Diff 查看器组件
 *
 * 显示单个文件变更的详细 diff 视图，支持语法高亮
 * 复用 EditWidget 的样式和逻辑
 */

import React, { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown, FileDown, Copy, Check, FileEdit, FilePlus, FileX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import * as Diff from 'diff';
import { FilePathLink } from '@/components/common/FilePathLink';
import type { CodexFileChange } from '@/types/codex-changes';

interface CodexDiffViewerProps {
  /** 文件变更数据 */
  change: CodexFileChange;
  /** 是否默认展开 */
  defaultExpanded?: boolean;
  /** 项目路径 */
  projectPath?: string;
  /** 导出单个变更回调 */
  onExport?: (changeId: string) => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * CodexDiffViewer 组件
 *
 * 显示文件变更的详细 diff 视图
 */
export const CodexDiffViewer: React.FC<CodexDiffViewerProps> = ({
  change,
  defaultExpanded = false,
  projectPath,
  onExport,
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const [showFullContext, setShowFullContext] = useState(false);
  const [expandedHunks, setExpandedHunks] = useState<Set<string>>(new Set());

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
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  };

  const rawRows = useMemo((): RawRow[] => {
    const oldText = change.old_content || '';
    const newText = change.new_content || '';
    const parts = Diff.diffLines(oldText, newText, {
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

        i += 1;
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
  }, [change.old_content, change.new_content]);

  const computedStats = useMemo(() => {
    return rawRows.reduce(
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
    );
  }, [rawRows]);

  const hasDiffContent = computedStats.added > 0 || computedStats.removed > 0;

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

  // 获取变更类型图标
  const ChangeIcon = useMemo(() => {
    switch (change.change_type) {
      case 'create':
        return FilePlus;
      case 'delete':
        return FileX;
      default:
        return FileEdit;
    }
  }, [change.change_type]);

  // 获取变更类型颜色
  const changeTypeColor = useMemo(() => {
    switch (change.change_type) {
      case 'create':
        return 'text-green-500';
      case 'delete':
        return 'text-red-500';
      default:
        return 'text-blue-500';
    }
  }, [change.change_type]);

  const normalizedPath = (change.file_path || '').replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/').filter(Boolean);
  const fileName = pathParts[pathParts.length - 1] || change.file_path;
  const dirPath = pathParts.slice(0, -1).join('/');

  // 复制 diff 到剪贴板
  const handleCopy = async () => {
    if (change.unified_diff) {
      await navigator.clipboard.writeText(change.unified_diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={cn('border border-border rounded-lg overflow-hidden', className)}>
      {/* 头部 */}
      <div
        className="flex items-center justify-between bg-muted px-3 py-2 cursor-pointer hover:bg-muted-hover transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <ChangeIcon className={cn('h-4 w-4 flex-shrink-0', changeTypeColor)} />

          {/* 使用 FilePathLink 组件使文件名可点击（文件名优先，目录作为辅助信息） */}
          <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 min-w-0">
              <FilePathLink
                filePath={change.file_path}
                projectPath={projectPath}
                displayText={fileName}
                className="text-sm font-medium"
              />
              {dirPath && (
                <span className="text-xs text-muted-foreground truncate max-w-[220px]" title={dirPath}>
                  {dirPath}
                </span>
              )}
            </div>
          </div>

          {/* 统计信息 */}
          <div className="flex items-center gap-2 text-xs font-mono">
            {(change.lines_added || 0) > 0 && (
              <span className="text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">
                +{change.lines_added}
              </span>
            )}
            {(change.lines_removed || 0) > 0 && (
              <span className="text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                -{change.lines_removed}
              </span>
            )}
          </div>

          {/* 变更来源标签 */}
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {change.source === 'command' ? '命令' : '工具'}
          </span>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 ml-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              setShowFullContext((v) => !v);
              setExpandedHunks(new Set());
            }}
            title={showFullContext ? '切换到上下文模式' : '显示完整文件'}
          >
            {showFullContext ? '上下文' : '完整'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            title="复制 Diff"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>

          {onExport && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={(e) => {
                e.stopPropagation();
                onExport(change.id);
              }}
              title="导出 Patch"
            >
              <FileDown className="h-3.5 w-3.5" />
            </Button>
          )}

          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Diff 内容 */}
      {isExpanded && (
        <div className="bg-background border-t border-border">
          {/* Diff 视图 */}
          <div className="max-h-[420px] overflow-y-auto overflow-x-auto">
            {!hasDiffContent ? (
              change.unified_diff ? (
                <pre className="m-0 p-3 text-[11px] font-mono whitespace-pre overflow-auto">
                  {change.unified_diff}
                </pre>
              ) : (
                <div className="px-4 py-3 text-muted-foreground text-xs">
                  暂无 diff 内容
                </div>
              )
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

          {/* 命令信息（如果是命令执行的变更） */}
          {change.command && (
            <div className="px-3 py-2 border-t border-border/50 bg-muted">
              <div className="text-xs text-muted-foreground mb-1">执行命令:</div>
              <code className="text-xs font-mono text-foreground/80 break-all">
                {change.command}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CodexDiffViewer;
