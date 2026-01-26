import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover } from "@/components/ui/popover";
import { DollarSign, Info } from "lucide-react";
import { motion } from "framer-motion";
import { formatDuration } from "@/lib/pricing";
import { ExecutionEngineSelector, type ExecutionEngineConfig } from "@/components/ExecutionEngineSelector";
import { ModelSelector } from "./ModelSelector";
import { ThinkingModeToggle } from "./ThinkingModeToggle";
import { PlanModeToggle } from "./PlanModeToggle";
import { SessionToolbar } from "@/components/SessionToolbar";
import { CodexRateLimits } from "@/components/widgets/CodexRateLimits";
import { CodexCompactSelector } from "@/components/codex/CodexCompactSelector";
import { EnhanceButton } from "./EnhanceButton";
import { ContextWindowIndicator } from "@/components/ContextWindowIndicator";
import { ModelType, ModelConfig } from "./types";
import type { EngineType } from "@/lib/contextWindow";

interface ControlBarProps {
  disabled?: boolean;
  isLoading: boolean;
  prompt: string;
  hasAttachments?: boolean;
  executionEngineConfig: ExecutionEngineConfig;
  setExecutionEngineConfig: (config: ExecutionEngineConfig) => void;
  selectedModel: ModelType;
  setSelectedModel: (model: ModelType) => void;
  availableModels: ModelConfig[];
  selectedThinkingMode: string;
  handleToggleThinkingMode: () => void;
  isPlanMode?: boolean;
  onTogglePlanMode?: () => void;
  hasMessages: boolean;
  sessionCost?: string;
  sessionStats?: any;
  showCostPopover: boolean;
  setShowCostPopover: (show: boolean) => void;
  messages?: any[];
  session?: any;
  isEnhancing: boolean;
  projectPath?: string;
  enableProjectContext: boolean;
  setEnableProjectContext: (enable: boolean) => void;
  enableDualAPI: boolean;
  setEnableDualAPI: (enable: boolean) => void;
  getEnabledProviders: () => any[];
  handleEnhancePromptWithAPI: (id: string) => void;
  onCancel: () => void;
  onSend: () => void;
  // 🆕 新增属性
  defaultProviderId?: string | null;
  setDefaultProviderId?: (id: string | null) => void;
  historyCount?: number;
  onOpenHistory?: () => void;
  onEnhance?: (providerId?: string) => void;
}

