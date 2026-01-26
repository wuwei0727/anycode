/**
 * SessionToolbar - 会话工具栏组件
 * 提供导出、复制等会话操作功能（合并版）
 */

import React, { useState } from 'react';
import { FileDown, Check, FileText, FileJson, FileCode2, Copy, GitCompare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { exportSession, copyToClipboard, exportAsJsonl, exportAsMarkdown, exportAsJson } from '@/lib/sessionExport';
import type { ClaudeStreamMessage } from '@/types/claude';
import type { Session } from '@/lib/api';
import type { EngineType } from '@/lib/contextWindow';

interface SessionToolbarProps {
  /** 当前会话的消息列表 */
  messages: ClaudeStreamMessage[];
  /** 当前会话信息 */
  session?: Session;
  /** 是否正在流式输出 */
  isStreaming?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 执行引擎类型 */
  engineType?: EngineType;
  /** 打开变更历史回调（仅 Codex） */
  onOpenChangeHistory?: () => void;
}

/**
 * SessionToolbar 组件（合并导出和复制功能）
 * 
 * @example
 * <SessionToolbar 
 *   messages={messages} 
 *   session={session} 
 *   isStreaming={false} 
 * />
 */
export const SessionToolbar: React.FC<SessionToolbarProps> = ({
  messages,
  session,
  isStreaming = false,
  className,
  engineType,
  onOpenChangeHistory,
}) => {
  const [actionStatus, setActionStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // 没有消息或正在流式输出时禁用
  const hasMessages = messages.length > 0;
  const isDisabled = !hasMessages || isStreaming;

  /**
   * 显示状态提示
   */
  const showStatus = (status: 'success' | 'error', message: string) => {
    setActionStatus(status);
    setStatusMessage(message);
    setTimeout(() => {
      setActionStatus('idle');
      setStatusMessage('');
    }, 2000);
  };

  /**
   * 处理复制操作
   */
  const handleCopy = async (format: 'jsonl' | 'markdown' | 'json') => {
    try {
      let content: string;
      let label: string;

      switch (format) {
        case 'jsonl':
          content = exportAsJsonl(messages);
          label = 'JSONL';
          break;
        case 'markdown':
          content = exportAsMarkdown(messages, session);
          label = 'Markdown';
          break;
        case 'json':
          content = exportAsJson(messages, session);
          label = 'JSON';
          break;
      }

      await copyToClipboard(content);
      showStatus('success', `已复制为 ${label}`);
      setIsMenuOpen(false);
    } catch (error) {
      console.error('复制失败:', error);
      showStatus('error', '复制失败');
    }
  };

  /**
   * 处理保存文件操作
   */
  const handleSave = async (format: 'json' | 'jsonl' | 'markdown') => {
    try {
      const filePath = await exportSession(messages, format, session);
      
      if (filePath) {
        showStatus('success', '文件已保存');
      }
      
      setIsMenuOpen(false);
    } catch (error) {
      console.error('保存文件失败:', error);
      showStatus('error', '保存失败');
    }
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* Codex 变更历史按钮 */}
      {engineType === 'codex' && onOpenChangeHistory && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenChangeHistory}
          disabled={isStreaming}
          className="h-8 px-2 gap-1.5"
          title="代码变更历史"
        >
          <GitCompare className="h-4 w-4" />
          <span className="text-xs">变更</span>
        </Button>
      )}
      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={isDisabled}
            className="h-8 px-2 gap-1.5"
          >
            {actionStatus === 'success' ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            <span className="text-xs">
              {actionStatus === 'success' ? statusMessage : 
               actionStatus === 'error' ? statusMessage : 
               '导出'}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {/* 复制到剪贴板 */}
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            复制到剪贴板
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handleCopy('jsonl')}>
            <Copy className="h-4 w-4 mr-2" />
            <div className="flex flex-col">
              <span className="text-sm">复制为 JSONL</span>
              <span className="text-xs text-muted-foreground">原始消息数据</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCopy('json')}>
            <Copy className="h-4 w-4 mr-2" />
            <div className="flex flex-col">
              <span className="text-sm">复制为 JSON</span>
              <span className="text-xs text-muted-foreground">结构化数据</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCopy('markdown')}>
            <Copy className="h-4 w-4 mr-2" />
            <div className="flex flex-col">
              <span className="text-sm">复制为 Markdown</span>
              <span className="text-xs text-muted-foreground">可读格式</span>
            </div>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* 保存到文件 */}
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            保存到文件
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handleSave('json')}>
            <FileJson className="h-4 w-4 mr-2" />
            <div className="flex flex-col">
              <span className="text-sm">保存为 JSON</span>
              <span className="text-xs text-muted-foreground">完整会话数据</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSave('jsonl')}>
            <FileCode2 className="h-4 w-4 mr-2" />
            <div className="flex flex-col">
              <span className="text-sm">保存为 JSONL</span>
              <span className="text-xs text-muted-foreground">流式数据格式</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSave('markdown')}>
            <FileText className="h-4 w-4 mr-2" />
            <div className="flex flex-col">
              <span className="text-sm">保存为 Markdown</span>
              <span className="text-xs text-muted-foreground">人类可读文档</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
