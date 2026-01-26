/**
 * CodexChangeListItem - 变更历史列表项（仅摘要）
 *
 * 用于在「代码变更历史」里显示文件变更的概要信息。
 * 点击后由上层打开「IDEA 风格」的新页面 diff（变更前 / 变更后完整上下文）。
 */

import React, { useMemo } from 'react';
import { ChevronRight, FileDown, FileEdit, FilePlus, FileX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FilePathLink } from '@/components/common/FilePathLink';
import type { CodexFileChange } from '@/types/codex-changes';

export interface CodexChangeListItemProps {
  change: CodexFileChange;
  projectPath?: string;
  onOpen: (change: CodexFileChange) => void;
  onExport?: (changeId: string) => void;
  className?: string;
}

export const CodexChangeListItem: React.FC<CodexChangeListItemProps> = ({
  change,
  projectPath,
  onOpen,
  onExport,
  className,
}) => {
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

  const changeTypeColor = useMemo(() => {
    switch (change.change_type) {
      case 'create':
        return 'text-green-600 dark:text-green-400';
      case 'delete':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-blue-600 dark:text-blue-400';
    }
  }, [change.change_type]);

  const normalizedPath = (change.file_path || '').replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/').filter(Boolean);
  const fileName = pathParts[pathParts.length - 1] || change.file_path;
  const dirPath = pathParts.slice(0, -1).join('/');

  const handleOpen = () => onOpen(change);

  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2',
        'bg-white dark:bg-gray-900 hover:bg-accent transition-colors cursor-pointer',
        className
      )}
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleOpen();
        }
      }}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <ChangeIcon className={cn('h-4 w-4 flex-shrink-0', changeTypeColor)} />

        <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 min-w-0">
            <FilePathLink
              filePath={change.file_path}
              projectPath={projectPath}
              displayText={fileName}
              className="text-sm font-medium"
            />
            {dirPath && (
              <span
                className="text-xs text-muted-foreground truncate max-w-[240px]"
                title={dirPath}
              >
                {dirPath}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          {(change.lines_added || 0) > 0 && (
            <span className="text-green-700 dark:text-green-300 bg-green-500/10 px-1.5 py-0.5 rounded">
              +{change.lines_added}
            </span>
          )}
          {(change.lines_removed || 0) > 0 && (
            <span className="text-red-700 dark:text-red-300 bg-red-500/10 px-1.5 py-0.5 rounded">
              -{change.lines_removed}
            </span>
          )}
        </div>

        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          {change.source === 'command' ? '命令' : '工具'}
        </span>
      </div>

      <div className="flex items-center gap-1 ml-2">
        {onExport && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              onExport(change.id);
            }}
            title="导出 Patch"
          >
            <FileDown className="h-3.5 w-3.5" />
          </Button>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
      </div>
    </div>
  );
};

export default CodexChangeListItem;

