import type { FinishReason } from "ai";
import type { StopReason } from "../types.js";

export function toStopReason(
  finishReason: FinishReason,
  stepCount: number,
  maxIterations: number,
  pending: boolean
): StopReason {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool-calls":
      if (pending) return "needs_approval";
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
