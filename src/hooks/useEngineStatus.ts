/**
 * useEngineStatus Hook
 * 
 * 管理 AI 引擎的状态检测、刷新和缓存
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { EngineType, EngineStatus, EngineStatusCache, UnifiedEngineStatus } from '@/types/engine';
import { CACHE_CONFIG, DETECTION_CONFIG, ENGINES } from '@/lib/engineConfig';

/**
 * Hook 返回类型
 */
export interface UseEngineStatusReturn {
  /** 引擎状态映射 */
  engineStatuses: Record<EngineType, EngineStatus>;
  
  /** 刷新状态映射 */
  isRefreshing: Record<EngineType, boolean>;
  
  /** 检查更新状态映射 */
  isCheckingUpdate: Record<EngineType, boolean>;
  
  /** 更新状态映射 */
  isUpdating: Record<EngineType, boolean>;
  
  /** 刷新指定引擎 */
  refreshEngine: (engine: EngineType) => Promise<void>;
  
  /** 刷新所有引擎 */
  refreshAllEngines: () => Promise<void>;
  
  /** 检查引擎更新 */
  checkUpdate: (engine: EngineType) => Promise<import('@/types/engine').CheckUpdateResult>;
  
  /** 更新指定引擎 */
  updateEngine: (engine: EngineType) => Promise<void>;
  
  /** 清除缓存 */
  clearCache: () => void;
  
  /** 获取缓存年龄（毫秒） */
  getCacheAge: (engine: EngineType) => number;
}

/**
 * 从 LocalStorage 加载缓存
 */
