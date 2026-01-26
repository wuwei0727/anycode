import { useState, useCallback } from "react";
import { api } from "@/lib/api";
import { callEnhancementAPI, getProvider, getEnabledProviders } from "@/lib/promptEnhancementService";
import { enhancePromptWithDualAPI } from "@/lib/dualAPIEnhancement";
import { loadContextConfig } from "@/lib/promptContextConfig";
import { ClaudeStreamMessage } from "@/types/claude";
import { getDefaultProviderId, setDefaultProviderId as saveDefaultProviderId, validateDefaultProvider } from "@/lib/defaultProviderManager";

// acemcp 结果整理的触发阈值（与 dualAPIEnhancement.ts 保持一致）
const ACEMCP_REFINEMENT_THRESHOLDS = {
  minSnippetCount: 5,
  minContentLength: 3000,
};

export interface UsePromptEnhancementOptions {
  prompt: string;
  isExpanded: boolean;
  onPromptChange: (newPrompt: string) => void;
  getConversationContext?: () => string[];
  messages?: ClaudeStreamMessage[];  // 🆕 完整的消息列表（用于双 API）
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  expandedTextareaRef: React.RefObject<HTMLTextAreaElement>;
  projectPath?: string;
  sessionId?: string;      // 🆕 会话 ID（用于历史上下文）
  projectId?: string;      // 🆕 项目 ID（用于历史上下文）
  enableProjectContext: boolean;
  enableMultiRound?: boolean; // 🆕 启用多轮搜索
}

/**
 * 以可撤销的方式更新 textarea 内容
 * 使用 document.execCommand 确保操作可以被 Ctrl+Z 撤销
 */
