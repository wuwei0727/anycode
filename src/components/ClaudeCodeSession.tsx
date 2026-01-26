import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  ChevronUp,
  X,
  List,
  GitCompare
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type Session, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { FloatingPromptInput, type FloatingPromptInputRef, type ModelType } from "./FloatingPromptInput";
import { ErrorBoundary } from "./ErrorBoundary";
import { RevertPromptPicker } from "./RevertPromptPicker";
import { PromptNavigator } from "./PromptNavigator";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import { type TranslationResult } from '@/lib/translationMiddleware';
import { useSessionCostCalculation } from '@/hooks/useSessionCostCalculation';
import { useDisplayableMessages } from '@/hooks/useDisplayableMessages';
import { useGroupedMessages } from '@/hooks/useGroupedMessages';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useSmartAutoScroll } from '@/hooks/useSmartAutoScroll';
import { useMessageTranslation } from '@/hooks/useMessageTranslation';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { usePromptExecution } from '@/hooks/usePromptExecution';
import { useSessionFileWatcher, type ExternalQueuedPromptEvent } from '@/hooks/useSessionFileWatcher';
import { MessagesProvider, useMessagesContext } from '@/contexts/MessagesContext';
import { PlanModeProvider, usePlanMode } from '@/contexts/PlanModeContext';
import { PlanApprovalDialog } from '@/components/dialogs/PlanApprovalDialog';
import { PlanModeStatusBar } from '@/components/widgets/system/PlanModeStatusBar';
import { UserQuestionProvider, useUserQuestion } from '@/contexts/UserQuestionContext';
import { AskUserQuestionDialog } from '@/components/dialogs/AskUserQuestionDialog';
import { codexConverter } from '@/lib/codexConverter';
import { SessionHeader } from "./session/SessionHeader";
import { SessionMessages, type SessionMessagesRef } from "./session/SessionMessages";
import { SelectionTranslationProvider } from "./SelectionTranslationProvider";
import { CodexChangeHistory } from "./codex/CodexChangeHistory";

import * as SessionHelpers from '@/lib/sessionHelpers';

import type { ClaudeStreamMessage } from '@/types/claude';

interface ClaudeCodeSessionProps {
  /**
   * Optional session to resume (when clicking from SessionList)
   */
  session?: Session;
  /**
   * Initial project path (for new sessions)
   */
  initialProjectPath?: string;
  /**
   * Optional className for styling
   */
  className?: string;
  /**
   * Callback when streaming state changes
   */
  onStreamingChange?: (isStreaming: boolean, sessionId: string | null) => void;
  /**
   * Callback when project path changes (for updating tab title)
   */
  onProjectPathChange?: (newPath: string) => void;
  /**
   * Whether this session is currently active (for event listener management)
   */
  isActive?: boolean;
}

/**
 * ClaudeCodeSession component for interactive Claude Code sessions
 * 
 * @example
 * <ClaudeCodeSession onBack={() => setView('projects')} />
 */
