import * as React from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
  ClaudePromptIcon,
  CodexPromptIcon,
  GeminiPromptIcon,
} from "./PromptBrandIcons";

export type PromptProvider = "codex" | "claude" | "gemini";

export function PromptProviderSwitch({
  value,
  onValueChange,
}: {
  value: PromptProvider;
  onValueChange: (v: PromptProvider) => void;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as PromptProvider);
      }}
      aria-label="选择提示词提供方"
      className={[
        "inline-flex items-center gap-1 rounded-2xl bg-zinc-100 p-1",
        "shadow-sm ring-1 ring-zinc-200",
      ].join(" ")}
    >
      <PillItem value="codex" label="Codex" icon={<CodexPromptIcon size={18} />} />
      <PillItem value="claude" label="Claude" icon={<ClaudePromptIcon size={18} />} />
      <PillItem value="gemini" label="Gemini" icon={<GeminiPromptIcon size={18} />} />
    </ToggleGroup.Root>
  );
}

function PillItem({
  value,
  label,
  icon,
}: {
  value: PromptProvider;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <ToggleGroup.Item
      value={value}
      className={[
        "group inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium",
        "text-zinc-700 hover:bg-white/70",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60",
        "data-[state=on]:bg-white data-[state=on]:text-zinc-900 data-[state=on]:shadow-sm",
      ].join(" ")}
    >
      <span className="grid h-5 w-5 place-items-center">{icon}</span>
      <span>{label}</span>
    </ToggleGroup.Item>
  );
}

