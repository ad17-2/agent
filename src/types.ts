import type { LanguageModel, Tool } from "ai";

export interface ConversationConfig {
  maxMessages?: number;
  ttlMs?: number;
}

export interface AgentOptions {
  model: LanguageModel;
  systemPrompt: string;
  tools: Record<string, Tool>;
  maxIterations?: number;
  maxTokens?: number;
  conversation?: ConversationConfig;
  onToolCall?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
}

export interface RunOptions {
  image?: ImageInput;
  signal?: AbortSignal;
}

export interface ImageInput {
  base64: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface AgentResult {
  message: string;
  toolsCalled: ToolCallRecord[];
  iterations: number;
  stopReason: StopReason;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  durationMs: number;
}

export type StopReason = "end_turn" | "max_iterations" | "error" | "aborted";

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mimeType: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; result: unknown };
