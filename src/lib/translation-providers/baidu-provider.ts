/**
 * 百度翻译提供商
 * 
 * 使用百度翻译API进行翻译
 * API文档: https://fanyi-api.baidu.com/doc/21
 * 签名算法: MD5(appid + q + salt + secretKey)
 * ⚡ 使用 Tauri HTTP 客户端绕过 CORS 限制
 */

import type {
  ITranslationProvider,
  TranslationRequest,
  TranslationResponse,
  BaiduTranslationConfig,
} from '@/types/selection-translation';
import { getProviderLanguageCode } from '@/types/selection-translation';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * 百度翻译 API 响应体
 */
interface BaiduResponseBody {
  from?: string;
  to?: string;
  trans_result?: Array<{
    src: string;
    dst: string;
  }>;
  error_code?: string;
  error_msg?: string;
}

/**
 * 百度翻译错误码映射
 */
const BAIDU_ERROR_MESSAGES: Record<string, string> = {
  '52001': '请求超时，请重试',
  '52002': '系统错误，请重试',
  '52003': '未授权用户，请检查APP ID',
  '54000': '必填参数为空',
  '54001': '签名错误，请检查密钥',
  '54003': '访问频率受限，请降低调用频率',
  '54004': '账户余额不足',
  '54005': '长query请求频繁，请降低长文本频率',
  '58000': '客户端IP非法',
  '58001': '译文语言方向不支持',
  '58002': '服务当前已关闭',
  '90107': '认证未通过或未生效',
};

export class BaiduProvider implements ITranslationProvider {
  readonly type = 'baidu' as const;
  readonly name = '百度翻译';

  private static readonly API_URL = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

  constructor(private config: BaiduTranslationConfig) {}

  /**
   * 生成MD5签名
   * 签名算法: MD5(appid + q + salt + secretKey)
   */
  private async generateSign(text: string, salt: string): Promise<string> {
    const signStr = this.config.appId + text + salt + this.config.secretKey;
    
    // MD5 不在 Web Crypto API 中，使用简单的 MD5 实现
    return this.md5(signStr);
  }

