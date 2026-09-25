import type { FinishReason, StepResult, ToolSet } from "ai";
import type { StopReason } from "../types.js";

/** True when a call in the step neither ran, failed, nor got an approval part: a tool with no `execute` ends the loop this way. */
export function hasUnexecutedToolCall(step: StepResult<ToolSet> | undefined): boolean {
  if (!step) return false;
  const answered = new Set<string>();
  for (const part of step.content) {
    if (part.type === "tool-result" || part.type === "tool-error") answered.add(part.toolCallId);
    if (part.type === "tool-approval-request" || part.type === "tool-approval-response") {
      answered.add(part.toolCall.toolCallId);
    }
  }
  return step.content.some((part) => part.type === "tool-call" && !answered.has(part.toolCallId));
}

export function toStopReason(
  finishReason: FinishReason,
  stepCount: number,
  maxIterations: number,
  pending: boolean,
  unexecuted = false
): StopReason {
  // The SDK runs tools under "stop", "length" and "other" too, so a gated call can be left unanswered under any of them.
  if (pending) return "needs_approval";
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool-calls":
      if (unexecuted) return "other";
      return stepCount >= maxIterations ? "max_iterations" : "stop_condition";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "content_filter";
    case "error":
      return "error";
    case "other":
      return "other";
  }
}
