/**
 * OpenAI Codex Event Converter
 *
 * Converts Codex JSONL events to ClaudeStreamMessage format
 * for seamless integration with existing message display components.
 */

import type {
  CodexEvent,
  CodexItem,
  CodexAgentMessageItem,
  CodexReasoningItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexWebSearchItem,
  CodexTodoListItem,
  CodexMessageMetadata,
} from '@/types/codex';
import type { ClaudeStreamMessage } from '@/types/claude';

const isDebugEnabled = (key: string): boolean => {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

// Enable by running in DevTools console:
// localStorage.setItem('anycode.debug.codexConverter', '1')
const DEBUG_CODEX_CONVERTER = isDebugEnabled('anycode.debug.codexConverter');
const debug = (...args: any[]) => {
  if (DEBUG_CODEX_CONVERTER) console.log(...args);
};

const coerceToString = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value.map(coerceToString).filter((s) => s.trim().length > 0).join('\n');
  }
  if (typeof value === 'object') {
    const v: any = value;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.message === 'string') return v.message;
    if (typeof v.content === 'string') return v.content;
    if (typeof v.summary_text === 'string') return v.summary_text;
    if (typeof v.value === 'string') return v.value;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
};

const pickFirstNonEmptyText = (...candidates: unknown[]): string => {
  for (const candidate of candidates) {
    const text = coerceToString(candidate);
    if (text.trim().length > 0) return text;
  }
  return '';
};

const extractUserRequestFromIdeContext = (value: string): string | null => {
  const marker = '## My request for Codex:';
  const idx = value.indexOf(marker);
  if (idx < 0) return null;
  const extracted = value.slice(idx + marker.length).trim();
  return extracted.length > 0 ? extracted : null;
};

/**
 * Maps Codex tool names to Claude Code tool names
 * This ensures consistent tool rendering between realtime stream and history loading
 */
const CODEX_TOOL_NAME_MAP: Record<string, string> = {
  // Command execution
  'shell_command': 'bash',
  'shell': 'bash',
  'terminal': 'bash',
  'execute': 'bash',
  'run_command': 'bash',

  // File operations
  'edit_file': 'edit',
  'modify_file': 'edit',
  'update_file': 'edit',
  'patch_file': 'edit',
  'edited': 'edit',           // Codex 文件编辑工具
  'str_replace_editor': 'edit', // Codex 字符串替换编辑器
  'apply_patch': 'edit',      // Codex 补丁应用
  'read_file': 'read',
  'view_file': 'read',
  'create_file': 'write',
  'write_file': 'write',
  'save_file': 'write',
  'delete_file': 'bash', // Usually done via shell command

  // Search operations
  'search_files': 'grep',
  'find_files': 'glob',
  'list_files': 'ls',
  'list_directory': 'ls',

  // Web operations
  'web_search': 'websearch',
  'search_web': 'websearch',
  'fetch_url': 'webfetch',
  'get_url': 'webfetch',
};

/**
 * Maps a Codex tool name to its Claude Code equivalent
 */
function mapCodexToolName(codexName: string): string {
  const lowerName = codexName.toLowerCase();
  return CODEX_TOOL_NAME_MAP[lowerName] || codexName;
}

function stripImagePlaceholders(text: string): string {
  // VSCode / Codex 可能会在 user 的 input_text 中注入占位标签：
  // <image>\n</image>
  // 这些标签不应作为可见文本渲染（真正的图片块会单独以 input_image 提供）。
  const withoutTags = text.replace(/<\/?image>/gi, '');
  const lines = withoutTags
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.join('\n').trim();
}

/**
 * State manager for Codex event conversion
 * Maintains context across multiple events for proper message construction
 */
export interface CodexEventConverterOptions {
  /**
   * Whether to surface event_msg.agent_reasoning as visible thinking blocks.
   * - Keep `false` (default) for history loading to avoid duplicate noise.
   * - Enable for realtime file-watcher streams to match VSCode plugin behavior.
   */
  includeAgentReasoning?: boolean;
}

export class CodexEventConverter {
  private options: CodexEventConverterOptions;
  private threadId: string | null = null;
  private currentTurnUsage: { input_tokens: number; cached_input_tokens?: number; output_tokens: number } | null = null;
  private itemMap: Map<string, CodexItem> = new Map();
  /** Stores tool results by call_id for later matching with tool_use */
  private toolResults: Map<string, { content: string; is_error: boolean }> = new Map();
  private agentReasoningSegments: Set<string> = new Set();

