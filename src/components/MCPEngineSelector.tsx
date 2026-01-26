import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MCPEngineType } from "@/lib/api";

// Storage key for persisting engine selection
const MCP_ENGINE_STORAGE_KEY = "mcp-selected-engine";

interface MCPEngineSelectorProps {
  value: MCPEngineType;
  onChange: (engine: MCPEngineType) => void;
  disabled?: boolean;
}

interface EngineOption {
  value: MCPEngineType;
  label: string;
  icon: string;
  description: string;
}

const ENGINE_OPTIONS: EngineOption[] = [
  {
    value: "claude",
    label: "Claude Code",
    icon: "🤖",
    description: "Anthropic Claude CLI",
  },
  {
    value: "codex",
    label: "Codex",
    icon: "⚡",
    description: "OpenAI Codex CLI",
  },
  {
    value: "gemini",
    label: "Gemini CLI",
    icon: "✨",
    description: "Google Gemini CLI",
  },
];

/**
 * Loads the saved engine selection from localStorage
 */
export function loadSavedEngine(): MCPEngineType {
  try {
    const saved = localStorage.getItem(MCP_ENGINE_STORAGE_KEY);
    if (saved && ["claude", "codex", "gemini"].includes(saved)) {
      return saved as MCPEngineType;
    }
  } catch (error) {
    console.error("Failed to load saved engine:", error);
  }
  return "claude"; // Default to Claude
}

/**
 * Saves the engine selection to localStorage
 */
export function saveEngine(engine: MCPEngineType): void {
  try {
    localStorage.setItem(MCP_ENGINE_STORAGE_KEY, engine);
  } catch (error) {
    console.error("Failed to save engine:", error);
  }
}

/**
 * Engine selector component for MCP management
 * Allows switching between Claude, Codex, and Gemini engines
 */
export const MCPEngineSelector: React.FC<MCPEngineSelectorProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const handleChange = (newValue: string) => {
    const engine = newValue as MCPEngineType;
    saveEngine(engine);
    onChange(engine);
  };

  const selectedOption = ENGINE_OPTIONS.find((opt) => opt.value === value);

  return (
    <Select value={value} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger className="w-[180px]">
        <SelectValue>
          {selectedOption && (
            <span className="flex items-center gap-2">
              <span>{selectedOption.icon}</span>
              <span>{selectedOption.label}</span>
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ENGINE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <div className="flex items-center gap-2">
              <span className="text-lg">{option.icon}</span>
              <div className="flex flex-col">
                <span className="font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </div>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export default MCPEngineSelector;
