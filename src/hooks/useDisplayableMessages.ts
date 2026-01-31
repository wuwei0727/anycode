/**
 * 可显示消息过滤 Hook
 *
 * 从 ClaudeCodeSession 提取（原 343-403 行）
 * 负责过滤出应该在 UI 中显示的消息
 */

import { useMemo } from 'react';
import type { ClaudeStreamMessage } from '@/types/claude';

const isDebugEnabled = (key: string): boolean => {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

// Enable by running in DevTools console:
// localStorage.setItem('anycode.debug.displayableMessages', '1')
const DEBUG_DISPLAYABLE_MESSAGES = isDebugEnabled('anycode.debug.displayableMessages');
const debug = (...args: any[]) => {
  if (DEBUG_DISPLAYABLE_MESSAGES) console.log(...args);
};

/**
 * 过滤选项
 */
interface DisplayableMessagesOptions {
  /** 是否隐藏 Warmup 消息及其回复 */
  hideWarmupMessages?: boolean;
  /** 是否隐藏启动期间的系统警告消息 */
  hideStartupWarnings?: boolean;
}

/**
 * 提取消息中的纯文本（仅用于过滤，不影响真实消息内容）
 */
function extractMessageText(message: ClaudeStreamMessage): string {
  const content = message.message?.content;
  if (!content) return '';

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text || '')
      .join('');
  }

  return '';
}

/**
 * 检查消息是否为系统注入的环境上下文/指令块
 * 这些内容对用户阅读没有意义，且会污染会话列表预览与搜索
 */
function isInjectedContextMessage(message: ClaudeStreamMessage): boolean {
  const text = extractMessageText(message);
  if (!text) return false;

  const lower = text.toLowerCase();
  return (
    lower.includes('<environment_context>') ||
    lower.includes('# agents.md instructions') ||
    lower.includes('<permissions instructions>') ||
    // Internal "turn aborted" markers should never be rendered as chat content.
    lower.includes('<turn_aborted')
  );
}

/**
 * 检查消息是否为 Skills 运行过程中的标签/日志消息
 * 用户通常不需要看到这些“无用标签”
 */
function isSkillsTraceMessage(message: ClaudeStreamMessage): boolean {
  if (message.type !== 'user') return false;
  const text = extractMessageText(message);
  if (!text) return false;

  return (
    text.includes('<command-name>') ||
    text.includes('<command-message>') ||
    text.includes('Launching skill:') ||
    text.includes('skill is running')
  );
}

/**
 * 检查消息是否为启动期间的系统警告消息
 * 这些消息通常在 Gemini 等引擎初始化 MCP 客户端时产生
 */
function isStartupWarningMessage(message: ClaudeStreamMessage): boolean {
  // 只检查 system 类型的消息
  if (message.type !== 'system') return false;

  // 获取消息内容
  const content = message.message?.content;
  let text = '';

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text || '')
      .join('');
  }

  // 检查是否包含启动期间的特征字符串
  const startupPatterns = [
    '[STARTUP]',
    'Recording metric',
    'initialize_mcp_clients',
    'Initializing MCP',
    'MCP client',
  ];

  return startupPatterns.some(pattern => text.includes(pattern));
}

/**
 * 检查消息是否为 Warmup 消息
 *
 * 真正的 Warmup 消息是系统生成的简短消息，通常以 "Warmup" 开头
 * 需要排除用户粘贴的包含 "Warmup" 关键字的长文本（如日志内容）
 */
function isWarmupMessage(message: ClaudeStreamMessage): boolean {
  if (message.type !== 'user') return false;

  const text = extractMessageText(message);

  // 修复：更精确的 Warmup 消息检测
  // 真正的 Warmup 消息特征：
  // 1. 消息以 "Warmup" 开头（系统生成的 Warmup 提示）
  // 2. 消息内容较短（通常不超过 200 字符）
  // 排除用户粘贴的包含 "Warmup" 的长日志文本
  const trimmedText = text.trim();

  // 如果消息太长（超过 200 字符），不认为是 Warmup 消息
  // 因为真正的 Warmup 消息是简短的系统提示
  if (trimmedText.length > 200) {
    return false;
  }

  // 检查是否以 "Warmup" 开头（不区分大小写）
  return trimmedText.toLowerCase().startsWith('warmup');
}

/**
 * 过滤出可显示的消息
 *
 * 过滤规则：
 * 1. 跳过没有实际内容的元消息（isMeta && !leafUuid && !summary）
 * 2. 跳过只包含工具结果的用户消息（工具结果已在 assistant 消息中显示）
 * 3. 跳过空内容的用户消息
 * 4. （可选）跳过 Warmup 消息及其回复
 *
 * @param messages - 原始消息列表
 * @param options - 过滤选项
 * @returns 过滤后的可显示消息列表
 *
 * @example
 * const displayableMessages = useDisplayableMessages(messages, { hideWarmupMessages: true });
 * // 用于渲染 UI
 */
