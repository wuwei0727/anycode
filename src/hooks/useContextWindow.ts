/**
 * useContextWindow Hook - 管理上下文窗口状态
 * 
 * 提供上下文窗口使用情况的计算和状态管理
 */

import { useState, useMemo, useCallback } from 'react';
import {
  EngineType,
  ContextWindowState,
  WarningLevel,
  calculateUsagePercent,
  getColorStatus,
  getWarningLevel,
  getMaxTokensForEngine,
} from '@/lib/contextWindow';

interface UseContextWindowOptions {
  /** 是否启用警告 */
  enableWarnings?: boolean;
}

interface UseContextWindowReturn extends ContextWindowState {
  /** 关闭当前警告 */
  dismissWarning: () => void;
  /** 重置警告状态 */
  resetWarnings: () => void;
  /** 已关闭的警告级别 */
  dismissedWarningLevel: WarningLevel;
}

/**
 * 上下文窗口状态管理 Hook
 * @param usedTokens 已使用的 token 数量
 * @param engine 引擎类型
 * @param model 模型名称（可选）
 * @param options 配置选项
 */
export function useContextWindow(
  usedTokens: number,
  engine: EngineType,
  model?: string,
  options: UseContextWindowOptions = {}
): UseContextWindowReturn {
  const { enableWarnings = true } = options;
  
  // 已关闭的警告级别
  const [dismissedWarningLevel, setDismissedWarningLevel] = useState<WarningLevel>('none');
  
  // 计算上下文窗口状态
  const state = useMemo<ContextWindowState>(() => {
    const maxTokens = getMaxTokensForEngine(engine, model);
    const usagePercent = calculateUsagePercent(usedTokens, maxTokens);
    const remainingPercent = 100 - usagePercent;
    const colorStatus = getColorStatus(usagePercent);
    const warningLevel = getWarningLevel(usagePercent);
    
    // 判断是否应该显示警告
    let shouldWarn = false;
    if (enableWarnings && warningLevel !== 'none') {
      // 只有当前警告级别高于已关闭的警告级别时才显示
      if (warningLevel === 'critical' && dismissedWarningLevel !== 'critical') {
        shouldWarn = true;
      } else if (warningLevel === 'warning' && dismissedWarningLevel === 'none') {
        shouldWarn = true;
      }
    }
    
    return {
      usedTokens,
      maxTokens,
      usagePercent,
      remainingPercent,
      colorStatus,
      shouldWarn,
      warningLevel,
    };
  }, [usedTokens, engine, model, enableWarnings, dismissedWarningLevel]);
  
  // 关闭当前警告
  const dismissWarning = useCallback(() => {
    setDismissedWarningLevel(state.warningLevel);
  }, [state.warningLevel]);
  
  // 重置警告状态（用于新会话）
  const resetWarnings = useCallback(() => {
    setDismissedWarningLevel('none');
  }, []);
  
  return {
    ...state,
    dismissWarning,
    resetWarnings,
    dismissedWarningLevel,
  };
}

export default useContextWindow;
