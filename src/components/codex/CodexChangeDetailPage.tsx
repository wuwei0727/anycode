/**
 * CodexChangeDetailPage - 变更详情页（IDEA 风格：变更前 / 变更后）
 *
 * 目标：
 * - 点击历史列表项后打开新页面（覆盖式页面）
 * - 展示完整上下文（不需要再点“展开/完整”）
 * - 左右对照（before / after）
 */

import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Copy, FileDown, Loader2, X } from 'lucide-react';
import * as Diff from 'diff';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { CodexFileChange } from '@/types/codex-changes';
import { FilePathLink } from '@/components/common/FilePathLink';
import { useTheme } from '@/contexts/ThemeContext';
import { CodexEventConverter } from '@/lib/codexConverter';
import { extractOldNewFromPatchText } from '@/lib/codexDiff';

const GitDiffView = React.lazy(() => import('./GitDiffView'));

export interface CodexChangeDetailPageProps {
  sessionId: string;
  changeId: string;
  projectPath?: string;
  initialChange?: CodexFileChange;
  /** 不从后端拉取详情，仅使用 initialChange 渲染（用于即时 tool diff） */
  disableFetch?: boolean;
  onClose: () => void;
  onExport?: (changeId: string) => void;
}

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
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
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
};

const normalizeForCompare = (value: string, projectPath?: string): string => {
  if (!value) return value;
  const v = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const isWindows = /^[A-Z]:/i.test(projectPath || "");
  return isWindows ? v.toLowerCase() : v;
};

const matchesFile = (candidatePath: string, wantedPath: string, projectPath?: string): boolean => {
  const cand = normalizeForCompare(candidatePath, projectPath);
  const want = normalizeForCompare(wantedPath, projectPath);
  if (!cand || !want) return false;
  if (cand === want) return true;
  return cand.endsWith(`/${want}`);
};

