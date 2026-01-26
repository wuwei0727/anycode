/**
 * Context Window Indicator - 上下文窗口使用情况工具函数
 * 
 * 提供计算和显示 AI 会话上下文窗口使用情况的工具函数
 */

// ============================================================================
// 类型定义
// ============================================================================

export type EngineType = 'claude' | 'codex' | 'gemini';
export type ColorStatus = 'green' | 'yellow' | 'red';
export type WarningLevel = 'none' | 'warning' | 'critical';

export interface ContextWindowState {
  /** 已使用的 token 数量 */
  usedTokens: number;
  /** 最大 token 数量 */
  maxTokens: number;
  /** 使用百分比 (0-100) */
  usagePercent: number;
  /** 剩余百分比 (0-100) */
  remainingPercent: number;
  /** 颜色状态 */
  colorStatus: ColorStatus;
  /** 是否显示警告 */
  shouldWarn: boolean;
  /** 警告级别 */
  warningLevel: WarningLevel;
}

// ============================================================================
// 常量配置
// ============================================================================

/** 颜色阈值配置 */
export const COLOR_THRESHOLDS = {
  green: { max: 50 },        // 0-50%: 绿色
  yellow: { min: 50, max: 80 }, // 50-80%: 黄色
  red: { min: 80 },          // 80-100%: 红色
} as const;

/** 警告阈值配置 */
export const WARNING_THRESHOLDS = {
  warning: 80,   // 80% 显示警告
  critical: 90,  // 90% 显示紧急警告
} as const;

/** 引擎上下文限制配置 */
export const ENGINE_CONTEXT_LIMITS: Record<string, Record<string, number>> = {
  claude: {
    'claude-sonnet-4-20250514': 200000,
    'claude-3-5-sonnet-20241022': 200000,
    'claude-3-5-haiku-20241022': 200000,
    'claude-3-opus-20240229': 200000,
    'claude-3-haiku-20240307': 200000,
    default: 200000,
  },
  codex: {
    'o3': 200000,
    'o4-mini': 200000,
    'gpt-4.1': 1000000,
    'gpt-4o': 128000,
    'codex-mini': 200000,
    default: 200000,
  },
  gemini: {
    'gemini-2.5-pro': 1000000,
    'gemini-2.5-flash': 1000000,
    'gemini-2.0-flash': 1000000,
    'gemini-1.5-pro': 2000000,
    default: 1000000,
  },
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算使用百分比
 * @param usedTokens 已使用的 token 数量
 * @param maxTokens 最大 token 数量
 * @returns 使用百分比 (0-100)
 */
export function calculateUsagePercent(usedTokens: number, maxTokens: number): number {
  // 处理无效输入
  if (!Number.isFinite(usedTokens) || usedTokens < 0) {
    return 0;
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return 0;
  }
  
  const percent = (usedTokens / maxTokens) * 100;
  // 限制在 0-100 范围内
  return Math.min(Math.max(percent, 0), 100);
}

/**
 * 根据使用百分比获取颜色状态
 * @param percent 使用百分比 (0-100)
 * @returns 颜色状态
 */
export function getColorStatus(percent: number): ColorStatus {
  if (percent >= COLOR_THRESHOLDS.red.min) {
    return 'red';
  }
  if (percent >= COLOR_THRESHOLDS.yellow.min) {
    return 'yellow';
  }
  return 'green';
}

/**
 * 根据使用百分比获取警告级别
 * @param percent 使用百分比 (0-100)
 * @returns 警告级别
 */
export function getWarningLevel(percent: number): WarningLevel {
  if (percent >= WARNING_THRESHOLDS.critical) {
    return 'critical';
  }
  if (percent >= WARNING_THRESHOLDS.warning) {
    return 'warning';
  }
  return 'none';
}

/**
 * 获取引擎的最大上下文 token 数量
 * @param engine 引擎类型
 * @param model 模型名称（可选）
 * @returns 最大 token 数量
 */
export function getMaxTokensForEngine(engine: EngineType, model?: string): number {
  const engineLimits = ENGINE_CONTEXT_LIMITS[engine];
  if (!engineLimits) {
    return ENGINE_CONTEXT_LIMITS.claude.default; // 默认使用 Claude 的限制
  }
  
  if (model && engineLimits[model]) {
    return engineLimits[model];
  }
  
  return engineLimits.default;
}

/**
 * 格式化 token 数量为可读字符串
 * @param count token 数量
 * @returns 格式化后的字符串，如 '35k'、'258k'、'1.2M'
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return '0';
  }
  
  if (count < 1000) {
    return count.toString();
  }
  
  if (count < 1000000) {
    const k = count / 1000;
    // 如果是整数 k，不显示小数点
    if (k === Math.floor(k)) {
      return `${Math.floor(k)}k`;
    }
    return `${k.toFixed(1)}k`;
  }
  
  const m = count / 1000000;
  if (m === Math.floor(m)) {
    return `${Math.floor(m)}M`;
  }
  return `${m.toFixed(1)}M`;
}

/**
 * 获取颜色对应的 CSS 类名
 * @param colorStatus 颜色状态
 * @returns CSS 类名对象
 */
export function getColorClasses(colorStatus: ColorStatus): {
  text: string;
  stroke: string;
  bg: string;
} {
  switch (colorStatus) {
    case 'green':
      return {
        // 使用更深的绿色，在浅色背景上更清晰
        text: 'text-emerald-600 dark:text-emerald-400',
        stroke: 'stroke-emerald-600 dark:stroke-emerald-400',
        bg: 'bg-emerald-600 dark:bg-emerald-400',
      };
    case 'yellow':
      return {
        // 使用橙色代替黄色，更容易看清
        text: 'text-orange-500 dark:text-orange-400',
        stroke: 'stroke-orange-500 dark:stroke-orange-400',
        bg: 'bg-orange-500 dark:bg-orange-400',
      };
    case 'red':
      return {
        text: 'text-red-600 dark:text-red-400',
        stroke: 'stroke-red-600 dark:stroke-red-400',
        bg: 'bg-red-600 dark:bg-red-400',
      };
  }
}