function updateTextareaWithUndo(textarea: HTMLTextAreaElement, newText: string) {
  // 保存当前焦点状态
  const hadFocus = document.activeElement === textarea;

  // 确保 textarea 获得焦点（execCommand 需要）
  if (!hadFocus) {
    textarea.focus();
  }

  // 选中全部文本
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  // 使用 execCommand 插入新文本（这会创建一个可撤销的历史记录）
  // 注意：execCommand 已被标记为废弃，但目前仍是唯一支持 undo 的方法
  const success = document.execCommand('insertText', false, newText);

  if (!success) {
    // 如果 execCommand 失败（某些浏览器可能不支持），使用备用方案
    // 虽然这不会创建 undo 历史，但至少能正常工作
    textarea.value = newText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 将光标移到末尾
  textarea.setSelectionRange(newText.length, newText.length);

  // 触发 input 事件以更新 React 状态
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  // 恢复焦点状态
  if (hadFocus) {
    textarea.focus();
  }
}

/**
 * 预览状态接口
 */
export interface PreviewState {
  originalPrompt: string;
  enhancedPrompt: string;
  providerId: string;
  providerName: string;
}

export function usePromptEnhancement({
  prompt,
  isExpanded,
  onPromptChange,
  getConversationContext,
  messages,       // 🆕 完整消息列表
  textareaRef,
  expandedTextareaRef,
  projectPath,
  sessionId,      // 🆕
  projectId,      // 🆕
  enableProjectContext,
  enableMultiRound = true, // 🆕 默认启用多轮搜索
}: UsePromptEnhancementOptions) {
  const [isEnhancing, setIsEnhancing] = useState(false);

  // 🆕 智能上下文提取开关（默认启用）
  const [enableDualAPI, setEnableDualAPI] = useState(() => {
    const saved = localStorage.getItem('enable_dual_api_enhancement');
    return saved !== null ? saved === 'true' : true;  // 默认启用
  });

  // 🆕 默认提供商 ID
  const [defaultProviderId, setDefaultProviderIdState] = useState<string | null>(() => {
    return getDefaultProviderId();
  });

  // 🆕 预览状态
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);

  // 🆕 设置默认提供商
  const setDefaultProviderId = useCallback((id: string | null) => {
    saveDefaultProviderId(id);
    setDefaultProviderIdState(id);
  }, []);

  // 🆕 验证并更新默认提供商（如果无效则清除）
  const validateAndUpdateDefaultProvider = useCallback(() => {
    if (defaultProviderId && !validateDefaultProvider(defaultProviderId)) {
      setDefaultProviderId(null);
      return null;
    }
    return defaultProviderId;
  }, [defaultProviderId, setDefaultProviderId]);

  /**
   * 获取项目上下文（如果启用）
   * 🆕 v2: 支持历史上下文感知和多轮搜索
   */
  const getProjectContext = async (): Promise<string | null> => {
    if (!enableProjectContext || !projectPath) {
      return null;
    }

    try {
      console.log('[getProjectContext] Fetching project context from acemcp...');
      console.log('[getProjectContext] Has session info:', { sessionId, projectId });

      // 🆕 传递会话信息以启用历史上下文感知
      const result = await api.enhancePromptWithContext(
        prompt.trim(),
        projectPath,
        sessionId,        // 🆕 传递会话 ID
        projectId,        // 🆕 传递项目 ID
        3000,
        enableMultiRound  // 🆕 启用多轮搜索
      );

      if (result.acemcpUsed && result.contextCount > 0) {
        console.log('[getProjectContext] Found context:', result.contextCount, 'items');
        console.log('[getProjectContext] Enhanced prompt length:', result.enhancedPrompt.length);
        console.log('[getProjectContext] Enhanced prompt preview:', result.enhancedPrompt.substring(0, 500));

        // 只返回上下文部分（不包括原提示词）
        const contextMatch = result.enhancedPrompt.match(/--- 项目上下文.*?---\n([\s\S]*)/);

        if (contextMatch) {
          const extractedContext = contextMatch[0];
          console.log('[getProjectContext] Extracted context length:', extractedContext.length);
          console.log('[getProjectContext] Extracted context preview:', extractedContext.substring(0, 300));
          return extractedContext;
        } else {
          console.warn('[getProjectContext] Failed to extract context with regex');
          return null;
        }
      }

      return null;
    } catch (error) {
      console.error('[getProjectContext] Failed:', error);
      return null;
    }
  };

  /**
   * 🆕 带预览的优化（返回预览状态而不是直接应用）
   */
  const handleEnhancePromptWithPreview = async (providerId: string): Promise<PreviewState | null> => {
    console.log('[handleEnhancePromptWithPreview] Starting with provider:', providerId);
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      return null;
    }

    // 获取提供商配置
    const provider = getProvider(providerId);
    if (!provider) {
      console.error('[handleEnhancePromptWithPreview] Provider not found:', providerId);
      return null;
    }

    if (!provider.enabled) {
      console.error('[handleEnhancePromptWithPreview] Provider disabled:', providerId);
      return null;
    }

    setIsEnhancing(true);

    try {
      // 获取项目上下文（如果启用）
      const projectContext = await getProjectContext();

      let result: string;

      // 加载配置的阈值
      const config = loadContextConfig();

      // 判断是否需要使用双 API 方案
      const needsAcemcpRefinement = projectContext && (
        (projectContext.match(/Path:|### 文件:/g) || []).length > ACEMCP_REFINEMENT_THRESHOLDS.minSnippetCount ||
        projectContext.length > ACEMCP_REFINEMENT_THRESHOLDS.minContentLength
      );
      const needsHistoryFiltering = messages && messages.length > config.maxMessages;
      const shouldUseDualAPI = enableDualAPI && (needsAcemcpRefinement || needsHistoryFiltering);

      if (shouldUseDualAPI) {
        result = await enhancePromptWithDualAPI(
          messages || [],
          trimmedPrompt,
          provider,
          projectContext || undefined
        );
      } else {
        let context = getConversationContext ? getConversationContext() : undefined;
        if (projectContext) {
          context = context ? [...context, projectContext] : [projectContext];
        }
        result = await callEnhancementAPI(provider, trimmedPrompt, context);
      }
      
      if (result && result.trim()) {
        const preview: PreviewState = {
          originalPrompt: trimmedPrompt,
          enhancedPrompt: result.trim(),
          providerId,
          providerName: provider.name,
        };
        setPreviewState(preview);
        return preview;
      }
      
      return null;
    } catch (error) {
      console.error('[handleEnhancePromptWithPreview] Failed:', error);
      return null;
    } finally {
      setIsEnhancing(false);
    }
  };

  /**
   * 🆕 应用预览的优化结果
   */
  const applyEnhancement = useCallback((customPrompt?: string) => {
    const promptToApply = customPrompt || previewState?.enhancedPrompt;
    if (!promptToApply) return;

    const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
    if (target) {
      updateTextareaWithUndo(target, promptToApply);
    }
    setPreviewState(null);
  }, [previewState, isExpanded, expandedTextareaRef, textareaRef]);

  /**
   * 🆕 取消预览
   */
  const cancelEnhancement = useCallback(() => {
    setPreviewState(null);
  }, []);

  /**
   * 🆕 一键优化（使用默认提供商或指定提供商）
   */
  const triggerEnhancement = useCallback(async (providerId?: string): Promise<PreviewState | null> => {
    // 确定使用哪个提供商
    let targetProviderId = providerId;
    
    if (!targetProviderId) {
      // 尝试使用默认提供商
      targetProviderId = validateAndUpdateDefaultProvider() || undefined;
    }
    
    if (!targetProviderId) {
      // 如果只有一个启用的提供商，使用它
      const enabledProviders = getEnabledProviders();
      if (enabledProviders.length === 1) {
        targetProviderId = enabledProviders[0].id;
      }
    }

    if (!targetProviderId) {
      console.warn('[triggerEnhancement] No provider available');
      return null;
    }

    return handleEnhancePromptWithPreview(targetProviderId);
  }, [validateAndUpdateDefaultProvider]);

  const handleEnhancePromptWithAPI = async (providerId: string) => {
    console.log('[handleEnhancePromptWithAPI] Starting with provider:', providerId);
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      onPromptChange("请描述您想要完成的任务");
      return;
    }

    // 获取提供商配置
    const provider = getProvider(providerId);
    if (!provider) {
      onPromptChange(trimmedPrompt + '\n\n❌ 提供商配置未找到');
      return;
    }

    if (!provider.enabled) {
      onPromptChange(trimmedPrompt + '\n\n❌ 提供商已禁用，请在设置中启用');
      return;
    }

    setIsEnhancing(true);

    try {
      // 获取项目上下文（如果启用）
      const projectContext = await getProjectContext();

      let result: string;

      // 🆕 加载配置的阈值
      const config = loadContextConfig();

      // 🆕 判断是否需要使用双 API 方案（混合策略）
      const needsAcemcpRefinement = projectContext && (
        (projectContext.match(/Path:|### 文件:/g) || []).length > ACEMCP_REFINEMENT_THRESHOLDS.minSnippetCount ||
        projectContext.length > ACEMCP_REFINEMENT_THRESHOLDS.minContentLength
      );
      const needsHistoryFiltering = messages && messages.length > config.maxMessages;
      const shouldUseDualAPI = enableDualAPI && (needsAcemcpRefinement || needsHistoryFiltering);

      console.log('[handleEnhancePromptWithAPI] Decision:', {
        enableDualAPI,
        messagesCount: messages?.length || 0,
        maxMessages: config.maxMessages,
        projectContextLength: projectContext?.length || 0,
        needsAcemcpRefinement,
        needsHistoryFiltering,
        shouldUseDualAPI
      });

      if (shouldUseDualAPI) {
        // ✨ 使用双 API 方案（混合策略：acemcp 整理 或 历史筛选）
        console.log('[handleEnhancePromptWithAPI] Using dual API approach');

        result = await enhancePromptWithDualAPI(
          messages || [],
          trimmedPrompt,
          provider,
          projectContext || undefined
        );

      } else {
        // 使用传统单次调用方案
        console.log('[handleEnhancePromptWithAPI] Using single API approach');

        // 获取对话上下文
        let context = getConversationContext ? getConversationContext() : undefined;

        // 如果有项目上下文，附加到 context 数组
        if (projectContext) {
          console.log('[handleEnhancePromptWithAPI] Adding project context to conversation context');
          context = context ? [...context, projectContext] : [projectContext];
        }

        result = await callEnhancementAPI(provider, trimmedPrompt, context);
      }
      
      if (result && result.trim()) {
        // 使用可撤销的方式更新文本
        const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
        if (target) {
          updateTextareaWithUndo(target, result.trim());
        }
      } else {
        const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
        if (target) {
          updateTextareaWithUndo(target, trimmedPrompt + '\n\n⚠️ API返回空结果，请重试');
        }
      }
    } catch (error) {
      console.error('[handleEnhancePromptWithAPI] Failed:', error);
      let errorMessage = '未知错误';
      
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      
      const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
      if (target) {
        updateTextareaWithUndo(target, trimmedPrompt + `\n\n❌ ${provider.name}: ${errorMessage}`);
      }
    } finally {
      setIsEnhancing(false);
    }
  };

  return {
    isEnhancing,
    handleEnhancePromptWithAPI,
    enableDualAPI,
    setEnableDualAPI,
    // 🆕 默认提供商相关
    defaultProviderId,
    setDefaultProviderId,
    // 🆕 预览相关
    previewState,
    applyEnhancement,
    cancelEnhancement,
    // 🆕 一键优化
    triggerEnhancement,
    handleEnhancePromptWithPreview,
  };
}
