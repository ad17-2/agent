import type { TextStreamPart, ToolSet } from "ai";
import type { AgentEvent } from "../types.js";

/** Parts that carry step data (`finish-step`) are mapped by the stream loop, not here. */
export function toAgentEvent(
  part: TextStreamPart<ToolSet>,
  toolDurations: ReadonlyMap<string, number>
): AgentEvent | undefined {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", content: part.text };

    case "reasoning-delta":
      return { type: "thinking", content: part.text };

    case "tool-input-start":
      return { type: "tool-input-start", name: part.toolName, toolCallId: part.id };

    case "tool-input-delta":
      return { type: "tool-input-delta", toolCallId: part.id, delta: part.delta };

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

    case "error":
      return {
        type: "error",
        error: part.error instanceof Error ? part.error : new Error(String(part.error)),
      };

    default:
      return undefined;
  }
}
