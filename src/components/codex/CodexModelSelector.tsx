import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CodexModelSelectorProps, CodexSelectionConfig, ReasoningModeOption, CodexModelOption } from '@/types/codex-selector';
import { ReasoningModeSelector } from './ReasoningModeSelector';
import { ModelSelector } from './ModelSelector';
import { api } from '@/lib/api';

/**
 * Codex 模型和推理模式选择器主组件
 * 集成推理模式选择器和模型选择器，提供完整的配置界面
 */
export const CodexModelSelector: React.FC<CodexModelSelectorProps> = ({
  onConfigChange,
  initialConfig,
  isVisible,
  onConfirm,
  onCancel,
  showConfirmButton = true,
}) => {
  // 状态管理
  const [config, setConfig] = useState<CodexSelectionConfig | null>(null);
  const [reasoningModes, setReasoningModes] = useState<ReasoningModeOption[]>([]);
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 使用 ref 来跟踪是否已经初始化，避免重复初始化
  const initializedRef = useRef(false);

  // 初始化配置
  useEffect(() => {
    console.log('[CodexModelSelector] useEffect triggered:', { isVisible, initialConfig, initialized: initializedRef.current });
    if (isVisible && !initializedRef.current) {
      initializedRef.current = true;
      initializeConfig();
    }
    
    // 当选择器关闭时重置初始化状态
    if (!isVisible) {
      initializedRef.current = false;
    }
  }, [isVisible]);

  const initializeConfig = async () => {
    try {
      setLoading(true);
      setError(null);

      // 并行加载配置和能力信息
      const [savedConfig, defaultConfig, capabilities] = await Promise.all([
        api.getCodexSelectionConfig(),
        api.getDefaultCodexSelectionConfig(),
        api.refreshCodexCapabilities(),
      ]);

      // 使用优先级：savedConfig（从 config.toml 读取）> initialConfig > defaultConfig
      // savedConfig 优先，确保与 Codex CLI 配置同步
      const finalConfig = savedConfig || initialConfig || defaultConfig;
      
      console.log('[CodexModelSelector] 配置优先级选择:', {
        savedConfig,
        initialConfig,
        defaultConfig,
        finalConfig
      });
      
      setConfig(finalConfig);
      setReasoningModes(capabilities.reasoningModes);
      setModels(capabilities.models);

      console.log('[CodexModelSelector] 初始化完成:', {
        finalConfig,
        reasoningModes: capabilities.reasoningModes,
        reasoningModesCount: capabilities.reasoningModes.length,
        models: capabilities.models,
        modelsCount: capabilities.models.length
      });

      // 初始化时通知父组件当前配置
      onConfigChange(finalConfig);
    } catch (err) {
      console.error('Failed to initialize Codex selector:', err);
      setError(err instanceof Error ? err.message : '初始化失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReasoningModeChange = (mode: string) => {
    if (!config) return;

    const newConfig: CodexSelectionConfig = {
      ...config,
      reasoningMode: mode,
      timestamp: Date.now(),
    };

    setConfig(newConfig);
    onConfigChange(newConfig);
    
    // 自动保存配置
    saveConfig(newConfig);
  };

  const handleModelChange = (model: string) => {
    if (!config) return;

    // 找到选择的模型
    const selectedModel = models.find(m => m.value === model);
    
    // 检查当前推理模式是否被新模型支持
    let newReasoningMode = config.reasoningMode;
    if (selectedModel && !selectedModel.supportedReasoningModes.includes(config.reasoningMode)) {
      // 如果当前推理模式不被支持，选择该模型支持的第一个模式
      newReasoningMode = selectedModel.supportedReasoningModes[0] || 'medium';
    }

    const newConfig: CodexSelectionConfig = {
      ...config,
      model: model,
      reasoningMode: newReasoningMode,
      timestamp: Date.now(),
    };

    setConfig(newConfig);
    onConfigChange(newConfig);
    
    // 自动保存配置
    saveConfig(newConfig);
  };

  const saveConfig = async (configToSave: CodexSelectionConfig) => {
    try {
      await api.saveCodexSelectionConfig(configToSave);
    } catch (err) {
      console.error('Failed to save Codex selection config:', err);
      // 不显示错误，因为这是自动保存
    }
  };

  // 获取当前选择模型支持的推理模式
  const getAvailableReasoningModes = (): ReasoningModeOption[] => {
    if (!config) return reasoningModes;

    const selectedModel = models.find(m => m.value === config.model);
    if (!selectedModel || !selectedModel.supportedReasoningModes) {
      return reasoningModes;
    }

    // 过滤出当前模型支持的推理模式
    return reasoningModes.filter(mode => 
      selectedModel.supportedReasoningModes.includes(mode.value)
    );
  };

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      setError(null);

      const capabilities = await api.refreshCodexCapabilities();
      setReasoningModes(capabilities.reasoningModes);
      setModels(capabilities.models);
    } catch (err) {
      console.error('Failed to refresh Codex capabilities:', err);
      setError(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const handleConfirm = () => {
    if (config && onConfirm) {
      onConfirm(config);
    }
  };

  if (!isVisible) {
    return null;
  }

  const modalContent = (
    <div className="fixed inset-0 z-[9999] bg-black/50 overflow-y-auto">
      <div className="min-h-full flex items-center justify-center p-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex-shrink-0 flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Codex 配置选择
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              选择推理模式和模型以优化 AI 性能
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title="刷新可用选项"
            >
              <svg
                className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
            {onCancel && (
              <button
                onClick={onCancel}
                className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* 内容区域 - 可滚动 */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center space-x-3">
                <div className="animate-spin h-6 w-6 border-2 border-gray-300 border-t-blue-500 rounded-full"></div>
                <span className="text-gray-600 dark:text-gray-400">加载配置选项...</span>
              </div>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <div className="text-red-500 mb-4">
                <svg className="h-12 w-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
              <button
                onClick={initializeConfig}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                重试
              </button>
            </div>
          ) : config ? (
            <div className="space-y-6">
              {/* 推理模式选择 */}
              <ReasoningModeSelector
                selectedMode={config.reasoningMode}
                options={getAvailableReasoningModes()}
                onModeChange={handleReasoningModeChange}
                loading={refreshing}
              />

              {/* 分隔线 */}
              <div className="border-t border-gray-200 dark:border-gray-700"></div>

              {/* 模型选择 */}
              <ModelSelector
                selectedModel={config.model}
                options={models}
                onModelChange={handleModelChange}
                loading={refreshing}
              />
            </div>
          ) : null}
        </div>

        {/* 底部按钮 */}
        {showConfirmButton && config && !loading && !error && (
          <div className="flex-shrink-0 flex items-center justify-between p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              配置将自动保存
            </div>
            <div className="flex items-center space-x-3">
              {onCancel && (
                <button
                  onClick={onCancel}
                  className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                >
                  取消
                </button>
              )}
              <button
                onClick={handleConfirm}
                className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium"
              >
                确认配置
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};