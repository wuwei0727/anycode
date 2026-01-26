/**
 * 选中文本翻译服务
 * 
 * 统一管理翻译提供商，提供翻译功能和配置管理
 */

import type {
  ITranslationProvider,
  TranslationProviderType,
  TranslationRequest,
  TranslationResponse,
  ProviderConfig,
  SelectionTranslationSettings,
  DeepLXConfig,
  BaiduTranslationConfig,
  TencentTranslationConfig,
} from '@/types/selection-translation';
import {
  DEFAULT_SELECTION_TRANSLATION_SETTINGS,
} from '@/types/selection-translation';
import { DeepLXProvider, BaiduProvider, TencentProvider } from './translation-providers';

/**
 * 配置存储键名
 */
const STORAGE_KEY = 'selection-translation-settings';

/**
 * 选中文本翻译服务类
 */
export class SelectionTranslationService {
  private providers: Map<TranslationProviderType, ITranslationProvider> = new Map();
  private settings: SelectionTranslationSettings;
  private initialized = false;

  constructor() {
    this.settings = { ...DEFAULT_SELECTION_TRANSLATION_SETTINGS };
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 从本地存储加载配置
      await this.loadSettings();
      // 初始化提供商
      this.initProviders();
      this.initialized = true;
      console.log('[SelectionTranslationService] Initialized:', {
        enabled: this.settings.enabled,
        defaultProvider: this.settings.defaultProvider,
        providersCount: this.providers.size,
      });
    } catch (error) {
      console.error('[SelectionTranslationService] Init failed:', error);
      // 使用默认配置
      this.settings = { ...DEFAULT_SELECTION_TRANSLATION_SETTINGS };
      this.initProviders();
      this.initialized = true;
    }
  }

  /**
   * 确保服务已初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * 初始化翻译提供商
   */
  private initProviders(): void {
    this.providers.clear();

    for (const config of this.settings.providers) {
      if (!config.enabled) continue;

      try {
        const provider = this.createProvider(config);
        if (provider && provider.validateConfig()) {
          this.providers.set(config.type, provider);
          console.log(`[SelectionTranslationService] Provider ${config.type} initialized`);
        }
      } catch (error) {
        console.error(`[SelectionTranslationService] Failed to init provider ${config.type}:`, error);
      }
    }
  }

  /**
   * 创建翻译提供商实例
   */
  private createProvider(config: ProviderConfig): ITranslationProvider | null {
    switch (config.type) {
      case 'deeplx':
        return new DeepLXProvider(config as DeepLXConfig);
      case 'baidu':
        return new BaiduProvider(config as BaiduTranslationConfig);
      case 'tencent':
        return new TencentProvider(config as TencentTranslationConfig);
      default:
        return null;
    }
  }

  /**
   * 从本地存储加载配置
   */
  private async loadSettings(): Promise<void> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.settings = {
          ...DEFAULT_SELECTION_TRANSLATION_SETTINGS,
          ...parsed,
        };
        console.log('[SelectionTranslationService] Settings loaded from storage');
      }
    } catch (error) {
      console.error('[SelectionTranslationService] Failed to load settings:', error);
    }
  }

  /**
   * 保存配置到本地存储
   */
  private async saveSettings(): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      console.log('[SelectionTranslationService] Settings saved to storage');
    } catch (error) {
      console.error('[SelectionTranslationService] Failed to save settings:', error);
    }
  }

  /**
   * 检测文本语言（简单实现）
   */
  private detectLanguage(text: string): string {
    // 检测中文字符
    const chineseChars = text.match(/[\u4e00-\u9fff]/g);
    if (chineseChars && chineseChars.length > text.length * 0.1) {
      return 'zh';
    }

    // 检测日文字符
    const japaneseChars = text.match(/[\u3040-\u309f\u30a0-\u30ff]/g);
    if (japaneseChars && japaneseChars.length > 0) {
      return 'ja';
    }

    // 检测韩文字符
    const koreanChars = text.match(/[\uac00-\ud7af]/g);
    if (koreanChars && koreanChars.length > 0) {
      return 'ko';
    }

    // 默认英文
    return 'en';
  }

  /**
   * 执行翻译
   */
  async translate(
    text: string,
    targetLang?: string,
    sourceLang?: string
  ): Promise<TranslationResponse> {
    await this.ensureInitialized();

    if (!this.settings.enabled) {
      return {
        success: false,
        error: '选中翻译功能已禁用',
      };
    }

    // 获取当前默认提供商
    const provider = this.providers.get(this.settings.defaultProvider);
    if (!provider) {
      // 尝试使用其他可用提供商
      const availableProvider = Array.from(this.providers.values())[0];
      if (!availableProvider) {
        return {
          success: false,
          error: '没有可用的翻译提供商，请检查配置',
        };
      }
      return this.translateWithProvider(availableProvider, text, targetLang, sourceLang);
    }

    return this.translateWithProvider(provider, text, targetLang, sourceLang);
  }

  /**
   * 使用指定提供商翻译
   */
  private async translateWithProvider(
    provider: ITranslationProvider,
    text: string,
    targetLang?: string,
    sourceLang?: string
  ): Promise<TranslationResponse> {
    // 确定源语言
    const detectedSourceLang = sourceLang || this.detectLanguage(text);
    
    // 确定目标语言
    let finalTargetLang = targetLang || this.settings.defaultTargetLang;
    
    // 如果源语言和目标语言相同，自动切换翻译方向
    if (detectedSourceLang === finalTargetLang) {
      finalTargetLang = detectedSourceLang === 'zh' ? 'en' : 'zh';
      console.log('[SelectionTranslationService] Auto-switched target language:', {
        detected: detectedSourceLang,
        newTarget: finalTargetLang,
      });
    }

    const request: TranslationRequest = {
      text,
      sourceLang: sourceLang || 'auto',
      targetLang: finalTargetLang,
    };

    console.log('[SelectionTranslationService] Translating with provider:', {
      provider: provider.type,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      textLength: text.length,
    });

    return provider.translate(request);
  }

  /**
   * 使用指定提供商类型翻译
   */
  async translateWith(
    providerType: TranslationProviderType,
    text: string,
    targetLang?: string,
    sourceLang?: string
  ): Promise<TranslationResponse> {
    await this.ensureInitialized();

    const provider = this.providers.get(providerType);
    if (!provider) {
      return {
        success: false,
        error: `提供商 ${providerType} 不可用`,
      };
    }

    return this.translateWithProvider(provider, text, targetLang, sourceLang);
  }

  /**
   * 获取当前设置
   */
  async getSettings(): Promise<SelectionTranslationSettings> {
    await this.ensureInitialized();
    return { ...this.settings };
  }

  /**
   * 更新设置
   */
  async updateSettings(settings: Partial<SelectionTranslationSettings>): Promise<void> {
    await this.ensureInitialized();
    
    this.settings = {
      ...this.settings,
      ...settings,
    };

    // 重新初始化提供商
    this.initProviders();
    
    // 保存到本地存储
    await this.saveSettings();

    console.log('[SelectionTranslationService] Settings updated:', this.settings);
  }

  /**
   * 更新提供商配置
   */
  async updateProviderConfig(config: ProviderConfig): Promise<void> {
    await this.ensureInitialized();

    const index = this.settings.providers.findIndex(p => p.type === config.type);
    if (index >= 0) {
      this.settings.providers[index] = config;
    } else {
      this.settings.providers.push(config);
    }

    // 重新初始化提供商
    this.initProviders();
    
    // 保存到本地存储
    await this.saveSettings();

    console.log('[SelectionTranslationService] Provider config updated:', config.type);
  }

  /**
   * 获取提供商配置
   */
  async getProviderConfig(type: TranslationProviderType): Promise<ProviderConfig | undefined> {
    await this.ensureInitialized();
    return this.settings.providers.find(p => p.type === type);
  }

  /**
   * 设置默认提供商
   */
  async setDefaultProvider(type: TranslationProviderType): Promise<void> {
    await this.ensureInitialized();
    
    this.settings.defaultProvider = type;
    await this.saveSettings();

    console.log('[SelectionTranslationService] Default provider set to:', type);
  }

  /**
   * 设置默认目标语言
   */
  async setDefaultTargetLang(lang: string): Promise<void> {
    await this.ensureInitialized();
    
    this.settings.defaultTargetLang = lang;
    await this.saveSettings();

    console.log('[SelectionTranslationService] Default target language set to:', lang);
  }

  /**
   * 启用/禁用功能
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.ensureInitialized();
    
    this.settings.enabled = enabled;
    await this.saveSettings();

    console.log('[SelectionTranslationService] Enabled:', enabled);
  }

  /**
   * 检查功能是否启用
   */
  async isEnabled(): Promise<boolean> {
    await this.ensureInitialized();
    return this.settings.enabled;
  }

  /**
   * 获取可用的提供商列表
   */
  async getAvailableProviders(): Promise<Array<{ type: TranslationProviderType; name: string }>> {
    await this.ensureInitialized();
    
    return Array.from(this.providers.entries()).map(([type, provider]) => ({
      type,
      name: provider.name,
    }));
  }

  /**
   * 测试提供商连接
   */
  async testProvider(type: TranslationProviderType): Promise<TranslationResponse> {
    await this.ensureInitialized();

    const provider = this.providers.get(type);
    if (!provider) {
      return {
        success: false,
        error: `提供商 ${type} 不可用，请先启用并配置该提供商`,
      };
    }

    // 使用简单的测试文本
    return provider.translate({
      text: 'Hello',
      sourceLang: 'en',
      targetLang: 'zh',
    });
  }

  /**
   * 使用临时配置测试提供商连接
   * 用于在保存设置之前测试配置是否有效
   */
  async testProviderWithConfig(config: ProviderConfig): Promise<TranslationResponse> {
    await this.ensureInitialized();

    // 创建临时提供商实例进行测试
    const provider = this.createProvider(config);
    if (!provider) {
      return {
        success: false,
        error: `无法创建提供商 ${config.type}`,
      };
    }

    // 验证配置
    if (!provider.validateConfig()) {
      return {
        success: false,
        error: `提供商 ${config.type} 配置无效，请检查必填项`,
      };
    }

    // 使用简单的测试文本
    return provider.translate({
      text: 'Hello',
      sourceLang: 'en',
      targetLang: 'zh',
    });
  }
}

// 导出单例实例
export const selectionTranslationService = new SelectionTranslationService();
