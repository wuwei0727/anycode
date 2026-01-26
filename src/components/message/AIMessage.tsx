import React from "react";
import { MessageBubble } from "./MessageBubble";
import { MessageContent } from "./MessageContent";
import { ToolCallsGroup } from "./ToolCallsGroup";
import { ThinkingBlock } from "./ThinkingBlock";
import { MessageImagePreview, extractImagePathsFromText } from "./MessageImagePreview";
import { cn } from "@/lib/utils";
import { tokenExtractor } from "@/lib/tokenExtractor";
import { formatTimestamp } from "@/lib/messageUtils";
import { ClaudeIcon } from "@/components/icons/ClaudeIcon";
import { CodexIcon } from "@/components/icons/CodexIcon";
import { GeminiIcon } from "@/components/icons/GeminiIcon";
import type { ClaudeStreamMessage } from '@/types/claude';

interface AIMessageProps {
  /** 消息数据 */
  message: ClaudeStreamMessage;
  /** 是否正在流式输出 */
  isStreaming?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 链接检测回调 */
  onLinkDetected?: (url: string) => void;
  /** 项目路径（用于解析相对文件路径） */
  projectPath?: string;
}

/**
 * 提取AI消息的文本内容
 */
const extractAIText = (message: ClaudeStreamMessage): string => {
  if (!message.message?.content) return '';
  
  const content = message.message.content;
  
  // 如果是字符串，直接返回
  if (typeof content === 'string') return content;
  
  // 如果是数组，提取所有text类型的内容
  if (Array.isArray(content)) {
    const texts = content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .filter(Boolean);
    
    // 调试日志：检查提取的文本内容
    if (texts.length > 0) {
      console.log('[AIMessage] Extracted text content:', {
        contentLength: content.length,
        textBlocksCount: texts.length,
        totalTextLength: texts.join('\n\n').length,
        preview: texts.join('\n\n').substring(0, 200) + '...',
      });
    }
    
    return texts.join('\n\n');
  }
  
  return '';
};

/**
 * 检测消息中是否有工具调用
 *
 * 注意：只检查 tool_use，不检查 tool_result
 * tool_result 是工具执行的结果，通常通过 ToolCallsGroup 根据 tool_use 匹配显示
 * Codex 的 function_call_output 事件会生成仅包含 tool_result 的消息，
 * 这些消息不应该触发工具卡片渲染（避免空白消息卡片）
 */
const hasToolCalls = (message: ClaudeStreamMessage): boolean => {
  if (!message.message?.content) return false;

  const content = message.message.content;
  if (!Array.isArray(content)) return false;

  return content.some((item: any) => item.type === 'tool_use');
};

/**
 * 检测消息中是否有思考块
 */
const hasThinkingBlock = (message: ClaudeStreamMessage): boolean => {
  if (!message.message?.content) return false;

  const content = message.message.content;
  if (!Array.isArray(content)) return false;

  return content.some((item: any) => item.type === 'thinking');
};

/**
 * 提取思考块内容
 */
const extractThinkingContent = (message: ClaudeStreamMessage): string => {
  if (!message.message?.content) return '';

  const content = message.message.content;
  if (!Array.isArray(content)) return '';

  const thinkingBlocks = content.filter((item: any) => item.type === 'thinking');
  return thinkingBlocks.map((item: any) => item.thinking || '').join('\n\n');
};

/**
 * AI消息组件（重构版）
 * 左对齐卡片样式，支持工具调用展示和思考块
 *
 * 打字机效果逻辑：
 * - 统一依赖 isStreaming prop（只有在流式输出时才启用）
 * - isStreaming 由 SessionMessages 组件传入，表示当前是最后一条消息且会话正在进行
 * - 历史消息加载时 isStreaming=false，不会触发打字机效果
 */