const ClaudeCodeSessionInner: React.FC<ClaudeCodeSessionProps> = ({
  session,
  initialProjectPath = "",
  className,
  onStreamingChange,
  onProjectPathChange,
  isActive = true, // 默认为活跃状态，保持向后兼容
}) => {
  // 🔧 FIX: 过滤掉特殊占位符 __NEW_PROJECT__，将其视为空路径
  const effectiveInitialPath = initialProjectPath === '__NEW_PROJECT__' ? '' : initialProjectPath;
  const [projectPath, setProjectPath] = useState(effectiveInitialPath || session?.project_path || "");
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const {
    messages,
    setMessages,
    isStreaming,
    setIsStreaming,
    filterConfig,
    setFilterConfig
  } = useMessagesContext();
  const isLoading = isStreaming;
  const setIsLoading = setIsStreaming;
  const [error, setError] = useState<string | null>(null);
  const [_rawJsonlOutput, setRawJsonlOutput] = useState<string[]>([]); // Kept for hooks, not directly used
  const [isFirstPrompt, setIsFirstPrompt] = useState(!session); // Key state for session continuation
  const [extractedSessionInfo, setExtractedSessionInfo] = useState<{ sessionId: string; projectId: string; engine?: 'claude' | 'codex' | 'gemini' } | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);

  // Plan Mode state - 使用 Context（方案 B-1）
  const {
    isPlanMode,
    setIsPlanMode,
    showApprovalDialog,
    pendingApproval,
    approvePlan,
    rejectPlan,
    closeApprovalDialog,
    setSendPromptCallback,
  } = usePlanMode();

  // 🆕 UserQuestion Context - 用户问答交互
  const {
    pendingQuestion,
    showQuestionDialog,
    submitAnswers,
    closeQuestionDialog,
    setSendMessageCallback,
  } = useUserQuestion();

  // 🆕 Execution Engine Config (Codex integration)
  // Load from localStorage but respect session's engine type if available
  const [executionEngineConfig, setExecutionEngineConfig] = useState<import('@/components/FloatingPromptInput/types').ExecutionEngineConfig>(() => {
    // 🔧 FIX: 如果 session 有明确的引擎类型，优先使用它
    // 这样可以避免在不同引擎项目间切换时显示错误的引擎类型
    const sessionEngine = session?.engine;
    
    // 默认配置
    const defaultConfig = {
      engine: 'claude' as const,
      codexMode: 'read-only' as const,
      codexModel: 'gpt-5.2',
      codexReasoningMode: 'medium',
    };
    
    try {
      const stored = localStorage.getItem('execution_engine_config');
      if (stored) {
        const parsedConfig = JSON.parse(stored);
        
        // 如果 session 有明确的引擎类型，覆盖 localStorage 中的引擎设置
        if (sessionEngine) {
          console.log('[ClaudeCodeSession] Using session engine type:', sessionEngine);
          return {
            ...parsedConfig,
            engine: sessionEngine,
          };
        }
        
        return parsedConfig;
      }
    } catch (error) {
      console.error('[ClaudeCodeSession] Failed to load engine config from localStorage:', error);
    }
    
    // 如果 session 有明确的引擎类型，使用它
    if (sessionEngine) {
      console.log('[ClaudeCodeSession] Using session engine type (no localStorage):', sessionEngine);
      return {
        ...defaultConfig,
        engine: sessionEngine,
      };
    }
    
    return defaultConfig;
  });

  // Queued prompts state
  const [queuedPrompts, setQueuedPrompts] = useState<Array<{ id: string; prompt: string; model: ModelType }>>([]);
  const [externalQueuedPrompts, setExternalQueuedPrompts] = useState<Array<{
    id: string;
    prompt: string;
    engine: string;
    source: ExternalQueuedPromptEvent['source'];
    message?: ClaudeStreamMessage;
  }>>([]);

  // State for revert prompt picker (defined early for useKeyboardShortcuts)
  const [showRevertPicker, setShowRevertPicker] = useState(false);

  // State for prompt navigator
  const [showPromptNavigator, setShowPromptNavigator] = useState(false);

  // State for Codex change history panel
  const [showChangeHistory, setShowChangeHistory] = useState(false);

  // Settings state to avoid repeated loading in StreamMessage components
  const [claudeSettings, setClaudeSettings] = useState<{ 
    showSystemInitialization?: boolean;
    hideWarmupMessages?: boolean;
  }>({});

  // ✅ Refactored: Use custom Hook for session cost calculation
  const { stats: costStats, formatCost } = useSessionCostCalculation(messages);

  // ✅ Refactored: Use custom Hook for message filtering
  useEffect(() => {
    setFilterConfig(prev => {
      const hideWarmup = claudeSettings?.hideWarmupMessages !== false;
      if (prev.hideWarmupMessages === hideWarmup) {
        return prev;
      }
      return {
        ...prev,
        hideWarmupMessages: hideWarmup
      };
    });
  }, [claudeSettings?.hideWarmupMessages, setFilterConfig]);

  const displayableMessages = useDisplayableMessages(messages, {
    hideWarmupMessages: filterConfig.hideWarmupMessages
  });

  // 🆕 将消息分组（处理子代理消息）
  const messageGroups = useGroupedMessages(displayableMessages, {
    enableSubagentGrouping: true
  });

  // Stable callback for toggling plan mode (prevents unnecessary event listener re-registration)
  const handleTogglePlanMode = useCallback(() => {
    setIsPlanMode(!isPlanMode);
  }, [isPlanMode, setIsPlanMode]);

  // Stable callback for showing revert dialog
  const handleShowRevertDialog = useCallback(() => {
    setShowRevertPicker(true);
  }, []);

  // ✅ Refactored: Use custom Hook for keyboard shortcuts
  useKeyboardShortcuts({
    isActive,
    onTogglePlanMode: handleTogglePlanMode,
    onShowRevertDialog: handleShowRevertDialog,
    hasDialogOpen: showRevertPicker
  });

  // ✅ Refactored: Use custom Hook for smart auto-scroll
  // 注意：这里使用 session?.id 而不是 effectiveSession?.id，因为 effectiveSession 在后面定义
  const { parentRef, userScrolled, setUserScrolled, setShouldAutoScroll } =
    useSmartAutoScroll({
      displayableMessages,
      isLoading,
      sessionId: session?.id
    });

  // ============================================================================
  // MESSAGE-LEVEL OPERATIONS (Fine-grained Undo/Redo)
  // ============================================================================
  // Operations extracted to useMessageOperations Hook

  // New state for preview feature
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  
  // Translation state
  const [lastTranslationResult, setLastTranslationResult] = useState<TranslationResult | null>(null);
  const [showPreviewPrompt, setShowPreviewPrompt] = useState(false);
  const [splitPosition, setSplitPosition] = useState(50);
  const [isPreviewMaximized, setIsPreviewMaximized] = useState(false);

  // Add collapsed state for queued prompts
  const [queuedPromptsCollapsed, setQueuedPromptsCollapsed] = useState(false);

  // ✅ All refs declared BEFORE custom Hooks that depend on them
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const hasActiveSessionRef = useRef(false);
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  const sessionMessagesRef = useRef<SessionMessagesRef>(null);
  const queuedPromptsRef = useRef<Array<{ id: string; prompt: string; model: ModelType }>>([]);
  const externalQueuedPromptsRef = useRef(externalQueuedPrompts);
  const isMountedRef = useRef(true);
  const isListeningRef = useRef(false);

  useEffect(() => {
    externalQueuedPromptsRef.current = externalQueuedPrompts;
  }, [externalQueuedPrompts]);

  const enqueueExternalPrompt = useCallback((evt: ExternalQueuedPromptEvent) => {
    const prompt = evt.prompt?.trim();
    if (!prompt) return;

    setExternalQueuedPrompts((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        prompt,
        engine: evt.engine,
        source: evt.source,
        message: evt.message,
      },
    ]);
  }, []);

  const dequeueExternalPrompt = useCallback((engine: string, prompt?: string) => {
    setExternalQueuedPrompts((prev) => {
      const p = prompt?.trim();
      if (p) {
        const idx = prev.findIndex((it) => it.engine === engine && it.prompt === p);
        if (idx >= 0) return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      }
      const idx = prev.findIndex((it) => it.engine === engine);
      if (idx >= 0) return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      return prev;
    });
  }, []);

  const flushSuppressedExternalPrompts = useCallback((engine: string) => {
    const suppressed = externalQueuedPromptsRef.current.filter(
      (p) => p.engine === engine && p.source === 'suppressed_user_message'
    );

    const msgs = suppressed.map((p) => p.message).filter(Boolean) as ClaudeStreamMessage[];
    if (msgs.length > 0) {
      setMessages((prev) => [...prev, ...msgs]);
    }

    // Remove only suppressed ones; keep 'enqueue' queue items (they'll be dequeued later)
    setExternalQueuedPrompts((prev) => prev.filter((p) => !(p.engine === engine && p.source === 'suppressed_user_message')));
  }, [setMessages]);

  // ✅ Refactored: Use custom Hook for message translation (AFTER refs are declared)
  const {
    processMessageWithTranslation,
    initializeProgressiveTranslation,
  } = useMessageTranslation({
    isMountedRef,
    lastTranslationResult: lastTranslationResult || undefined,
    onMessagesUpdate: setMessages
  });

  // ✅ Refactored: Use custom Hook for session lifecycle (AFTER refs and translation Hook are declared)
  const {
    loadSessionHistory,
    checkForActiveSession,
    // reconnectToSession removed - listeners now persist across tab switches
  } = useSessionLifecycle({
    session,
    isMountedRef,
    isListeningRef,
    hasActiveSessionRef,
    unlistenRefs,
    setIsLoading,
    setError,
    setMessages,
    setRawJsonlOutput,
    setClaudeSessionId,
    initializeProgressiveTranslation,
    processMessageWithTranslation
  });

  // 🆕 Session File Watcher - 监听外部工具（如 VSCode Codex 插件）对会话文件的修改
  // 当在外部工具中聊天时，自动同步新消息到本应用
  // 注意：这里使用 session prop 而不是 effectiveSession，因为 effectiveSession 在后面定义
  // 对于新会话（extractedSessionInfo），文件监听会在 effectiveSession 更新后通过 useEffect 重新触发
  // refreshSession 可用于手动刷新，目前自动同步已足够，暂不在 UI 中暴露
  useSessionFileWatcher({
    session: session,
    // ✅ 与 claude-output 监听一致：保持监听直到会话完成/组件卸载
    // 否则用户切到其他标签页/窗口后，会错过外部插件写入的增量内容
    enabled: !isStreaming,
    isMountedRef,
    setMessages,
    isStreaming,
    onExternalQueuedPrompt: enqueueExternalPrompt,
    onExternalDequeued: dequeueExternalPrompt,
    onExternalStreamComplete: flushSuppressedExternalPrompts,
  });

  // Keep ref in sync with state
  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  // 🔧 NEW: Notify parent when project path changes (for tab title update)
  useEffect(() => {
    // Only notify if projectPath is valid and not the initial placeholder
    // 🔧 FIX: 使用 effectiveInitialPath 而不是 initialProjectPath
    if (projectPath && projectPath !== effectiveInitialPath && onProjectPathChange) {
      console.log('[ClaudeCodeSession] Project path changed, notifying parent:', projectPath);
      onProjectPathChange(projectPath);
    }
  }, [projectPath, effectiveInitialPath, onProjectPathChange]);

  // ⚡ PERFORMANCE FIX: Git 初始化延迟到真正需要时
  // 原问题：每次加载会话都立即执行 git init + git add + git commit
  // 在大项目中，git add . 可能需要数秒，导致会话加载卡顿
  // 解决方案：只在发送提示词时才初始化 Git（在 recordPromptSent 中已有）
  // useEffect(() => {
  //   if (!projectPath) return;
  //   api.checkAndInitGit(projectPath).then(...);
  // }, [projectPath]);

  // Get effective session info (from prop or extracted) - use useMemo to ensure it updates
  const effectiveSession = useMemo(() => {
    if (session) return session;
    if (extractedSessionInfo) {
      return {
        id: extractedSessionInfo.sessionId,
        project_id: extractedSessionInfo.projectId,
        project_path: projectPath,
        created_at: Date.now(),
        engine: extractedSessionInfo.engine, // 🔧 FIX: Include engine field
      } as Session;
    }
    return null;
  }, [session, extractedSessionInfo, projectPath]);

  // 🔧 FIX: 当 session 变化时，同步更新引擎配置
  // 这样可以确保在切换到不同引擎的会话时，引擎选择器显示正确的引擎类型
  useEffect(() => {
    const sessionEngine = session?.engine;
    if (sessionEngine && sessionEngine !== executionEngineConfig.engine) {
      console.log('[ClaudeCodeSession] Session engine changed, updating config:', sessionEngine);
      setExecutionEngineConfig(prev => ({
        ...prev,
        engine: sessionEngine,
      }));
    }
  }, [session?.engine]);

  // ✅ Refactored: Use custom Hook for prompt execution (AFTER all other Hooks)
  const { handleSendPrompt } = usePromptExecution({
    projectPath,
    isLoading,
    claudeSessionId,
    effectiveSession,
    isPlanMode,
    lastTranslationResult,
    isActive,
    isFirstPrompt,
    extractedSessionInfo,
    executionEngine: executionEngineConfig.engine, // 🆕 Codex integration
    codexMode: executionEngineConfig.codexMode,    // 🆕 Codex integration
    codexModel: executionEngineConfig.codexModel,  // 🆕 Codex integration
    codexReasoningMode: executionEngineConfig.codexReasoningMode, // 🆕 Codex reasoning mode
    geminiModel: executionEngineConfig.geminiModel,           // 🆕 Gemini integration
    geminiApprovalMode: executionEngineConfig.geminiApprovalMode, // 🆕 Gemini integration
    hasActiveSessionRef,
    unlistenRefs,
    isMountedRef,
    isListeningRef,
    queuedPromptsRef,
    setIsLoading,
    setError,
    setMessages,
    setClaudeSessionId,
    setLastTranslationResult,
    setQueuedPrompts,
    setRawJsonlOutput,
    setExtractedSessionInfo,
    setIsFirstPrompt,
    processMessageWithTranslation
  });

  // 🆕 方案 B-1: 设置发送提示词回调，用于计划批准后自动执行
  useEffect(() => {
    // 创建一个简化的发送函数，只需要 prompt 参数
    const simpleSendPrompt = (prompt: string) => {
      handleSendPrompt(prompt, 'sonnet'); // 使用默认模型
    };
    setSendPromptCallback(simpleSendPrompt);

    // 清理时移除回调
    return () => {
      setSendPromptCallback(null);
    };
  }, [handleSendPrompt, setSendPromptCallback]);

  // 🆕 设置 UserQuestion 的发送消息回调，用于答案提交后自动发送
  useEffect(() => {
    const simpleSendMessage = (message: string) => {
      handleSendPrompt(message, 'sonnet'); // 使用默认模型
    };
    setSendMessageCallback(simpleSendMessage);

    // 清理时移除回调
    return () => {
      setSendMessageCallback(null);
    };
  }, [handleSendPrompt, setSendMessageCallback]);

  // Debug logging
  useEffect(() => {
    console.log('[ClaudeCodeSession] State update:', {
      projectPath,
      session,
      extractedSessionInfo,
      effectiveSession,
      messagesCount: messages.length,
      isLoading
    });
  }, [projectPath, session, extractedSessionInfo, effectiveSession, messages.length, isLoading]);

  // Load recent projects when component mounts (only for new sessions)
  useEffect(() => {
    // 🔧 FIX: 使用 effectiveInitialPath 而不是 initialProjectPath
    if (!session && !effectiveInitialPath) {
      const loadRecentProjects = async () => {
        try {
          const projects = await api.listProjects();
          // Sort by created_at (latest first) and take top 5
          const sortedProjects = projects
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, 5);
          setRecentProjects(sortedProjects);
        } catch (error) {
          console.error("Failed to load recent projects:", error);
        }
      };
      loadRecentProjects();
    }
  }, [session, effectiveInitialPath]);

  // Load session history if resuming
  useEffect(() => {
    if (session) {
      // Set the claudeSessionId immediately when we have a session
      setClaudeSessionId(session.id);

      // 🆕 Auto-switch execution engine based on session type
      const sessionEngine = (session as any).engine;

      if (sessionEngine === 'codex') {
        setExecutionEngineConfig(prev => ({
          ...prev,
          engine: 'codex' as const,
        }));
      } else if (sessionEngine === 'gemini') {
        setExecutionEngineConfig(prev => ({
          ...prev,
          engine: 'gemini' as const,
        }));
      } else {
        setExecutionEngineConfig(prev => ({
          ...prev,
          engine: 'claude',
        }));
      }

      // Load session history first, then check for active session
      const initializeSession = async () => {
        await loadSessionHistory();
        // After loading history, check if the session is still active
        if (isMountedRef.current) {
          await checkForActiveSession();
        }
        // 加载完成后滚动到底部（延迟更长时间确保虚拟列表渲染完成）
        setTimeout(() => {
          if (isMountedRef.current && sessionMessagesRef.current) {
            sessionMessagesRef.current.scrollToBottom();
          }
        }, 300);
      };

      initializeSession();
    }
  }, [session]); // Remove hasLoadedSession dependency to ensure it runs on mount

  // Load Claude settings once for all StreamMessage components
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await api.getClaudeSettings();
        setClaudeSettings(settings);
      } catch (error) {
        console.error("Failed to load Claude settings:", error);
        setClaudeSettings({ 
          showSystemInitialization: true,
          hideWarmupMessages: true // Default: hide warmup messages for better UX
        }); // Default fallback
      }
    };

    loadSettings();
  }, []);

  // Report streaming state changes
  useEffect(() => {
    onStreamingChange?.(isLoading, claudeSessionId);
  }, [isLoading, claudeSessionId, onStreamingChange]);

  // 🔧 FIX: DO NOT clean up listeners on tab switch
  // Listeners should persist until session completes or component unmounts
  // This fixes the issue where:
  // 1. User sends prompt in tab A
  // 2. User switches to tab B before receiving session_id
  // 3. Listeners in tab A were cleaned up, causing output loss
  //
  // The listeners will be automatically cleaned up when:
  // - Session completes (in processComplete/processCodexComplete)
  // - Component unmounts (in the cleanup effect below)
  //
  // Multi-tab conflict is prevented by:
  // - Message deduplication (processedClaudeMessages/processedCodexMessages Set)
  // - isMountedRef check in message handlers
  // - Session-specific event channels (claude-output:{session_id})
  useEffect(() => {
    // Only log tab state changes for debugging
    if (!isActive) {
      console.log('[ClaudeCodeSession] Tab became inactive, keeping listeners active for ongoing session');
    } else {
      console.log('[ClaudeCodeSession] Tab became active');
    }
  }, [isActive]);

  // ✅ Keyboard shortcuts (ESC, Shift+Tab) extracted to useKeyboardShortcuts Hook

  // ✅ Smart scroll management (3 useEffect blocks) extracted to useSmartAutoScroll Hook

  // ✅ Session lifecycle functions (loadSessionHistory, checkForActiveSession, reconnectToSession)
  // are now provided by useSessionLifecycle Hook

  const handleSelectPath = async () => {
    try {
      const selected = await SessionHelpers.selectProjectPath();

      if (selected) {
        setProjectPath(selected);
        setError(null);
      }
    } catch (err) {
      console.error("Failed to select directory:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    }
  };

  // ✅ handleSendPrompt function is now provided by usePromptExecution Hook (line 207-234)

  // Get conversation context for prompt enhancement
  // 🔧 FIX: Use useCallback to ensure getConversationContext always uses the latest messages
  // This fixes the issue where prompt enhancement doesn't work in historical sessions
  const getConversationContext = useCallback((): string[] => {
    return SessionHelpers.getConversationContext(messages);
  }, [messages]);

  const handleCancelExecution = async () => {
    if (!isLoading) return;

    try {
      // 🆕 根据执行引擎调用相应的取消方法
      if (executionEngineConfig.engine === 'codex') {
        await api.cancelCodex(claudeSessionId || undefined);
      } else {
        await api.cancelClaudeExecution(claudeSessionId || undefined);
      }
      
      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten && typeof unlisten === 'function' && unlisten());
      unlistenRefs.current = [];
      
      // Reset states
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      isListeningRef.current = false;
      setError(null);
      
      // Reset session state on cancel
      setClaudeSessionId(null);
      
      // Clear queued prompts
      setQueuedPrompts([]);
      setExternalQueuedPrompts([]);
      
      // Add a message indicating the session was cancelled
      const cancelMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "info",
        result: "用户已取消会话",
        timestamp: new Date().toISOString(),
        receivedAt: new Date().toISOString()
      };
      setMessages(prev => [...prev, cancelMessage]);
    } catch (err) {
      console.error("Failed to cancel execution:", err);
      
      // Even if backend fails, we should update UI to reflect stopped state
      // Add error message but still stop the UI loading state
      const errorMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "error",
        result: `Failed to cancel execution: ${err instanceof Error ? err.message : 'Unknown error'}. The process may still be running in the background.`,
        timestamp: new Date().toISOString(),
        receivedAt: new Date().toISOString()
      };
      setMessages(prev => [...prev, errorMessage]);
      
      // Clean up listeners anyway
      unlistenRefs.current.forEach(unlisten => unlisten && typeof unlisten === 'function' && unlisten());
      unlistenRefs.current = [];
      
      // Reset states to allow user to continue
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      isListeningRef.current = false;
      setError(null);
    }
  };

  // Handle URL detection from terminal output
  const handleLinkDetected = (url: string) => {
    const currentState: SessionHelpers.PreviewState = {
      showPreview,
      showPreviewPrompt,
      previewUrl,
      isPreviewMaximized,
      splitPosition
    };
    const newState = SessionHelpers.handleLinkDetected(url, currentState);
    if (newState.previewUrl !== currentState.previewUrl) {
      setPreviewUrl(newState.previewUrl);
    }
    if (newState.showPreviewPrompt !== currentState.showPreviewPrompt) {
      setShowPreviewPrompt(newState.showPreviewPrompt);
    }
  };

  const handleClosePreview = () => {
    const currentState: SessionHelpers.PreviewState = {
      showPreview,
      showPreviewPrompt,
      previewUrl,
      isPreviewMaximized,
      splitPosition
    };
    const newState = SessionHelpers.handleClosePreview(currentState);
    setShowPreview(newState.showPreview);
    setIsPreviewMaximized(newState.isPreviewMaximized);
  };

  const handlePreviewUrlChange = (url: string) => {
    const currentState: SessionHelpers.PreviewState = {
      showPreview,
      showPreviewPrompt,
      previewUrl,
      isPreviewMaximized,
      splitPosition
    };
    const newState = SessionHelpers.handlePreviewUrlChange(url, currentState);
    setPreviewUrl(newState.previewUrl);
  };

  const handleTogglePreviewMaximize = () => {
    const currentState: SessionHelpers.PreviewState = {
      showPreview,
      showPreviewPrompt,
      previewUrl,
      isPreviewMaximized,
      splitPosition
    };
    const newState = SessionHelpers.handleTogglePreviewMaximize(currentState);
    setIsPreviewMaximized(newState.isPreviewMaximized);
    setSplitPosition(newState.splitPosition);
  };

  // 🆕 辅助函数：计算用户消息对应的 promptIndex
  // 只计算真实用户输入，排除系统消息和工具结果
  const getPromptIndexForMessage = useCallback((displayableIndex: number): number => {
    // 找到 displayableMessages[displayableIndex] 在 messages 中的实际位置
    const displayableMessage = displayableMessages[displayableIndex];
    const actualIndex = messages.findIndex(m => m === displayableMessage);

    console.log('[getPromptIndexForMessage] 🔍 开始计算 promptIndex:', {
      displayableIndex,
      actualIndex,
      totalMessages: messages.length,
      displayableMessagesCount: displayableMessages.length,
      targetMessagePreview: displayableMessage?.message?.content?.[0]?.text?.substring(0, 50)
    });

    if (actualIndex === -1) return -1;
    
    // 计算这是第几条真实用户消息（排除 Warmup/System 和纯工具结果消息）
    // 这个逻辑必须和后端 prompt_tracker.rs 完全一致！
    const validUserMessages: Array<{ text: string; index: number }> = [];

    messages.slice(0, actualIndex + 1).forEach((m, idx) => {
      // 只处理 user 类型消息
      if (m.type !== 'user') return;

      // 检查是否是侧链消息（agent 消息）- 与后端一致
      const isSidechain = (m as any).isSidechain === true;
      if (isSidechain) return;

      // 检查是否有 parent_tool_use_id（子代理的消息）- 与后端一致
      const hasParentToolUseId = (m as any).parent_tool_use_id !== null && (m as any).parent_tool_use_id !== undefined;
      if (hasParentToolUseId) return;

      // 提取消息文本（处理字符串和数组两种格式）
      const content = m.message?.content;
      let text = '';
      let hasTextContent = false;
      let hasToolResult = false;

      if (typeof content === 'string') {
        text = content;
        hasTextContent = text.trim().length > 0;
      } else if (Array.isArray(content)) {
        // 提取所有 text 类型的内容
        const textItems = content.filter((item: any) => item.type === 'text');
        text = textItems.map((item: any) => item.text || '').join('');
        hasTextContent = textItems.length > 0 && text.trim().length > 0;

        // 检查是否有 tool_result
        hasToolResult = content.some((item: any) => item.type === 'tool_result');
      }

      // 如果只有 tool_result 没有 text，不计入（这些是工具执行的结果）
      if (hasToolResult && !hasTextContent) return;

      // ✅ 修复：必须有有效的文本内容（与后端逻辑一致）
      if (!hasTextContent) return;

      // ✅ 修复：排除系统注入的环境上下文/指令块（与后端一致）
      if (
        text.includes('<environment_context>') ||
        text.includes('# AGENTS.md instructions') ||
        text.includes('<permissions instructions>')
      ) return;

      // 排除自动发送的 Warmup 和 Skills 消息
      const isWarmupMessage = text.includes('Warmup');
      const isSkillMessage = text.includes('<command-name>')
        || text.includes('Launching skill:')
        || text.includes('skill is running');

      if (!isWarmupMessage && !isSkillMessage) {
        validUserMessages.push({ text: text.substring(0, 30), index: idx });
      }
    });

    const promptIndex = validUserMessages.length - 1;

    console.log('[getPromptIndexForMessage] 📊 计算结果:', {
      validUserMessagesCount: validUserMessages.length,
      promptIndex,
      validMessages: validUserMessages
    });

    return promptIndex;
  }, [messages, displayableMessages]);


  // 🆕 撤回处理函数 - 支持三种撤回模式
  // Handle prompt navigation - scroll to specific prompt
  const handlePromptNavigation = useCallback((promptIndex: number) => {
    if (sessionMessagesRef.current) {
      sessionMessagesRef.current.scrollToPrompt(promptIndex);
    }
    // 导航面板的关闭由 PromptNavigator 组件内部的固定状态控制
  }, []);

  // 🆕 计算降级用的前端消息列表（用于 RevertPromptPicker）
  const fallbackPrompts = useMemo(() => {
    const frontendUserMessages = messages.filter(m => {
      if (m.type !== 'user') return false;
      const isSidechain = (m as any).isSidechain === true;
      const hasParentToolUseId = (m as any).parent_tool_use_id !== null && (m as any).parent_tool_use_id !== undefined;
      if (isSidechain || hasParentToolUseId) return false;

      const content = m.message?.content;
      let text = '';
      let hasTextContent = false;
      let hasToolResult = false;

      if (typeof content === 'string') {
        text = content;
        hasTextContent = text.trim().length > 0;
      } else if (Array.isArray(content)) {
        const textItems = content.filter((item: any) => item.type === 'text');
        text = textItems.map((item: any) => item.text || '').join('');
        hasTextContent = textItems.length > 0 && text.trim().length > 0;
        hasToolResult = content.some((item: any) => item.type === 'tool_result');
      }

      if (hasToolResult && !hasTextContent) return false;
      if (!hasTextContent) return false;

      const isWarmupMessage = text.includes('Warmup');
      const isSkillMessage = text.includes('<command-name>')
        || text.includes('Launching skill:')
        || text.includes('skill is running');

      return !isWarmupMessage && !isSkillMessage;
    });

    return frontendUserMessages.map((m, index) => {
      const content = m.message?.content;
      let text = '';

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const textItems = content.filter((item: any) => item.type === 'text');
        text = textItems.map((item: any) => item.text || '').join('');
      }

      return {
        index,
        text,
      };
    });
  }, [messages]);

  const handleRevert = useCallback(async (promptIndex: number, mode: import('@/lib/api').RewindMode = 'both') => {
    if (!effectiveSession) return;

    try {
      // 🆕 详细调试日志：记录前端状态
      console.log('[Prompt Revert] ========== START REVERT ==========');
      console.log('[Prompt Revert] Request:', {
        promptIndex,
        mode,
        sessionId: effectiveSession.id,
        projectId: effectiveSession.project_id,
        projectPath
      });

      // 🆕 记录前端消息统计
      const frontendUserMessages = messages.filter(m => {
        if (m.type !== 'user') return false;
        const isSidechain = (m as any).isSidechain === true;
        const hasParentToolUseId = (m as any).parent_tool_use_id !== null && (m as any).parent_tool_use_id !== undefined;
        if (isSidechain || hasParentToolUseId) return false;

        const content = m.message?.content;
        let text = '';
        let hasTextContent = false;
        let hasToolResult = false;

        if (typeof content === 'string') {
          text = content;
          hasTextContent = text.trim().length > 0;
        } else if (Array.isArray(content)) {
          const textItems = content.filter((item: any) => item.type === 'text');
          text = textItems.map((item: any) => item.text || '').join('');
          hasTextContent = textItems.length > 0 && text.trim().length > 0;
          hasToolResult = content.some((item: any) => item.type === 'tool_result');
        }

        if (hasToolResult && !hasTextContent) return false;
        if (!hasTextContent) return false;

        const isWarmupMessage = text.includes('Warmup');
        const isSkillMessage = text.includes('<command-name>')
          || text.includes('Launching skill:')
          || text.includes('skill is running');

        return !isWarmupMessage && !isSkillMessage;
      });

      console.log('[Prompt Revert] Frontend message stats:', {
        totalMessages: messages.length,
        displayableMessages: displayableMessages.length,
        validUserPrompts: frontendUserMessages.length,
        promptPreviews: frontendUserMessages.map((m, idx) => {
          const content = m.message?.content;
          let preview: string = '(empty)';

          if (typeof content === 'string') {
            preview = (content as string).substring(0, 60);
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => (c.text || '') as string);
            const joined = textParts.join('');
            preview = joined.substring(0, 60);
          }

          return `#${idx}: ${preview}...`;
        })
      });

      const sessionEngine = effectiveSession.engine || executionEngineConfig.engine || 'claude';
      const isCodex = sessionEngine === 'codex';
      const isGemini = sessionEngine === 'gemini';

      // 🆕 先从后端获取实际的 prompt 列表，验证索引是否有效
      console.log('[Prompt Revert] Fetching backend prompt list to validate index...');
      let backendPrompts: any[] = [];
      
      try {
        if (isCodex) {
          backendPrompts = await api.getCodexPromptList(effectiveSession.id);
        } else if (isGemini) {
          backendPrompts = await api.getGeminiPromptList(effectiveSession.id, projectPath);
        } else {
          backendPrompts = await api.getPromptList(
            effectiveSession.id,
            effectiveSession.project_id
          );
        }
      } catch (err) {
        console.warn('[Prompt Revert] Backend prompt list unavailable, using frontend fallback:', err);
        
        // 提取错误消息
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.log('[Prompt Revert] Error details:', errorMessage);
        
        // 🆕 降级方案：直接从当前 messages 提取用户消息
        console.log('[Prompt Revert] Frontend fallback - extracting from current messages:', {
          totalMessages: messages.length,
          promptIndex,
          hasFloatingPromptRef: !!floatingPromptRef.current
        });
        
        // 重新计算有效的用户消息（与 fallbackPrompts 逻辑一致）
        const validUserMessages = messages.filter(m => {
          if (m.type !== 'user') return false;
          const isSidechain = (m as any).isSidechain === true;
          const hasParentToolUseId = (m as any).parent_tool_use_id !== null && (m as any).parent_tool_use_id !== undefined;
          if (isSidechain || hasParentToolUseId) return false;

          const content = m.message?.content;
          let text = '';
          let hasTextContent = false;
          let hasToolResult = false;

          if (typeof content === 'string') {
            text = content;
            hasTextContent = text.trim().length > 0;
          } else if (Array.isArray(content)) {
            const textItems = content.filter((item: any) => item.type === 'text');
            text = textItems.map((item: any) => item.text || '').join('');
            hasTextContent = textItems.length > 0 && text.trim().length > 0;
            hasToolResult = content.some((item: any) => item.type === 'tool_result');
          }

          if (hasToolResult && !hasTextContent) return false;
          if (!hasTextContent) return false;

          const isWarmupMessage = text.includes('Warmup');
          const isSkillMessage = text.includes('<command-name>')
            || text.includes('Launching skill:')
            || text.includes('skill is running');

          return !isWarmupMessage && !isSkillMessage;
        });

        console.log('[Prompt Revert] Valid user messages found:', validUserMessages.length);
        
        if (promptIndex >= 0 && promptIndex < validUserMessages.length) {
          const targetMessage = validUserMessages[promptIndex];
          const content = targetMessage.message?.content;
          let messageText = '';

          if (typeof content === 'string') {
            messageText = content;
          } else if (Array.isArray(content)) {
            const textItems = content.filter((item: any) => item.type === 'text');
            messageText = textItems.map((item: any) => item.text || '').join('');
          }
          
          console.log('[Prompt Revert] Extracted message text length:', messageText.length);
          
          if (messageText && floatingPromptRef.current) {
            console.log('[Prompt Revert] ✅ Using frontend fallback, restoring message to input:', messageText.substring(0, 100) + '...');
            floatingPromptRef.current.setPrompt(messageText);
            setShowRevertPicker(false); // 关闭撤回选择器
            return; // 直接返回，不需要调用后端
          } else {
            console.error('[Prompt Revert] Failed to extract message text or ref unavailable');
          }
        } else {
          console.error('[Prompt Revert] Index out of range for frontend messages:', {
            promptIndex,
            validUserMessagesCount: validUserMessages.length
          });
        }
        
        // 显示更详细的错误信息
        const detailedError = `无法获取会话历史记录。\n\n错误详情：${errorMessage}\n\n请检查：\n• 会话文件是否存在\n• 会话目录权限是否正确\n• WSL 配置是否正确（如果使用 WSL 模式）`;
        setError(detailedError);
        return;
      }

      console.log('[Prompt Revert] Backend prompt list:', {
        count: backendPrompts.length,
        requestedIndex: promptIndex,
        validRange: `0-${backendPrompts.length - 1}`
      });

      // 验证索引是否在有效范围内
      if (promptIndex >= backendPrompts.length) {
        console.warn('[Prompt Revert] Index out of range, attempting frontend fallback:', {
          promptIndex,
          backendPromptsCount: backendPrompts.length,
          frontendUserMessages: frontendUserMessages.length
        });

        // 🆕 降级方案：即使后端返回空列表，也尝试从前端消息恢复
        if (promptIndex >= 0 && promptIndex < frontendUserMessages.length) {
          const targetMessage = frontendUserMessages[promptIndex];
          const content = targetMessage.message?.content;
          let messageText = '';

          if (typeof content === 'string') {
            messageText = content;
          } else if (Array.isArray(content)) {
            const textItems = content.filter((item: any) => item.type === 'text');
            messageText = textItems.map((item: any) => item.text || '').join('');
          }

          console.log('[Prompt Revert] Extracted message text from frontend:', messageText.length);

          if (messageText && floatingPromptRef.current) {
            console.log('[Prompt Revert] ✅ Using frontend fallback (empty backend list), restoring message to input');

            // 🆕 提取并分离图片路径（与正常撤回逻辑一致）
            const extractedImages: Array<{ filePath: string; match: string }> = [];
            let cleanText = messageText;

            // 检测图片文件扩展名
            const isImageFile = (path: string): boolean => {
              if (path.startsWith('data:image/')) return true;
              const ext = path.split('.').pop()?.toLowerCase();
              return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext || '');
            };

            // 模式1: @"path" 格式
            const quotedPattern = /@"([^"]+)"/g;
            let match;
            while ((match = quotedPattern.exec(messageText)) !== null) {
              const path = match[1];
              if (isImageFile(path)) {
                extractedImages.push({ filePath: path, match: match[0] });
              }
            }

            // 模式2: @path 格式（不带引号）
            const unquotedPattern = /@([^\s@]+)/g;
            while ((match = unquotedPattern.exec(messageText)) !== null) {
              const path = match[1];
              if (isImageFile(path)) {
                extractedImages.push({ filePath: path, match: match[0] });
              }
            }

            // 模式3: "path" 格式（带引号但无@前缀）
            const quotedPathPattern = /"([A-Za-z]:\\[^"]+|\/[^"]+)"/g;
            while ((match = quotedPathPattern.exec(messageText)) !== null) {
              const path = match[1];
              if (isImageFile(path)) {
                extractedImages.push({ filePath: path, match: match[0] });
              }
            }

            // 模式4: 直接路径格式（Windows: C:\... 或 Unix: /...）
            const directPathPattern = /(?:^|\s)([A-Za-z]:\\[^\s"]+|\/(?:[^\s"]+\/)+[^\s"]+)(?=\s|$)/g;
            while ((match = directPathPattern.exec(messageText)) !== null) {
              const path = match[1];
              if (isImageFile(path)) {
                extractedImages.push({ filePath: path, match: match[1] });
              }
            }

            // 去重（使用 filePath 作为键）
            const uniqueImages = Array.from(
              new Map(extractedImages.map(img => [img.filePath, img])).values()
            );

            console.log('[Prompt Revert] Extracted images:', uniqueImages);

            // 从文本中移除所有图片路径
            uniqueImages.forEach(img => {
              cleanText = cleanText.replace(img.match, '').trim();
            });

            console.log('[Prompt Revert] Clean text:', cleanText);
            console.log('[Prompt Revert] Extracted image paths:', uniqueImages.map(img => img.filePath));

            // 🆕 恢复文本和图片 - 将图片路径添加到文本中（作为 embeddedImages 显示缩略图）
            // 而不是使用 imageAttachments（显示为文件名标签）
            let finalPrompt = cleanText;
            if (uniqueImages.length > 0) {
              const imageMentions = uniqueImages.map(img => {
                const path = img.filePath;
                return path.includes(' ') ? `@"${path}"` : `@${path}`;
              }).join(' ');
              finalPrompt = cleanText + (cleanText ? ' ' : '') + imageMentions;
            }

            console.log('[Prompt Revert] Final prompt with images:', finalPrompt);
            floatingPromptRef.current.setPrompt(finalPrompt);

            // 🆕 清空撤回点之后的消息（找到目标消息在 messages 中的位置）
            const targetMessageIndex = messages.findIndex(m => m === targetMessage);
            if (targetMessageIndex !== -1) {
              console.log('[Prompt Revert] Truncating messages from index:', targetMessageIndex);
              setMessages(messages.slice(0, targetMessageIndex));
            }

            setShowRevertPicker(false);

            // 显示警告提示
            setError('⚠️ 会话文件不可用，已将消息恢复到输入框。代码未回滚。');
            setTimeout(() => setError(''), 3000);

            return;
          }
        }

        // 如果前端也没有数据，显示错误
        let errorMsg: string;
        if (backendPrompts.length === 0) {
          errorMsg = '当前会话没有可撤回的消息。\n\n可能的原因：\n• 会话文件可能已被删除\n• 会话文件可能损坏\n• 会话目录配置不正确';
        } else {
          errorMsg = `无法撤回：此消息可能还在处理中，请稍后再试。\n（请求索引: ${promptIndex}，后端有效范围: 0-${backendPrompts.length - 1}）`;
        }

        setError(errorMsg);
        return;
      }

      console.log('[Prompt Revert] ✅ Index validation passed, proceeding with revert');

      console.log('[Prompt Revert] Reverting to prompt #', promptIndex, 'with mode:', mode);

      // 调用后端撤回（返回提示词文本）
      let promptText: string | undefined;
      let backendRevertFailed = false;
      
      try {
        promptText = isCodex
          ? await api.revertCodexToPrompt(
              effectiveSession.id,
              projectPath,
              promptIndex,
              mode
            )
          : isGemini
          ? await api.revertGeminiToPrompt(
              effectiveSession.id,
              projectPath,
              promptIndex,
              mode
            )
          : await api.revertToPrompt(
              effectiveSession.id,
              effectiveSession.project_id,
              projectPath,
              promptIndex,
              mode
            );
      } catch (revertError) {
        console.warn('[Prompt Revert] Backend revert API failed, using frontend fallback:', revertError);
        backendRevertFailed = true;
        
        // 🆕 降级方案：即使后端撤回失败，也要恢复消息到输入框
        // 从 backendPrompts 或 frontendUserMessages 提取消息文本
        if (promptIndex >= 0 && promptIndex < backendPrompts.length) {
          promptText = backendPrompts[promptIndex].text;
          console.log('[Prompt Revert] Using backend prompt list for text extraction');
        } else if (promptIndex >= 0 && promptIndex < frontendUserMessages.length) {
          const targetMessage = frontendUserMessages[promptIndex];
          const content = targetMessage.message?.content;

          if (typeof content === 'string') {
            promptText = content;
          } else if (Array.isArray(content)) {
            const textItems = content.filter((item: any) => item.type === 'text');
            promptText = textItems.map((item: any) => item.text || '').join('');
          }
          console.log('[Prompt Revert] Using frontend messages for text extraction');
        }
        
        if (!promptText) {
          throw new Error('无法提取消息文本：后端撤回失败且前端数据不可用');
        }
      }

      console.log('[Prompt Revert] Revert successful, reloading messages...');

      // 🆕 如果后端撤回失败，跳过消息重新加载，直接恢复到输入框
      if (backendRevertFailed) {
        console.log('[Prompt Revert] Backend revert failed, skipping message reload');
        
        // 直接恢复提示词到输入框
        if (floatingPromptRef.current && promptText) {
          console.log('[Prompt Revert] Restoring prompt to input (fallback mode):', promptText.substring(0, 100) + '...');
          floatingPromptRef.current.setPrompt(promptText);
          setShowRevertPicker(false);
          
          // 显示警告提示
          setError('⚠️ 会话文件不可用，已将消息恢复到输入框。代码未回滚。');
          
          // 3秒后清除警告
          setTimeout(() => {
            setError('');
          }, 3000);
        }
        
        return; // 不继续执行后续的消息重新加载
      }

      // 重新加载消息历史（根据引擎类型使用不同的 API）
      if (isGemini) {
        // Gemini 使用专门的 API 加载历史
        const geminiDetail = await api.getGeminiSessionDetail(projectPath, effectiveSession.id);

        // 将 Gemini 消息转换为 ClaudeStreamMessage 格式（与 useSessionLifecycle 保持一致）
        const convertedMessages: any[] = geminiDetail.messages.flatMap((msg: any) => {
          const messages: any[] = [];

          if (msg.type === 'user') {
            messages.push({
              type: 'user',
              message: {
                content: msg.content ? [{ type: 'text', text: msg.content }] : []
              },
              timestamp: msg.timestamp,
              engine: 'gemini',
            });
          } else {
            // Gemini assistant message
            const content: any[] = [];

            // Add tool calls if present
            if (msg.toolCalls && msg.toolCalls.length > 0) {
              for (const toolCall of msg.toolCalls) {
                content.push({
                  type: 'tool_use',
                  id: toolCall.id,
                  name: toolCall.name,
                  input: toolCall.args,
                });

                if (toolCall.result !== undefined) {
                  messages.push({
                    type: 'user',
                    message: {
                      content: [{
                        type: 'tool_result',
                        tool_use_id: toolCall.id,
                        content: toolCall.resultDisplay || JSON.stringify(toolCall.result),
                        is_error: toolCall.status === 'error',
                      }]
                    },
                    timestamp: toolCall.timestamp || msg.timestamp,
                    engine: 'gemini',
                  });
                }
              }
            }

            if (msg.content) {
              content.push({
                type: 'text',
                text: msg.content,
              });
            }

            messages.push({
              type: 'assistant',
              message: {
                content: content.length > 0 ? content : [{ type: 'text', text: '' }],
                role: 'assistant'
              },
              timestamp: msg.timestamp,
              engine: 'gemini',
              model: msg.model,
            });
          }

          return messages;
        });

        setMessages(convertedMessages);
        console.log('[Prompt Revert] Loaded Gemini messages:', {
          total: convertedMessages.length,
        });
      } else {
        // Claude/Codex 使用原有 API
        const history = await api.loadSessionHistory(
          effectiveSession.id,
          effectiveSession.project_id,
          sessionEngine as any
        );

        if (sessionEngine === 'codex' && Array.isArray(history)) {
          // 将 Codex 事件转换为消息格式（与 useSessionLifecycle 保持一致）
          codexConverter.reset();
          const convertedMessages: any[] = [];
          for (const event of history) {
            const msg = codexConverter.convertEventObject(event as any);
            if (msg) convertedMessages.push(msg);
          }
          setMessages(convertedMessages);
          console.log('[Prompt Revert] Loaded Codex messages:', {
            total: convertedMessages.length,
          });
        } else if (Array.isArray(history)) {
          setMessages(history);
          console.log('[Prompt Revert] Loaded messages:', {
            total: history.length,
            hideWarmupSetting: claudeSettings?.hideWarmupMessages
          });
        } else if (history && typeof history === 'object' && 'messages' in history) {
          setMessages((history as any).messages);
          console.log('[Prompt Revert] Loaded messages:', {
            total: (history as any).messages.length,
            hideWarmupSetting: claudeSettings?.hideWarmupMessages
          });
        }
      }

      // 恢复提示词到输入框（仅在对话撤回模式下）
      if ((mode === 'conversation_only' || mode === 'both') && floatingPromptRef.current && promptText) {
        console.log('[Prompt Revert] Restoring prompt to input:', promptText);

        // 🆕 提取并分离图片路径
        const extractedImages: Array<{ filePath: string; match: string }> = [];
        let cleanText = promptText;

        // 检测图片文件扩展名
        const isImageFile = (path: string): boolean => {
          if (path.startsWith('data:image/')) return true;
          const ext = path.split('.').pop()?.toLowerCase();
          return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext || '');
        };

        // 模式1: @"path" 格式
        const quotedPattern = /@"([^"]+)"/g;
        let match;
        while ((match = quotedPattern.exec(promptText)) !== null) {
          const path = match[1];
          if (isImageFile(path)) {
            extractedImages.push({ filePath: path, match: match[0] });
          }
        }

        // 模式2: @path 格式（不带引号）
        const unquotedPattern = /@([^\s@]+)/g;
        while ((match = unquotedPattern.exec(promptText)) !== null) {
          const path = match[1];
          if (isImageFile(path)) {
            extractedImages.push({ filePath: path, match: match[0] });
          }
        }

        // 模式3: "path" 格式（带引号但无@前缀）
        const quotedPathPattern = /"([A-Za-z]:\\[^"]+|\/[^"]+)"/g;
        while ((match = quotedPathPattern.exec(promptText)) !== null) {
          const path = match[1];
          if (isImageFile(path)) {
            extractedImages.push({ filePath: path, match: match[0] });
          }
        }

        // 模式4: 直接路径格式（Windows: C:\... 或 Unix: /...）
        const directPathPattern = /(?:^|\s)([A-Za-z]:\\[^\s"]+|\/(?:[^\s"]+\/)+[^\s"]+)(?=\s|$)/g;
        while ((match = directPathPattern.exec(promptText)) !== null) {
          const path = match[1];
          if (isImageFile(path)) {
            extractedImages.push({ filePath: path, match: match[1] }); // 注意这里用 match[1] 而不是 match[0]
          }
        }

        // 去重（使用 filePath 作为键）
        const uniqueImages = Array.from(
          new Map(extractedImages.map(img => [img.filePath, img])).values()
        );

        console.log('[Prompt Revert] Extracted images:', uniqueImages);

        // 从文本中移除所有图片路径
        uniqueImages.forEach(img => {
          cleanText = cleanText.replace(img.match, '').trim();
        });

        console.log('[Prompt Revert] Clean text:', cleanText);
        console.log('[Prompt Revert] Extracted image paths:', uniqueImages.map(img => img.filePath));

        // 🆕 恢复文本和图片 - 将图片路径添加到文本中（作为 embeddedImages 显示缩略图）
        // 而不是使用 imageAttachments（显示为文件名标签）
        let finalPrompt = cleanText;
        if (uniqueImages.length > 0) {
          const imageMentions = uniqueImages.map(img => {
            const path = img.filePath;
            return path.includes(' ') ? `@"${path}"` : `@${path}`;
          }).join(' ');
          finalPrompt = cleanText + (cleanText ? ' ' : '') + imageMentions;
        }

        console.log('[Prompt Revert] Final prompt with images:', finalPrompt);
        floatingPromptRef.current.setPrompt(finalPrompt);
      }

      // 显示成功提示
      const modeText = {
        'conversation_only': '对话已删除',
        'code_only': '代码已回滚',
        'both': '对话已删除，代码已回滚'
      }[mode];

      // 使用简单的成功提示（避免依赖外部 toast 库）
      setError(''); // 清除错误
      console.log(`[Prompt Revert] Success: ${modeText}`);

    } catch (error) {
      console.error('[Prompt Revert] Failed to revert:', error);
      setError('撤回失败：' + error);
    }
  }, [effectiveSession, projectPath, claudeSettings?.hideWarmupMessages, executionEngineConfig.engine, messages, floatingPromptRef]);

  // Cleanup event listeners and track mount state
  // ⚠️ IMPORTANT: No dependencies! Only cleanup on real unmount
  // Adding dependencies like effectiveSession would cause cleanup to run
  // when session ID is extracted, clearing active listeners
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      console.log('[ClaudeCodeSession] Component unmounting, cleaning up listeners');
      isMountedRef.current = false;
      isListeningRef.current = false;

      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten && typeof unlisten === 'function' && unlisten());
      unlistenRefs.current = [];

      // Reset session state on unmount
      setClaudeSessionId(null);
    };
  }, []); // Empty deps - only run on mount/unmount

  const messagesList = (
    <SelectionTranslationProvider>
      <SessionMessages
        ref={sessionMessagesRef}
        messageGroups={messageGroups}
        isLoading={isLoading}
        claudeSettings={claudeSettings}
        effectiveSession={effectiveSession}
        getPromptIndexForMessage={getPromptIndexForMessage}
        handleLinkDetected={handleLinkDetected}
        handleRevert={handleRevert}
        error={error}
        parentRef={parentRef}
      />
    </SelectionTranslationProvider>
  );

  // Show project path input only when:
  // 1. No initial session prop AND
  // 2. No extracted session info (from successful first response)
  const projectPathInput = !effectiveSession && (
    <SessionHeader
      projectPath={projectPath}
      setProjectPath={(path) => {
        setProjectPath(path);
        setError(null);
      }}
      handleSelectPath={handleSelectPath}
      recentProjects={recentProjects}
      isLoading={isLoading}
    />
  );

  // If preview is maximized, render only the WebviewPreview in full screen
  if (showPreview && isPreviewMaximized) {
    return (
      <AnimatePresence>
        <motion.div 
          className="fixed inset-0 z-50 bg-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <WebviewPreview
            initialUrl={previewUrl}
            onClose={handleClosePreview}
            isMaximized={isPreviewMaximized}
            onToggleMaximize={handleTogglePreviewMaximize}
            onUrlChange={handlePreviewUrlChange}
            className="h-full"
          />
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <div className={cn("flex h-full bg-background", className)}>
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 🔧 FIX: 添加 flex flex-col 确保子元素的 h-full 能正确继承高度 */}
        <div className={cn(
          "flex-1 flex flex-col overflow-hidden transition-all duration-300"
        )}>
          {showPreview ? (
            // Split pane layout when preview is active
            <SplitPane
              left={
                // 🔧 FIX: 添加 overflow-hidden 确保子元素的 flex-1 + overflow-y-auto 能正确工作
                <div className="h-full flex flex-col overflow-hidden">
                  {projectPathInput}
                  <PlanModeStatusBar isPlanMode={isPlanMode} />
                  {messagesList}
                </div>
              }
              right={
                <WebviewPreview
                  initialUrl={previewUrl}
                  onClose={handleClosePreview}
                  isMaximized={isPreviewMaximized}
                  onToggleMaximize={handleTogglePreviewMaximize}
                  onUrlChange={handlePreviewUrlChange}
                />
              }
              initialSplit={splitPosition}
              onSplitChange={setSplitPosition}
              minLeftWidth={400}
              minRightWidth={400}
              className="h-full"
            />
          ) : (
            // Original layout when no preview
            // 🔧 FIX: 添加 overflow-hidden 确保子元素的 flex-1 + overflow-y-auto 能正确工作
            <div className="h-full flex flex-col overflow-hidden">
              {projectPathInput && (
                <div className="w-full flex-shrink-0">
                  {projectPathInput}
                </div>
              )}
              <PlanModeStatusBar isPlanMode={isPlanMode} />
              {messagesList}

              {isLoading && messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-3">
                    <div className="rotating-symbol text-primary" />
                    <span className="text-sm text-muted-foreground">
                      {session ? "加载会话历史记录..." : "初始化 Claude Code..."}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>


        {/* Floating Prompt Input - Always visible */}
        <ErrorBoundary>
          {/* Queued Prompts Display */}
          <AnimatePresence>
            {(queuedPrompts.length > 0 || externalQueuedPrompts.length > 0) && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="fixed left-[calc(50%+var(--sidebar-width,4rem)/2)] -translate-x-1/2 z-30 w-full max-w-3xl px-4 transition-[left] duration-300"
                style={{
                  bottom: 'calc(140px + env(safe-area-inset-bottom))', // 在输入区域上方
                }}
              >
                <div className="floating-element backdrop-enhanced rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Queued Prompts ({queuedPrompts.length + externalQueuedPrompts.length})
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setQueuedPromptsCollapsed(prev => !prev)}>
                      {queuedPromptsCollapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </Button>
                  </div>
                  {!queuedPromptsCollapsed && queuedPrompts.map((queuedPrompt, index) => (
                    <motion.div
                      key={queuedPrompt.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ delay: index * 0.05 }}
                      className="flex items-start gap-2 bg-muted/50 rounded-md p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
                          <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                            {queuedPrompt.model === "opus" ? "Opus" : queuedPrompt.model === "sonnet1m" ? "Sonnet 1M" : "Sonnet"}
                          </span>
                        </div>
                        <p className="text-sm line-clamp-2 break-words">{queuedPrompt.prompt}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 flex-shrink-0"
                        onClick={() => setQueuedPrompts(prev => prev.filter(p => p.id !== queuedPrompt.id))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </motion.div>
                  ))}
                  {!queuedPromptsCollapsed && externalQueuedPrompts.map((queuedPrompt, index) => (
                    <motion.div
                      key={queuedPrompt.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ delay: (queuedPrompts.length + index) * 0.05 }}
                      className="flex items-start gap-2 bg-muted/50 rounded-md p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium text-muted-foreground">#{queuedPrompts.length + index + 1}</span>
                          <span className="text-xs px-1.5 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded">
                            {queuedPrompt.engine === 'codex' ? 'Codex' : queuedPrompt.engine === 'claude' ? 'Claude' : queuedPrompt.engine}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {queuedPrompt.source === 'enqueue' ? 'queued' : 'waiting'}
                          </span>
                        </div>
                        <p className="text-sm line-clamp-2 break-words">{queuedPrompt.prompt}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 flex-shrink-0"
                        onClick={() => setExternalQueuedPrompts(prev => prev.filter(p => p.id !== queuedPrompt.id))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Enhanced scroll controls with smart indicators */}
          {displayableMessages.length > 5 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: 0.5 }}
              className={cn(
                "fixed z-50 pointer-events-auto transition-all duration-300",
                showPromptNavigator ? "right-[336px]" : "right-4"
              )}
              style={{
                bottom: 'calc(145px + env(safe-area-inset-bottom))',
              }}
            >
              <div className="flex flex-col gap-1.5">
                {/* Codex Change History Button - Only show for Codex sessions */}
                {executionEngineConfig.engine === 'codex' && !showChangeHistory && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center gap-1 bg-background/60 backdrop-blur-md border border-border/50 rounded-xl px-1.5 py-2 cursor-pointer hover:bg-accent/80 shadow-sm"
                    onClick={() => setShowChangeHistory(true)}
                    title="代码变更历史 - 查看所有文件修改记录"
                  >
                    <GitCompare className="h-4 w-4" />
                    <div className="flex flex-col items-center text-[10px] leading-tight tracking-wider">
                      <span>变</span>
                      <span>更</span>
                    </div>
                  </motion.div>
                )}

                {/* Prompt Navigator Button */}
                {!showPromptNavigator && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center gap-1 bg-background/60 backdrop-blur-md border border-border/50 rounded-xl px-1.5 py-2 cursor-pointer hover:bg-accent/80 shadow-sm"
                    onClick={() => setShowPromptNavigator(true)}
                    title="提示词导航 - 快速跳转到任意提示词"
                  >
                    <List className="h-4 w-4" />
                    <div className="flex flex-col items-center text-[10px] leading-tight tracking-wider">
                      <span>提</span>
                      <span>示</span>
                      <span>词</span>
                    </div>
                  </motion.div>
                )}

                {/* New message indicator - only show when user scrolled away */}
                <AnimatePresence>
                  {userScrolled && (
                    <motion.div
                      initial={{ opacity: 0, y: 20, scale: 0.8 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 20, scale: 0.8 }}
                      className="flex flex-col items-center gap-1 bg-background/60 backdrop-blur-md border border-border/50 rounded-xl px-1.5 py-2 cursor-pointer hover:bg-accent/80 shadow-sm"
                      onClick={() => {
                        setUserScrolled(false);
                        setShouldAutoScroll(true);
                        // 使用虚拟列表的 scrollToBottom 方法
                        sessionMessagesRef.current?.scrollToBottom();
                      }}
                      title="新消息 - 点击滚动到底部"
                    >
                      <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                      <div className="flex flex-col items-center text-[10px] leading-tight tracking-wider">
                        <span>新</span>
                        <span>消</span>
                        <span>息</span>
                      </div>
                      <ChevronDown className="h-3 w-3" />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Traditional scroll controls */}
                <div className="flex flex-col bg-background/60 backdrop-blur-md border border-border/50 rounded-xl overflow-hidden shadow-sm">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUserScrolled(true);
                      setShouldAutoScroll(false);
                      if (parentRef.current) {
                        parentRef.current.scrollTo({
                          top: 0,
                          behavior: 'smooth'
                        });
                      }
                    }}
                    className="px-1.5 py-1.5 hover:bg-accent/80 rounded-none h-auto min-h-0"
                    title="滚动到顶部"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <div className="h-px w-full bg-border/50" />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUserScrolled(false);
                      setShouldAutoScroll(true);
                      // 使用虚拟列表的 scrollToBottom 方法
                      sessionMessagesRef.current?.scrollToBottom();
                    }}
                    className="px-1.5 py-1.5 hover:bg-accent/80 rounded-none h-auto min-h-0"
                    title="滚动到底部"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          <div>
            <FloatingPromptInput
              className={cn(
                "left-[var(--sidebar-width,4rem)] transition-[left,right] duration-300",
                showPromptNavigator ? "right-[328px]" : "right-[12px]"
              )}
              ref={floatingPromptRef}
              onSend={handleSendPrompt}
              onCancel={handleCancelExecution}
              isLoading={isLoading}
              disabled={!projectPath}
              projectPath={projectPath}
              sessionId={effectiveSession?.id}         // 🆕 传递会话 ID
              projectId={effectiveSession?.project_id} // 🆕 传递项目 ID
              sessionModel={session?.model}
              getConversationContext={getConversationContext}
              messages={messages}                      // 🆕 传递完整消息列表
              isPlanMode={isPlanMode}
              onTogglePlanMode={handleTogglePlanMode}
              sessionCost={formatCost(costStats.totalCost)}
              sessionStats={costStats}
              hasMessages={messages.length > 0}
              session={effectiveSession || undefined}  // 🆕 传递完整会话信息用于导出
              executionEngineConfig={executionEngineConfig}              // 🆕 Codex 集成
              onExecutionEngineConfigChange={setExecutionEngineConfig}   // 🆕 Codex 集成
            />
          </div>

        </ErrorBoundary>

        {/* Revert Prompt Picker - Shows when double ESC is pressed */}
        {showRevertPicker && effectiveSession && (
          <RevertPromptPicker
            sessionId={effectiveSession.id}
            projectId={effectiveSession.project_id}
            projectPath={projectPath}
            engine={effectiveSession.engine || executionEngineConfig.engine || 'claude'}
            onSelect={handleRevert}
            onClose={() => setShowRevertPicker(false)}
            fallbackPrompts={fallbackPrompts}
          />
        )}

        {/* Plan Approval Dialog - 方案 B-1: ExitPlanMode 触发审批 */}
        <PlanApprovalDialog
          open={showApprovalDialog}
          plan={pendingApproval?.plan || ''}
          onClose={closeApprovalDialog}
          onApprove={approvePlan}
          onReject={rejectPlan}
        />

        {/* 🆕 User Question Dialog - AskUserQuestion 自动触发 */}
        <AskUserQuestionDialog
          open={showQuestionDialog}
          questions={pendingQuestion?.questions || []}
          onClose={closeQuestionDialog}
          onSubmit={submitAnswers}
        />
      </div>

      {/* Prompt Navigator - Quick navigation to any user prompt */}
      <PromptNavigator
        messages={messages}
        isOpen={showPromptNavigator}
        onClose={() => setShowPromptNavigator(false)}
        onPromptClick={handlePromptNavigation}
      />

      {/* Codex Change History - Shows file changes for Codex sessions */}
      {executionEngineConfig.engine === 'codex' && effectiveSession?.id && (
        <CodexChangeHistory
          sessionId={effectiveSession.id}
          projectPath={projectPath}
          isOpen={showChangeHistory}
          onClose={() => setShowChangeHistory(false)}
        />
      )}

    </div>
  );
};

export const ClaudeCodeSession: React.FC<ClaudeCodeSessionProps> = (props) => {
  return (
    <MessagesProvider initialFilterConfig={{ hideWarmupMessages: true }}>
      <PlanModeProvider>
        <UserQuestionProvider>
          <ClaudeCodeSessionInner {...props} />
        </UserQuestionProvider>
      </PlanModeProvider>
    </MessagesProvider>
  );
};
