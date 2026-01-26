/**
 * ✅ System Initialized Widget - 系统初始化信息展示
 *
 * 迁移并拆分自 ToolWidgets.tsx (原 2266-2493 行)
 * 主组件 (~100行) + ToolsList 子组件 (~180行)
 */

import React from "react";
import { Settings } from "lucide-react";

export interface SystemInitializedWidgetProps {
  /** 会话 ID */
  sessionId?: string;
  /** 模型名称 */
  model?: string;
  /** 工作目录 */
  cwd?: string;
  /** 可用工具列表 */
  tools?: string[];
  /** 时间戳 */
  timestamp?: string;
}

/**
 * 系统初始化 Widget
 *
 * 展示会话初始化信息，包括会话 ID、模型、工作目录和可用工具
 */
export const SystemInitializedWidget: React.FC<SystemInitializedWidgetProps> = ({
  timestamp,
}) => {
  /**
   * 格式化时间戳
   */
  const formatTimestamp = (timestamp: string | undefined): string => {
    if (!timestamp) return '';

    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return '';

      return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-1.5 text-sm text-blue-600 dark:text-blue-400">
      <div className="flex items-center gap-2">
        <Settings className="h-3.5 w-3.5" />
        <span>System Initialized</span>
        {formatTimestamp(timestamp) && (
          <>
            <span className="text-muted-foreground/40">•</span>
            <span className="text-xs text-muted-foreground font-mono">
              {formatTimestamp(timestamp)}
            </span>
          </>
        )}
      </div>
    </div>
  );
};
