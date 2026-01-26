import React, { useState, useEffect, useMemo } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { CodexSelectionConfig, ReasoningModeOption, CodexModelOption } from '@/types/codex-selector';

interface CodexInlineConfigProps {
  /** 当前配置 */
  config: CodexSelectionConfig | null;
  /** 配置变更回调 */
  onConfigChange: (config: CodexSelectionConfig) => void;
  /** 是否可见（仅 Codex 引擎时显示） */
  visible: boolean;
  /** 可选的类名 */
  className?: string;
}

/**
 * Codex 内联配置组件
 * 在会话列表下方显示紧凑的模型和推理模式选择器
 */
export const CodexInlineConfig: React.FC<CodexInlineConfigProps> = ({
  config,
  onConfigChange,
  visible,
  className,
}) => {
  const [reasoningModes, setReasoningModes] = useState<ReasoningModeOption[]>([]);
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载配置选项
  useEffect(() => {
    if (visible) {
      loadCapabilities();
    }
  }, [visible]);

  const loadCapabilities = async () => {
    try {
      setLoading(true);
      setError(null);
      const capabilities = await api.refreshCodexCapabilities();
      setReasoningModes(capabilities.reasoningModes);
      setModels(capabilities.models);
    } catch (err) {
      console.error('[CodexInlineConfig] Failed to load capabilities:', err);
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // 获取当前选择模型支持的推理模式
  const availableReasoningModes = useMemo(() => {
    if (!config) return reasoningModes;

    const selectedModel = models.find(m => m.value === config.model);
    if (!selectedModel || !selectedModel.supportedReasoningModes) {
      return reasoningModes;
    }

    return reasoningModes.filter(mode =>
      selectedModel.supportedReasoningModes.includes(mode.value)
    );
  }, [config, models, reasoningModes]);

  const handleModelChange = async (model: string) => {
    if (!config) return;

    // 找到选择的模型
    const selectedModel = models.find(m => m.value === model);

    // 检查当前推理模式是否被新模型支持
    let newReasoningMode = config.reasoningMode;
    if (selectedModel && !selectedModel.supportedReasoningModes.includes(config.reasoningMode)) {
      newReasoningMode = selectedModel.supportedReasoningModes[0] || 'medium';
    }

    const newConfig: CodexSelectionConfig = {
      ...config,
      model,
      reasoningMode: newReasoningMode,
      timestamp: Date.now(),
    };

    onConfigChange(newConfig);
    await saveConfig(newConfig);
  };

  const handleReasoningModeChange = async (mode: string) => {
    if (!config) return;

    const newConfig: CodexSelectionConfig = {
      ...config,
      reasoningMode: mode,
      timestamp: Date.now(),
    };

    onConfigChange(newConfig);
    await saveConfig(newConfig);
  };

  const saveConfig = async (configToSave: CodexSelectionConfig) => {
    try {
      await api.saveCodexSelectionConfig(configToSave);
    } catch (err) {
      console.error('[CodexInlineConfig] Failed to save config:', err);
    }
  };

  // 获取模型显示名称
  const getModelLabel = (modelValue: string) => {
    const model = models.find(m => m.value === modelValue);
    return model?.label || modelValue;
  };

  // 获取推理模式显示名称
  const getReasoningModeLabel = (modeValue: string) => {
    const mode = reasoningModes.find(m => m.value === modeValue);
    return mode?.label || modeValue;
  };

  if (!visible) return null;

  return (
    <div className={cn(
      "flex items-center gap-3 p-3 bg-muted/30 rounded-lg border border-border",
      className
    )}>
      {/* Codex 图标和标签 */}
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Bot className="h-4 w-4" />
        <span>Codex 配置</span>
      </div>

      {/* 分隔线 */}
      <div className="h-6 w-px bg-border" />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>加载中...</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadCapabilities}
            className="h-7 px-2"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            重试
          </Button>
        </div>
      ) : config ? (
        <>
          {/* 模型选择 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">模型:</span>
            <Select value={config.model} onValueChange={handleModelChange}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue placeholder="选择模型">
                  {getModelLabel(config.model)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem
                    key={model.value}
                    value={model.value}
                    disabled={!model.isAvailable}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{model.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {model.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 推理模式选择 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">推理:</span>
            <Select value={config.reasoningMode} onValueChange={handleReasoningModeChange}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="选择推理模式">
                  {getReasoningModeLabel(config.reasoningMode)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {availableReasoningModes.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    <div className="flex flex-col">
                      <span className="font-medium">{mode.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {mode.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 刷新按钮 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={loadCapabilities}
            className="h-7 w-7 p-0 ml-auto"
            title="刷新配置选项"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </>
      ) : null}
    </div>
  );
};

export default CodexInlineConfig;
