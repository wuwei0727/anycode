/**
 * 默认提供商管理模块
 * 管理用户设置的默认提示词优化 API 提供商
 */

import { getProvider } from './promptEnhancementService';

const DEFAULT_PROVIDER_KEY = 'prompt_enhancement_default_provider';

/**
 * 获取默认提供商 ID
 * @returns 默认提供商 ID，如果未设置则返回 null
 */
export function getDefaultProviderId(): string | null {
  try {
    const id = localStorage.getItem(DEFAULT_PROVIDER_KEY);
    if (!id) return null;
    
    // 验证提供商是否仍然有效
    if (!validateDefaultProvider(id)) {
      clearDefaultProviderId();
      return null;
    }
    
    return id;
  } catch (error) {
    console.error('[DefaultProviderManager] Failed to get default provider:', error);
    return null;
  }
}

/**
 * 设置默认提供商 ID
 * @param id 提供商 ID，传入 null 清除默认设置
 */
export function setDefaultProviderId(id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(DEFAULT_PROVIDER_KEY);
      console.log('[DefaultProviderManager] Default provider cleared');
    } else {
      localStorage.setItem(DEFAULT_PROVIDER_KEY, id);
      console.log('[DefaultProviderManager] Default provider set to:', id);
    }
  } catch (error) {
    console.error('[DefaultProviderManager] Failed to set default provider:', error);
  }
}

/**
 * 清除默认提供商设置
 */
export function clearDefaultProviderId(): void {
  setDefaultProviderId(null);
}

/**
 * 验证默认提供商是否仍然有效
 * 检查提供商是否存在且已启用
 * @param id 提供商 ID
 * @returns 提供商是否有效
 */
export function validateDefaultProvider(id?: string | null): boolean {
  const providerId = id ?? localStorage.getItem(DEFAULT_PROVIDER_KEY);
  if (!providerId) return false;
  
  try {
    const provider = getProvider(providerId);
    return provider !== undefined && provider.enabled;
  } catch (error) {
    console.error('[DefaultProviderManager] Failed to validate provider:', error);
    return false;
  }
}

/**
 * 获取默认提供商的完整信息
 * @returns 默认提供商对象，如果未设置或无效则返回 null
 */
export function getDefaultProvider() {
  const id = getDefaultProviderId();
  if (!id) return null;
  
  return getProvider(id) || null;
}

/**
 * 检查是否有可用的默认提供商
 * @returns 是否有有效的默认提供商
 */
export function hasDefaultProvider(): boolean {
  return getDefaultProviderId() !== null;
}
