/**
 * 优化预览对话框组件
 * 显示原始和优化后的提示词对比，支持应用、取消、编辑操作
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, Edit2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
// cn utility not needed in this component
import { computeDiff, computeDiffStats, DiffSegment } from '@/lib/textDiff';

interface PreviewDialogProps {
  open: boolean;
  originalPrompt: string;
  enhancedPrompt: string;
  providerName?: string;
  onApply: (prompt: string) => void;
  onCancel: () => void;
  onClose: () => void;
}

/**
 * 渲染差异高亮的文本
 */
const DiffHighlight: React.FC<{ diff: DiffSegment[] }> = ({ diff }) => {
  return (
    <div className="whitespace-pre-wrap break-words">
      {diff.map((segment, index) => {
        switch (segment.type) {
          case 'added':
            return (
              <span
                key={index}
                className="bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 rounded px-0.5"
              >
                {segment.text}
              </span>
            );
          case 'removed':
            return (
              <span
                key={index}
                className="bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 line-through rounded px-0.5"
              >
                {segment.text}
              </span>
            );
          default:
            return <span key={index}>{segment.text}</span>;
        }
      })}
    </div>
  );
};

export const PreviewDialog: React.FC<PreviewDialogProps> = ({
  open,
  originalPrompt,
  enhancedPrompt,
  providerName,
  onApply,
  onCancel,
  onClose,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState(enhancedPrompt);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 重置编辑状态
  useEffect(() => {
    if (open) {
      setIsEditing(false);
      setEditedPrompt(enhancedPrompt);
    }
  }, [open, enhancedPrompt]);

  // 计算差异
  const diff = computeDiff(originalPrompt, enhancedPrompt);
  const stats = computeDiffStats(diff);

  // 键盘快捷键处理
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!open) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onApply(isEditing ? editedPrompt : enhancedPrompt);
    }
  }, [open, onCancel, onApply, isEditing, editedPrompt, enhancedPrompt]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // 聚焦编辑框
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(
        textareaRef.current.value.length,
        textareaRef.current.value.length
      );
    }
  }, [isEditing]);

  const handleApply = () => {
    onApply(isEditing ? editedPrompt : enhancedPrompt);
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditedPrompt(enhancedPrompt);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedPrompt(enhancedPrompt);
  };

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
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
            onClick={onClose}
          />

          {/* 对话框 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-4 md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[90vw] md:max-w-4xl md:max-h-[85vh] bg-background border border-border rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">优化预览</h2>
                {providerName && (
                  <Badge variant="secondary" className="text-xs">
                    {providerName}
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  变化 {stats.changePercentage}%
                </Badge>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-auto p-6">
              {isEditing ? (
                /* 编辑模式 */
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">编辑优化后的提示词</h3>
                    <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                      <RotateCcw className="h-3 w-3 mr-1" />
                      取消编辑
                    </Button>
                  </div>
                  <Textarea
                    ref={textareaRef}
                    value={editedPrompt}
                    onChange={(e) => setEditedPrompt(e.target.value)}
                    className="min-h-[300px] resize-none font-mono text-sm"
                    placeholder="编辑优化后的提示词..."
                  />
                </div>
              ) : (
                /* 对比模式 */
                <div className="grid md:grid-cols-2 gap-6">
                  {/* 原始提示词 */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-muted-foreground">原始提示词</h3>
                      <Badge variant="outline" className="text-xs">
                        {originalPrompt.length} 字符
                      </Badge>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50 min-h-[200px] max-h-[400px] overflow-auto">
                      <p className="text-sm whitespace-pre-wrap break-words">{originalPrompt}</p>
                    </div>
                  </div>

                  {/* 优化后提示词 */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-muted-foreground">优化后提示词</h3>
                      <Badge variant="outline" className="text-xs">
                        {enhancedPrompt.length} 字符
                      </Badge>
                      {stats.addedCount > 0 && (
                        <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200">
                          +{stats.addedCount}
                        </Badge>
                      )}
                      {stats.removedCount > 0 && (
                        <Badge className="text-xs bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">
                          -{stats.removedCount}
                        </Badge>
                      )}
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50 min-h-[200px] max-h-[400px] overflow-auto">
                      <DiffHighlight diff={diff} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 底部操作栏 */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/30">
              <div className="text-xs text-muted-foreground">
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">Ctrl+Enter</kbd> 应用 · 
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs ml-1">Esc</kbd> 取消
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={onCancel}>
                  取消
                </Button>
                {!isEditing && (
                  <Button variant="outline" onClick={handleEdit}>
                    <Edit2 className="h-3.5 w-3.5 mr-1.5" />
                    编辑
                  </Button>
                )}
                <Button onClick={handleApply} className="bg-primary hover:bg-primary/90">
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                  应用
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
