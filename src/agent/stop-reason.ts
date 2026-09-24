import type { FinishReason } from "ai";
import type { StopReason } from "../types.js";

export type SignalState = "aborted" | "timeout" | undefined;

/**
 * Maps the SDK's finish reason to the package's StopReason, per docs/design.md:
 * stop -> end_turn, tool-calls (step-capped) -> max_iterations, length -> max_tokens,
 * content-filter -> content_filter, error -> error, other -> other.
 * Aborts and timeouts are reported as a result, never thrown.
 */
export function toStopReason(
  finishReason: FinishReason,
  steps: ReadonlyArray<unknown>,
  maxIterations: number,
  signalState: SignalState
): StopReason {
  if (signalState === "aborted") return "aborted";
  if (signalState === "timeout") return "timeout";

  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool-calls":
      return steps.length >= maxIterations ? "max_iterations" : "other";
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