  /**
   * 简单的 MD5 实现
   */
  private md5(string: string): string {
    function md5cycle(x: number[], k: number[]) {
      let a = x[0], b = x[1], c = x[2], d = x[3];

      a = ff(a, b, c, d, k[0], 7, -680876936);
      d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819);
      b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897);
      d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341);
      b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416);
      d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063);
      b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682);
      d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290);
      b = ff(b, c, d, a, k[15], 22, 1236535329);

      a = gg(a, b, c, d, k[1], 5, -165796510);
      d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713);
      b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691);
      d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335);
      b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438);
      d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961);
      b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467);
      d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473);
      b = gg(b, c, d, a, k[12], 20, -1926607734);

      a = hh(a, b, c, d, k[5], 4, -378558);
      d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562);
      b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060);
      d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632);
      b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174);
      d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979);
      b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487);
      d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520);
      b = hh(b, c, d, a, k[2], 23, -995338651);

      a = ii(a, b, c, d, k[0], 6, -198630844);
      d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905);
      b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571);
      d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523);
      b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359);
      d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380);
      b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070);
      d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259);
      b = ii(b, c, d, a, k[9], 21, -343485551);

      x[0] = add32(a, x[0]);
      x[1] = add32(b, x[1]);
      x[2] = add32(c, x[2]);
      x[3] = add32(d, x[3]);
    }

    function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }

    function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
      return cmn((b & c) | ((~b) & d), a, b, x, s, t);
    }

    function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
      return cmn((b & d) | (c & (~d)), a, b, x, s, t);
    }

    function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
      return cmn(b ^ c ^ d, a, b, x, s, t);
    }

    function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
      return cmn(c ^ (b | (~d)), a, b, x, s, t);
    }

    function md5blk_array(a: number[]) {
      const md5blks: number[] = [];
      for (let i = 0; i < 64; i += 4) {
        md5blks[i >> 2] = a[i]
          + (a[i + 1] << 8)
          + (a[i + 2] << 16)
          + (a[i + 3] << 24);
      }
      return md5blks;
    }

    function add32(a: number, b: number) {
      return (a + b) & 0xFFFFFFFF;
    }

    function rhex(n: number) {
      const hex_chr = '0123456789abcdef';
      let s = '';
      for (let j = 0; j < 4; j++) {
        s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0F)
          + hex_chr.charAt((n >> (j * 8)) & 0x0F);
      }
      return s;
    }

    function hex(x: number[]) {
      return x.map(rhex).join('');
    }

    // UTF-8 encode
    const utf8Encode = (str: string): number[] => {
      const result: number[] = [];
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 128) {
          result.push(c);
        } else if (c < 2048) {
          result.push((c >> 6) | 192);
          result.push((c & 63) | 128);
        } else if (c < 55296 || c >= 57344) {
          result.push((c >> 12) | 224);
          result.push(((c >> 6) & 63) | 128);
          result.push((c & 63) | 128);
        } else {
          i++;
          const c2 = str.charCodeAt(i);
          const u = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
          result.push((u >> 18) | 240);
          result.push(((u >> 12) & 63) | 128);
          result.push(((u >> 6) & 63) | 128);
          result.push((u & 63) | 128);
        }
      }
      return result;
    };

    const bytes = utf8Encode(string);
    const n = bytes.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i: number;

    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk_array(bytes.slice(i - 64, i)));
    }

    const tail = bytes.slice(i - 64);
    const tailLen = tail.length;
    tail.push(0x80);

    while (tail.length < 64) {
      tail.push(0);
    }

    if (tailLen >= 56) {
      md5cycle(state, md5blk_array(tail));
      tail.fill(0);
    }

    // Append length in bits
    const bitLen = n * 8;
    tail[56] = bitLen & 0xFF;
    tail[57] = (bitLen >> 8) & 0xFF;
    tail[58] = (bitLen >> 16) & 0xFF;
    tail[59] = (bitLen >> 24) & 0xFF;
    tail[60] = 0;
    tail[61] = 0;
    tail[62] = 0;
    tail[63] = 0;

    md5cycle(state, md5blk_array(tail));

    return hex(state);
  }

  /**
   * 执行翻译
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.validateConfig()) {
      return {
        success: false,
        error: '百度翻译配置无效：缺少APP ID或密钥',
      };
    }

    try {
      // 转换语言代码为百度格式
      const sourceLang = getProviderLanguageCode(request.sourceLang, 'baidu');
      const targetLang = getProviderLanguageCode(request.targetLang, 'baidu');

      // 生成随机salt
      const salt = Date.now().toString();
      
      // 生成签名
      const sign = await this.generateSign(request.text, salt);

      // 构建请求参数
      const params = new URLSearchParams({
        q: request.text,
        from: sourceLang,
        to: targetLang,
        appid: this.config.appId,
        salt: salt,
        sign: sign,
      });

      console.log('[BaiduProvider] Sending translation request:', {
        sourceLang,
        targetLang,
        textLength: request.text.length,
      });

      // ⚡ 使用 Tauri HTTP 客户端绕过 CORS 限制
      const response = await tauriFetch(`${BaiduProvider.API_URL}?${params.toString()}`, {
        method: 'GET',
      });

      if (!response.ok) {
        console.error('[BaiduProvider] HTTP error:', response.status, response.statusText);
        return {
          success: false,
          error: `HTTP错误: ${response.status} ${response.statusText}`,
        };
      }

      const data: BaiduResponseBody = await response.json();

      // 检查错误码
      if (data.error_code) {
        const errorMsg = BAIDU_ERROR_MESSAGES[data.error_code] || data.error_msg || `错误码: ${data.error_code}`;
        console.error('[BaiduProvider] API error:', data);
        return {
          success: false,
          error: errorMsg,
        };
      }

      // 提取翻译结果
      if (data.trans_result && data.trans_result.length > 0) {
        const translatedText = data.trans_result.map(r => r.dst).join('\n');
        
        console.log('[BaiduProvider] Translation successful:', {
          originalLength: request.text.length,
          translatedLength: translatedText.length,
          detectedFrom: data.from,
        });

        return {
          success: true,
          translatedText,
          detectedSourceLang: data.from,
        };
      }

      return {
        success: false,
        error: '翻译结果为空',
      };
    } catch (error) {
      console.error('[BaiduProvider] Translation failed:', error);
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
      this.config.appId &&
      this.config.appId.trim().length > 0 &&
      this.config.secretKey &&
      this.config.secretKey.trim().length > 0
    );
  }

  /**
   * 获取当前配置
   */
  getConfig(): BaiduTranslationConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<BaiduTranslationConfig>): void {
    Object.assign(this.config, config);
  }
}
