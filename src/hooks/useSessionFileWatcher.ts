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
    onExternalQueuedPrompt,
    onExternalDequeued,
    onExternalStreamComplete,
  } = config;

  const isWatchingRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const lastMessageCountRef = useRef(0);
  const externalStreamRef = useRef(false);
  const codexConverterRef = useRef<CodexEventConverter | null>(null);
  const codexPromptIndexRef = useRef(-1);
  const codexPromptTextRef = useRef('');
  const codexTrackedFileToolsRef = useRef(new Map<string, {
    filePath: string;
    changeType: 'create' | 'update' | 'delete' | 'auto';
    oldContentPromise: Promise<string | null>;
    fallbackNewContent: string;
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

  // Reset per-session state
  useEffect(() => {
    externalStreamRef.current = false;
    codexPromptIndexRef.current = -1;
    codexPromptTextRef.current = '';
    codexTrackedFileToolsRef.current.clear();
    codexRecordedToolUseIdsRef.current.clear();
    codexHasSyncedChangesRef.current = false;

    const engine = (session as any)?.engine || 'claude';
    if (engine === 'codex') {
      codexConverterRef.current = new CodexEventConverter();
    } else {
      codexConverterRef.current = null;
    }
  }, [session?.id]);

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
      if (!tracked) return;
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

          const oldContent = await tracked.oldContentPromise;
          const resolvedChangeType =
            tracked.changeType === 'auto'
              ? (oldContent !== null ? 'update' : 'create')
              : tracked.changeType;

          const diskNewContent =
            resolvedChangeType === 'delete' ? null : await safeReadFile(tracked.filePath);
          const newContent = diskNewContent ?? tracked.fallbackNewContent ?? '';
          const oldContentToSend = resolvedChangeType === 'create' ? null : (oldContent ?? '');

          await api.codexRecordFileChange(
            sessionId,
            projectPath,
            tracked.filePath,
            resolvedChangeType,
            'tool',
            promptIndex,
            promptText,
            newContent,
            oldContentToSend
          );
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

      const filePath: string | undefined =
        toolInput?.file_path ||
        toolInput?.path ||
        toolInput?.file ||
        toolInput?.filename;

      if (!toolUseId || !filePath) continue;
      if (trackedTools.has(toolUseId)) continue;

      // Determine change type
      let changeType: 'create' | 'update' | 'delete' | 'auto' | null = null;
      if (typeof toolInput?.change_type === 'string' && ['create', 'update', 'delete'].includes(toolInput.change_type)) {
        changeType = toolInput.change_type;
      } else if (typeof toolInput?.patch === 'string') {
        const patch = toolInput.patch as string;
        if (patch.includes('*** Create File:')) changeType = 'create';
        else if (patch.includes('*** Delete File:')) changeType = 'delete';
        else if (patch.includes('*** Update File:')) changeType = 'update';
      } else if (toolName === 'write' || toolName === 'create_file') {
        changeType = 'auto';
      } else if (toolName === 'edit') {
        changeType = 'update';
      } else if (toolName === 'delete_file' || toolName === 'remove_file') {
        changeType = 'delete';
      }

      if (!changeType) continue;

      const normalizedFilePath = normalizeRecordedPath(filePath);

      const oldContentPromise = (async () => {
        const diskOld = await safeReadFile(normalizedFilePath);
        if (diskOld !== null) return diskOld;
        if (typeof toolInput?.old_string === 'string') return toolInput.old_string;
        return null;
      })();

      const fallbackNewContent =
        typeof toolInput?.content === 'string'
          ? toolInput.content
          : typeof toolInput?.new_string === 'string'
          ? toolInput.new_string
          : typeof toolInput?.patch === 'string'
          ? toolInput.patch
          : typeof toolInput?.diff === 'string'
          ? toolInput.diff
          : '';

      trackedTools.set(toolUseId, {
        filePath: normalizedFilePath,
        changeType,
        oldContentPromise,
        fallbackNewContent,
        fallbackTimer: null,
      });

      // Fallback: apply_patch-like payloads may not emit tool_result consistently
      const patchText =
        typeof toolInput?.patch === 'string'
          ? toolInput.patch
          : typeof toolInput?.raw_input === 'string'
          ? toolInput.raw_input
          : '';

      if (typeof patchText === 'string' && patchText.includes('*** Begin Patch')) {
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
      // If no records exist, backfill from session JSONL so ChangeHistory has data.
      const existing = await api.codexListFileChanges(session.id).catch(() => []);
      const shouldBackfill = existing.length === 0;

      const events = await api.loadCodexSessionHistory(session.id);
      const converter = new CodexEventConverter();

      let promptIndex = -1;
      for (const event of events) {
        const rawMsg = converter.convertEventObject(event);
        if (!rawMsg) continue;
        const msg = sanitizeMessageForDisplay(rawMsg);

        if (msg.type === 'user') {
          promptIndex += 1;
          codexPromptIndexRef.current = promptIndex;
          codexPromptTextRef.current = extractPromptText(msg);
          continue;
        }

        if (shouldBackfill) {
          processCodexMessageForChangeTracking(msg);
        }
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
      const converter = codexConverterRef.current || (codexConverterRef.current = new CodexEventConverter());
      // Track streaming state from Codex turn lifecycle
      for (const eventData of event.new_lines) {
        if (eventData?.type === 'turn.started') {
          externalStreamRef.current = true;
        }
        if (eventData?.type === 'turn.completed' || eventData?.type === 'turn.failed') {
          externalStreamRef.current = false;
          onExternalStreamComplete?.('codex');
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

        // Convert to display message (if any)
        const rawMsg = converter.convertEventObject(eventData);
        if (!rawMsg) continue;
        const msg = sanitizeMessageForDisplay(rawMsg);

        // Track prompt index/text for mapping file changes -> prompt
        if (msg.type === 'user') {
          codexPromptIndexRef.current += 1;
          codexPromptTextRef.current = extractPromptText(msg);
        }

        // Record file changes for Codex change history (right panel)
        processCodexMessageForChangeTracking(msg);

        // If user message arrives while Codex is still streaming, show it as queued instead of inline
        if (msg.type === 'user' && externalStreamRef.current) {
          const prompt = extractPromptText(msg);
          onExternalQueuedPrompt?.({
            engine: 'codex',
            prompt: prompt || '(queued)',
            source: 'suppressed_user_message',
            message: msg,
          });
          continue;
        }

        newMessages.push(msg);
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
          externalStreamRef.current = false;
          onExternalStreamComplete?.(event.engine);
        } else if (eventData?.type === 'assistant') {
          externalStreamRef.current = true;
        }

        if (eventData.type && ['user', 'assistant', 'system', 'result', 'summary', 'thinking', 'tool_use'].includes(eventData.type)) {
          const msg = sanitizeMessageForDisplay(eventData as ClaudeStreamMessage);

          // If user message appears while assistant is streaming, keep it in queue until complete
          if (msg.type === 'user' && externalStreamRef.current) {
            const prompt = extractPromptText(msg);
            onExternalQueuedPrompt?.({
              engine: event.engine,
              prompt: prompt || '(queued)',
              source: 'suppressed_user_message',
              message: msg,
            });
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
  }, [session, isMountedRef, setMessages, onExternalQueuedPrompt, onExternalDequeued, onExternalStreamComplete, processCodexMessageForChangeTracking]);

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
          const msg = converter.convertEventObject(event);
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