function loadCache(): EngineStatusCache {
  try {
    const cached = localStorage.getItem(CACHE_CONFIG.STORAGE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error('[useEngineStatus] Failed to load cache:', error);
  }
  return {};
}

/**
 * 保存缓存到 LocalStorage
 */
function saveCache(cache: EngineStatusCache): void {
  try {
    localStorage.setItem(CACHE_CONFIG.STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.error('[useEngineStatus] Failed to save cache:', error);
  }
}

/**
 * 将后端状态转换为前端状态
 */
function convertToEngineStatus(unified: UnifiedEngineStatus): EngineStatus {
  return {
    status: unified.isInstalled ? 'connected' : 'disconnected',
    version: unified.version,
    environment: unified.environment as 'native' | 'wsl',
    wslDistro: unified.wslDistro,
    path: unified.path,
    lastChecked: unified.lastChecked ? new Date(unified.lastChecked * 1000) : new Date(),
    error: unified.error,
  };
}

/**
 * 检查缓存是否有效
 */
function isCacheValid(cacheEntry: EngineStatusCache[string]): boolean {
  if (!cacheEntry) return false;
  const age = Date.now() - cacheEntry.timestamp;
  return age < cacheEntry.ttl;
}

/**
 * 引擎状态管理 Hook
 */
export function useEngineStatus(): UseEngineStatusReturn {
  // 状态
  const [engineStatuses, setEngineStatuses] = useState<Record<EngineType, EngineStatus>>(() => {
    // 初始化时从缓存加载
    const cache = loadCache();
    const initialStatuses: Partial<Record<EngineType, EngineStatus>> = {};
    
    ENGINES.forEach(engine => {
      const cacheEntry = cache[engine.type];
      if (cacheEntry && isCacheValid(cacheEntry)) {
        // 恢复 Date 对象
        initialStatuses[engine.type] = {
          ...cacheEntry.status,
          lastChecked: cacheEntry.status.lastChecked 
            ? new Date(cacheEntry.status.lastChecked) 
            : undefined
        };
      } else {
        // 默认状态
        initialStatuses[engine.type] = {
          status: 'checking',
        };
      }
    });
    
    return initialStatuses as Record<EngineType, EngineStatus>;
  });
  
  const [isRefreshing, setIsRefreshing] = useState<Record<EngineType, boolean>>({
    claude: false,
    codex: false,
    gemini: false,
  });
  
  const [isCheckingUpdate, setIsCheckingUpdate] = useState<Record<EngineType, boolean>>({
    claude: false,
    codex: false,
    gemini: false,
  });
  
  const [isUpdating, setIsUpdating] = useState<Record<EngineType, boolean>>({
    claude: false,
    codex: false,
    gemini: false,
  });
  
  /**
   * 检查单个引擎状态
   */
  const checkEngine = useCallback(async (engine: EngineType): Promise<EngineStatus> => {
    console.log(`[useEngineStatus] Checking ${engine} status...`);
    
    try {
      // 添加超时控制
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), DETECTION_CONFIG.TIMEOUT);
      });
      
      const statusPromise = api.checkEngineStatus(engine);
      
      const unified = await Promise.race([statusPromise, timeoutPromise]);
      const status = convertToEngineStatus(unified);
      
      console.log(`[useEngineStatus] ${engine} status:`, status);
      return status;
    } catch (error) {
      console.error(`[useEngineStatus] Failed to check ${engine}:`, error);
      
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        lastChecked: new Date(),
      };
    }
  }, []);
  
  /**
   * 刷新指定引擎
   */
  const refreshEngine = useCallback(async (engine: EngineType) => {
    // 防止重复刷新
    if (isRefreshing[engine]) {
      console.log(`[useEngineStatus] ${engine} is already refreshing`);
      return;
    }
    
    setIsRefreshing(prev => ({ ...prev, [engine]: true }));
    setEngineStatuses(prev => ({
      ...prev,
      [engine]: { ...prev[engine], status: 'checking' }
    }));
    
    try {
      const status = await checkEngine(engine);
      
      setEngineStatuses(prev => ({
        ...prev,
        [engine]: status
      }));
      
      // 更新缓存
      const cache = loadCache();
      cache[engine] = {
        status,
        timestamp: Date.now(),
        ttl: CACHE_CONFIG.TTL
      };
      saveCache(cache);
      
    } finally {
      setIsRefreshing(prev => ({ ...prev, [engine]: false }));
    }
  }, [isRefreshing, checkEngine]);
  
  /**
   * 刷新所有引擎
   */
  const refreshAllEngines = useCallback(async () => {
    console.log('[useEngineStatus] Refreshing all engines...');
    
    const promises = ENGINES.map(engine => refreshEngine(engine.type));
    await Promise.allSettled(promises);
    
    console.log('[useEngineStatus] All engines refreshed');
  }, [refreshEngine]);
  
  /**
   * 检查引擎更新
   */
  const checkUpdateFunc = useCallback(async (engine: EngineType) => {
    setIsCheckingUpdate(prev => ({ ...prev, [engine]: true }));
    
    try {
      console.log(`[useEngineStatus] Checking update for ${engine}...`);
      
      // 先刷新状态获取最新的环境信息
      const freshStatus = await api.checkEngineStatus(engine);
      
      if (!freshStatus.environment) {
        throw new Error('无法确定运行环境');
      }
      
      // 使用最新的环境信息检查更新
      const result = await api.checkEngineUpdate(engine, freshStatus.environment, freshStatus.wslDistro);
      console.log(`[useEngineStatus] Update check result:`, result);
      return result;
    } catch (error) {
      console.error(`[useEngineStatus] Failed to check update for ${engine}:`, error);
      throw error;
    } finally {
      setIsCheckingUpdate(prev => ({ ...prev, [engine]: false }));
    }
  }, []);
  
  /**
   * 更新指定引擎
   */
  const updateEngineFunc = useCallback(async (engine: EngineType) => {
    // 防止重复更新
    if (isUpdating[engine]) {
      console.log(`[useEngineStatus] ${engine} is already updating`);
      return;
    }
    
    const status = engineStatuses[engine];
    if (!status.environment) {
      throw new Error('无法确定运行环境');
    }
    
    setIsUpdating(prev => ({ ...prev, [engine]: true }));
    
    try {
      console.log(`[useEngineStatus] Updating ${engine}...`);
      const result = await api.updateEngine(engine, status.environment, status.wslDistro);
      
      if (result.success) {
        console.log(`[useEngineStatus] ${engine} updated successfully:`, result);
        // 更新成功后刷新状态
        await refreshEngine(engine);
      } else {
        throw new Error(result.error || '更新失败');
      }
    } catch (error) {
      console.error(`[useEngineStatus] Failed to update ${engine}:`, error);
      throw error;
    } finally {
      setIsUpdating(prev => ({ ...prev, [engine]: false }));
    }
  }, [isUpdating, engineStatuses, refreshEngine]);
  
  /**
   * 清除缓存
   */
  const clearCache = useCallback(() => {
    try {
      localStorage.removeItem(CACHE_CONFIG.STORAGE_KEY);
      console.log('[useEngineStatus] Cache cleared');
    } catch (error) {
      console.error('[useEngineStatus] Failed to clear cache:', error);
    }
  }, []);
  
  /**
   * 获取缓存年龄
   */
  const getCacheAge = useCallback((engine: EngineType): number => {
    const cache = loadCache();
    const cacheEntry = cache[engine];
    if (!cacheEntry) return Infinity;
    return Date.now() - cacheEntry.timestamp;
  }, []);
  
  /**
   * 初始化：检查缓存并在后台刷新
   */
  useEffect(() => {
    const cache = loadCache();
    let needsRefresh = false;
    
    // 检查是否需要刷新
    ENGINES.forEach(engine => {
      const cacheEntry = cache[engine.type];
      if (!cacheEntry || !isCacheValid(cacheEntry)) {
        needsRefresh = true;
      }
    });
    
    // 如果缓存无效，后台刷新
    if (needsRefresh) {
      console.log('[useEngineStatus] Cache invalid, refreshing in background...');
      refreshAllEngines();
    }
  }, []); // 只在挂载时运行一次
  
  return {
    engineStatuses,
    isRefreshing,
    isCheckingUpdate,
    isUpdating,
    refreshEngine,
    refreshAllEngines,
    checkUpdate: checkUpdateFunc,
    updateEngine: updateEngineFunc,
    clearCache,
    getCacheAge,
  };
}
