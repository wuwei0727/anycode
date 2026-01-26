import React, { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api, type CodexRateLimits as CodexRateLimitsType } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/popover";

interface CodexRateLimitsProps {
  className?: string;
  /** 是否自动刷新 */
  autoRefresh?: boolean;
  /** 刷新间隔（毫秒），默认 30 秒 */
  refreshInterval?: number;
  /** 会话标识，用于在新建/切换会话时强制刷新 */
  sessionId?: string;
}

/**
 * Codex Rate Limits 显示组件
 * 显示 5 小时和每周的配额使用情况，样式参考官方 Codex 插件
 */
export const CodexRateLimits: React.FC<CodexRateLimitsProps> = ({
  className,
  autoRefresh = true,
  refreshInterval = 30000,
  sessionId,
}) => {
  const [rateLimits, setRateLimits] = useState<CodexRateLimitsType | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRateLimits = useCallback(async () => {
    try {
      const limits = await api.getCodexRateLimits();
      setRateLimits(limits);
      setError(null);
    } catch (err) {
      console.error("[CodexRateLimits] Failed to fetch:", err);
      setError(err instanceof Error ? err.message : "获取配额失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 初始加载 + 会话切换时强制刷新
  useEffect(() => {
    fetchRateLimits();
  }, [fetchRateLimits, sessionId]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(fetchRateLimits, refreshInterval);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, fetchRateLimits]);

  // 如果没有数据，不显示
  if (isLoading) {
    return (
      <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground h-8 px-2", className)}>
        <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        <span>加载...</span>
      </div>
    );
  }

  if (error || !rateLimits || (!rateLimits.primary && !rateLimits.secondary)) {
    return null;
  }

  const { primary, secondary } = rateLimits;

  // 计算颜色：绿色 > 50%, 黄色 20-50%, 红色 < 20%
  const getColorClass = (remaining: number) => {
    if (remaining >= 50) return "text-green-500 dark:text-green-400";
    if (remaining >= 20) return "text-yellow-500 dark:text-yellow-400";
    return "text-red-500 dark:text-red-400";
  };

  return (
    <div className={cn("relative", className)}>
      <Popover
        open={isOpen}
        onOpenChange={setIsOpen}
        trigger={
          <div
            className="flex items-center gap-2 px-2 py-1 h-8 rounded-md bg-background/60 backdrop-blur-sm border border-border/50 cursor-pointer hover:bg-accent/50 transition-colors"
          >
            {/* 圆形图标 - 类似官方 */}
            <svg className="w-3.5 h-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            
            {/* 5h 配额 */}
            {primary && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">5h</span>
                <span className={cn("text-xs font-mono font-medium", getColorClass(primary.remaining_percent))}>
                  {Math.round(primary.remaining_percent)}%
                </span>
              </div>
            )}

            {/* 分隔符 */}
            {primary && secondary && (
              <div className="w-px h-3 bg-border/50" />
            )}

            {/* Weekly 配额 */}
            {secondary && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">周</span>
                <span className={cn("text-xs font-mono font-medium", getColorClass(secondary.remaining_percent))}>
                  {Math.round(secondary.remaining_percent)}%
                </span>
              </div>
            )}

            {/* 展开/折叠图标 */}
            {isOpen ? (
              <ChevronUp className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        }
        content={
          <div className="space-y-3 min-w-[200px]">
            {/* 标题 - 类似官方 */}
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <span className="text-sm font-medium">Rate limits remaining</span>
            </div>

            {/* 5h 配额详情 */}
            {primary && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold">5h</span>
                <div className="flex items-center gap-2">
                  <span className={cn("text-sm font-mono", getColorClass(primary.remaining_percent))}>
                    {Math.round(primary.remaining_percent)}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    · {primary.resets_at_formatted}
                  </span>
                </div>
              </div>
            )}

            {/* Weekly 配额详情 */}
            {secondary && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold">Weekly</span>
                <div className="flex items-center gap-2">
                  <span className={cn("text-sm font-mono", getColorClass(secondary.remaining_percent))}>
                    {Math.round(secondary.remaining_percent)}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    · {secondary.resets_at_formatted}
                  </span>
                </div>
              </div>
            )}
          </div>
        }
        side="top"
        align="center"
        className="w-auto"
      />
    </div>
  );
};

export default CodexRateLimits;
