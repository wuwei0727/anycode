/**
 * useSessionFileWatcher Hook
 *
 * 监听会话文件变化，实现与外部工具（如 VSCode Codex 插件）的实时同步。
 * 当在外部工具中聊天时，这个 hook 会检测到文件变化并自动更新消息列表。
 */

import { useEffect, useRef, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api, type Session } from '@/lib/api';
import type { ClaudeStreamMessage } from '@/types/claude';
import { CodexEventConverter } from '@/lib/codexConverter';
import { extractFilePathFromPatchText, extractOldNewFromPatchText, splitPatchIntoFileChunks } from '@/lib/codexDiff';
import type { CodexFileChange } from '@/types/codex-changes';

interface SessionFileChangedEvent {
  session_id: string;
  new_lines: any[];
  engine: string;
}

export interface ExternalQueuedPromptEvent {
  engine: string;
  prompt: string;
  source: 'enqueue' | 'suppressed_user_message';
  message?: ClaudeStreamMessage;
  displayedInline?: boolean;
}

interface UseSessionFileWatcherConfig {
  /** 当前会话 */
  session: Session | undefined;
  /** 是否启用文件监听 */
  enabled?: boolean;
  /** 组件是否已挂载 */
  isMountedRef: React.MutableRefObject<boolean>;
  /** 更新消息列表的回调 */
  setMessages: React.Dispatch<React.SetStateAction<ClaudeStreamMessage[]>>;
  /** 是否正在流式输出（本地执行中） */
  isStreaming?: boolean;
  /** 外部流式状态变化（用于外部插件占用时的排队） */
  onExternalStreamStatusChange?: (isStreaming: boolean, engine: string) => void;
  /** 外部工具队列：入队（用于 VSCode 官方插件等） */
  onExternalQueuedPrompt?: (event: ExternalQueuedPromptEvent) => void;
  /** 外部工具队列：出队（默认移除队首） */
  onExternalDequeued?: (engine: string, prompt?: string) => void;
  /** 外部流结束：用于把 suppressed 的 user 消息刷回到主对话 */
  onExternalStreamComplete?: (engine: string) => void;
}

interface UseSessionFileWatcherReturn {
  /** 手动刷新会话 */
  refreshSession: () => Promise<void>;
  /** 是否正在监听 */
  isWatching: boolean;
}

