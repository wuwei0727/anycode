/**
 * Tencent Translation Provider
 * TMT API with TC3-HMAC-SHA256 signature
 * ⚡ 使用 Tauri HTTP 客户端绕过 CORS 限制
 */

import type {
  ITranslationProvider,
  TranslationRequest,
  TranslationResponse,
  TencentTranslationConfig,
} from '@/types/selection-translation';
import { getProviderLanguageCode } from '@/types/selection-translation';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

interface TencentResponseBody {
  Response: {
    TargetText?: string;
    Source?: string;
    Target?: string;
    RequestId?: string;
    Error?: {
      Code: string;
      Message: string;
    };
  };
}

export class TencentProvider implements ITranslationProvider {
  readonly type = 'tencent' as const;
  readonly name = 'Tencent';

  private static readonly SERVICE = 'tmt';
  private static readonly HOST = 'tmt.tencentcloudapi.com';
  private static readonly VERSION = '2018-03-21';
  private static readonly ACTION = 'TextTranslate';

  constructor(private config: TencentTranslationConfig) {}

  private async hmacSha256(key: ArrayBuffer | string, message: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const keyData = typeof key === 'string' ? encoder.encode(key) : key;
    const messageData = encoder.encode(message);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  }

  private async sha256(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return this.bufferToHex(hashBuffer);
  }

  private bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private getUTCDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  private getRegionCode(region: string): string {
    if (region.startsWith('ap-') || region.startsWith('na-') || region.startsWith('eu-')) return region;
    if (region.includes('beijing') || region.includes('Beijing')) return 'ap-beijing';
    if (region.includes('shanghai') || region.includes('Shanghai')) return 'ap-shanghai';
    if (region.includes('guangzhou') || region.includes('Guangzhou')) return 'ap-guangzhou';
    return 'ap-guangzhou';
  }

  private async generateTC3Signature(payload: string, timestamp: number): Promise<{ authorization: string; timestamp: string }> {
    const date = this.getUTCDate(timestamp);
    const service = TencentProvider.SERVICE;
    const host = TencentProvider.HOST;
    const algorithm = 'TC3-HMAC-SHA256';

    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + host + '\n';
    const signedHeaders = 'content-type;host';
    const hashedRequestPayload = await this.sha256(payload);
    
    const canonicalRequest = httpRequestMethod + '\n' + canonicalUri + '\n' + canonicalQueryString + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedRequestPayload;

    const credentialScope = date + '/' + service + '/tc3_request';
    const hashedCanonicalRequest = await this.sha256(canonicalRequest);
    const stringToSign = algorithm + '\n' + timestamp.toString() + '\n' + credentialScope + '\n' + hashedCanonicalRequest;

    const secretDate = await this.hmacSha256('TC3' + this.config.secretKey, date);
    const secretService = await this.hmacSha256(secretDate, service);
    const secretSigning = await this.hmacSha256(secretService, 'tc3_request');
    const signatureBuffer = await this.hmacSha256(secretSigning, stringToSign);
    const signature = this.bufferToHex(signatureBuffer);

    const authorization = algorithm + ' Credential=' + this.config.secretId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    return { authorization, timestamp: timestamp.toString() };
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.validateConfig()) {
      return { success: false, error: 'Tencent config invalid: missing SecretId or SecretKey' };
    }

    try {
      const sourceLang = getProviderLanguageCode(request.sourceLang, 'tencent');
      const targetLang = getProviderLanguageCode(request.targetLang, 'tencent');
      const regionCode = this.getRegionCode(this.config.region);

      const payload = JSON.stringify({
        SourceText: request.text,
        Source: sourceLang,
        Target: targetLang,
        ProjectId: 0,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const { authorization, timestamp: ts } = await this.generateTC3Signature(payload, timestamp);

      console.log('[TencentProvider] Request:', payload);
      console.log('[TencentProvider] Region:', regionCode);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': TencentProvider.HOST,
        'X-TC-Action': TencentProvider.ACTION,
        'X-TC-Version': TencentProvider.VERSION,
        'X-TC-Timestamp': ts,
        'X-TC-Region': regionCode,
        'Authorization': authorization,
      };

      // ⚡ 使用 Tauri HTTP 客户端绕过 CORS 限制
      const response = await tauriFetch('https://' + TencentProvider.HOST + '/', {
        method: 'POST',
        headers,
        body: payload,
      });

      const responseText = await response.text();
      console.log('[TencentProvider] Response:', responseText);

      if (!response.ok) {
        return { success: false, error: 'HTTP error: ' + response.status };
      }

      const data: TencentResponseBody = JSON.parse(responseText);

      if (data.Response.Error) {
        console.error('[TencentProvider] API Error:', data.Response.Error);
        return { success: false, error: data.Response.Error.Message || data.Response.Error.Code };
      }

      if (data.Response.TargetText) {
        console.log('[TencentProvider] Success:', data.Response.TargetText);
        return {
          success: true,
          translatedText: data.Response.TargetText,
          detectedSourceLang: data.Response.Source,
        };
      }

      return { success: false, error: 'Empty result' };
    } catch (error) {
      console.error('[TencentProvider] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }

  validateConfig(): boolean {
    return !!(this.config.secretId && this.config.secretId.trim().length > 0 && this.config.secretKey && this.config.secretKey.trim().length > 0);
  }

  getConfig(): TencentTranslationConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<TencentTranslationConfig>): void {
    Object.assign(this.config, config);
  }
}