export const ControlBar: React.FC<ControlBarProps> = ({
  disabled,
  isLoading,
  prompt,
  hasAttachments = false,
  executionEngineConfig,
  setExecutionEngineConfig,
  selectedModel,
  setSelectedModel,
  availableModels,
  selectedThinkingMode,
  handleToggleThinkingMode,
  isPlanMode,
  onTogglePlanMode,
  hasMessages,
  sessionCost,
  sessionStats,
  showCostPopover,
  setShowCostPopover,
  messages,
  session,
  isEnhancing,
  projectPath,
  enableProjectContext,
  setEnableProjectContext,
  enableDualAPI,
  setEnableDualAPI,
  getEnabledProviders,
  handleEnhancePromptWithAPI,
  onCancel,
  onSend,
  // 🆕 新增属性
  defaultProviderId,
  setDefaultProviderId,
  historyCount = 0,
  onOpenHistory,
  onEnhance,
}) => {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Execution Engine Selector */}
      <ExecutionEngineSelector
        value={executionEngineConfig}
        onChange={setExecutionEngineConfig}
      />

      {/* Only show Claude-specific controls for Claude Code */}
      {executionEngineConfig.engine === 'claude' && (
        <>
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            disabled={disabled}
            availableModels={availableModels}
          />

          <ThinkingModeToggle
            isEnabled={selectedThinkingMode === "on"}
            onToggle={handleToggleThinkingMode}
            disabled={disabled}
          />

          {onTogglePlanMode && (
            <PlanModeToggle
              isPlanMode={isPlanMode || false}
              onToggle={onTogglePlanMode}
              disabled={disabled}
            />
          )}
        </>
      )}

      {/* Codex 模型和推理模式选择 - 只在 Codex 引擎时显示 */}
      {executionEngineConfig.engine === 'codex' && (
        <CodexCompactSelector
          config={{
            model: executionEngineConfig.codexModel,
            reasoningMode: executionEngineConfig.codexReasoningMode,
          }}
          onConfigChange={(config) => {
            setExecutionEngineConfig({
              ...executionEngineConfig,
              codexModel: config.model,
              codexReasoningMode: config.reasoningMode,
            });
          }}
          disabled={disabled || isLoading}
        />
      )}

      {/* Codex Rate Limits - 只在 Codex 引擎时显示 */}
      {executionEngineConfig.engine === 'codex' && (
        <CodexRateLimits
          autoRefresh={true}
          refreshInterval={30000}
          sessionId={session?.id}
        />
      )}

      {/* Context Window Indicator - 上下文窗口使用情况 */}
      {hasMessages && sessionStats && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
        >
          <ContextWindowIndicator
            usedTokens={sessionStats.totalTokens || 0}
            engine={executionEngineConfig.engine as EngineType}
            model={executionEngineConfig.engine === 'claude' ? selectedModel : undefined}
            size="sm"
            showWarnings={true}
            maxContextWindow={sessionStats.contextWindow}
          />
        </motion.div>
      )}

      {/* Session Cost with Details */}
      {hasMessages && sessionCost && sessionStats && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
          onMouseEnter={() => setShowCostPopover(true)}
          onMouseLeave={() => setShowCostPopover(false)}
        >
          <Popover
            open={showCostPopover}
            onOpenChange={setShowCostPopover}
            trigger={
              <Badge variant="outline" className="flex items-center gap-1 px-2 py-1 h-8 cursor-default hover:bg-accent transition-colors border-border/50">
                <DollarSign className="h-3 w-3 text-green-600 dark:text-green-400" />
                <span className="font-mono text-xs">{sessionCost}</span>
                <Info className="h-3 w-3 text-muted-foreground ml-1" />
              </Badge>
            }
            content={
              <div className="space-y-2">
                <div className="font-medium text-sm border-b pb-1">会话统计</div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">总成本:</span>
                    <span className="font-mono font-medium">{sessionCost}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">总 Tokens:</span>
                    <span className="font-mono">{sessionStats.totalTokens.toLocaleString()}</span>
                  </div>
                  {/* ... other stats ... */}
                  {sessionStats.durationSeconds > 0 && (
                    <>
                      <div className="border-t pt-1 mt-1"></div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">会话时长:</span>
                        <span className="font-mono">{formatDuration(sessionStats.durationSeconds)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            }
            side="top"
            align="center"
            className="w-80"
          />
        </motion.div>
      )}

      {/* Loading Indicator */}
      {isLoading && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.2 }}
          className="flex items-center gap-1.5 px-2 py-1 bg-blue-50/50 dark:bg-blue-900/20 border border-blue-200/50 dark:border-blue-800/50 rounded-md text-xs text-blue-600 dark:text-blue-400 h-8"
        >
          <div className="rotating-symbol text-blue-600 dark:text-blue-400" style={{ width: '12px', height: '12px' }} />
          <span>处理中</span>
        </motion.div>
      )}

      <div className="flex-1" />

      {/* Session Export Toolbar */}
      {messages && messages.length > 0 && (
        <SessionToolbar
          messages={messages}
          session={session}
          isStreaming={isLoading}
        />
      )}

      {/* 🆕 新的优化按钮 */}
      <EnhanceButton
        disabled={disabled}
        isEnhancing={isEnhancing}
        hasText={!!prompt.trim()}
        defaultProviderId={defaultProviderId || null}
        enabledProviders={getEnabledProviders()}
        enableProjectContext={enableProjectContext}
        enableDualAPI={enableDualAPI}
        hasProjectPath={!!projectPath}
        historyCount={historyCount}
        onEnhance={(providerId) => {
          if (onEnhance) {
            onEnhance(providerId);
          } else if (providerId) {
            handleEnhancePromptWithAPI(providerId);
          }
        }}
        onSetDefaultProvider={setDefaultProviderId || (() => {})}
        onToggleProjectContext={setEnableProjectContext}
        onToggleDualAPI={(checked) => {
          setEnableDualAPI(checked);
          localStorage.setItem('enable_dual_api_enhancement', String(checked));
        }}
        onOpenSettings={() => window.dispatchEvent(new CustomEvent('open-prompt-api-settings'))}
        onOpenHistory={onOpenHistory || (() => {})}
      />

      {/* Send/Cancel Button */}
      {isLoading ? (
        <Button
          onClick={onCancel}
          variant="destructive"
          size="default"
          disabled={disabled}
          className="h-8 shadow-md bg-red-500 hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700 text-white font-medium"
        >
          取消
        </Button>
      ) : (
        <Button
          onClick={onSend}
          disabled={(!prompt.trim() && !hasAttachments) || disabled}
          size="default"
          className="h-8 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-sm transition-all duration-200"
        >
          发送
        </Button>
      )}
    </div>
  );
};