export function useSessionFileWatcher(config: UseSessionFileWatcherConfig): UseSessionFileWatcherReturn {
  const {
    session,
    enabled = true,
    isMountedRef,
    setMessages,
    isStreaming = false,
    onExternalStreamStatusChange,
    onExternalQueuedPrompt,
    onExternalDequeued,
    onExternalStreamComplete,
  } = config;

  const isWatchingRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const lastMessageCountRef = useRef(0);
  const externalStreamRef = useRef(false);
  // Codex VSCode rollout format doesn't emit turn.completed; we use response_item(role=assistant)
  // and a small debounce fallback after agent_message to end "external streaming" accurately.
  const codexStreamEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexConverterRef = useRef<CodexEventConverter | null>(null);
  const codexPromptIndexRef = useRef(-1);
  const codexPromptTextRef = useRef('');
  type TrackedCodexFileToolEntry = {
    filePath: string;
    changeType: 'create' | 'update' | 'delete' | 'auto';
    oldContentPromise: Promise<string | null>;
    fallbackNewContent: string;
    diffHint?: string;
    toolName?: string;
    toolNewContent?: string;
  };

  const codexTrackedFileToolsRef = useRef(new Map<string, {
    entries: TrackedCodexFileToolEntry[];
    fallbackTimer?: ReturnType<typeof setTimeout> | null;
  }>());
  const codexRecordedToolUseIdsRef = useRef(new Set<string>());
  const codexHasSyncedChangesRef = useRef(false);
  const readTextFileCachedRef = useRef<((path: string) => Promise<string>) | null>(null);

  const extractPromptText = (msg: ClaudeStreamMessage): string => {
    const content: any = msg.message?.content;
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((it: any) => it?.type === 'text')
        .map((it: any) => it?.text || '')
        .join('');
      return text;
    }
    return '';
  };

  const extractQueuePromptText = (eventData: any): string => {
    const candidates = [
      eventData?.prompt,
      eventData?.text,
      eventData?.message,
      eventData?.content,
      eventData?.payload?.prompt,
      eventData?.payload?.text,
      eventData?.payload?.message,
      eventData?.payload?.content,
    ];
    const found = candidates.find((v) => typeof v === 'string' && v.trim().length > 0);
    return (found as string | undefined)?.trim() || '';
  };

  const stripImagePlaceholders = (text: string): string => {
    const withoutTags = text.replace(/<\/?image>/gi, '');
    const lines = withoutTags
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.join('\n').trim();
  };

  const sanitizeMessageForDisplay = (msg: ClaudeStreamMessage): ClaudeStreamMessage => {
    const content: any = msg.message?.content;
    if (!Array.isArray(content) || content.length === 0) return msg;

    let mutated = false;
    const nextContent = content
      .map((it: any) => {
        if (it?.type !== 'text') return it;
        const rawText = it?.text || '';
        const nextText = /<\/?image>/i.test(rawText) ? stripImagePlaceholders(rawText) : rawText;
        if (nextText !== it.text) mutated = true;
        return { ...it, text: nextText };
      })
      .filter((it: any) => it?.type !== 'text' || (it?.text || '').trim().length > 0);

    if (!mutated && nextContent.length === content.length) return msg;
    return {
      ...msg,
      message: {
        ...(msg as any).message,
        content: nextContent,
      },
    } as ClaudeStreamMessage;
  };

  const updateExternalStreaming = useCallback((next: boolean, engine: string) => {
    if (externalStreamRef.current === next) return;
    externalStreamRef.current = next;
    onExternalStreamStatusChange?.(next, engine);
  }, [onExternalStreamStatusChange]);

  // Reset per-session state
  useEffect(() => {
    updateExternalStreaming(false, (session as any)?.engine || 'claude');
    if (codexStreamEndTimerRef.current) {
      clearTimeout(codexStreamEndTimerRef.current);
      codexStreamEndTimerRef.current = null;
    }
    codexPromptIndexRef.current = -1;
    codexPromptTextRef.current = '';
    codexTrackedFileToolsRef.current.clear();
    codexRecordedToolUseIdsRef.current.clear();
    codexHasSyncedChangesRef.current = false;

    const engine = (session as any)?.engine || 'claude';
    if (engine === 'codex') {
      // Realtime file watcher should show Codex "agent_reasoning" updates (matches VSCode plugin).
      codexConverterRef.current = new CodexEventConverter({ includeAgentReasoning: true });
    } else {
      codexConverterRef.current = null;
    }
  }, [session?.id, updateExternalStreaming, session]);

  // Lazy-load readTextFile to avoid repeated dynamic imports
  const getReadTextFile = useCallback(async () => {
    if (readTextFileCachedRef.current) return readTextFileCachedRef.current;
    const mod = await import('@tauri-apps/plugin-fs');
    readTextFileCachedRef.current = mod.readTextFile;
    return readTextFileCachedRef.current;
  }, []);

  const normalizePath = (p: string) => (p || '').replace(/\\/g, '/');
  // Some Codex tools may output WSL paths missing the leading "/" (e.g. "mnt/d/work/...").
  const normalizeMaybeWslAbs = (p: string) => {
    const np = normalizePath(p || '');
    if (/^mnt\/[a-zA-Z]\//.test(np)) return `/${np}`;
    return np;
  };

  const isWindowsHost = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
  const toHostPath = useCallback((p: string) => {
    const np = normalizeMaybeWslAbs(p);
    if (!isWindowsHost) return np;
    const m = np.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (!m) return np;
    return `${m[1].toUpperCase()}:/${m[2]}`;
  }, [isWindowsHost]);

  const getFullPath = useCallback((filePath: string) => {
    const projectPath = session?.project_path || '';
    const fp = toHostPath(filePath);
    // Absolute paths: keep as-is
    if (fp.startsWith('/') || fp.match(/^[A-Z]:/i)) return fp;
    const base = toHostPath(projectPath).replace(/\/+$/, '');
    const rel = toHostPath(filePath).replace(/^\/+/, '');
    if (!base) return rel;
    return `${base}/${rel}`;
  }, [session?.project_path, toHostPath]);

  const normalizeRecordedPath = useCallback((filePath: string) => {
    const projectPath = session?.project_path || '';
    const fp = toHostPath(filePath).replace(/\\/g, '/');
    const base = toHostPath(projectPath).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!base) return fp.replace(/^\.\//, '');
    const fpLower = fp.toLowerCase();
    const baseLower = base.toLowerCase();
    if (fpLower.startsWith(`${baseLower}/`)) {
      return fp.slice(base.length + 1);
    }
    return fp.replace(/^\.\//, '');
  }, [session?.project_path, toHostPath]);

  const safeReadFile = useCallback(async (filePath: string): Promise<string | null> => {
    try {
      const readTextFile = await getReadTextFile();
      return await readTextFile(getFullPath(filePath));
    } catch {
      return null;
    }
  }, [getReadTextFile, getFullPath]);

  const processCodexMessageForChangeTracking = useCallback((msg: ClaudeStreamMessage) => {
    if (!session) return;
    const engine = (session as any).engine || 'claude';
    if (engine !== 'codex') return;
    if (msg.type !== 'assistant' || !msg.message?.content) return;

    const contentBlocks = msg.message.content as any[];
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return;

    const sessionId = session.id;
    const projectPath = session.project_path;

    const trackedTools = codexTrackedFileToolsRef.current;
    const recordedToolUseIds = codexRecordedToolUseIdsRef.current;

    const finalizeToolChange = (toolUseId: string) => {
      const tracked = trackedTools.get(toolUseId);
      if (!tracked || tracked.entries.length === 0) return;
      if (recordedToolUseIds.has(toolUseId)) return;
      recordedToolUseIds.add(toolUseId);

      if (tracked.fallbackTimer) {
        clearTimeout(tracked.fallbackTimer);
        tracked.fallbackTimer = null;
      }

      void (async () => {
        try {
          const promptIndex = codexPromptIndexRef.current;
          if (promptIndex < 0) return;

          const promptText = codexPromptTextRef.current || '';

          for (const entry of tracked.entries) {
            const oldContent = await entry.oldContentPromise;
            const resolvedChangeType =
              entry.changeType === 'auto'
                ? (oldContent !== null ? 'update' : 'create')
                : entry.changeType;

            const diskNewContent =
              resolvedChangeType === 'delete' ? null : await safeReadFile(entry.filePath);
            const newContent = (diskNewContent ?? entry.toolNewContent ?? entry.fallbackNewContent ?? '') || '';
            const oldContentToSend = resolvedChangeType === 'create' ? null : (oldContent ?? '');

            await api.codexRecordFileChange(
              sessionId,
              projectPath,
              entry.filePath,
              resolvedChangeType,
              'tool',
              promptIndex,
              promptText,
              newContent,
              oldContentToSend,
              entry.toolName || null,
              toolUseId,
              entry.diffHint || null
            );
          }
        } catch (err) {
          console.warn('[SessionFileWatcher] Failed to record Codex file change:', err);
        } finally {
          trackedTools.delete(toolUseId);
        }
      })();
    };

    // 1) tool_use -> start tracking (snapshot old content)
    for (const block of contentBlocks) {
      if (block?.type !== 'tool_use') continue;

      const toolUseId: string | undefined = block?.id;
      const toolName: string | undefined = block?.name;
      const toolInput: any = block?.input || {};

      const patchText =
        typeof toolInput?.patch === 'string'
          ? toolInput.patch
          : typeof toolInput?.diff === 'string'
          ? toolInput.diff
          : typeof toolInput?.raw_input === 'string'
          ? toolInput.raw_input
          : '';
      if (!toolUseId) continue;
      if (recordedToolUseIds.has(toolUseId)) continue;
      if (trackedTools.has(toolUseId)) continue;

      const toolNameLower = (toolName || '').toLowerCase();

      const inferChangeTypeFromPatch = (text: string): 'create' | 'update' | 'delete' | null => {
        if (!text) return null;
        if (text.includes('*** Add File:') || text.includes('*** Create File:')) return 'create';
        if (text.includes('*** Delete File:')) return 'delete';
        if (text.includes('*** Update File:')) return 'update';
        if (text.includes('--- /dev/null') || text.includes('new file mode')) return 'create';
        if (text.includes('+++ /dev/null') || text.includes('deleted file mode')) return 'delete';
        if (text.includes('@@')) return 'update';
        return null;
      };

      const chunks = patchText ? splitPatchIntoFileChunks(patchText) : [];
      const inputFilePath: string | null =
        toolInput?.file_path || toolInput?.path || toolInput?.file || toolInput?.filename || null;

      const fileTargets: Array<{ filePath: string; patchText: string }> =
        chunks.length > 0
          ? chunks
          : inputFilePath
          ? [{ filePath: String(inputFilePath), patchText }]
          : patchText
          ? (() => {
              const fp = extractFilePathFromPatchText(patchText);
              return fp ? [{ filePath: fp, patchText }] : [];
            })()
          : [];

      if (fileTargets.length === 0) continue;

      const entries = fileTargets
        .map((target): TrackedCodexFileToolEntry | null => {
          const rawPath = String(target.filePath || '').trim();
          if (!rawPath) return null;

          const normalizedFilePath = normalizeRecordedPath(rawPath);
          const chunkPatchText = String(target.patchText || '');
          const patchDiff = chunkPatchText ? extractOldNewFromPatchText(chunkPatchText) : null;

          let changeType: 'create' | 'update' | 'delete' | 'auto' | null = null;
          if (typeof toolInput?.change_type === 'string' && ['create', 'update', 'delete'].includes(toolInput.change_type) && fileTargets.length === 1) {
            changeType = toolInput.change_type;
          } else if (chunkPatchText) {
            changeType = inferChangeTypeFromPatch(chunkPatchText);
          }

          if (!changeType) {
            if (toolNameLower === 'write') changeType = 'auto';
            else if (toolNameLower === 'edit' || toolNameLower === 'multiedit') changeType = 'update';
          }

          if (!changeType) return null;

          const oldContentPromise = (async () => {
            const diskOld = await safeReadFile(normalizedFilePath);
            if (diskOld !== null) return diskOld;
            if (patchDiff?.oldText) return patchDiff.oldText;
            if (typeof toolInput?.old_string === 'string') return toolInput.old_string;
            return null;
          })();

          const toolNewContent =
            typeof toolInput?.content === 'string'
              ? toolInput.content
              : typeof toolInput?.new_string === 'string'
              ? toolInput.new_string
              : patchDiff?.newText || undefined;

          const fallbackNewContent = patchDiff?.newText || '';

          return {
            filePath: normalizedFilePath,
            changeType,
            oldContentPromise,
            fallbackNewContent,
            diffHint: chunkPatchText && chunkPatchText.trim().length > 0 ? chunkPatchText : undefined,
            toolName: toolNameLower,
            toolNewContent,
          };
        })
        .filter((v): v is TrackedCodexFileToolEntry => Boolean(v));

      if (entries.length === 0) continue;

      trackedTools.set(toolUseId, { entries, fallbackTimer: null });

      // Fallback: apply_patch-like payloads may not emit tool_result consistently
      if (typeof patchText === 'string' && (patchText.includes('*** Begin Patch') || patchText.includes('diff --git'))) {
        const existing = trackedTools.get(toolUseId);
        if (existing && !existing.fallbackTimer) {
          existing.fallbackTimer = setTimeout(() => {
            finalizeToolChange(toolUseId);
          }, 2000);
        }
      }
    }

    // 2) tool_result -> finalize record
    for (const block of contentBlocks) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId: string | undefined = block?.tool_use_id;
      if (!toolUseId) continue;
      finalizeToolChange(toolUseId);
    }
  }, [session, normalizeRecordedPath, safeReadFile]);

  const syncCodexChangesFromHistoryIfNeeded = useCallback(async () => {
    if (!session) return;
    const engine = (session as any).engine || 'claude';
    if (engine !== 'codex') return;
    if (codexHasSyncedChangesRef.current) return;
    codexHasSyncedChangesRef.current = true;

    try {
      const existing: CodexFileChange[] = await api.codexListFileChanges(session.id).catch(() => []);
      // Seed recorded tool_use ids from persisted change records to make backfill incremental.
      // tool_call_id may contain a comma-separated list for aggregated tool diffs.
      const recordedToolUseIds = codexRecordedToolUseIdsRef.current;
      for (const ch of existing) {
        const raw = ch.tool_call_id;
        if (typeof raw !== 'string' || !raw.trim()) continue;
        raw
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
          .forEach((id: string) => recordedToolUseIds.add(id));
      }

      const events = await api.loadCodexSessionHistory(session.id);
      const converter = new CodexEventConverter();

      let promptIndex = -1;
      for (const event of events) {
        let rawMsg: ClaudeStreamMessage | null = null;
        try {
          rawMsg = converter.convertEventObject(event);
        } catch (err) {
          console.warn('[SessionFileWatcher] Failed to convert Codex history event:', err, event);
          continue;
        }
        if (!rawMsg) continue;
        const msg = sanitizeMessageForDisplay(rawMsg);

        if (msg.type === 'user') {
          promptIndex += 1;
          codexPromptIndexRef.current = promptIndex;
          codexPromptTextRef.current = extractPromptText(msg);
          continue;
        }

        processCodexMessageForChangeTracking(msg);
      }
    } catch (err) {
      console.warn('[SessionFileWatcher] Failed to sync Codex changes from history:', err);
    }
  }, [session, processCodexMessageForChangeTracking]);

  /**
   * 处理文件变化事件
   */
  const handleFileChanged = useCallback(async (event: SessionFileChangedEvent) => {
    if (!isMountedRef.current) return;
    if (!session || event.session_id !== session.id) return;

    console.log('[SessionFileWatcher] Received file change event:', {
      sessionId: event.session_id,
      newLinesCount: event.new_lines.length,
      engine: event.engine,
    });

    // 转换新事件为消息
    const newMessages: ClaudeStreamMessage[] = [];

    if (event.engine === 'codex') {
      const converter =
        codexConverterRef.current ||
        (codexConverterRef.current = new CodexEventConverter({ includeAgentReasoning: true }));

      const clearCodexStreamEndTimer = () => {
        if (!codexStreamEndTimerRef.current) return;
        clearTimeout(codexStreamEndTimerRef.current);
        codexStreamEndTimerRef.current = null;
      };

      const endExternalStreamIfNeeded = () => {
        clearCodexStreamEndTimer();
        if (!externalStreamRef.current) return;
        updateExternalStreaming(false, 'codex');
        onExternalStreamComplete?.('codex');
      };

      const scheduleExternalStreamEndFallback = () => {
        // If Codex emits agent_message without a matching response_item(role=assistant),
        // avoid getting stuck in "external streaming" forever.
        clearCodexStreamEndTimer();
        codexStreamEndTimerRef.current = setTimeout(() => {
          endExternalStreamIfNeeded();
        }, 600);
      };

      // Track streaming state from Codex turn lifecycle
      for (const eventData of event.new_lines) {
        const wasExternalStreaming = externalStreamRef.current;

        // Different Codex distributions emit different lifecycle events:
        // - codex CLI: turn.started / turn.completed
        // - codex_vscode rollout: turn_context + response_item(message, role=assistant)
        if (eventData?.type === 'turn.started' || eventData?.type === 'turn_context') {
          updateExternalStreaming(true, 'codex');
          clearCodexStreamEndTimer();
        }
        if (eventData?.type === 'turn.completed' || eventData?.type === 'turn.failed') {
          endExternalStreamIfNeeded();
        }
        if (eventData?.type === 'error') {
          endExternalStreamIfNeeded();
        }

        // Optional queue-operation support (future-proof)
        if (eventData?.type === 'queue-operation') {
          const op = eventData?.operation || eventData?.op || eventData?.action;
          if (op === 'enqueue') {
            const prompt = extractQueuePromptText(eventData);
            if (prompt) onExternalQueuedPrompt?.({ engine: 'codex', prompt, source: 'enqueue' });
          } else if (op === 'dequeue') {
            const prompt = extractQueuePromptText(eventData);
            onExternalDequeued?.('codex', prompt || undefined);
          }
          continue;
        }

        // VSCode rollout: response_item(message, role=assistant) is the best available end marker.
        const isRolloutFinalAssistantMessage =
          eventData?.type === 'response_item' &&
          eventData?.payload?.type === 'message' &&
          eventData?.payload?.role === 'assistant';

        // VSCode rollout sometimes emits agent_message; if response_item is missing, fallback ends the stream.
        const isAgentMessage =
          eventData?.type === 'event_msg' &&
          eventData?.payload?.type === 'agent_message';
        if (isAgentMessage && externalStreamRef.current) {
          scheduleExternalStreamEndFallback();
        }

        // Convert to display message (if any)
        let rawMsg: ClaudeStreamMessage | null = null;
        try {
          rawMsg = converter.convertEventObject(eventData);
        } catch (err) {
          console.warn('[SessionFileWatcher] Failed to convert Codex event:', err, eventData);
          continue;
        }
        if (!rawMsg) continue;
        const msg = sanitizeMessageForDisplay(rawMsg);

        // Track prompt index/text for mapping file changes -> prompt
        if (msg.type === 'user') {
          // A user message may indicate an external prompt was just enqueued; treat as stream start
          // only if we weren't already streaming.
          if (!externalStreamRef.current) {
            updateExternalStreaming(true, 'codex');
          }
          codexPromptIndexRef.current += 1;
          codexPromptTextRef.current = extractPromptText(msg);
        }

        // Record file changes for Codex change history (right panel)
        processCodexMessageForChangeTracking(msg);

        // If user message arrives while Codex is still streaming, show it inline and mark as queued
        if (msg.type === 'user' && wasExternalStreaming) {
          const prompt = extractPromptText(msg);
          onExternalQueuedPrompt?.({
            engine: 'codex',
            prompt: prompt || '(queued)',
            source: 'suppressed_user_message',
            message: msg,
            displayedInline: true,
          });
          newMessages.push(msg);
          continue;
        }

        newMessages.push(msg);

        // End marker: only after the final assistant response item (avoid ending on developer/system text)
        if (isRolloutFinalAssistantMessage) {
          endExternalStreamIfNeeded();
        }
      }
    } else {
      // Claude/Gemini 格式
      for (const eventData of event.new_lines) {
        // Claude CLI queue operations (used by VSCode/Project UI)
        if (eventData?.type === 'queue-operation') {
          const op = eventData?.operation || eventData?.op || eventData?.action;
          if (op === 'enqueue') {
            const prompt = extractQueuePromptText(eventData);
            if (prompt) onExternalQueuedPrompt?.({ engine: event.engine, prompt, source: 'enqueue' });
          } else if (op === 'dequeue') {
            const prompt = extractQueuePromptText(eventData);
            onExternalDequeued?.(event.engine, prompt || undefined);
          }
          continue;
        }

        // Claude streaming completion marker
        if (eventData?.type === 'result') {
          updateExternalStreaming(false, event.engine);
          onExternalStreamComplete?.(event.engine);
        } else if (eventData?.type === 'assistant') {
          updateExternalStreaming(true, event.engine);
        }

        if (eventData.type && ['user', 'assistant', 'system', 'result', 'summary', 'thinking', 'tool_use'].includes(eventData.type)) {
          const msg = sanitizeMessageForDisplay(eventData as ClaudeStreamMessage);

          // If user message appears while assistant is streaming, show it inline and mark as queued
          if (msg.type === 'user' && externalStreamRef.current) {
            const prompt = extractPromptText(msg);
            onExternalQueuedPrompt?.({
              engine: event.engine,
              prompt: prompt || '(queued)',
              source: 'suppressed_user_message',
              message: msg,
              displayedInline: true,
            });
            newMessages.push(msg);
            continue;
          }

          newMessages.push(msg);
        }
      }
    }

    if (newMessages.length > 0) {
      console.log('[SessionFileWatcher] Adding', newMessages.length, 'new messages');
      setMessages(prev => [...prev, ...newMessages]);
    }
  }, [session, isMountedRef, setMessages, onExternalQueuedPrompt, onExternalDequeued, onExternalStreamComplete, processCodexMessageForChangeTracking, updateExternalStreaming]);

  /**
   * 手动刷新会话（重新加载所有消息）
   */
  const refreshSession = useCallback(async () => {
    if (!session) return;

    console.log('[SessionFileWatcher] Refreshing session:', session.id);

    try {
      const engine = (session as any).engine || 'claude';
      let history: ClaudeStreamMessage[] = [];

      if (engine === 'codex') {
        const events = await api.loadCodexSessionHistory(session.id);
        const converter = new CodexEventConverter();
        for (const event of events) {
          let msg: ClaudeStreamMessage | null = null;
          try {
            msg = converter.convertEventObject(event);
          } catch (err) {
            console.warn('[SessionFileWatcher] Failed to convert Codex history event:', err, event);
            continue;
          }
          if (!msg) continue;
          history.push(sanitizeMessageForDisplay(msg));
        }
      } else if (engine === 'gemini') {
        const detail = await api.getGeminiSessionDetail(session.project_path, session.id);
        // 转换 Gemini 消息格式（简化版）
        history = detail.messages.flatMap((msg: any) => {
          const messages: ClaudeStreamMessage[] = [];
          if (msg.type === 'user') {
            messages.push({
              type: 'user' as const,
              message: {
                content: msg.content ? [{ type: 'text', text: msg.content }] : []
              },
              timestamp: msg.timestamp,
              engine: 'gemini' as const,
            });
          } else {
            messages.push({
              type: 'assistant' as const,
              message: {
                content: msg.content ? [{ type: 'text', text: msg.content }] : [],
                role: 'assistant'
              },
              timestamp: msg.timestamp,
              engine: 'gemini' as const,
            });
          }
          return messages;
        });
      } else {
        history = await api.loadSessionHistory(session.id, session.project_id, engine);
      }

      if (isMountedRef.current) {
        setMessages(history);
        lastMessageCountRef.current = history.length;
      }
    } catch (error) {
      console.error('[SessionFileWatcher] Failed to refresh session:', error);
    }
  }, [session, isMountedRef, setMessages]);

  /**
   * 启动文件监听
   */
  useEffect(() => {
    if (!enabled || !session || isStreaming) {
      return;
    }

    const engine = (session as any).engine || 'claude';
    
    // 外部工具常见场景：VSCode 官方 Codex 插件、Claude Code 插件
    // Gemini 的历史格式不是 JSONL（chats/session-*.json），暂不在此处启用
    if (engine !== 'codex' && engine !== 'claude') {
      return;
    }

    let mounted = true;

    const startWatching = async () => {
      try {
        // 设置事件监听器
        const unlisten = await listen<SessionFileChangedEvent>('session-file-changed', (event) => {
          if (mounted) {
            handleFileChanged(event.payload);
          }
        });
        unlistenRef.current = unlisten;

        // For Codex: ensure change history is populated (also initializes prompt index)
        if (engine === 'codex') {
          await syncCodexChangesFromHistoryIfNeeded();
        }

        // 启动后端文件监听
        await api.startSessionWatcher(session.id, engine);
        isWatchingRef.current = true;
        
        console.log('[SessionFileWatcher] Started watching session:', session.id);
      } catch (error) {
        console.error('[SessionFileWatcher] Failed to start watching:', error);
      }
    };

    startWatching();

    return () => {
      mounted = false;
      
      // 清理事件监听器
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      // 停止后端文件监听
      if (isWatchingRef.current && session) {
        api.stopSessionWatcher(session.id).catch(err => {
          console.error('[SessionFileWatcher] Failed to stop watching:', err);
        });
        isWatchingRef.current = false;
      }
    };
  }, [enabled, session, isStreaming, handleFileChanged, syncCodexChangesFromHistoryIfNeeded]);

  return {
    refreshSession,
    isWatching: isWatchingRef.current,
  };
}
