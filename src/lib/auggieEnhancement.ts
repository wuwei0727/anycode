/**
 * Auggie 提示词优化集成
 * 通过 auggie CLI 的 prompt-enhancer 功能优化提示词
 * 
 * auggie 支持两种调用方式：
 * 1. 通过 MCP 工具调用（如果 auggie 作为 MCP 服务器运行）
 * 2. 通过 HTTP 代理调用（需要启动 auggie HTTP 代理服务）
 */

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface AuggieConfig {
  enabled: boolean;
  // HTTP 代理模式配置
  httpProxyUrl?: string;
  // 是否使用 MCP 模式
  useMcpMode?: boolean;
}

const AUGGIE_CONFIG_KEY = 'auggie_enhancement_config';

/**
 * 加载 Auggie 配置
 */
export function loadAuggieConfig(): AuggieConfig {
  try {
    const stored = localStorage.getItem(AUGGIE_CONFIG_KEY);
    if (!stored) {
      return {
        enabled: false,
        httpProxyUrl: 'http://localhost:3001',
        useMcpMode: true,
      };
    }
    return JSON.parse(stored);
  } catch (error) {
    console.error('[AuggieEnhancement] Failed to load config:', error);
    return {
      enabled: false,
      httpProxyUrl: 'http://localhost:3001',
      useMcpMode: true,
    };
  }
}

/**
 * 保存 Auggie 配置
 */
export function saveAuggieConfig(config: AuggieConfig): void {
  try {
    localStorage.setItem(AUGGIE_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('[AuggieEnhancement] Failed to save config:', error);
  }
}

/**
 * 检查 Auggie 是否可用
 */
export async function checkAuggieAvailability(): Promise<{
  available: boolean;
  mode: 'mcp' | 'http' | 'none';
  message: string;
}> {
  const config = loadAuggieConfig();
  
  // 尝试 MCP 模式
  if (config.useMcpMode) {
    try {
      // 检查 auggie MCP 服务器是否运行
      const mcpServers = await invoke<any[]>('mcp_list');
      const auggieServer = mcpServers?.find((s: any) => 
        s.name?.toLowerCase().includes('auggie') || 
        s.name?.toLowerCase().includes('augment')
      );
      
      if (auggieServer) {
        return {
          available: true,
          mode: 'mcp',
          message: `Auggie MCP 服务器已连接: ${auggieServer.name}`,
        };
      }
    } catch (error) {
      console.log('[AuggieEnhancement] MCP check failed:', error);
    }
  }
  
  // 尝试 HTTP 代理模式
  if (config.httpProxyUrl) {
    try {
      const response = await tauriFetch(`${config.httpProxyUrl}/health`, {
        method: 'GET',
        connectTimeout: 3000,
      });
      
      if (response.ok) {
        return {
          available: true,
          mode: 'http',
          message: `Auggie HTTP 代理已连接: ${config.httpProxyUrl}`,
        };
      }
    } catch (error) {
      console.log('[AuggieEnhancement] HTTP proxy check failed:', error);
    }
  }
  
  return {
    available: false,
    mode: 'none',
    message: 'Auggie 服务不可用。请确保 auggie 已登录并运行。',
  };
}

/**
 * 通过 Auggie 优化提示词
 * 
 * @param prompt 原始提示词
 * @param context 可选的上下文信息
 * @returns 优化后的提示词
 */
export async function enhancePromptWithAuggie(
  prompt: string,
  context?: string[]
): Promise<string> {
  const config = loadAuggieConfig();
  
  if (!config.enabled) {
    throw new Error('Auggie 优化功能未启用');
  }
  
  // 构建完整的提示词（包含上下文）
  let fullPrompt = prompt;
  if (context && context.length > 0) {
    fullPrompt = `${context.join('\n')}\n\n${prompt}`;
  }
  
  // 尝试 MCP 模式
  if (config.useMcpMode) {
    try {
      const result = await callAuggieMcp(fullPrompt);
      if (result) {
        return result;
      }
    } catch (error) {
      console.warn('[AuggieEnhancement] MCP call failed, trying HTTP:', error);
    }
  }
  
  // 尝试 HTTP 代理模式
  if (config.httpProxyUrl) {
    try {
      const result = await callAuggieHttp(config.httpProxyUrl, fullPrompt);
      return result;
    } catch (error) {
      console.error('[AuggieEnhancement] HTTP call failed:', error);
      throw error;
    }
  }
  
  throw new Error('无法连接到 Auggie 服务');
}

/**
 * 通过 MCP 调用 Auggie prompt-enhancer
 */
async function callAuggieMcp(prompt: string): Promise<string> {
  // 调用 Tauri 后端的 MCP 工具调用功能
  // 这需要后端支持调用 MCP 工具
  try {
    const result = await invoke<string>('call_mcp_tool', {
      serverName: 'auggie',
      toolName: 'prompt-enhancer',
      arguments: {
        prompt: prompt,
        mode: 'AGENT',  // 使用 AGENT 模式进行优化
      },
    });
    
    return result;
  } catch (error) {
    console.error('[AuggieEnhancement] MCP tool call failed:', error);
    throw error;
  }
}

/**
 * 通过 HTTP 代理调用 Auggie
 */
async function callAuggieHttp(baseUrl: string, prompt: string): Promise<string> {
  const response = await tauriFetch(`${baseUrl}/enhance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: prompt,
      mode: 'AGENT',
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Auggie HTTP 请求失败: ${response.status} ${errorText}`);
  }
  
  const data = await response.json();
  
  if (data.error) {
    throw new Error(`Auggie 错误: ${data.error}`);
  }
  
  return data.enhancedPrompt || data.result || data.content;
}

/**
 * 创建 Auggie 提供商对象（用于与现有系统集成）
 */
export function createAuggieProvider(): {
  id: string;
  name: string;
  enabled: boolean;
  isAuggie: true;
} {
  const config = loadAuggieConfig();
  return {
    id: 'auggie',
    name: 'Auggie (Augment)',
    enabled: config.enabled,
    isAuggie: true,
  };
}

