 import { tokenExtractor, type StandardizedTokenUsage, normalizeRawUsage } from '@/lib/tokenExtractor';
import { calculateMessageCost } from '@/lib/pricing';
import type { ClaudeStreamMessage } from '@/types/claude';

export interface BillingEvent {
  key: string;
  tokens: StandardizedTokenUsage;
  model: string;
  cost: number;
  timestamp?: string;
  timestampMs?: number;
  message: ClaudeStreamMessage;
}

export interface SessionCostTotals {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionCostAggregation {
  totals: SessionCostTotals;
  events: BillingEvent[];
  assistantMessageCount: number;
  firstEventTimestampMs?: number;
  lastEventTimestampMs?: number;
}

interface MutableBillingEvent extends BillingEvent {
  totalTokenCount: number;
  order: number;
}

const MODEL_FALLBACK = 'claude-sonnet-4.5';

/**
 * 检查消息是否包含 usage 数据（支持多引擎）
 * - Claude: assistant 消息中的 usage 字段
 * - Codex: system 消息中的 usage 字段（来自 turn.completed 事件）
 * - Gemini: assistant 消息中的 stats 字段
 */
function hasUsageData(message: ClaudeStreamMessage): boolean {
  // Claude/Codex: 检查 usage 字段
  if ((message as any).usage) {
    return true;
  }
  // Claude: 检查 message.usage 字段
  if ((message as any).message?.usage) {
    return true;
  }
  // Gemini: 检查 stats 字段
  if ((message as any).stats) {
    return true;
  }
  return false;
}

/**
 * 从消息中提取 usage 数据（支持多引擎）
 */
function extractUsageFromMessage(message: ClaudeStreamMessage): StandardizedTokenUsage {
  // Codex: 直接从顶层 usage 字段提取（来自 token_count 或 turn.completed 事件）
  const codexUsage = (message as any).usage;
  if (codexUsage && typeof codexUsage.input_tokens === 'number') {
    return normalizeRawUsage({
      input_tokens: codexUsage.input_tokens,
      output_tokens: codexUsage.output_tokens || 0,
      cache_read_tokens: codexUsage.cache_read_tokens || codexUsage.cached_input_tokens || 0,
    });
  }
  
  // Gemini: 从 stats 字段提取
  const geminiStats = (message as any).stats;
  if (geminiStats && typeof geminiStats.input_tokens === 'number') {
    return normalizeRawUsage({
      input_tokens: geminiStats.input_tokens,
      output_tokens: geminiStats.output_tokens || 0,
    });
  }
  
  // Claude: 使用标准 tokenExtractor
  return tokenExtractor.extract(message);
}

interface CodexUsageData {
  tokens: StandardizedTokenUsage;
  timestamp?: string;
  timestampMs?: number;
}

export function aggregateSessionCost(messages: ClaudeStreamMessage[]): SessionCostAggregation {
  const eventMap = new Map<string, MutableBillingEvent>();
  
  // 第一遍：检测是否是 Codex 会话，并找到最新的 token_count 消息
  // Codex 的 token_count 消息中的 usage 已经是累计值，不需要累加
  let latestCodexUsage: CodexUsageData | null = null;
  
  for (const message of messages) {
    const msgAny = message as any;
    const isCodexTokenCount = message.type === 'system' && 
      msgAny.subtype === 'info' && 
      msgAny.usage &&
      (msgAny.engine === 'codex' || msgAny.contextWindow);
    
    if (isCodexTokenCount) {
      const tokens = extractUsageFromMessage(message);
      const { timestamp, timestampMs } = extractTimestamp(message);
      const currentTimestampMs = latestCodexUsage?.timestampMs;
      console.log('[SessionCost] Found Codex token_count:', {
        input: tokens.input_tokens,
        output: tokens.output_tokens,
        cacheRead: tokens.cache_read_tokens,
        contextWindow: msgAny.contextWindow,
        timestamp
      });
      if (!latestCodexUsage || (timestampMs && (!currentTimestampMs || timestampMs > currentTimestampMs))) {
        latestCodexUsage = { tokens, timestamp, timestampMs };
      }
    }
  }
  
  // 如果是 Codex 会话，直接使用最新的累计值，不需要处理其他消息
  const isCodexSession = latestCodexUsage !== null;

  // 第二遍：只有非 Codex 会话才处理其他消息
  if (!isCodexSession) {
    messages.forEach((message, index) => {
      // 支持多引擎：
      // - Claude: type === 'assistant' 且有 usage
      // - Gemini: type === 'assistant' 且有 stats
      const isClaudeAssistant = message.type === 'assistant';
      const isGeminiAssistant = message.type === 'assistant' && (message as any).stats;
    
    if (!isClaudeAssistant && !isGeminiAssistant) {
      return;
    }

    // 检查是否有 usage 数据
    if (!hasUsageData(message)) {
      return;
    }

    const tokens = extractUsageFromMessage(message);
    const totalTokenCount = calculateTotalTokens(tokens);

    if (totalTokenCount === 0) {
      return;
    }

    const key = getBillingKey(message, index);
    const { timestamp, timestampMs } = extractTimestamp(message);
    const model = getModelName(message);
    const cost = calculateMessageCost(tokens, model);

    const existing = eventMap.get(key);
    if (
      !existing ||
      totalTokenCount > existing.totalTokenCount ||
      (totalTokenCount === existing.totalTokenCount && (timestampMs ?? 0) >= (existing.timestampMs ?? 0))
    ) {
      eventMap.set(key, {
        key,
        tokens,
        model,
        cost,
        timestamp,
        timestampMs,
        message,
        totalTokenCount,
        order: index,
      });
    }
    });
  }

  const events = Array.from(eventMap.values()).sort((a, b) => {
    if (a.timestampMs !== undefined && b.timestampMs !== undefined && a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }

    if (a.timestampMs !== undefined) {
      return -1;
    }

    if (b.timestampMs !== undefined) {
      return 1;
    }

    return a.order - b.order;
  });

  const totals: SessionCostTotals = {
    totalCost: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  // 对于 Codex 会话，直接使用最新的累计值
  // 使用类型断言来解决 TypeScript 的闭包类型推断问题
  const codexUsageData = latestCodexUsage as CodexUsageData | null;
  if (isCodexSession && codexUsageData !== null) {
    const codexTokens = codexUsageData.tokens;
    totals.inputTokens = codexTokens.input_tokens;
    totals.outputTokens = codexTokens.output_tokens;
    totals.cacheReadTokens = codexTokens.cache_read_tokens;
    totals.cacheWriteTokens = codexTokens.cache_creation_tokens;
    // Codex: cached_input_tokens 是 input_tokens 的子集，不要重复计算
    // total_tokens = input_tokens + output_tokens
    totals.totalTokens = codexTokens.input_tokens + codexTokens.output_tokens;
    // Codex 成本计算（使用默认模型）
    totals.totalCost = calculateMessageCost(codexTokens, 'codex');
    console.log('[SessionCost] Codex session totals:', {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      cacheReadTokens: totals.cacheReadTokens
    });
  } else {
    // 对于 Claude/Gemini，累加所有事件
    events.forEach(event => {
      totals.totalCost += event.cost;
      totals.inputTokens += event.tokens.input_tokens;
      totals.outputTokens += event.tokens.output_tokens;
      totals.cacheReadTokens += event.tokens.cache_read_tokens;
      totals.cacheWriteTokens += event.tokens.cache_creation_tokens;
      totals.totalTokens += calculateTotalTokens(event.tokens);
    });
  }

  const timestampValues = events
    .map(event => event.timestampMs)
    .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));

