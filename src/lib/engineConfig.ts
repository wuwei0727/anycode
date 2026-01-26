/**
 * 引擎配置常量
 * 定义所有 AI 引擎的配置信息
 */

import { ClaudeIcon } from '@/components/icons/ClaudeIcon';
import { CodexIcon } from '@/components/icons/CodexIcon';
import { GeminiIcon } from '@/components/icons/GeminiIcon';
import type { EngineConfig, EngineType, EngineErrorType } from '@/types/engine';

/**
 * 引擎配置映射
 */
export const ENGINE_CONFIGS: Record<EngineType, EngineConfig> = {
  claude: {
    type: 'claude',
    name: 'claude',
    displayName: 'Claude Code',
    Icon: ClaudeIcon,
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10 hover:bg-orange-500/20',
    installUrl: 'https://docs.claude.ai/docs/installation',
    docsUrl: 'https://docs.claude.ai',
    updateCheckUrl: 'https://api.github.com/repos/anthropics/claude-code/releases/latest'
  },
  codex: {
    type: 'codex',
    name: 'codex',
    displayName: 'Codex CLI',
    Icon: CodexIcon,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10 hover:bg-blue-500/20',
    installUrl: 'https://github.com/openai/codex-cli#installation',
    docsUrl: 'https://github.com/openai/codex-cli',
  },
  gemini: {
    type: 'gemini',
    name: 'gemini',
    displayName: 'Gemini CLI',
    Icon: GeminiIcon,
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10 hover:bg-purple-500/20',
    installUrl: 'https://ai.google.dev/gemini-api/docs/cli',
    docsUrl: 'https://ai.google.dev/gemini-api',
  }
};

/**
 * 引擎列表（按顺序）
 */
export const ENGINES: EngineConfig[] = [
  ENGINE_CONFIGS.claude,
  ENGINE_CONFIGS.codex,
  ENGINE_CONFIGS.gemini
];

/**
 * 错误消息映射
 */
export const ERROR_MESSAGES: Record<EngineErrorType, string> = {
  not_installed: '引擎未安装。请先安装后再使用。',
  permission_denied: '权限不足。请检查文件权限设置。',
  invalid_path: '引擎路径无效。请检查自定义路径配置。',
  version_check_failed: '无法获取版本信息。引擎可能未正确安装。',
  timeout: '检测超时。请检查网络连接或引擎状态。',
  unknown: '未知错误。请查看日志获取详细信息。'
};

/**
 * 环境显示名称
 */
export const ENVIRONMENT_LABELS = {
  native: 'Native',
  wsl: 'WSL'
} as const;

/**
 * 环境图标
 */
export const ENVIRONMENT_ICONS = {
  native: '🖥️',
  wsl: '🐧'
} as const;

/**
 * 缓存配置
 */
export const CACHE_CONFIG = {
  /** 缓存键前缀 */
  KEY_PREFIX: 'engine_status_',
  
  /** 缓存 TTL (5 分钟) */
  TTL: 5 * 60 * 1000,
  
  /** LocalStorage 键 */
  STORAGE_KEY: 'engine_status_cache'
} as const;

/**
 * 检测配置
 */
export const DETECTION_CONFIG = {
  /** 检测超时时间 (5 秒) */
  TIMEOUT: 5000,
  
  /** 防抖延迟 (1 秒) */
  DEBOUNCE_DELAY: 1000,
  
  /** 重试次数 */
  MAX_RETRIES: 2
} as const;
