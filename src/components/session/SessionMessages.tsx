import React, { useImperativeHandle, forwardRef } from "react";
import { motion } from "framer-motion";
import { StreamMessageV2 } from "@/components/message";
import type { MessageGroup } from "@/lib/subagentGrouping";
import type { RewindMode } from "@/lib/api";

export interface SessionMessagesRef {
  scrollToPrompt: (promptIndex: number) => void;
  scrollToBottom: () => void;
}

interface SessionMessagesProps {
  messageGroups: MessageGroup[];
  isLoading: boolean;
  claudeSettings: { showSystemInitialization?: boolean; hideWarmupMessages?: boolean };
  effectiveSession: any;
  getPromptIndexForMessage: (index: number) => number;
  handleLinkDetected: (url: string) => void;
  handleRevert: (promptIndex: number, mode: RewindMode) => void;
  error?: string | null;
  parentRef: React.RefObject<HTMLDivElement>;
}

/**
 * SessionMessages - 简化版消息列表组件
 * 移除虚拟列表，使用普通渲染，解决滚动条晃动问题
 */
export const SessionMessages = forwardRef<SessionMessagesRef, SessionMessagesProps>(({
  messageGroups,
  isLoading,
  claudeSettings,
  effectiveSession,
  getPromptIndexForMessage,
  handleLinkDetected,
  handleRevert,
  error,
  parentRef
}, ref) => {

  useImperativeHandle(ref, () => ({
    scrollToPrompt: (promptIndex: number) => {
      const element = document.getElementById(`prompt-${promptIndex}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        console.warn(`[Prompt Navigation] Prompt #${promptIndex} not found`);
      }
    },
    scrollToBottom: () => {
      if (parentRef.current) {
        parentRef.current.scrollTo({
          top: parentRef.current.scrollHeight,
          behavior: 'auto'
        });
      }
    }
  }));

  return (
    <div
      ref={parentRef}
      className="overflow-y-auto relative flex-1 scrollbar-visible"
      style={{
        paddingTop: '20px',
        paddingBottom: '300px',
      }}
    >
      {/* 内容容器 - 限制宽度并居中 */}
      <div className="w-full max-w-5xl lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[85%] mx-auto">
        <div className="px-4 pt-8 pb-4 space-y-2">
          {messageGroups.map((messageGroup, index) => {
            const groupKey =
              messageGroup.type === 'normal'
                ? `normal-${messageGroup.index}`
                : messageGroup.type === 'subagent'
                ? `subagent-${messageGroup.group.id}`
                : messageGroup.type === 'activity'
                ? `activity-${messageGroup.group.startIndex}`
                : `group-${index}`;

            // promptIndex is needed not only for user bubbles, but also for activity/subagent groups
            // so features like change-history + diff viewers can map changes back to the prompt.
            const anchorIndex =
              messageGroup.type === 'normal'
                ? messageGroup.index
                : messageGroup.type === 'subagent'
                ? messageGroup.group.startIndex
                : messageGroup.type === 'activity'
                ? messageGroup.group.startIndex
                : undefined;

            const promptIndex = anchorIndex !== undefined ? getPromptIndexForMessage(anchorIndex) : undefined;

            return (
              <div key={groupKey} data-index={index}>
                <StreamMessageV2
                  messageGroup={messageGroup}
                  onLinkDetected={handleLinkDetected}
                  claudeSettings={claudeSettings}
                  isStreaming={index === messageGroups.length - 1 && isLoading}
                  promptIndex={promptIndex}
                  sessionId={effectiveSession?.id}
                  projectId={effectiveSession?.project_id}
                  projectPath={effectiveSession?.project_path}
                  onRevert={handleRevert}
                />
              </div>
            );
          })}
        </div>

        {/* Error indicator */}
        {error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive mx-4"
          >
            {error}
          </motion.div>
        )}
      </div>
    </div>
  );
});

SessionMessages.displayName = "SessionMessages";