  const firstEventTimestampMs = timestampValues.length > 0 ? Math.min(...timestampValues) : undefined;
  const lastEventTimestampMs = timestampValues.length > 0 ? Math.max(...timestampValues) : undefined;

  return {
    totals,
    events,
    assistantMessageCount: events.length,
    firstEventTimestampMs,
    lastEventTimestampMs,
  };
}

function calculateTotalTokens(tokens: StandardizedTokenUsage): number {
  return (
    tokens.input_tokens +
    tokens.output_tokens +
    tokens.cache_creation_tokens +
    tokens.cache_read_tokens
  );
}

function getBillingKey(message: ClaudeStreamMessage, index: number): string {
  const nestedId = (message as any)?.message?.id;
  if (typeof nestedId === 'string' && nestedId.trim() !== '') {
    return `message:${nestedId}`;
  }

  const messageId = (message as any).id;
  if (typeof messageId === 'string' && messageId.trim() !== '') {
    return `message:${messageId}`;
  }

  const uuid = (message as any).uuid;
  if (typeof uuid === 'string' && uuid.trim() !== '') {
    return `uuid:${uuid}`;
  }

  const timestamp = (message as any).timestamp ?? (message as any).receivedAt;
  if (typeof timestamp === 'string' && timestamp.trim() !== '') {
    return `time:${timestamp}`;
  }

  return `index:${index}`;
}

function extractTimestamp(message: ClaudeStreamMessage): { timestamp?: string; timestampMs?: number } {
  const candidates = [
    (message as any).timestamp,
    (message as any).receivedAt,
    (message as any).sentAt,
    (message as any)?.message?.timestamp,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      continue;
    }

    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return {
        timestamp: candidate,
        timestampMs: parsed,
      };
    }
  }

  return {};
}

function getModelName(message: ClaudeStreamMessage): string {
  const candidates = [
    (message as any).model,
    (message as any)?.message?.model,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return MODEL_FALLBACK;
}




