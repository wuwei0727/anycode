import React from 'react';
import { ReasoningModeSelectorProps } from '@/types/codex-selector';

/**
 * 推理模式选择器组件
 * 允许用户选择 Codex 的推理深度模式
 */
export const ReasoningModeSelector: React.FC<ReasoningModeSelectorProps> = ({
  selectedMode,
  options,
  onModeChange,
  disabled = false,
  loading = false,
}) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          选择推理模式
        </h3>
        {loading && (
          <div className="flex items-center space-x-2 text-xs text-gray-500">
            <div className="animate-spin h-3 w-3 border border-gray-300 border-t-blue-500 rounded-full"></div>
            <span>加载中...</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={`
              flex items-start space-x-3 p-3 rounded-lg border cursor-pointer transition-all
              ${
                selectedMode === option.value
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
              }
              ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            <div className="flex items-center h-5">
              <input
                type="radio"
                name="reasoning-mode"
                value={option.value}
                checked={selectedMode === option.value}
                onChange={(e) => {
                  if (!disabled && e.target.checked) {
                    onModeChange(option.value);
                  }
                }}
                disabled={disabled || loading}
                className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500 focus:ring-2"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {option.label}
                </span>
                {selectedMode === option.value && (
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
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {option.description}
              </p>
            </div>
          </label>
        ))}
      </div>

      {options.length === 0 && !loading && (
        <div className="text-center py-4 text-gray-500 dark:text-gray-400">
          <p className="text-sm">暂无可用的推理模式</p>
        </div>
      )}
    </div>
  );
};