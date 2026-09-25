import { describe, it, expect } from "vitest";
import type { FinishReason } from "ai";
import { toStopReason } from "../src/agent/stop-reason.js";

describe("toStopReason", () => {
  const finishReasons: Array<[FinishReason, string]> = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["content-filter", "content_filter"],
    ["error", "error"],
    ["other", "other"],
  ];

  for (const [finishReason, expected] of finishReasons) {
    it(`maps '${finishReason}' to '${expected}'`, () => {
      expect(toStopReason(finishReason, 1, 10)).toBe(expected);
    });
  }

  it("maps 'tool-calls' to 'max_iterations' when the step cap was reached", () => {
    expect(toStopReason("tool-calls", 3, 3)).toBe("max_iterations");
  });

  it("maps 'tool-calls' to 'stop_condition' when the step cap was not reached", () => {
    expect(toStopReason("tool-calls", 1, 10)).toBe("stop_condition");
  });
});
