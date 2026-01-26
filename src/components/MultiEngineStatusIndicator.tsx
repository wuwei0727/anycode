import React, { useState } from "react";
import { Loader2, RefreshCw, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { ENGINES, ENVIRONMENT_ICONS, ENVIRONMENT_LABELS } from "@/lib/engineConfig";
import type { EngineType } from "@/types/engine";

interface MultiEngineStatusIndicatorProps {
  className?: string;
  onSettingsClick?: () => void;
  compact?: boolean;
}

/**
 * 多引擎状态指示器
 * 显示 Claude、Codex、Gemini 三个引擎的状态
 */
export const MultiEngineStatusIndicator: React.FC<MultiEngineStatusIndicatorProps> = ({
  className,
  onSettingsClick,
  compact = false
}) => {
  const [selectedEngine, setSelectedEngine] = useState<EngineType | null>(null);
  const [updateInfo, setUpdateInfo] = useState<Record<EngineType, { currentVersion?: string; latestVersion?: string; updateAvailable: boolean } | null>>({
    claude: null,
    codex: null,
    gemini: null,
  });
  
  // 使用 Hook 管理引擎状态
  const { engineStatuses, isRefreshing, isCheckingUpdate, isUpdating, refreshEngine, checkUpdate, updateEngine } = useEngineStatus();

  // 获取状态指示器（小圆点）
  const getStatusDot = (statusType: "connected" | "disconnected" | "checking" | "error") => {
    switch (statusType) {
      case "connected":
        return (
          <div className="h-2 w-2 rounded-full bg-green-500 ring-1 ring-background shadow-sm" />
        );
      case "disconnected":
        return (
          <div className="h-2 w-2 rounded-full bg-red-500 ring-1 ring-background shadow-sm" />
        );
      case "checking":
        return <Loader2 className="h-2 w-2 text-blue-500 animate-spin" />;
      case "error":
        return (
          <div className="h-2 w-2 rounded-full bg-yellow-500 ring-1 ring-background shadow-sm" />
        );
    }
  };

  // 获取状态文本
  const getStatusText = (statusType: "connected" | "disconnected" | "checking" | "error") => {
    switch (statusType) {
      case "connected":
        return "已连接";
      case "disconnected":
        return "未连接";
      case "checking":
        return "检查中";
      case "error":
        return "错误";
    }
  };

  return (
    <div className={cn("w-full", className)}>
      <TooltipProvider>
        <div className={cn(
          "flex gap-2",
          compact ? "flex-col items-center" : "flex-row justify-center"
        )}>
          {ENGINES.map((engine) => {
            const status = engineStatuses[engine.type];
            const isSelected = selectedEngine === engine.type;
            const isCurrentlyRefreshing = isRefreshing[engine.type];
            const isCurrentlyCheckingUpdate = isCheckingUpdate[engine.type];
            const isCurrentlyUpdating = isUpdating[engine.type];
            const updateInfoForEngine = updateInfo[engine.type];
            const { Icon } = engine;

            return (
              <Popover
                key={engine.type}
                open={isSelected}
                onOpenChange={(open) => setSelectedEngine(open ? engine.type : null)}
                trigger={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "relative h-10 w-10 p-0 rounded-lg transition-all",
                          engine.bgColor,
                          isSelected && "ring-2 ring-primary"
                        )}
                      >
                        <div className="relative flex items-center justify-center">
                          <Icon className={cn("h-5 w-5", engine.color)} />
                          <div className="absolute bottom-0 right-0 translate-x-1 translate-y-1">
                            {getStatusDot(status.status)}
                          </div>
                        </div>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side={compact ? "right" : "top"}>
                      <p>{engine.name}</p>
                    </TooltipContent>
                  </Tooltip>
                }
                content={
                  <div className="space-y-3 w-[320px] max-h-[500px] overflow-y-auto p-4">
                    {/* 头部 */}
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-sm">
                        {engine.displayName} 状态
                      </h4>
                      <div className="flex items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => refreshEngine(engine.type)}
                              disabled={isCurrentlyRefreshing}
                              className="h-7 w-7 p-0"
                            >
                              <RefreshCw
                                className={cn(
                                  "h-3.5 w-3.5",
                                  isCurrentlyRefreshing && "animate-spin"
                                )}
                              />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>刷新状态</TooltipContent>
                        </Tooltip>

                        {onSettingsClick && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={onSettingsClick}
                                className="h-7 w-7 p-0"
                              >
                                <Settings className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{engine.displayName} 设置</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>

                    {/* 状态详情 */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">
                          连接状态:
                        </span>
                        <Badge
                          variant={
                            status.status === "connected" ? "default" : "secondary"
                          }
                          className="text-xs"
                        >
                          {getStatusText(status.status)}
                        </Badge>
                      </div>

                      {status.environment && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            运行环境:
                          </span>
                          <span className="text-xs">
                            {ENVIRONMENT_ICONS[status.environment]}{" "}
                            {ENVIRONMENT_LABELS[status.environment]}
                            {status.wslDistro && ` (${status.wslDistro})`}
                          </span>
                        </div>
                      )}

                      {status.version && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            版本:
                          </span>
                          <Badge variant="outline" className="text-xs font-mono">
                            {status.version}
                          </Badge>
                        </div>
                      )}

                      {status.path && (
                        <div className="flex flex-col gap-1">
                          <span className="text-sm text-muted-foreground">
                            路径:
                          </span>
                          <span className="text-xs font-mono text-muted-foreground break-all">
                            {status.path}
                          </span>
                        </div>
                      )}

                      {status.lastChecked && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            最后检查:
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {status.lastChecked.toLocaleTimeString("zh-CN")}
                          </span>
                        </div>
                      )}

                      {status.error && (
                        <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                          {status.error}
                        </div>
                      )}
                      
                      {/* 更新按钮 */}
                      {status.status === "connected" && status.environment && (
                        <div className="pt-2 border-t space-y-2">
                          {/* 显示更新信息 */}
                          {updateInfoForEngine && (
                            <div className="text-xs space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground shrink-0">当前版本:</span>
                                <span className="font-mono text-right break-all">{updateInfoForEngine.currentVersion || status.version}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground shrink-0">最新版本:</span>
                                <span className="font-mono font-semibold text-primary text-right break-all">
                                  {updateInfoForEngine.latestVersion || '查询失败'}
                                </span>
                              </div>
                              {updateInfoForEngine.updateAvailable && (
                                <div className="text-green-600 dark:text-green-400 font-medium text-center py-1">
                                  ✓ 有新版本可用
                                </div>
                              )}
                              {!updateInfoForEngine.updateAvailable && updateInfoForEngine.latestVersion && (
                                <div className="text-muted-foreground text-center py-1">
                                  已是最新版本
                                </div>
                              )}
                            </div>
                          )}
                          
                          {/* 检查更新按钮 */}
                          {!updateInfoForEngine && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={async () => {
                                try {
                                  const result = await checkUpdate(engine.type);
                                  setUpdateInfo(prev => ({
                                    ...prev,
                                    [engine.type]: {
                                      currentVersion: result.currentVersion,
                                      latestVersion: result.latestVersion,
                                      updateAvailable: result.updateAvailable,
                                    }
                                  }));
                                } catch (error) {
                                  console.error('Check update failed:', error);
                                  alert(`检查更新失败: ${error instanceof Error ? error.message : String(error)}`);
                                }
                              }}
                              disabled={isCurrentlyCheckingUpdate || isCurrentlyRefreshing}
                            >
                              {isCurrentlyCheckingUpdate ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                                  检查中...
                                </>
                              ) : (
                                <>
                                  <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                  检查更新
                                </>
                              )}
                            </Button>
                          )}
                          
                          {/* 执行更新按钮 */}
                          {updateInfoForEngine && updateInfoForEngine.updateAvailable && (
                            <Button
                              variant="default"
                              size="sm"
                              className="w-full"
                              onClick={async () => {
                                try {
                                  await updateEngine(engine.type);
                                  // 更新成功后清除更新信息
                                  setUpdateInfo(prev => ({
                                    ...prev,
                                    [engine.type]: null
                                  }));
                                } catch (error) {
                                  console.error('Update failed:', error);
                                  alert(`更新失败: ${error instanceof Error ? error.message : String(error)}`);
                                }
                              }}
                              disabled={isCurrentlyUpdating || isCurrentlyRefreshing}
                            >
                              {isCurrentlyUpdating ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                                  更新中...
                                </>
                              ) : (
                                <>
                                  <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                  立即更新
                                </>
                              )}
                            </Button>
                          )}
                          
                          {/* 重新检查按钮 */}
                          {updateInfoForEngine && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full"
                              onClick={() => {
                                setUpdateInfo(prev => ({
                                  ...prev,
                                  [engine.type]: null
                                }));
                              }}
                            >
                              重新检查
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                }
                side="right"
                align="center"
              />
          );
        })}
        </div>
      </TooltipProvider>
    </div>
  );
};
