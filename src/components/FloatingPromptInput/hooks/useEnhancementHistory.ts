/**
 * 优化历史管理 Hook
 * 管理当前会话的提示词优化历史记录
 */

import { useState, useCallback, useEffect } from 'react';

const HISTORY_STORAGE_KEY = 'prompt_enhancement_history';
const MAX_HISTORY_ITEMS = 20;

export interface EnhancementHistoryItem {
  id: string;
  timestamp: number;
  originalPrompt: string;
  enhancedPrompt: string;
  providerId: string;
  providerName: string;
}

export interface UseEnhancementHistoryResult {
  history: EnhancementHistoryItem[];
  addToHistory: (item: Omit<EnhancementHistoryItem, 'id' | 'timestamp'>) => void;
  clearHistory: () => void;
  restoreFromHistory: (id: string) => EnhancementHistoryItem | null;
  removeFromHistory: (id: string) => void;
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 从 SessionStorage 加载历史记录
 */
function loadHistoryFromStorage(): EnhancementHistoryItem[] {
  try {
    const stored = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as EnhancementHistoryItem[];
  } catch (error) {
    console.error('[useEnhancementHistory] Failed to load history:', error);
    return [];
  }
}

/**
 * 保存历史记录到 SessionStorage
 */
function saveHistoryToStorage(history: EnhancementHistoryItem[]): void {
  try {
    sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('[useEnhancementHistory] Failed to save history:', error);
  }
}

/**
 * 优化历史管理 Hook
 */
export function useEnhancementHistory(): UseEnhancementHistoryResult {
  const [history, setHistory] = useState<EnhancementHistoryItem[]>(() => loadHistoryFromStorage());

  // 同步到 SessionStorage
  useEffect(() => {
    saveHistoryToStorage(history);
  }, [history]);

  /**
   * 添加新的历史记录
   */
  const addToHistory = useCallback((item: Omit<EnhancementHistoryItem, 'id' | 'timestamp'>) => {
    const newItem: EnhancementHistoryItem = {
      ...item,
      id: generateId(),
      timestamp: Date.now(),
    };

    setHistory(prev => {
      // 添加到开头，保持最新的在前面
      const updated = [newItem, ...prev];
      // 限制最大数量
      if (updated.length > MAX_HISTORY_ITEMS) {
        return updated.slice(0, MAX_HISTORY_ITEMS);
      }
      return updated;
    });

    console.log('[useEnhancementHistory] Added to history:', newItem.id);
  }, []);

  /**
   * 清除所有历史记录
   */
  const clearHistory = useCallback(() => {
    setHistory([]);
    sessionStorage.removeItem(HISTORY_STORAGE_KEY);
    console.log('[useEnhancementHistory] History cleared');
  }, []);

  /**
   * 从历史记录中恢复
   */
  const restoreFromHistory = useCallback((id: string): EnhancementHistoryItem | null => {
    const item = history.find(h => h.id === id);
    if (item) {
      console.log('[useEnhancementHistory] Restored from history:', id);
      return item;
    }
    console.warn('[useEnhancementHistory] History item not found:', id);
    return null;
  }, [history]);

  /**
   * 从历史记录中删除单个项目
   */
  const removeFromHistory = useCallback((id: string) => {
    setHistory(prev => prev.filter(h => h.id !== id));
    console.log('[useEnhancementHistory] Removed from history:', id);
  }, []);

  return {
    history,
    addToHistory,
    clearHistory,
    restoreFromHistory,
    removeFromHistory,
  };
}
