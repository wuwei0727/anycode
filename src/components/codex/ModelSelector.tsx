import React from 'react';
import { ModelSelectorProps } from '@/types/codex-selector';

/**
 * 模型选择器组件
 * 允许用户选择 Codex 模型，支持按类别分组显示
 */
export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModel,
  options,
  onModelChange,
  disabled = false,
  loading = false,
}) => {
  // 按类别分组模型
  const groupedModels = React.useMemo(() => {
    const groups: Record<string, typeof options> = {};
    
    options.forEach((model) => {
      const category = model.category || 'general';
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(model);
    });

    // 对每个分组内的模型按 order 排序
    Object.keys(groups).forEach((category) => {
      groups[category].sort((a, b) => a.order - b.order);
    });

    return groups;
  }, [options]);

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'codex':
        return '代码专用模型';
      case 'general':
        return '通用模型';
      default:
        return '其他模型';
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'codex':
        return (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        );
      case 'general':
        return (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
        );
      default:
        return (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        );
    }
  };

  // 调试日志
  React.useEffect(() => {
    console.log('[ModelSelector] 渲染:', {
      optionsCount: options.length,
      options,
      selectedModel,
      groupedModelsKeys: Object.keys(groupedModels),
      groupedModels
    });
  }, [options, selectedModel, groupedModels]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          选择模型
        </h3>
        {loading && (
          <div className="flex items-center space-x-2 text-xs text-gray-500">
            <div className="animate-spin h-3 w-3 border border-gray-300 border-t-blue-500 rounded-full"></div>
            <span>加载中...</span>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {Object.entries(groupedModels).map(([category, models]) => (
          <div key={category} className="space-y-2">
            <div className="flex items-center space-x-2 text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide">
              {getCategoryIcon(category)}
              <span>{getCategoryLabel(category)}</span>
            </div>
            
            <div className="space-y-2 pl-6">
              {models.map((model) => (
                <label
                  key={model.value}
                  className={`
                    flex items-start space-x-3 p-3 rounded-lg border cursor-pointer transition-all
                    ${
                      selectedModel === model.value
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }
                    ${disabled || !model.isAvailable ? 'opacity-50 cursor-not-allowed' : ''}
                  `}
                >
                  <div className="flex items-center h-5">
                    <input
                      type="radio"
                      name="model"
                      value={model.value}
                      checked={selectedModel === model.value}
                      onChange={(e) => {
                        if (!disabled && model.isAvailable && e.target.checked) {
                          onModelChange(model.value);
                        }
                      }}
                      disabled={disabled || loading || !model.isAvailable}
                      className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500 focus:ring-2"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {model.label}
                      </span>
                      {selectedModel === model.value && (
                        <svg
                          className="h-4 w-4 text-blue-500"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                      {!model.isAvailable && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400">
                          不可用
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {model.description}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      {options.length === 0 && !loading && (
        <div className="text-center py-4 text-gray-500 dark:text-gray-400">
          <p className="text-sm">暂无可用的模型</p>
        </div>
      )}
    </div>
  );
};