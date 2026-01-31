/**
 * CodexChangeHistory - 代码变更历史查看器
 *
 * 显示 Codex 会话中所有文件变更的历史记录
 * 支持按 prompt 分组、筛选、导出
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  X,
  FileDown,
  Filter,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  AlertCircle,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { save } from '@tauri-apps/plugin-dialog';
import { CodexChangeListItem } from './CodexChangeListItem';
import { CodexChangeDetailPage } from './CodexChangeDetailPage';
import type {
  CodexFileChange,
  ChangeType,
} from '@/types/codex-changes';
import {
  groupChangesByPrompt,
  getFileName,
  formatTimestamp,
} from '@/types/codex-changes';

interface CodexChangeHistoryProps {
  /** 会话 ID */
  sessionId: string;
  /** 项目路径 */
  projectPath?: string;
  /** 是否打开 */
  isOpen: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * 筛选状态
 */
interface FilterState {
  changeType: ChangeType | 'all';
}

/**
 * CodexChangeHistory 组件
 *
 * 右侧抽屉形式显示变更历史
 */
export const CodexChangeHistory: React.FC<CodexChangeHistoryProps> = ({
  sessionId,
  projectPath,
  isOpen,
  onClose,
  className,
}) => {
  const [changes, setChanges] = useState<CodexFileChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<FilterState>({ changeType: 'all' });
  const [exporting, setExporting] = useState(false);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);

  const didSetInitialExpandedRef = useRef(false);
  const loadStateRef = useRef({ inFlight: false, queued: false, seq: 0 });

  useEffect(() => {
    didSetInitialExpandedRef.current = false;
    setExpandedPrompts(new Set());
  }, [sessionId]);

  // 加载变更历史
  const loadChanges = useCallback(async (options?: { silent?: boolean }) => {
    if (!sessionId) return;

    const silent = options?.silent === true;

    if (loadStateRef.current.inFlight) {
      loadStateRef.current.queued = true;
      return;
    }

    loadStateRef.current.inFlight = true;
    loadStateRef.current.queued = false;
    const requestId = ++loadStateRef.current.seq;

    if (!silent) setLoading(true);
    setError(null);

    try {
      const data = await api.codexListFileChanges(sessionId);

      if (requestId !== loadStateRef.current.seq) return;

      setChanges(data);

      // 默认展开最新的 prompt（只在首次加载/新会话时做一次，避免自动刷新打断用户展开状态）
      if (!didSetInitialExpandedRef.current && data.length > 0) {
        const latest = data
          .slice()
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .at(-1);
        const latestPromptIndex = latest?.prompt_index;
        if (latestPromptIndex !== undefined) {
          setExpandedPrompts((prev) => (prev.size > 0 ? prev : new Set([latestPromptIndex])));
        }
        didSetInitialExpandedRef.current = true;
      }
    } catch (err) {
      console.error('Failed to load changes:', err);
      if (requestId === loadStateRef.current.seq) {
        setError(err instanceof Error ? err.message : '加载变更历史失败');
      }
    } finally {
      if (requestId === loadStateRef.current.seq) {
        setLoading(false);
      }
      loadStateRef.current.inFlight = false;

      if (loadStateRef.current.queued) {
        loadStateRef.current.queued = false;
        void loadChanges({ silent: true });
      }
    }
  }, [sessionId]);

  // 当抽屉打开时加载数据
  useEffect(() => {
    if (isOpen && sessionId) {
      loadChanges();
    }
  }, [isOpen, sessionId, loadChanges]);

  // Close detail page when sidebar closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedChangeId(null);
    }
  }, [isOpen]);

  // 🆕 Real-time refresh: reload when a new change is recorded for this session
  useEffect(() => {
    if (!isOpen || !sessionId) return;

    let unlisten: UnlistenFn | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        unlisten = await listen(`codex-change-recorded:${sessionId}`, () => {
          // Debounce: multiple file changes may arrive back-to-back
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            loadChanges({ silent: true });
          }, 300);
        });
      } catch (err) {
        console.warn('[CodexChangeHistory] Failed to listen codex-change-recorded:', err);
      }
    })();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (unlisten) unlisten();
    };
  }, [isOpen, sessionId, loadChanges]);

  // 应用筛选
  const filteredChanges = useMemo(() => {
    if (filter.changeType === 'all') {
      return changes;
    }
    return changes.filter((c) => c.change_type === filter.changeType);
  }, [changes, filter]);

  // 按 prompt 分组
  const groupedChanges = useMemo(() => {
    return groupChangesByPrompt(filteredChanges);
  }, [filteredChanges]);

  // 切换 prompt 展开状态
  const togglePrompt = (promptIndex: number) => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(promptIndex)) {
        next.delete(promptIndex);
      } else {
        next.add(promptIndex);
      }
      return next;
    });
  };

  // 导出所有变更
  const handleExportAll = async () => {
    try {
      setExporting(true);
      const filePath = await save({
        defaultPath: `codex-changes-${sessionId}.patch`,
        filters: [{ name: 'Patch 文件', extensions: ['patch'] }],
      });

      if (filePath) {
        await api.codexExportPatch(sessionId, filePath);
      }
    } catch (err) {
      console.error('Failed to export patch:', err);
    } finally {
      setExporting(false);
    }
  };

  // 导出单个变更
  const handleExportSingle = async (changeId: string) => {
    try {
      const change = changes.find((c) => c.id === changeId);
      const fileName = change ? getFileName(change.file_path) : 'change';

      const filePath = await save({
        defaultPath: `${fileName}.patch`,
        filters: [{ name: 'Patch 文件', extensions: ['patch'] }],
      });

      if (filePath) {
        await api.codexExportSingleChange(sessionId, changeId, filePath);
      }
    } catch (err) {
      console.error('Failed to export single change:', err);
    }
  };

  // 渲染筛选菜单
  const renderFilterMenu = () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1">
          <Filter className="h-3.5 w-3.5" />
          <span className="text-xs">
            {filter.changeType === 'all'
              ? '全部'
              : filter.changeType === 'create'
              ? '新建'
              : filter.changeType === 'update'
              ? '修改'
              : '删除'}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs">变更类型</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setFilter({ changeType: 'all' })}>
          全部
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFilter({ changeType: 'create' })}>
          ➕ 新建
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFilter({ changeType: 'update' })}>
          ✏️ 修改
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFilter({ changeType: 'delete' })}>
          🗑️ 删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        'fixed right-0 top-0 bottom-0 h-full w-[560px] max-w-[90vw] border-l border-border z-50',
        'flex flex-col shadow-xl',
        'bg-white dark:bg-gray-900',
        'animate-in slide-in-from-right duration-200',
        className
      )}
    >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold">代码变更历史</h2>
            {changes.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({changes.length} 个变更)
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* 刷新按钮 */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => loadChanges()}
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>

            {/* 导出按钮 */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={handleExportAll}
              disabled={changes.length === 0 || exporting}
              title="导出所有变更"
            >
              <FileDown className="h-3.5 w-3.5" />
            </Button>

            {/* 关闭按钮 */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 筛选栏 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 bg-white dark:bg-gray-900">
          {renderFilterMenu()}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-32 text-center px-4">
              <AlertCircle className="h-8 w-8 text-red-500 mb-2" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => loadChanges()}
              >
                重试
              </Button>
            </div>
          ) : changes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-center px-4">
              <FileText className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">暂无变更记录</p>
              <p className="text-xs text-muted-foreground mt-1">
                Codex 执行文件操作后会自动记录
              </p>
            </div>
          ) : (
            <div className="p-3 space-y-3">
              {groupedChanges.map((group) => (
                <div key={group.promptIndex} className="border border-border rounded-lg overflow-hidden">
                  {/* Prompt 分组头部 */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-900 cursor-pointer hover:bg-accent transition-colors"
                    onClick={() => togglePrompt(group.promptIndex)}
                  >
                    {expandedPrompts.has(group.promptIndex) ? (
                      <ChevronDown className="h-4 w-4 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 flex-shrink-0" />
                    )}

                    <span className="text-sm font-medium">
                      Prompt #{group.promptIndex + 1}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(group.endTimestamp || group.timestamp)}
                    </span>

                    <div className="flex-1" />

                    {/* 统计信息 */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {group.stats.totalFiles} 个文件
                      </span>
                      {group.stats.linesAdded > 0 && (
                        <span className="text-green-600 dark:text-green-400">
                          +{group.stats.linesAdded}
                        </span>
                      )}
                      {group.stats.linesRemoved > 0 && (
                        <span className="text-red-600 dark:text-red-400">
                          -{group.stats.linesRemoved}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 文件变更列表 */}
                  {expandedPrompts.has(group.promptIndex) && (
                    <div className="p-2 space-y-2 bg-white dark:bg-gray-900">
                      {group.changes.map((change) => (
                        <CodexChangeListItem
                          key={change.id}
                          change={change}
                          projectPath={projectPath}
                          onExport={handleExportSingle}
                          onOpen={(c) => setSelectedChangeId(c.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部信息 */}
        {changes.length > 0 && (
          <div className="px-4 py-2 border-t border-border bg-muted text-xs text-muted-foreground">
            提示: 导出的 .patch 文件可在 IDEA 中通过 VCS → Apply Patch 打开
          </div>
        )}

        {/* 变更详情页（点击列表项打开） */}
        {selectedChangeId && (
          <CodexChangeDetailPage
            sessionId={sessionId}
            changeId={selectedChangeId}
            projectPath={projectPath}
            initialChange={changes.find((c) => c.id === selectedChangeId)}
            onClose={() => setSelectedChangeId(null)}
            onExport={handleExportSingle}
          />
        )}
    </div>
  );
};

export default CodexChangeHistory;
