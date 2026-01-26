/**
 * 优化按钮组件
 * 支持一键优化（有默认提供商时）和下拉菜单选择提供商
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wand2, ChevronDown, Settings, History, Zap, Code2, Loader2, Check, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PromptEnhancementProvider } from '@/lib/promptEnhancementService';

interface EnhanceButtonProps {
  disabled?: boolean;
  isEnhancing: boolean;
  hasText: boolean;
  defaultProviderId: string | null;
  enabledProviders: PromptEnhancementProvider[];
  enableProjectContext: boolean;
  enableDualAPI: boolean;
  hasProjectPath: boolean;
  historyCount: number;
  onEnhance: (providerId?: string) => void;
  onSetDefaultProvider: (id: string | null) => void;
  onToggleProjectContext: (enabled: boolean) => void;
  onToggleDualAPI: (enabled: boolean) => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
}

export const EnhanceButton: React.FC<EnhanceButtonProps> = ({
  disabled,
  isEnhancing,
  hasText,
  defaultProviderId,
  enabledProviders,
  enableProjectContext,
  enableDualAPI,
  hasProjectPath,
  historyCount,
  onEnhance,
  onSetDefaultProvider,
  onToggleProjectContext,
  onToggleDualAPI,
  onOpenSettings,
  onOpenHistory,
}) => {
  const [showSuccess] = useState(false);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isLongPress, setIsLongPress] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // 获取默认提供商名称
  const defaultProvider = enabledProviders.find(p => p.id === defaultProviderId);
  const hasDefaultProvider = !!defaultProvider;

  // 清理长按计时器
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  // 处理点击
  const handleClick = () => {
    if (isLongPress) {
      setIsLongPress(false);
      return;
    }

    if (hasDefaultProvider) {
      // 有默认提供商，直接优化
      onEnhance(defaultProviderId!);
    } else if (enabledProviders.length === 1) {
      // 只有一个提供商，直接使用
      onEnhance(enabledProviders[0].id);
    } else {
      // 显示下拉菜单
      setDropdownOpen(true);
    }
  };

  // 处理长按开始
  const handleMouseDown = () => {
    longPressTimerRef.current = setTimeout(() => {
      setIsLongPress(true);
      setDropdownOpen(true);
    }, 500);
  };

  // 处理长按结束
  const handleMouseUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // 处理右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setDropdownOpen(true);
  };

  // 选择提供商进行优化
  const handleSelectProvider = (providerId: string) => {
    setDropdownOpen(false);
    onEnhance(providerId);
  };

  // 设置为默认提供商
  const handleSetDefault = (providerId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onSetDefaultProvider(providerId === defaultProviderId ? null : providerId);
  };

  const isDisabled = disabled || !hasText || isEnhancing;

  return (
    <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="default"
          disabled={isDisabled}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onContextMenu={handleContextMenu}
          className={cn(
            "gap-2 h-8 border-border/50 transition-all duration-200",
            hasText && !isEnhancing && "bg-gradient-to-r from-violet-500/10 to-purple-500/10 border-violet-500/30 hover:border-violet-500/50 hover:bg-violet-500/20",
            isEnhancing && "bg-violet-500/20 border-violet-500/50",
            !hasText && "opacity-50"
          )}
        >
          <AnimatePresence mode="wait">
            {isEnhancing ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex items-center gap-2"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
                <span className="text-xs text-violet-600 dark:text-violet-400">优化中...</span>
              </motion.div>
            ) : showSuccess ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex items-center gap-2"
              >
                <Check className="h-3.5 w-3.5 text-green-500" />
                <span className="text-xs text-green-600 dark:text-green-400">完成</span>
              </motion.div>
            ) : (
              <motion.div
                key="default"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex items-center gap-2"
              >
                <Wand2 className={cn(
                  "h-3.5 w-3.5",
                  hasText ? "text-violet-500" : "text-muted-foreground"
                )} />
                <span className="text-xs">
                  {hasDefaultProvider ? defaultProvider.name : '优化'}
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </motion.div>
            )}
          </AnimatePresence>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72 bg-background/95 backdrop-blur-md border-border/50">
        {/* 项目上下文开关 */}
        {hasProjectPath && (
          <>
            <div className="px-2 py-1.5">
              <label className="flex items-center justify-between cursor-pointer hover:bg-accent/50 rounded px-2 py-1.5 transition-colors">
                <div className="flex items-center gap-2">
                  <Code2 className={cn("h-4 w-4", enableProjectContext ? "text-primary" : "text-muted-foreground")} />
                  <div>
                    <div className={cn("text-sm font-medium", enableProjectContext && "text-primary")}>
                      启用项目上下文
                    </div>
                    <p className="text-xs text-muted-foreground">
                      使用 acemcp 搜索相关代码
                    </p>
                  </div>
                </div>
                <Switch
                  checked={enableProjectContext}
                  onCheckedChange={onToggleProjectContext}
                />
              </label>
            </div>
            <DropdownMenuSeparator className="bg-border/50" />
          </>
        )}

        {/* 智能上下文开关 */}
        <div className="px-2 py-1.5">
          <label className="flex items-center justify-between cursor-pointer hover:bg-accent/50 rounded px-2 py-1.5 transition-colors">
            <div className="flex items-center gap-2">
              <Zap className={cn("h-4 w-4", enableDualAPI ? "text-primary" : "text-muted-foreground")} />
              <div>
                <div className={cn("text-sm font-medium", enableDualAPI && "text-primary")}>
                  智能上下文提取
                </div>
                <p className="text-xs text-muted-foreground">
                  AI 筛选相关消息
                </p>
              </div>
            </div>
            <Switch
              checked={enableDualAPI}
              onCheckedChange={onToggleDualAPI}
            />
          </label>
        </div>
        <DropdownMenuSeparator className="bg-border/50" />

        {/* 提供商列表 */}
        {enabledProviders.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground px-2">
              选择提供商
            </DropdownMenuLabel>
            {enabledProviders.map((provider) => (
              <DropdownMenuItem
                key={provider.id}
                onClick={() => handleSelectProvider(provider.id)}
                className="cursor-pointer flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{provider.name}</span>
                </div>
                <div className="flex items-center gap-1">
                  {provider.id === defaultProviderId && (
                    <Badge variant="secondary" className="text-xs px-1.5">
                      默认
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity",
                      provider.id === defaultProviderId && "opacity-100"
                    )}
                    onClick={(e) => handleSetDefault(provider.id, e)}
                    title={provider.id === defaultProviderId ? "取消默认" : "设为默认"}
                  >
                    <Star className={cn(
                      "h-3 w-3",
                      provider.id === defaultProviderId ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"
                    )} />
                  </Button>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="bg-border/50" />
          </>
        ) : (
          <>
            <div className="px-4 py-3 text-center">
              <p className="text-sm text-muted-foreground">暂无可用的提供商</p>
              <p className="text-xs text-muted-foreground mt-1">请先配置 API 提供商</p>
            </div>
            <DropdownMenuSeparator className="bg-border/50" />
          </>
        )}

        {/* 历史记录 */}
        <DropdownMenuItem onClick={onOpenHistory} className="cursor-pointer">
          <History className="h-3.5 w-3.5 mr-2" />
          <span>优化历史</span>
          {historyCount > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">
              {historyCount}
            </Badge>
          )}
        </DropdownMenuItem>

        {/* 设置 */}
        <DropdownMenuItem onClick={onOpenSettings} className="cursor-pointer">
          <Settings className="h-3.5 w-3.5 mr-2" />
          管理 API 配置
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