export function useDisplayableMessages(
  messages: ClaudeStreamMessage[],
  options: DisplayableMessagesOptions = {}
): ClaudeStreamMessage[] {
  // 默认隐藏 Warmup（undefined 时为 true），只有明确设置为 false 时才显示
  const hideWarmupMessages = options.hideWarmupMessages !== false;
  // 默认隐藏启动警告（undefined 时为 true）
  const hideStartupWarnings = options.hideStartupWarnings !== false;

  return useMemo(() => {
    // Codex may emit assistant output as event_msg.agent_message (fallback) AND as response_item.message.
    // We prefer response_item when available and drop the agent_message duplicate.
    const codexAssistantResponseTexts = new Set<string>();
    for (const msg of messages) {
      if (msg.engine !== 'codex') continue;
      if (msg.type !== 'assistant') continue;
      if ((msg as any)._codexAgentMessage) continue;

      const text = extractMessageText(msg).trim();
      if (!text) continue;
      codexAssistantResponseTexts.add(text);
    }

    // Extra safety: dedupe identical Codex assistant messages that may arrive twice
    // (e.g. global + session-specific channels).
    const seenCodexAssistantContentKeys = new Set<string>();

    // 如果需要隐藏 Warmup，先找到所有 Warmup 消息的索引
    const warmupIndices = new Set<number>();

    if (hideWarmupMessages) {
      messages.forEach((msg, idx) => {
        if (isWarmupMessage(msg)) {
          warmupIndices.add(idx);
          // 找到紧跟其后的 assistant 回复（Warmup 的响应）
          if (idx + 1 < messages.length && messages[idx + 1].type === 'assistant') {
            warmupIndices.add(idx + 1);
          }
        }
      });
      debug('[useDisplayableMessages] Hiding Warmup:', {
        totalMessages: messages.length,
        warmupIndices: Array.from(warmupIndices),
        hideWarmupSetting: hideWarmupMessages
      });
    }

    const filtered = messages.filter((message, index) => {
      // De-dupe Codex agent_message fallback when response_item exists for the same (timestamp, text).
      if (message.engine === 'codex' && message.type === 'assistant') {
        const text = extractMessageText(message).trim();
        if (text) {
          // Prefer response_item.message over agent_message, regardless of timestamp drift.
          if ((message as any)._codexAgentMessage && codexAssistantResponseTexts.has(text)) {
            return false;
          }

          const metaId = message.codexMetadata?.codexItemId;
          const metaType = message.codexMetadata?.codexItemType;
          const base =
            metaId && metaType
              ? `meta:${metaType}:${metaId}`
              : `ts:${(message.timestamp || message.receivedAt || '').toString()}`;
          const key = `${base}|${text}`;
          if (seenCodexAssistantContentKeys.has(key)) {
            return false;
          }
          seenCodexAssistantContentKeys.add(key);
        }
      }

      // 规则 0：隐藏 Warmup 消息及其回复
      if (hideWarmupMessages && warmupIndices.has(index)) {
        return false;
      }
      // 规则 0.5：隐藏启动期间的系统警告消息
      if (hideStartupWarnings && isStartupWarningMessage(message)) {
        return false;
      }
      // 规则 0.6：隐藏系统注入的环境上下文/指令块
      if (isInjectedContextMessage(message)) {
        return false;
      }
      // 规则 0.7：隐藏 Skills 过程标签/日志消息
      if (isSkillsTraceMessage(message)) {
        return false;
      }
      // 规则 1：跳过没有实际内容的元消息
      if (message.isMeta && !message.leafUuid && !message.summary) {
        return false;
      }

      // 规则 2 & 3：处理用户消息
      if (message.type === 'user' && message.message) {
        debug('[useDisplayableMessages] 检查用户消息 #', index, '| isMeta:', message.isMeta, '| content:', message.message.content);
        // 跳过元消息标记的用户消息
        if (message.isMeta) return false;

        const msg = message.message;

        // 检查是否有空内容
        if (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0)) {
          return false;
        }

        // 检查是否只包含工具结果
        if (Array.isArray(msg.content)) {
          let hasVisibleContent = false;

          for (const content of msg.content) {
            // 如果有文本内容，保留消息
            if (content.type === 'text') {
              hasVisibleContent = true;
              break;
            }

            // 检查工具结果是否会被跳过（已在 assistant 消息中显示）
            if (content.type === 'tool_result') {
              let willBeSkipped = false;

              if (content.tool_use_id) {
                // 向前查找匹配的 tool_use
                for (let i = index - 1; i >= 0; i--) {
                  const prevMsg = messages[i];

                  if (
                    prevMsg.type === 'assistant' &&
                    prevMsg.message?.content &&
                    Array.isArray(prevMsg.message.content)
                  ) {
                    const toolUse = prevMsg.message.content.find(
                      (c: any) => c.type === 'tool_use' && c.id === content.tool_use_id
                    );

                    if (toolUse) {
                      const toolName = toolUse.name?.toLowerCase();

                      // 这些工具有专用的 Widget，结果不需要单独显示
                      const toolsWithWidgets = [
                        'task',
                        'edit',
                        'multiedit',
                        'todowrite',
                        'ls',
                        'read',
                        'glob',
                        'bash',
                        'write',
                        'grep'
                      ];

                      if (
                        toolsWithWidgets.includes(toolName) ||
                        toolUse.name?.startsWith('mcp__')
                      ) {
                        willBeSkipped = true;
                      }
                      break;
                    }
                  }
                }
              }

              // 如果工具结果不会被跳过，说明有可见内容
              if (!willBeSkipped) {
                hasVisibleContent = true;
                break;
              }
            }
          }

          // 如果没有可见内容,过滤掉这条消息
          if (!hasVisibleContent) {
            debug('[useDisplayableMessages] ❌ 过滤用户消息 #', index, '(无可见内容)');
            return false;
          } else {
            debug('[useDisplayableMessages] ✅ 保留用户消息 #', index);
          }
        }
      }

      // 其他情况保留消息
      return true;
    });

    // 统计保留的消息
    const userMessagesCount = filtered.filter(m => m.type === 'user').length;
    debug('[useDisplayableMessages] 过滤结果:', {
      原始消息: messages.length,
      保留消息: filtered.length,
      用户消息数: userMessagesCount
    });

    return filtered;
  }, [messages, hideWarmupMessages, hideStartupWarnings]);
}