export const CodexChangeDetailPage: React.FC<CodexChangeDetailPageProps> = ({
  sessionId,
  changeId,
  projectPath,
  initialChange,
  disableFetch = false,
  onClose,
  onExport,
}) => {
  const [loading, setLoading] = useState(!disableFetch);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<CodexFileChange | null>(initialChange || null);
  const [copied, setCopied] = useState(false);
  const { theme } = useTheme();
  const hydratedFromHistoryRef = useRef(false);

  // ESC 关闭 + 禁用 body 滚动
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Load detail (always ask backend for the latest/backfilled content)
  useEffect(() => {
    if (disableFetch) {
      setLoading(false);
      return;
    }
    let mounted = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const detail = await api.codexGetChangeDetail(sessionId, changeId);
        if (!mounted) return;
        setChange(detail);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : '加载变更详情失败');
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [sessionId, changeId, disableFetch]);

  // Fallback: try to reconstruct tool-level diff when recorded content is missing
  useEffect(() => {
    // Fast path: if we only have a patch/unified diff, try to extract before/after snippets
    // so we can still render the double-column diff viewer.
    if (!change) return;
    if (change.old_content || change.new_content) return;
    if (!change.unified_diff) return;

    const patchDiff = extractOldNewFromPatchText(change.unified_diff);
    if (!patchDiff) return;
    if (!patchDiff.oldText && !patchDiff.newText) return;

    setChange((prev) => {
      if (!prev) return prev;
      if (prev.old_content || prev.new_content) return prev;
      return {
        ...prev,
        old_content: patchDiff.oldText,
        new_content: patchDiff.newText,
      };
    });
  }, [change?.old_content, change?.new_content, change?.unified_diff]);

  // Fallback: try to reconstruct tool-level diff from session history when recorded content is missing
  useEffect(() => {
    if (!change || hydratedFromHistoryRef.current) return;
    if (change.source !== 'tool') return;
    if (!change.file_path) return;
    if (change.prompt_index < 0) return;
    if (change.old_content || change.new_content) return;

    let mounted = true;
    hydratedFromHistoryRef.current = true;

    (async () => {
      try {
        const events = await api.loadCodexSessionHistory(sessionId);
        const converter = new CodexEventConverter();
        let promptIndex = -1;
        let best: { oldText: string; newText: string } | null = null;

        for (const event of events) {
          const msg = converter.convertEventObject(event as any);
          if (!msg) continue;

          if (msg.type === 'user') {
            promptIndex += 1;
            continue;
          }

          if (promptIndex !== change.prompt_index) {
            continue;
          }

          if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) {
            continue;
          }

          for (const block of msg.message.content as any[]) {
            if (block?.type !== 'tool_use') continue;
            const name = String(block?.name || '').toLowerCase();
            const input = block?.input || {};
            const fp = input.file_path || input.path || input.file || input.filename || '';
            if (!fp || !matchesFile(fp, change.file_path, projectPath)) continue;

            const patchText =
              typeof input?.patch === 'string'
                ? input.patch
                : typeof input?.diff === 'string'
                ? input.diff
                : typeof input?.raw_input === 'string'
                ? input.raw_input
                : '';
            const patchDiff = patchText ? extractOldNewFromPatchText(patchText) : null;

            if (name === 'edit') {
              let oldText = typeof input.old_string === 'string' ? input.old_string : '';
              let newText = typeof input.new_string === 'string' ? input.new_string : '';
              if ((!oldText || !newText) && patchDiff) {
                if (!oldText) oldText = patchDiff.oldText || oldText;
                if (!newText) newText = patchDiff.newText || newText;
              }
              if (oldText || newText) {
                best = { oldText, newText };
              }
            } else if (name === 'multiedit') {
              const edits = Array.isArray(input.edits) ? input.edits : [];
              for (const e of edits) {
                const oldText = typeof e?.old_string === 'string' ? e.old_string : '';
                const newText = typeof e?.new_string === 'string' ? e.new_string : '';
                if (oldText || newText) {
                  best = { oldText, newText };
                }
              }
              if (!best && patchDiff) {
                if (patchDiff.oldText || patchDiff.newText) {
                  best = { oldText: patchDiff.oldText, newText: patchDiff.newText };
                }
              }
            } else if (name === 'write') {
              const newText = typeof input.content === 'string' ? input.content : patchDiff?.newText || '';
              if (newText) {
                best = { oldText: '', newText };
              }
            } else if (patchDiff && (patchDiff.oldText || patchDiff.newText)) {
              best = { oldText: patchDiff.oldText, newText: patchDiff.newText };
            }
          }
        }

        if (mounted && best) {
          setChange((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              old_content: best.oldText,
              new_content: best.newText,
            };
          });
        }
      } catch (err) {
        console.warn('[CodexChangeDetailPage] Failed to hydrate tool diff from history:', err);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [change, sessionId, projectPath]);

  const normalizedPath = (change?.file_path || '').replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/').filter(Boolean);
  const fileName = pathParts[pathParts.length - 1] || change?.file_path || '';
  const dirPath = pathParts.slice(0, -1).join('/');

  const oldText = change?.old_content ?? '';
  const newText = change?.new_content ?? '';

  const rawRows = useMemo(() => buildRawRows(oldText, newText), [oldText, newText]);
  const hasAnyContent = Boolean(oldText || newText || change?.unified_diff);

  const numberedRows = useMemo(() => {
    let oldLn = 1;
    let newLn = 1;
    return rawRows.map((r) => {
      const oldLineNumber = r.hasLeft ? oldLn++ : undefined;
      const newLineNumber = r.hasRight ? newLn++ : undefined;
      return { ...r, oldLineNumber, newLineNumber };
    });
  }, [rawRows]);

  const stats = useMemo(() => {
    // If we only have unified_diff (e.g. aggregated multi-tool-call diffs),
    // prefer backend-provided +/- so the header stays accurate.
    if (
      !oldText &&
      !newText &&
      change?.unified_diff &&
      typeof change.lines_added === 'number' &&
      typeof change.lines_removed === 'number'
    ) {
      return { added: change.lines_added, removed: change.lines_removed };
    }

    return numberedRows.reduce(
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
  }, [change?.lines_added, change?.lines_removed, change?.unified_diff, numberedRows, oldText, newText]);

  const handleCopy = async () => {
    const text = change?.unified_diff || '';
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const content = (
    <div className="fixed inset-0 z-[9999] bg-white dark:bg-gray-900 text-foreground flex flex-col">
      {/* Header */}
      <div className="h-12 px-3 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={onClose} title="返回 (ESC)">
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>

          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <FilePathLink
                filePath={change?.file_path || ''}
                projectPath={projectPath}
                displayText={fileName}
                className="text-sm font-semibold"
              />
              {dirPath && (
                <span className="text-xs text-muted-foreground truncate max-w-[420px]" title={dirPath}>
                  {dirPath}
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {change?.change_type ? `类型: ${change.change_type}` : ''}{' '}
              {typeof stats.added === 'number' && typeof stats.removed === 'number'
                ? `  ·  +${stats.added} -${stats.removed}`
                : ''}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleCopy}
            disabled={!change?.unified_diff}
            title="复制 unified diff"
          >
            {copied ? <span className="text-xs font-medium text-green-600">OK</span> : <Copy className="h-4 w-4" />}
          </Button>

          {onExport && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => onExport(changeId)}
              title="导出 Patch"
            >
              <FileDown className="h-4 w-4" />
            </Button>
          )}

          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose} title="关闭 (ESC)">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center px-6 text-sm text-muted-foreground">
            {error}
          </div>
        ) : !hasAnyContent ? (
          <div className="h-full flex items-center justify-center px-6 text-sm text-muted-foreground">
            暂无 diff 内容
          </div>
        ) : change?.unified_diff && (!oldText && !newText) ? (
          <pre className="m-0 p-4 text-[12px] font-mono whitespace-pre overflow-auto h-full">
            {change.unified_diff}
          </pre>
        ) : (oldText || newText) ? (
          <div className="h-full overflow-auto">
            <React.Suspense
              fallback={
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <GitDiffView
                filePath={change?.file_path || fileName || 'file'}
                oldText={oldText}
                newText={newText}
                theme={theme}
                fontSize={12}
              />
            </React.Suspense>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            {/* Title row like IDEA */}
            <div className="grid grid-cols-2 border-b border-border text-xs font-medium">
              <div className="px-3 py-2 bg-muted text-muted-foreground">变更前 (Before)</div>
              <div className="px-3 py-2 bg-muted text-muted-foreground border-l border-border">变更后 (After)</div>
            </div>

            <table className="w-full border-collapse text-[12px] font-mono">
              <tbody>
                {numberedRows.map((r, idx) => {
                  const leftBg = r.kind === 'removed' || r.kind === 'modified' ? 'bg-red-500/25' : '';
                  const rightBg = r.kind === 'added' || r.kind === 'modified' ? 'bg-green-500/25' : '';
                  const showWordDiff = r.kind === 'modified' && r.hasLeft && r.hasRight;

                  const wordDiff = showWordDiff ? Diff.diffWordsWithSpace(r.left || '', r.right || '') : null;

                  const leftNode = showWordDiff
                    ? wordDiff!
                        .filter((p: any) => !p.added)
                        .map((p: any, i: number) => (
                          <span
                            key={`l-${idx}-${i}`}
                            className={p.removed ? 'bg-red-500/35 text-red-800 dark:text-red-200' : undefined}
                          >
                            {p.value}
                          </span>
                        ))
                    : (r.left ?? '');

                  const rightNode = showWordDiff
                    ? wordDiff!
                        .filter((p: any) => !p.removed)
                        .map((p: any, i: number) => (
                          <span
                            key={`r-${idx}-${i}`}
                            className={p.added ? 'bg-green-500/35 text-green-800 dark:text-green-200' : undefined}
                          >
                            {p.value}
                          </span>
                        ))
                    : (r.right ?? '');

                  return (
                    <tr key={`${r.oldLineNumber ?? 'x'}-${r.newLineNumber ?? 'y'}-${r.kind}-${idx}`} className="align-top">
                      {/* Before */}
                      <td className="w-12 select-none text-right pr-2 text-muted-foreground bg-muted border-r border-border/50">
                        {r.oldLineNumber ?? ''}
                      </td>
                      <td className={cn('px-2 border-r border-border/50', leftBg)}>
                        <pre className="m-0 whitespace-pre leading-5">{leftNode}</pre>
                      </td>

                      {/* After */}
                      <td className="w-12 select-none text-right pr-2 text-muted-foreground bg-muted border-r border-border/50">
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
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
};

export default CodexChangeDetailPage;
