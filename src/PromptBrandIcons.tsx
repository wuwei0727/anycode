import { Claude, Gemini, OpenAI } from "@lobehub/icons";

/** Claude：橙色圆底爆闪 */
export function ClaudePromptIcon({ size = 22 }: { size?: number }) {
  return <Claude.Avatar size={size} />;
}

/** Codex：蓝底 OpenAI 花（用 OpenAI.Avatar 的 gpt4 底色） */
export function CodexPromptIcon({ size = 22 }: { size?: number }) {
  return <OpenAI.Avatar size={size} type="gpt4" shape="circle" />;
}

/** Gemini：彩色星芒（透明底） */
export function GeminiPromptIcon({ size = 22 }: { size?: number }) {
  return <Gemini.Color size={size} />;
}

