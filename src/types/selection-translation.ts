/**
 * 选中文本翻译功能类型定义
 * 
 * 支持多个翻译API提供商：DeepLX、百度翻译、腾讯翻译
 */

/**
 * 翻译提供商类型
 */
export type TranslationProviderType = 'deeplx' | 'baidu' | 'tencent';

/**
 * 支持的语言代码
 */
export type LanguageCode = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru';

/**
 * 翻译请求参数
 */
export interface TranslationRequest {
  /** 待翻译文本 */
  text: string;
  /** 源语言，'auto' 表示自动检测 */
  sourceLang: LanguageCode | string;
  /** 目标语言 */
  targetLang: LanguageCode | string;
}

/**
 * 翻译响应结果
 */
export interface TranslationResponse {
  /** 是否成功 */
  success: boolean;
  /** 翻译后的文本 */
  translatedText?: string;
  /** 检测到的源语言 */
  detectedSourceLang?: string;
  /** 备选翻译 */
  alternatives?: string[];
  /** 错误信息 */
  error?: string;
}

/**
 * 翻译提供商接口
 */
export interface ITranslationProvider {
  /** 提供商类型 */
  readonly type: TranslationProviderType;
  /** 提供商显示名称 */
  readonly name: string;
  /** 执行翻译 */
  translate(request: TranslationRequest): Promise<TranslationResponse>;
  /** 验证配置是否有效 */
  validateConfig(): boolean;
}

/**
 * DeepLX 配置
 */
export interface DeepLXConfig {
  type: 'deeplx';
  /** API端点URL */
  endpoint: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 百度翻译配置
 */
export interface BaiduTranslationConfig {
  type: 'baidu';
  /** 百度翻译APP ID */
  appId: string;
  /** 百度翻译密钥 */
  secretKey: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 腾讯翻译配置
 */
export interface TencentTranslationConfig {
  type: 'tencent';
  /** 腾讯云 SecretId */
  secretId: string;
  /** 腾讯云 SecretKey */
  secretKey: string;
  /** 地域，默认 'ap-guangzhou' */
  region: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 提供商配置联合类型
 */
export type ProviderConfig = DeepLXConfig | BaiduTranslationConfig | TencentTranslationConfig;

/**
 * 选中翻译全局配置
 */
export interface SelectionTranslationSettings {
  /** 是否启用选中翻译功能 */
  enabled: boolean;
  /** 默认翻译提供商 */
  defaultProvider: TranslationProviderType;
  /** 默认目标语言 */
  defaultTargetLang: LanguageCode | string;
  /** 各提供商配置列表 */
  providers: ProviderConfig[];
}

/**
 * 选中翻译弹窗位置
 */
export interface PopupPosition {
  x: number;
  y: number;
}

/**
 * 文本选中状态
 */
export interface TextSelectionState {
  /** 选中的文本 */
  selectedText: string;
  /** 弹窗位置 */
  position: PopupPosition;
  /** 是否显示弹窗 */
  isVisible: boolean;
}

/**
 * 翻译状态
 */
export interface TranslationState {
  /** 是否正在翻译 */
  loading: boolean;
  /** 翻译结果 */
  result?: TranslationResponse;
  /** 错误信息 */
  error?: string;
}

/**
 * 语言代码映射表（各提供商语言代码可能不同）
 */
export interface LanguageCodeMapping {
  /** 标准语言代码 */
  standard: LanguageCode;
  /** DeepLX 语言代码 */
  deeplx: string;
  /** 百度翻译语言代码 */
  baidu: string;
  /** 腾讯翻译语言代码 */
  tencent: string;
}

/**
 * 默认配置
 */
export const DEFAULT_SELECTION_TRANSLATION_SETTINGS: SelectionTranslationSettings = {
  enabled: true,
  defaultProvider: 'deeplx',
  defaultTargetLang: 'zh',
  providers: [
    {
      type: 'deeplx',
      endpoint: 'https://api.deeplx.org/68cx1T8IdWoxthtonIT20KzN3LZMbp-fq0Eknvi6DCs/translate',
      enabled: true,
    },
    {
      type: 'baidu',
      appId: '',
      secretKey: '',
      enabled: false,
    },
    {
      type: 'tencent',
      secretId: '',
      secretKey: '',
      region: 'ap-guangzhou',
      enabled: false,
    },
  ],
};

/**
 * 语言代码映射表
 */
export const LANGUAGE_CODE_MAPPINGS: LanguageCodeMapping[] = [
  { standard: 'auto', deeplx: 'auto', baidu: 'auto', tencent: 'auto' },
  { standard: 'zh', deeplx: 'ZH', baidu: 'zh', tencent: 'zh' },
  { standard: 'en', deeplx: 'EN', baidu: 'en', tencent: 'en' },
  { standard: 'ja', deeplx: 'JA', baidu: 'jp', tencent: 'ja' },
  { standard: 'ko', deeplx: 'KO', baidu: 'kor', tencent: 'ko' },
  { standard: 'fr', deeplx: 'FR', baidu: 'fra', tencent: 'fr' },
  { standard: 'de', deeplx: 'DE', baidu: 'de', tencent: 'de' },
  { standard: 'es', deeplx: 'ES', baidu: 'spa', tencent: 'es' },
  { standard: 'ru', deeplx: 'RU', baidu: 'ru', tencent: 'ru' },
];

/**
 * 获取提供商对应的语言代码
 */
export function getProviderLanguageCode(
  standardCode: LanguageCode | string,
  provider: TranslationProviderType
): string {
  const mapping = LANGUAGE_CODE_MAPPINGS.find(m => m.standard === standardCode);
  if (mapping) {
    return mapping[provider];
  }
  // 如果没有找到映射，返回原始代码
  return standardCode;
}

/**
 * 从提供商语言代码转换为标准代码
 */
export function getStandardLanguageCode(
  providerCode: string,
  provider: TranslationProviderType
): LanguageCode | string {
  const mapping = LANGUAGE_CODE_MAPPINGS.find(m => m[provider] === providerCode);
  if (mapping) {
    return mapping.standard;
  }
  return providerCode;
}
