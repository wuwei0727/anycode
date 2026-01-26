import React, { useState, useEffect, useMemo } from 'react';
import { Bot } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { ReasoningModeOption, CodexModelOption } from '@/types/codex-selector';

interface CodexCompactSelectorProps {
  /** 当前配置 */
  config: {
    model?: string;
    reasoningMode?: string;
  };
  /** 配置变更回调 */
  onConfigChange: (config: { model: string; reasoningMode: string }) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

/**
 * Codex 紧凑选择器组件
 * 在底部工具栏显示模型和推理模式选择
 */
export const CodexCompactSelector: React.FC<CodexCompactSelectorProps> = ({
  config,
  onConfigChange,
  disabled = false,
}) => {
  const [reasoningModes, setReasoningModes] = useState<ReasoningModeOption[]>([]);
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [loading, setLoading] = useState(true);

  // 加载配置选项
  useEffect(() => {
    loadCapabilities();
  }, []);

  const loadCapabilities = async () => {
    try {
      setLoading(true);
      // 使用强制刷新确保获取最新的能力信息
      const capabilities = await api.forceRefreshCodexCapabilities();
      setReasoningModes(capabilities.reasoningModes);
      setModels(capabilities.models);
    } catch (err) {
      console.error('[CodexCompactSelector] Failed to load capabilities:', err);
      // 如果强制刷新失败，尝试普通刷新
      try {
        const capabilities = await api.refreshCodexCapabilities();
        setReasoningModes(capabilities.reasoningModes);
        setModels(capabilities.models);
      } catch (fallbackErr) {
        console.error('[CodexCompactSelector] Fallback refresh also failed:', fallbackErr);
      }
    } finally {
      setLoading(false);
    }
  };

  // 获取当前选择模型支持的推理模式
  const availableReasoningModes = useMemo(() => {
    const currentModel = config.model || 'gpt-5.2-codex';
    const selectedModel = models.find(m => m.value === currentModel);
    if (!selectedModel || !selectedModel.supportedReasoningModes) {
      return reasoningModes;
    }
    return reasoningModes.filter(mode =>
      selectedModel.supportedReasoningModes.includes(mode.value)
    );
  }, [config.model, models, reasoningModes]);

  const handleModelChange = async (model: string) => {
    const selectedModel = models.find(m => m.value === model);
    let newReasoningMode = config.reasoningMode || 'medium';
    
    // 检查当前推理模式是否被新模型支持
    if (selectedModel && !selectedModel.supportedReasoningModes.includes(newReasoningMode)) {
      newReasoningMode = selectedModel.supportedReasoningModes[0] || 'medium';
    }

    const newConfig = { model, reasoningMode: newReasoningMode };
    onConfigChange(newConfig);
    
    // 保存配置
    try {
      await api.saveCodexSelectionConfig({
        model,
        reasoningMode: newReasoningMode,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('[CodexCompactSelector] Failed to save config:', err);
    }
  };

  const handleReasoningModeChange = async (reasoningMode: string) => {
    const newConfig = { 
      model: config.model || 'gpt-5.2-codex', 
      reasoningMode 
    };
    onConfigChange(newConfig);
    
    // 保存配置
    try {
      await api.saveCodexSelectionConfig({
        ...newConfig,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('[CodexCompactSelector] Failed to save config:', err);
    }
  };

  // 获取显示标签
  const getModelLabel = (modelValue: string) => {
    const model = models.find(m => m.value === modelValue);
    return model?.label || modelValue;
  };

  const getReasoningModeLabel = (modeValue: string) => {
    const mode = reasoningModes.find(m => m.value === modeValue);
    return mode?.label || modeValue;
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Bot className="h-3 w-3 animate-pulse" />
        <span>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* 模型选择 */}
      <Select 
        value={config.model || 'gpt-5.2-codex'} 
        onValueChange={handleModelChange}
        disabled={disabled}
      >
        <SelectTrigger className="h-7 w-auto min-w-[120px] text-xs border-border/50 bg-background/50">
          <SelectValue>
            {getModelLabel(config.model || 'gpt-5.2-codex')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem
              key={model.value}
              value={model.value}
              disabled={!model.isAvailable}
              className="text-xs"
            >
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* 推理模式选择 */}
      <Select 
        value={config.reasoningMode || 'medium'} 
        onValueChange={handleReasoningModeChange}
        disabled={disabled}
      >
        <SelectTrigger className="h-7 w-auto min-w-[100px] text-xs border-border/50 bg-background/50">
          <SelectValue>
            {getReasoningModeLabel(config.reasoningMode || 'medium')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {availableReasoningModes.map((mode) => (
            <SelectItem key={mode.value} value={mode.value} className="text-xs">
              {mode.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

export default CodexCompactSelector;
