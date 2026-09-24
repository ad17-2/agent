import type { TextStreamPart, ToolSet } from "ai";
import type { AgentEvent, TokenUsage, ToolCallRecord } from "../types.js";

function toTokenUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

export function toAgentEvent(
  part: TextStreamPart<ToolSet>,
  toolDurations: ReadonlyMap<string, number>,
  stepIndex: number,
  stepToolsCalled: ToolCallRecord[]
): AgentEvent | undefined {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", content: part.text };

    case "reasoning-delta":
      return { type: "thinking", content: part.text };

    case "tool-call":
      return {
        type: "tool-call-start",
        name: part.toolName,
        input: part.input,
        toolCallId: part.toolCallId,
      };

    case "tool-result":
      return {
        type: "tool-call-complete",
        name: part.toolName,
        output: part.output,
        toolCallId: part.toolCallId,
        durationMs: toolDurations.get(part.toolCallId) ?? 0,
      };

    case "tool-error":
      return {
        type: "tool-call-error",
        name: part.toolName,
        error: part.error instanceof Error ? part.error.message : String(part.error),
        toolCallId: part.toolCallId,
      };

    case "finish-step":
      return {
        type: "step-complete",
        stepIndex,
        toolsCalled: stepToolsCalled,
        usage: toTokenUsage(part.usage),
      };

    case "error":
      return {
        type: "error",
        error: part.error instanceof Error ? part.error : new Error(String(part.error)),
      };

    default:
      return undefined;
  }
}

export { toTokenUsage };
