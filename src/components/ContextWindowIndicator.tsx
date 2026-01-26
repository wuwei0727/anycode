/**
 * ContextWindowIndicator - 上下文窗口使用情况指示器
 * 
 * 显示当前会话的上下文窗口使用情况，包括圆形进度环和详细信息
 */

import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  EngineType,
  formatTokenCount,
  getColorClasses,
  getMaxTokensForEngine,
  calculateUsagePercent,
  getColorStatus,
  getWarningLevel,
} from '@/lib/contextWindow';

interface ContextWindowIndicatorProps {
  /** 当前已使用的 token 数量 */
  usedTokens: number;
  /** AI 引擎类型 */
  engine: EngineType;
  /** 模型名称（可选） */
  model?: string;
  /** 组件大小 */
  size?: 'sm' | 'md' | 'lg';
  /** 是否显示警告 */
  showWarnings?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义上下文窗口大小（从 Codex token_count 事件中提取） */
  maxContextWindow?: number;
}

// 尺寸配置 - 增大尺寸使文字更清晰
const SIZE_CONFIG = {
  sm: { ring: 32, stroke: 3, fontSize: 'text-xs' },
  md: { ring: 40, stroke: 3, fontSize: 'text-sm' },
  lg: { ring: 48, stroke: 4, fontSize: 'text-base' },
};

export const ContextWindowIndicator: React.FC<ContextWindowIndicatorProps> = ({
  usedTokens,
  engine,
  model,
  size = 'sm',
  showWarnings = true,
  className,
  maxContextWindow,
}) => {
  const [dismissedWarningLevel, setDismissedWarningLevel] = useState<'none' | 'warning' | 'critical'>('none');
  
  // 计算状态 - 优先使用从 Codex 消息中提取的上下文窗口大小
  const maxTokens = maxContextWindow || getMaxTokensForEngine(engine, model);
  const usagePercent = calculateUsagePercent(usedTokens, maxTokens);
  const remainingPercent = 100 - usagePercent;
  const colorStatus = getColorStatus(usagePercent);
  const warningLevel = getWarningLevel(usagePercent);
  const colorClasses = getColorClasses(colorStatus);
  
  // 判断是否显示警告
  const shouldShowWarning = showWarnings && warningLevel !== 'none' && (
    (warningLevel === 'critical' && dismissedWarningLevel !== 'critical') ||
    (warningLevel === 'warning' && dismissedWarningLevel === 'none')
  );
  
  // 尺寸配置
  const config = SIZE_CONFIG[size];
  const radius = (config.ring - config.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (usagePercent / 100) * circumference;
  
  // 关闭警告
  const handleDismissWarning = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissedWarningLevel(warningLevel);
  };

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div 
              className={cn(
                'relative flex items-center justify-center cursor-default',
                'hover:opacity-80 transition-opacity'
              )}
              style={{ width: config.ring, height: config.ring }}
            >
              {/* 背景圆环 */}
              <svg
                className="absolute transform -rotate-90"
                width={config.ring}
                height={config.ring}
              >
                <circle
                  cx={config.ring / 2}
                  cy={config.ring / 2}
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={config.stroke}
                  className="text-muted-foreground/20"
                />
                {/* 进度圆环 */}
                <circle
                  cx={config.ring / 2}
                  cy={config.ring / 2}
                  r={radius}
                  fill="none"
                  strokeWidth={config.stroke}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  className={cn(colorClasses.stroke, 'transition-all duration-300')}
                />
              </svg>
              {/* 百分比文字 */}
              <span className={cn(config.fontSize, 'font-medium', colorClasses.text)}>
                {Math.round(usagePercent)}%
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1.5 py-1">
              <div className="font-medium text-sm">上下文窗口</div>
              <div className="text-xs space-y-1">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">使用情况:</span>
                  <span className={cn('font-mono', colorClasses.text)}>
                    {Math.round(usagePercent)}% 已用 ({Math.round(remainingPercent)}% 剩余)
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Token 数量:</span>
                  <span className="font-mono">
                    {formatTokenCount(usedTokens)} / {formatTokenCount(maxTokens)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">引擎:</span>
                  <span className="capitalize">{engine}</span>
                </div>
                {model && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">模型:</span>
                    <span className="font-mono text-[10px]">{model}</span>
                  </div>
                )}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      
      {/* 警告提示 */}
      {shouldShowWarning && (
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-md text-xs',
            warningLevel === 'critical'
              ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
              : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
          )}
        >
          <AlertTriangle className="h-3 w-3" />
          <span>
            {warningLevel === 'critical' ? '上下文即将满' : '上下文较高'}
          </span>
          <button
            onClick={handleDismissWarning}
            className="ml-1 hover:opacity-70 transition-opacity"
            aria-label="关闭警告"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
};

export default ContextWindowIndicator;
