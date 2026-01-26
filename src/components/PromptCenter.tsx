import React from "react";
import { CodexPromptManager } from "@/components/CodexPromptManager";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { GeminiMarkdownEditor } from "@/components/GeminiMarkdownEditor";
import { PromptProviderSwitch, type PromptProvider } from "@/PromptProviderSwitch";

interface PromptCenterProps {
  onBack: () => void;
  defaultEngine?: PromptProvider;
}

export const PromptCenter: React.FC<PromptCenterProps> = ({
  onBack,
  defaultEngine = "codex",
}) => {
  const [provider, setProvider] = React.useState<PromptProvider>(defaultEngine);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">提示词</h1>
        <p className="mt-2 text-sm text-zinc-600">管理 Claude / Codex / Gemini 提示词</p>

        <div className="mt-4">
          <PromptProviderSwitch value={provider} onValueChange={setProvider} />
        </div>
      </div>

      <div className="flex-1 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        {provider === "codex" && (
          <div className="h-full overflow-hidden p-6">
            <CodexPromptManager onBack={onBack} />
          </div>
        )}
        {provider === "claude" && (
          <div className="h-full overflow-hidden p-6">
            <MarkdownEditor onBack={onBack} />
          </div>
        )}
        {provider === "gemini" && (
          <div className="h-full overflow-hidden p-6">
            <GeminiMarkdownEditor onBack={onBack} />
          </div>
        )}
      </div>
    </div>
  );
};
