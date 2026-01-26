/**
 * 优化历史面板组件
 * 显示当前会话的提示词优化历史记录
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { History, Trash2, Clock, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { EnhancementHistoryItem } from './hooks/useEnhancementHistory';

interface EnhancementHistoryPanelProps {
  open: boolean;
  history: EnhancementHistoryItem[];
  onSelect: (item: EnhancementHistoryItem) => void;
  onClear: () => void;
  onClose: () => void;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - timestamp;

  // 小于 1 分钟
  if (diff < 60 * 1000) {
    return '刚刚';
  }

  // 小于 1 小时
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.floor(diff / (60 * 1000));
    return `${minutes} 分钟前`;
  }

  // 同一天
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // 其他
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 截断文本
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

export const EnhancementHistoryPanel: React.FC<EnhancementHistoryPanelProps> = ({
  open,
  history,
  onSelect,
  onClear,
  onClose,
}) => {
  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
            onClick={onClose}
          />

          {/* 面板 */}
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-background border-l border-border shadow-2xl z-50 flex flex-col"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-semibold">优化历史</h2>
                <Badge variant="secondary" className="text-xs">
                  {history.length}
                </Badge>
              </div>
              <div className="flex items-center gap-1">
                {history.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onClear}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    清空
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={onClose}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* 内容 */}
            <ScrollArea className="flex-1">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <History className="h-12 w-12 mb-4 opacity-30" />
                  <p className="text-sm">暂无优化历史</p>
                  <p className="text-xs mt-1">优化提示词后会自动记录</p>
                </div>
              ) : (
                <div className="p-2 space-y-2">
                  {history.map((item, index) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={cn(
                        "p-3 rounded-lg border border-border/50 bg-card hover:bg-accent/50 cursor-pointer transition-colors",
                        "group"
                      )}
                      onClick={() => onSelect(item)}
                    >
                      {/* 时间和提供商 */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>{formatTimestamp(item.timestamp)}</span>
                        </div>
                        <Badge variant="outline" className="text-xs">
                          {item.providerName}
                        </Badge>
                      </div>

                      {/* 原始 -> 优化后 */}
                      <div className="space-y-2">
                        <div className="text-xs">
                          <span className="text-muted-foreground">原始: </span>
                          <span className="text-foreground/80">
                            {truncateText(item.originalPrompt, 60)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <ArrowRight className="h-3 w-3" />
                        </div>
                        <div className="text-xs">
                          <span className="text-muted-foreground">优化: </span>
                          <span className="text-foreground">
                            {truncateText(item.enhancedPrompt, 80)}
                          </span>
                        </div>
                      </div>

                      {/* 悬停提示 */}
                      <div className="mt-2 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        点击恢复此提示词
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