  // ✅ FIX: Add cumulative token tracking for real-time context window updates
  /** Cumulative token usage across all turns in the session */
  private cumulativeUsage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
  };

  constructor(options: CodexEventConverterOptions = {}) {
    this.options = options;
  }

  /**
   * Gets stored tool result by call_id
   * Used by UI to match tool_use with its result
   */
  getToolResult(callId: string): { content: string; is_error: boolean } | undefined {
    return this.toolResults.get(callId);
  }

  /**
   * Gets all stored tool results
   * Returns a new Map to prevent external modification
   */
  getAllToolResults(): Map<string, { content: string; is_error: boolean }> {
    return new Map(this.toolResults);
  }

  /**
   * Converts a Codex JSONL event to ClaudeStreamMessage format
   * @param eventLine - Raw JSONL line from Codex output
   * @returns ClaudeStreamMessage or null if event should be skipped
   */
  convertEvent(eventLine: string): ClaudeStreamMessage | null {
    try {
      const event = JSON.parse(eventLine) as CodexEvent;
      return this.convertEventObject(event);
    } catch (error) {
      console.error('[CodexConverter] Failed to parse event:', eventLine, error);
      return null;
    }
  }

  /**
   * Converts a parsed Codex event object to ClaudeStreamMessage format
   * @param event - Parsed Codex event object
   * @returns ClaudeStreamMessage or null if event should be skipped
   */
  convertEventObject(event: CodexEvent): ClaudeStreamMessage | null {
      debug('[CodexConverter] Processing event:', event.type, event);

      switch (event.type) {
        case 'thread.started':
          this.threadId = event.thread_id;

          // ✅ FIX: Reset cumulative usage when a new thread starts
          this.cumulativeUsage = {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
          };

          // Return init message with session_id for frontend to track
          return {
            type: 'system',
            subtype: 'init',
            result: `Codex session started`,
            session_id: event.thread_id, // ← Important: frontend will extract this
            timestamp: (event as any).timestamp || new Date().toISOString(),
            receivedAt: (event as any).timestamp || new Date().toISOString(),
          };

        case 'turn.started':
          // Reset turn state
          this.currentTurnUsage = null;
          debug('[CodexConverter] Skipping turn.started event');
          return null; // Don't display turn start events

        case 'turn.completed':
          this.currentTurnUsage = event.usage;

          // ✅ FIX: Accumulate token usage for real-time context window tracking
          this.cumulativeUsage.input_tokens += event.usage.input_tokens;
          this.cumulativeUsage.output_tokens += event.usage.output_tokens;
          if (event.usage.cached_input_tokens) {
            this.cumulativeUsage.cached_input_tokens += event.usage.cached_input_tokens;
          }

          debug('[CodexConverter] Cumulative usage updated:', {
            input: this.cumulativeUsage.input_tokens,
            cached: this.cumulativeUsage.cached_input_tokens,
            output: this.cumulativeUsage.output_tokens,
            total: this.cumulativeUsage.input_tokens + this.cumulativeUsage.output_tokens,
          });

          // ✅ FIX: Pass cumulative usage instead of turn usage for accurate context window display
          return this.createUsageMessage(this.cumulativeUsage, event.timestamp);

        case 'turn.failed':
          return this.createErrorMessage(event.error.message, event.timestamp);

        case 'item.started':
          {
            const msg = this.convertItem(event.item, 'started', event.timestamp);
            this.itemMap.set(event.item.id, event.item);
            return msg;
          }

        case 'item.updated':
          {
            const msg = this.convertItem(event.item, 'updated', event.timestamp);
            this.itemMap.set(event.item.id, event.item);
            return msg;
          }

        case 'item.completed':
          {
            const msg = this.convertItem(event.item, 'completed', event.timestamp);
            this.itemMap.set(event.item.id, event.item);
            return msg;
          }

        case 'error':
          return this.createErrorMessage(event.error.message, event.timestamp);

        case 'session_meta':
          // Return init message
          return {
            type: 'system',
            subtype: 'init',
            result: `Codex session started (ID: ${event.payload.id})`,
            session_id: event.payload.id,
            timestamp: event.payload.timestamp || event.timestamp || new Date().toISOString(),
            receivedAt: event.payload.timestamp || event.timestamp || new Date().toISOString(),
          };

        case 'response_item':
          return this.convertResponseItem(event);

        case 'event_msg':
          return this.convertEventMsg(event as import('@/types/codex').CodexEvent);

        case 'turn_context':
          // Turn context events are metadata, don't display
          debug('[CodexConverter] Skipping turn_context event');
          return null;

        default:
          console.warn('[CodexConverter] Unknown event type:', (event as any).type, 'Full event:', event);
          return null;
      }
  }

  /**
   * Converts event_msg event to ClaudeStreamMessage
   */
  private convertEventMsg(event: import('@/types/codex').CodexEvent): ClaudeStreamMessage | null {
    const { payload } = event;

    switch (payload.type) {
      case 'agent_reasoning':
        // Realtime-friendly thinking updates (VSCode plugin shows these while the model is working).
        // We keep it OFF by default to avoid duplicating response_item.reasoning when loading history.
        if (!this.options.includeAgentReasoning) {
          debug('[CodexConverter] Skipping event_msg.agent_reasoning (handled by response_item.reasoning)');
          return null;
        }
        {
          const raw = pickFirstNonEmptyText((payload as any).text, (payload as any).message, (payload as any).content);
          const text = raw.trim();
          if (!text) return null;

          this.agentReasoningSegments.add(text);

          return {
            type: 'thinking',
            content: raw,
            timestamp: event.timestamp || new Date().toISOString(),
            receivedAt: event.timestamp || new Date().toISOString(),
            engine: 'codex' as const,
            _codexAgentReasoning: true,
          } as ClaudeStreamMessage;
        }

      case 'token_count':
        // Extract token usage from event_msg with type="token_count"
        // This contains detailed usage info including model_context_window
        if (payload.info) {
          const info = payload.info;
          // 使用 last_token_usage 表示当前上下文窗口中的 token 数量（与官方插件一致）
          // total_token_usage 是整个会话的累计值，last_token_usage 是当前请求的上下文
          const lastUsage = info.last_token_usage || info.total_token_usage || {};
          const contextWindow = info.model_context_window || 200000;
          
          return {
            type: 'system',
            subtype: 'info',
            result: '', // Empty result - this is just for usage tracking
            timestamp: event.timestamp || new Date().toISOString(),
            receivedAt: event.timestamp || new Date().toISOString(),
            engine: 'codex' as const,
            // Store usage data for context window calculation (使用 last_token_usage)
            usage: {
              input_tokens: lastUsage.input_tokens || 0,
              output_tokens: lastUsage.output_tokens || 0,
              cache_read_tokens: lastUsage.cached_input_tokens || 0,
              cache_creation_tokens: 0,
              reasoning_tokens: lastUsage.reasoning_output_tokens || 0,
            },
            // Store context window info for ContextWindowIndicator
            contextWindow: contextWindow,
            rateLimits: payload.rate_limits,
          } as ClaudeStreamMessage;
        }
        return null;

      case 'user_message':
        // ⚠️ DUPLICATE DETECTION: Codex sends BOTH event_msg.user_message AND response_item (role: user)
        // These are the SAME user prompt with identical content
        // Processing both causes duplicate display with different timestamps
        //
        // Example from JSONL:
        // Line 4: {"type":"response_item","payload":{"role":"user","content":[...]}}
        // Line 5: {"type":"event_msg","payload":{"type":"user_message","message":"..."}}
        //
        // We skip event_msg.user_message to avoid duplication
        debug('[CodexConverter] ⚠️ Skipping event_msg.user_message (duplicates response_item with role=user)');
        return null;

      case 'agent_message':
      case 'assistant_message': {
        // Codex may emit assistant text as event_msg.agent_message (sometimes without a matching
        // response_item message). We convert it so the UI can display the output.
        //
        // When response_item is also present, we de-dupe in useDisplayableMessages via
        // the `_codexAgentMessage` marker.
        const text = pickFirstNonEmptyText((payload as any).message, (payload as any).text, (payload as any).content);
        if (!text.trim()) return null;
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
          timestamp: event.timestamp || new Date().toISOString(),
          receivedAt: event.timestamp || new Date().toISOString(),
          engine: 'codex' as const,
          _codexAgentMessage: true,
        } as ClaudeStreamMessage;
      }

      default:
        debug('[CodexConverter] Skipping event_msg with payload.type:', payload.type);
        return null;
    }
  }

  /**
   * Converts response_item event to ClaudeStreamMessage
   * Note: This handles different payload.type values including function_call, reasoning, etc.
   */
  private convertResponseItem(event: import('@/types/codex').CodexEvent): ClaudeStreamMessage | null {
    const { payload } = event;
    if (!payload) {
      console.warn('[CodexConverter] response_item missing payload:', event);
      return null;
    }

    // Handle different response_item payload types
    const payloadType = (payload as any).type;

    // A new user message indicates a new turn; reset per-turn agent_reasoning tracking.
    if (payloadType === 'message' && payload.role === 'user') {
      this.agentReasoningSegments.clear();
    }

    if (payloadType === 'function_call') {
      // Tool use (function call)
      return this.convertFunctionCall(event);
    }

    if (payloadType === 'function_call_output') {
      // Tool result (function call output)
      return this.convertFunctionCallOutput(event);
    }

    // Handle custom_tool_call (e.g., apply_patch for file editing)
    if (payloadType === 'custom_tool_call') {
      return this.convertCustomToolCall(event);
    }

    // Handle custom_tool_call_output (result of custom tool call)
    if (payloadType === 'custom_tool_call_output') {
      return this.convertCustomToolCallOutput(event);
    }

    if (payloadType === 'reasoning') {
      // Extended thinking (encrypted content)
      return this.convertReasoningPayload(event);
    }

    if (payloadType === 'ghost_snapshot') {
      // Ghost commit snapshot - skip for now
      debug('[CodexConverter] Skipping ghost_snapshot');
      return null;
    }

    // Handle message-type response_item (user/assistant messages)
    if (!payload.role) {
      console.warn('[CodexConverter] response_item missing role and not a recognized type:', event);
      return null;
    }

    // Normalize payload.content (Codex usually uses array, but be defensive)
    const rawContentArray: any[] = Array.isArray((payload as any).content)
      ? (payload as any).content
      : typeof (payload as any).content === 'string'
      ? [{ type: payload.role === 'user' ? 'input_text' : 'output_text', text: (payload as any).content }]
      : [];

    // VSCode Codex plugin usually wraps the real request inside an IDE-context blob.
    // Keep the actual "My request for Codex" part and drop the injected context (without losing images).
    let coercedUserRequest: string | null = null;
    let suppressInjectedUserText = false;
    if (payload.role === 'user' && rawContentArray.length > 0) {
      const combinedUserText = rawContentArray
        .filter((c: any) => c?.type === 'input_text')
        .map((c: any) => coerceToString(c?.text))
        .filter((s: string) => s.trim().length > 0)
        .join('\n');

      coercedUserRequest = extractUserRequestFromIdeContext(combinedUserText);

      const lower = combinedUserText.toLowerCase();
      const hasInjectedContext =
        lower.includes('<environment_context>') ||
        lower.includes('# agents.md instructions') ||
        lower.includes('<permissions instructions>') ||
        lower.includes('<turn_aborted');

      // If it looks like injected context but we can't extract a real request, drop text blocks.
      if (hasInjectedContext && !coercedUserRequest) {
        suppressInjectedUserText = true;
      }
    }

    // Map payload to Claude message structure
    // Note: Codex uses 'input_text' for user messages and 'output_text' for assistant messages
    // Claude uses 'text' for both
    // Codex uses 'input_image' with 'image_url' for images
    // Claude uses 'image' with 'source' for images
    const hasImageBlock = rawContentArray.some((c: any) => c?.type === 'input_image');
    let didApplyUserRequest = false;

	    const content = rawContentArray.map((c: any) => {
	      // Handle text content
	      if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'output_text_delta' || c.type === 'text') {
	        const rawTextValue = c.text ?? c.delta ?? c.message ?? c.content ?? '';

	        // For IDE-context user messages, surface only the actual request (once).
	        if (payload.role === 'user' && c.type === 'input_text') {
	          if (coercedUserRequest) {
	            if (didApplyUserRequest) return null;
	            didApplyUserRequest = true;
	            const reqText = /<\/?image>/i.test(coercedUserRequest) || hasImageBlock
	              ? stripImagePlaceholders(coercedUserRequest)
	              : coercedUserRequest;
	            if (!reqText.trim()) return null;
	            return { type: 'text', text: reqText };
	          }
	          if (suppressInjectedUserText) {
	            return null;
	          }
	        }

	        const rawText = coerceToString(rawTextValue);
	        const text = /<\/?image>/i.test(rawText) || hasImageBlock ? stripImagePlaceholders(rawText) : rawText;
	        if (!text || !text.trim()) return null;
	        return { ...c, type: 'text', text };
	      }
      
      // Handle image content - convert Codex format to Claude format
      if (c.type === 'input_image' && c.image_url) {
        debug('[CodexConverter] Found input_image, converting to Claude format');
        // Parse data URL: data:image/png;base64,xxxxx
        const dataUrlMatch = c.image_url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUrlMatch) {
          debug('[CodexConverter] Converted input_image (base64):', {
            mediaType: dataUrlMatch[1],
            dataLength: dataUrlMatch[2].length,
          });
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataUrlMatch[1],
              data: dataUrlMatch[2],
            },
          };
        }
        // If it's a regular URL (not data URL)
        debug('[CodexConverter] Converted input_image (url):', c.image_url.substring(0, 100));
        return {
          type: 'image',
          source: {
            type: 'url',
            url: c.image_url,
          },
        };
      }
      
      return c;
    });
    const filteredContent = content.filter(Boolean);

    // Check if content is empty or has only empty text blocks
    if (filteredContent.length === 0) {
      console.warn('[CodexConverter] response_item has empty content, skipping');
      return null;
    }

    const hasNonEmptyContent = filteredContent.some((c: any) => {
      if (c.type === 'text') {
        return c.text && c.text.trim().length > 0;
      }
      return true; // Non-text content blocks are considered valid
    });

    if (!hasNonEmptyContent) {
      console.warn('[CodexConverter] response_item has no non-empty content, skipping');
      return null;
    }

	    // 调试日志：检查转换后的内容
	    debug('[CodexConverter] Converted response_item content:', {
	      role: payload.role,
	      contentBlocks: filteredContent.length,
	      textBlocks: filteredContent.filter((c: any) => c?.type === 'text').length,
	      totalTextLength: filteredContent
	        .filter((c: any) => c?.type === 'text')
	        .reduce((sum: number, c: any) => sum + (c?.text?.length || 0), 0),
	    });

    const message: ClaudeStreamMessage = {
      type: payload.role === 'user' ? 'user' : 'assistant',
      message: {
        role: payload.role,
        content: filteredContent
      },
      timestamp: payload.timestamp || event.timestamp || new Date().toISOString(),
      receivedAt: payload.timestamp || event.timestamp || new Date().toISOString(),
      // Add Codex identifier for UI display
      engine: 'codex' as const,
    };

    debug('[CodexConverter] Converted response_item:', {
      eventType: event.type,
      role: payload.role,
      contentTypes: filteredContent?.map((c: any) => c.type),
      contentCount: filteredContent.length,
      messageType: message.type
    });

    return message;
  }

  /**
   * Converts function_call response_item to tool_use message
   */
  private convertFunctionCall(event: any): ClaudeStreamMessage {
    const payload = event.payload;
    const rawToolName = payload.name || 'unknown_tool';
    // Map Codex tool names to Claude Code equivalents for consistent rendering
    const toolName = mapCodexToolName(rawToolName);
    let toolArgs: any = {};
    try {
      toolArgs = payload.arguments ? JSON.parse(payload.arguments) : {};
    } catch (err) {
      console.warn('[CodexConverter] Failed to parse tool arguments:', err, payload.arguments);
      toolArgs = {};
    }
    const callId = payload.call_id || `call_${Date.now()}`;

    // For shell_command, also normalize the input structure
    let normalizedInput = toolArgs;
    if (toolName === 'bash' && !toolArgs.command && toolArgs.cmd) {
      normalizedInput = { command: toolArgs.cmd, ...toolArgs };
    }

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: callId,
            name: toolName,
            input: normalizedInput,
          },
        ],
      },
      timestamp: event.timestamp || new Date().toISOString(),
      receivedAt: event.timestamp || new Date().toISOString(),
      engine: 'codex' as const,
    };
  }

  /**
   * Converts function_call_output response_item to tool_result message
   *
   * Note: For Codex, function_call and function_call_output are separate events.
   * We return a message with tool_result so it gets added to toolResults Map,
   * but mark it with _toolResultOnly so UI can filter it out from display.
   */
  private convertFunctionCallOutput(event: any): ClaudeStreamMessage {
    const payload = event.payload;
    const callId = payload.call_id || `call_${Date.now()}`;
    const output = payload.output || '';

    // Parse output if it's JSON string
    let resultContent = output;
    try {
      if (typeof output === 'string' && output.trim().startsWith('[')) {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed) && parsed[0]?.text) {
          resultContent = parsed[0].text;
        }
      }
    } catch {
      // Keep original output if parsing fails
    }

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent),
          },
        ],
      },
      timestamp: event.timestamp || new Date().toISOString(),
      receivedAt: event.timestamp || new Date().toISOString(),
      engine: 'codex' as const,
      // Mark as tool_result_only so UI can filter it out from display
      _toolResultOnly: true,
    } as ClaudeStreamMessage;
  }

  /**
   * Converts custom_tool_call response_item to tool_use message
   * Handles tools like apply_patch for file editing
   *
   * Format:
   * {
   *   "type": "custom_tool_call",
   *   "status": "completed",
   *   "call_id": "call_xxx",
   *   "name": "apply_patch",
   *   "input": "*** Begin Patch\n*** Update File: path/to/file\n..."
   * }
   */
  private convertCustomToolCall(event: any): ClaudeStreamMessage {
    const payload = event.payload;
    const rawToolName = payload.name || 'unknown_tool';
    const toolName = mapCodexToolName(rawToolName);
    const callId = payload.call_id || `call_${Date.now()}`;
    const input = payload.input || '';

    // Parse apply_patch input to extract file path and changes
    let normalizedInput: Record<string, any> = { raw_input: input };

    if (rawToolName === 'apply_patch' && typeof input === 'string') {
      // Extract file path from patch format: "*** Update File: path/to/file"
      const fileMatch = input.match(/\*\*\* (?:Update|Create|Delete|Add) File: (.+)/);
      const filePath = fileMatch ? fileMatch[1].trim() : '';

      // Extract the patch content (everything between @@ markers)
      const patchMatch = input.match(/@@\n([\s\S]*?)(?:\n\*\*\* End Patch|$)/);
      const patchContent = patchMatch ? patchMatch[1] : input;

      // Parse diff-like content for old_string/new_string
      const lines = patchContent.split('\n');
      const oldLines: string[] = [];
      const newLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('-') && !line.startsWith('---')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          newLines.push(line.slice(1));
        } else if (!line.startsWith('@@') && !line.startsWith('***')) {
          // Context line - add to both
          oldLines.push(line);
          newLines.push(line);
        }
      }

      normalizedInput = {
        file_path: filePath,
        old_string: oldLines.join('\n'),
        new_string: newLines.join('\n'),
        patch: input,
      };
    }

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: callId,
            name: toolName,
            input: normalizedInput,
          },
        ],
      },
      timestamp: event.timestamp || new Date().toISOString(),
      receivedAt: event.timestamp || new Date().toISOString(),
      engine: 'codex' as const,
    };
  }

  /**
   * Converts custom_tool_call_output response_item
   *
   * Format:
   * {
   *   "type": "custom_tool_call_output",
   *   "call_id": "call_xxx",
   *   "output": "{\"output\":\"Success. Updated...\",\"metadata\":{...}}"
   * }
   *
   * Similar to function_call_output, we return a message with tool_result
   * so it gets added to toolResults Map, but mark it with _toolResultOnly
   * so UI can filter it out from display.
   */
  private convertCustomToolCallOutput(event: any): ClaudeStreamMessage {
    const payload = event.payload;
    const callId = payload.call_id || `call_${Date.now()}`;
    const output = payload.output || '';

    // Parse output if it's JSON string
    let resultContent = output;
    let isError = false;

    try {
      if (typeof output === 'string' && output.trim().startsWith('{')) {
        const parsed = JSON.parse(output);
        resultContent = parsed.output || parsed.message || output;
        isError = parsed.metadata?.exit_code !== 0;
      }
    } catch {
      // Keep original output if parsing fails
    }

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent),
            is_error: isError,
          },
        ],
      },
      timestamp: event.timestamp || new Date().toISOString(),
      receivedAt: event.timestamp || new Date().toISOString(),
      engine: 'codex' as const,
      // Mark as tool_result_only so UI can filter it out from display
      _toolResultOnly: true,
    } as ClaudeStreamMessage;
  }

  /**
   * Converts reasoning response_item to thinking message
   */
  private convertReasoningPayload(event: any): ClaudeStreamMessage | null {
    const payload = event.payload;

    // Extract summary text if available
    const rawSummary = (payload as any)?.summary;
    const summaryArray: any[] =
      Array.isArray(rawSummary) ? rawSummary : (typeof rawSummary === 'string' ? [{ text: rawSummary }] : []);

    const summarySegments: string[] = summaryArray
      .map((s: any) =>
        pickFirstNonEmptyText(
          s?.text,
          s?.summary_text,
          s?.content,
          s?.message,
          s?.value
        )
      )
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    // If we already streamed each segment via event_msg.agent_reasoning, skip the aggregated reasoning payload
    // to avoid duplicates in realtime mode.
    if (this.options.includeAgentReasoning && summarySegments.length > 0) {
      const allSeen = summarySegments.every((s) => this.agentReasoningSegments.has(s));
      if (allSeen) {
        return null;
      }
    }

    const summaryText = summarySegments.join('\n') || '';

    // In realtime mode, if we have no readable summary, skip the noisy placeholder
    // (VSCode plugin typically shows agent_reasoning/tool progress instead).
    if (this.options.includeAgentReasoning && !summaryText.trim()) {
      return null;
    }

    // Note: encrypted_content is encrypted and cannot be displayed
    // We use the summary instead
    return {
      type: 'thinking',
      content: summaryText || '(Extended thinking - encrypted content)',
      timestamp: event.timestamp || new Date().toISOString(),
      receivedAt: event.timestamp || new Date().toISOString(),
      engine: 'codex' as const,
    };
  }

  /**
   * Converts a Codex item to ClaudeStreamMessage
   */
  private convertItem(item: CodexItem, phase: 'started' | 'updated' | 'completed', eventTimestamp?: string): ClaudeStreamMessage | null {
    const metadata: CodexMessageMetadata = {
      codexItemType: item.type,
      codexItemId: item.id,
      threadId: this.threadId || undefined,
      usage: this.currentTurnUsage || undefined,
    };

    switch (item.type) {
      case 'agent_message':
        return this.convertAgentMessage(item, phase, metadata, eventTimestamp);

      case 'reasoning':
        return this.convertReasoning(item, phase, metadata, eventTimestamp);

      case 'command_execution':
        return this.convertCommandExecution(item, phase, metadata, eventTimestamp);

      case 'file_change':
        return this.convertFileChange(item, phase, metadata, eventTimestamp);

      case 'mcp_tool_call':
        // Only show tool calls when completed (to avoid "executing" state)
        if (phase === 'completed') {
          return this.convertMcpToolCall(item, phase, metadata, eventTimestamp);
        }
        debug('[CodexConverter] Skipping mcp_tool_call in phase:', phase);
        return null;

      case 'web_search':
        return this.convertWebSearch(item, phase, metadata, eventTimestamp);

      case 'todo_list':
        return this.convertTodoList(item, phase, metadata, eventTimestamp);

      default:
        console.warn('[CodexConverter] Unknown item type:', (item as any).type, 'Full item:', item);
        return null;
    }
  }

  /**
   * Converts agent_message to assistant message
   */
  private convertAgentMessage(
    item: CodexAgentMessageItem,
    _phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: item.text,
          },
        ],
      },
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }

  /**
   * Converts reasoning to thinking message
   */
  private convertReasoning(
    item: CodexReasoningItem,
    _phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    return {
      type: 'thinking',
      content: item.text,
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }

  /**
   * Converts command_execution to tool_use message
   */
  private convertCommandExecution(
    item: CodexCommandExecutionItem,
    phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage {
    const isComplete = phase === 'completed';
    const toolUseId = `codex_cmd_${item.id}`;
    const ts = eventTimestamp || new Date().toISOString();

    const toolUseBlock = {
      type: 'tool_use',
      id: toolUseId,
      name: 'bash',
      input: { command: item.command },
    };

    if (!isComplete) {
      // Stream a tool_use inside an assistant message so UI renders immediately
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [toolUseBlock],
        },
        timestamp: ts,
        receivedAt: ts,
        engine: 'codex' as const,
        codexMetadata: metadata,
      };
    }

    // Completed -> assistant message containing both tool_use + tool_result
    const toolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [
        {
          type: 'text',
          text: item.aggregated_output || '',
        },
      ],
      is_error: item.status === 'failed',
    };

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [toolUseBlock, toolResultBlock],
      },
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }

  /**
   * Converts file_change to tool_use message
   */
  private convertFileChange(
    item: CodexFileChangeItem,
    phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage | null {
    const ts = eventTimestamp || new Date().toISOString();

    // Merge with previous stage (itemMap now stores the last item BEFORE this event)
    const prevItem = this.itemMap.get(item.id) as CodexFileChangeItem | undefined;
    const mergedItem: CodexFileChangeItem & Record<string, any> = {
      ...(prevItem || {}),
      ...item,
      // Legacy fields
      file_path: item.file_path ?? prevItem?.file_path,
      change_type: item.change_type ?? prevItem?.change_type,
      content: item.content ?? prevItem?.content,
      // Newer fields
      changes: (item as any).changes ?? (prevItem as any)?.changes,
      // Optional diff payloads
      patch: (item as any).patch ?? (prevItem as any)?.patch,
      diff: (item as any).diff ?? (prevItem as any)?.diff,
      lines_changed: (item as any).lines_changed ?? (prevItem as any)?.lines_changed,
    };

    // Normalize to a list of (file_path, change_type)
    const normalizedChanges: Array<{ file_path: string; change_type: 'create' | 'update' | 'delete' }> = [];

    if (Array.isArray((mergedItem as any).changes) && (mergedItem as any).changes.length > 0) {
      for (const c of (mergedItem as any).changes) {
        const rawPath = c?.path ?? c?.file_path ?? c?.filePath ?? c?.file ?? c?.filename;
        const rawKind = c?.kind ?? c?.change_type ?? c?.changeType;

        if (typeof rawPath !== 'string' || !rawPath.trim()) continue;

        const kind = rawKind === 'create' || rawKind === 'update' || rawKind === 'delete'
          ? rawKind
          : 'update';

        normalizedChanges.push({ file_path: rawPath.trim(), change_type: kind });
      }
    }

    // Fallback: legacy single-file shape
    if (normalizedChanges.length === 0) {
      const fp = mergedItem.file_path;
      if (typeof fp === 'string' && fp.trim()) {
        const ct = mergedItem.change_type;
        const changeType: 'create' | 'update' | 'delete' =
          ct === 'create' || ct === 'update' || ct === 'delete' ? ct : 'update';
        normalizedChanges.push({ file_path: fp.trim(), change_type: changeType });
      }
    }

    if (normalizedChanges.length === 0) {
      console.warn('[CodexConverter] file_change missing file path(s), skipping:', mergedItem);
      return null;
    }

    // Stable ordering across phases (started/updated/completed)
    normalizedChanges.sort((a, b) => a.file_path.localeCompare(b.file_path));

    const multi = normalizedChanges.length > 1;
    const contentBlocks: any[] = [];

    normalizedChanges.forEach((change, idx) => {
      const toolUseId = normalizedChanges.length === 1
        ? `codex_file_${item.id}`
        : `codex_file_${item.id}_${idx}`;

      const toolName = change.change_type === 'create'
        ? 'write'
        : change.change_type === 'delete'
        ? 'bash'
        : 'edit';

      const inputPayload: Record<string, any> = {
        file_path: change.file_path,
        change_type: change.change_type,
      };

      // Only attach heavy payloads when it's clearly single-file
      if (!multi) {
        if (mergedItem.content) inputPayload.content = mergedItem.content;
        if ((mergedItem as any).diff) inputPayload.diff = (mergedItem as any).diff;
        if ((mergedItem as any).patch) inputPayload.patch = (mergedItem as any).patch;
        if ((mergedItem as any).lines_changed) inputPayload.lines_changed = (mergedItem as any).lines_changed;
      }

      contentBlocks.push({
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input: inputPayload,
      });

      if (phase === 'completed') {
        contentBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'text',
              text: this.buildFileChangeSummary(change, mergedItem, !multi),
            },
          ],
          is_error: mergedItem.status === 'failed',
        });
      }
    });

    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: contentBlocks,
      },
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }

  private buildFileChangeSummary(
    change: { file_path: string; change_type: 'create' | 'update' | 'delete' },
    item: CodexFileChangeItem & Record<string, any>,
    includeSnippet: boolean
  ): string {
    const header = `File ${change.change_type}: ${change.file_path}`;
    if (!includeSnippet) return header;

    const diff = item.patch || item.diff || '';
    const content = item.content || '';
    const snippetSource = diff || content;
    if (!snippetSource) return header;

    const snippet = snippetSource.length > 800 ? `${snippetSource.slice(0, 800)}\n...[truncated]` : snippetSource;
    return `${header}\n${snippet}`;
  }

  /**
   * Converts mcp_tool_call to complete tool_use + tool_result message
   * Only called when phase === 'completed'
   */
  private convertMcpToolCall(
    item: any, // Use any to handle actual Codex format
    _phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    const toolUseId = `codex_mcp_${item.id}`;

    // Extract tool name from Codex format: server.tool or just tool
    const toolName = item.server ? `mcp__${item.server}__${item.tool}` : (item.tool || item.tool_name);

    // Always create a complete message with both tool_use and tool_result
    {
    // Extract actual result content from nested structure
    const output = item.result || item.tool_output;
    let resultText = '';

	    if (output && typeof output === 'object') {
	      // MCP result format: { content: [{ text: "..." }], ... }
	      if (output.content && Array.isArray(output.content)) {
	        resultText = output.content
	          .filter((c: any) => c && (c.type === 'text' || c.text))
	          .map((c: any) => c.text)
	          .join('\n');
	      } else {
	        resultText = JSON.stringify(output, null, 2);
	      }
    } else {
      resultText = output ? String(output) : '';
    }

    // Return assistant message with both tool_use and tool_result in content array
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: item.arguments || item.tool_input || {},
          },
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'text', text: resultText }],
            is_error: item.status === 'failed' || item.error !== null,
          }
        ]
      },
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }
  }

  /**
   * Converts web_search to tool_use message
   */
  private convertWebSearch(
    item: CodexWebSearchItem,
    phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    const toolUseId = `codex_search_${item.id}`;

    const toolUseBlock = {
      type: 'tool_use',
      id: toolUseId,
      name: 'web_search',
      input: { query: item.query },
    };

    if (phase !== 'completed') {
      return {
        type: 'assistant',
        message: { role: 'assistant', content: [toolUseBlock] },
        timestamp: ts,
        receivedAt: ts,
        engine: 'codex' as const,
        codexMetadata: metadata,
      };
    }

    const toolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [
        {
          type: 'text',
          text: JSON.stringify(item.results, null, 2),
        },
      ],
      is_error: item.status === 'failed',
    };

    return {
      type: 'assistant',
      message: { role: 'assistant', content: [toolUseBlock, toolResultBlock] },
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }

  /**
   * Converts todo_list to system message
   */
  private convertTodoList(
    item: CodexTodoListItem,
    _phase: string,
    metadata: CodexMessageMetadata,
    eventTimestamp?: string
  ): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    const todoText = item.todos
      .map(
        (todo) =>
          `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '⏳' : '○'} ${todo.description}`
      )
      .join('\n');

    return {
      type: 'system',
      subtype: 'info',
      result: `**Plan:**\n${todoText}`,
      timestamp: ts,
      receivedAt: ts,
      engine: 'codex' as const,
      codexMetadata: metadata,
    };
  }

  /**
   * Creates a usage statistics message
   *
   * IMPORTANT: This message format is used by sessionCost.ts to detect Codex token counts
   * Requirements: type='system', subtype='info', usage field, engine='codex' or contextWindow field
   */
  private createUsageMessage(usage: {
    input_tokens: number;
    cached_input_tokens?: number;
    output_tokens: number;
  }, eventTimestamp?: string): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    const totalTokens = usage.input_tokens + usage.output_tokens;
    const cacheInfo = usage.cached_input_tokens ? ` (${usage.cached_input_tokens} cached)` : '';

    return {
      type: 'system',
      subtype: 'info',
      result: `**Token Usage:** ${totalTokens} tokens (${usage.input_tokens} input${cacheInfo}, ${usage.output_tokens} output)`,
      timestamp: ts,
      receivedAt: ts,
      usage,
      engine: 'codex' as const, // ✅ FIX: Add engine field for sessionCost.ts detection
      contextWindow: 200000,     // ✅ FIX: Add contextWindow for proper display (default Codex limit)
    };
  }

  /**
   * Creates an error message
   */
  private createErrorMessage(errorText: string, eventTimestamp?: string): ClaudeStreamMessage {
    const ts = eventTimestamp || new Date().toISOString();
    return {
      type: 'system',
      subtype: 'error',
      result: `**Error:** ${errorText}`,
      timestamp: ts,
      receivedAt: ts,
    };
  }

  /**
   * Resets converter state (e.g., when starting a new session)
   */
  reset(): void {
    this.threadId = null;
    this.currentTurnUsage = null;
    this.itemMap.clear();
    this.toolResults.clear(); // Also clear tool results
    this.agentReasoningSegments.clear();

    // ✅ FIX: Reset cumulative token usage when starting a new session
    this.cumulativeUsage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    };
  }
}

/**
 * Singleton instance for global use
 */
export const codexConverter = new CodexEventConverter();
