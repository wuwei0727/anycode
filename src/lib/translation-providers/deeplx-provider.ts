/**
 * DeepLX 翻译提供商
 * 
 * 使用 DeepLX API 进行翻译
 * API格式: POST请求，JSON格式
 * 请求体: { text, source_lang, target_lang }
 * 响应: { data: "翻译结果" }
 */

import type {
  ITranslationProvider,
  TranslationRequest,
  TranslationResponse,
  DeepLXConfig,
} from '@/types/selection-translation';
import { getProviderLanguageCode } from '@/types/selection-translation';

/**
 * DeepLX API 请求体
 */
interface DeepLXRequestBody {
  text: string;
  source_lang: string;
  target_lang: string;
}

/**
 * DeepLX API 响应体
 * 完整响应示例:
 * {
 *   "code": 200,
 *   "id": 8370380002,
 *   "data": "翻译结果",
 *   "alternatives": ["备选翻译1", "备选翻译2"],
 *   "source_lang": "EN",
 *   "target_lang": "ZH",
 *   "method": "Free"
 * }
 */
interface DeepLXResponseBody {
  code?: number;
  id?: number;
  data?: string;
  message?: string;
  alternatives?: string[];
  source_lang?: string;
  target_lang?: string;
  method?: string;
}

export class DeepLXProvider implements ITranslationProvider {
  readonly type = 'deeplx' as const;
  readonly name = 'DeepLX';

  constructor(private config: DeepLXConfig) {}

  /**
   * 执行翻译
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.validateConfig()) {
      return {
        success: false,
        error: 'DeepLX 配置无效：缺少API端点',
      };
    }

    try {
      // 转换语言代码为 DeepLX 格式
      const sourceLang = getProviderLanguageCode(request.sourceLang, 'deeplx');
      const targetLang = getProviderLanguageCode(request.targetLang, 'deeplx');

      const requestBody: DeepLXRequestBody = {
        text: request.text,
        source_lang: sourceLang,
        target_lang: targetLang,
      };

      // 打印完整请求参数
      console.log('[DeepLXProvider] 📤 请求参数:', JSON.stringify(requestBody, null, 2));
      console.log('[DeepLXProvider] 📤 请求端点:', this.config.endpoint);

      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        console.error('[DeepLXProvider] ❌ HTTP错误:', response.status, response.statusText);
        return {
          success: false,
          error: `HTTP错误: ${response.status} ${response.statusText}`,
        };
      }

      const data: DeepLXResponseBody = await response.json();
      
      // 打印完整响应
      console.log('[DeepLXProvider] 📥 原始响应:', JSON.stringify(data, null, 2));

      // 检查响应是否成功
      if (data.code && data.code !== 200) {
        console.error('[DeepLXProvider] ❌ API错误:', data);
        return {
          success: false,
          error: data.message || `API错误: ${data.code}`,
        };
      }

      // 提取翻译结果
      if (data.data) {
        console.log('[DeepLXProvider] ✅ 翻译成功:', {
          原文: request.text,
          译文: data.data,
          备选: data.alternatives,
        });

        return {
          success: true,
          translatedText: data.data,
          alternatives: data.alternatives,
          detectedSourceLang: data.source_lang || (sourceLang === 'auto' ? undefined : sourceLang),
        };
      }

      return {
        success: false,
        error: '翻译结果为空',
      };
    } catch (error) {
      console.error('[DeepLXProvider] Translation failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '翻译请求失败',
      };
    }
  }

  /**
   * 验证配置是否有效
   */
  validateConfig(): boolean {
    return !!(
      this.config.endpoint &&
      this.config.endpoint.trim().length > 0 &&
      (this.config.endpoint.startsWith('http://') || this.config.endpoint.startsWith('https://'))
    );
  }

  /**
   * 获取当前配置
   */
  getConfig(): DeepLXConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<DeepLXConfig>): void {
    Object.assign(this.config, config);
  }
}