export const AIMessage: React.FC<AIMessageProps> = ({
  message,
  isStreaming = false,
  className,
  onLinkDetected,
  projectPath
}) => {
  const text = extractAIText(message);
  const hasTools = hasToolCalls(message);
  const hasThinking = hasThinkingBlock(message);
  const thinkingContent = hasThinking ? extractThinkingContent(message) : '';

  // 🆕 提取图片路径并从文本中分离
  const { images, cleanText } = extractImagePathsFromText(text);

  // Detect engine type for avatar styling
  const isCodexMessage = (message as any).engine === 'codex';
  const isGeminiMessage = (message as any).geminiMetadata?.provider === 'gemini' || (message as any).engine === 'gemini';

  // 打字机效果只在流式输出时启用
  // isStreaming=true 表示：当前是最后一条消息 && 会话正在进行中
  const enableTypewriter = isStreaming;

  // 如果既没有文本又没有工具调用又没有思考块又没有图片，不渲染
  if (!cleanText && !hasTools && !hasThinking && images.length === 0) return null;

  // 提取 tokens 统计
  const tokenStats = message.message?.usage ? (() => {
    const extractedTokens = tokenExtractor.extract({
      type: 'assistant',
      message: { usage: message.message.usage }
    });
    const parts = [`${extractedTokens.input_tokens}/${extractedTokens.output_tokens}`];
    if (extractedTokens.cache_creation_tokens > 0) {
      parts.push(`创建${extractedTokens.cache_creation_tokens}`);
    }
    if (extractedTokens.cache_read_tokens > 0) {
      parts.push(`缓存${extractedTokens.cache_read_tokens}`);
    }
    return parts.join(' | ');
  })() : null;

  const assistantName = isGeminiMessage ? 'Gemini' : isCodexMessage ? 'Codex' : 'Claude';

  // 根据引擎类型选择图标
  const EngineIcon = isGeminiMessage ? GeminiIcon : isCodexMessage ? CodexIcon : ClaudeIcon;

  return (
    <div className={cn("relative group", className)}>
      <MessageBubble variant="assistant">
        <div className="flex gap-4 items-start">
          {/* Left Column: Avatar */}
          <div className="flex-shrink-0 mt-0.5 select-none">
            <div className={cn(
              "flex items-center justify-center w-7 h-7 rounded-lg",
              isGeminiMessage
                ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 dark:bg-purple-500/20"
                : isCodexMessage
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 dark:bg-blue-500/20"
                  : "bg-orange-500/10 text-orange-600 dark:text-orange-400 dark:bg-orange-500/20"
            )}>
              <EngineIcon className="w-4 h-4" />
            </div>
          </div>

          {/* Right Column: Content */}
          <div className="flex-1 min-w-0">

            {/* Main Content */}
            <div className="space-y-1">
              {/* 🆕 图片预览（如果有的话） */}
              {images.length > 0 && (
                <MessageImagePreview images={images} />
              )}

              {cleanText && (
                <div className="prose prose-neutral dark:prose-invert max-w-none leading-relaxed text-[15px]">
                  <MessageContent
                    content={cleanText}
                    isStreaming={enableTypewriter && !hasTools && !hasThinking}
                    enableTypewriter={enableTypewriter && !hasTools && !hasThinking}
                    projectPath={projectPath}
                  />
                </div>
              )}

              {/* Thinking Block */}
              {hasThinking && thinkingContent && (
                <ThinkingBlock
                  content={thinkingContent}
                  isStreaming={enableTypewriter}
                  autoCollapseDelay={2500}
                />
              )}

              {/* Tool Calls */}
              {hasTools && (
                <ToolCallsGroup
                  message={message}
                  onLinkDetected={onLinkDetected}
                  projectPath={projectPath}
                />
              )}
            </div>

            {/* Footer: Meta Info (Hover Only) */}
            <div className="flex items-center justify-end gap-2 pt-1 text-[10px] text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none">
              <span className="font-medium">{assistantName}</span>
              {formatTimestamp((message as any).receivedAt ?? (message as any).timestamp) && (
                <>
                  <span>•</span>
                  <span>
                    {formatTimestamp((message as any).receivedAt ?? (message as any).timestamp)}
                  </span>
                </>
              )}
              {tokenStats && (
                <>
                  <span>•</span>
                  <span className="font-mono opacity-80">
                    {tokenStats}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </MessageBubble>
    </div>
  );
};
