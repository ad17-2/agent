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
      expect(toStopReason(finishReason, [{}], 10, undefined)).toBe(expected);
    });
  }

  it("maps 'tool-calls' to 'max_iterations' when the step cap was reached", () => {
    const steps = [{}, {}, {}];
    expect(toStopReason("tool-calls", steps, 3, undefined)).toBe("max_iterations");
  });

  it("maps 'tool-calls' to 'other' when the step cap was not reached", () => {
    const steps = [{}];
    expect(toStopReason("tool-calls", steps, 10, undefined)).toBe("other");
  });

  it("reports 'aborted' when the caller's signal fired, regardless of finishReason", () => {
    expect(toStopReason("stop", [{}], 10, "aborted")).toBe("aborted");
  });

  it("reports 'timeout' when the run timeout fired, regardless of finishReason", () => {
    expect(toStopReason("length", [{}], 10, "timeout")).toBe("timeout");
  });
});
