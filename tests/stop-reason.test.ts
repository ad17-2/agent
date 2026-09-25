import { describe, it, expect } from "vitest";
import type { FinishReason, StepResult, ToolSet } from "ai";
import { hasUnexecutedToolCall, toStopReason } from "../src/agent/stop-reason.js";

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
      expect(toStopReason(finishReason, 1, 10, false)).toBe(expected);
    });
  }

  it("maps 'tool-calls' to 'max_iterations' when the step cap was reached", () => {
    expect(toStopReason("tool-calls", 3, 3, false)).toBe("max_iterations");
  });

  it("maps 'tool-calls' to 'stop_condition' when the step cap was not reached", () => {
    expect(toStopReason("tool-calls", 1, 10, false)).toBe("stop_condition");
  });

  it("16. a pending approval wins over the step cap, so the run stays resumable", () => {
    expect(toStopReason("tool-calls", 3, 10, false)).toBe("stop_condition");
    expect(toStopReason("tool-calls", 3, 10, true)).toBe("needs_approval");
    expect(toStopReason("tool-calls", 10, 10, true)).toBe("needs_approval");
  });

  it("a pending approval wins over every finish reason the SDK runs tools under", () => {
    for (const finishReason of ["stop", "length", "other"] as const) {
      expect(toStopReason(finishReason, 1, 10, true)).toBe("needs_approval");
    }
  });

  it("maps 'tool-calls' to 'other' when a call was left unexecuted, else to 'stop_condition'", () => {
    expect(toStopReason("tool-calls", 1, 10, false, true)).toBe("other");
    expect(toStopReason("tool-calls", 1, 10, false, false)).toBe("stop_condition");
    expect(toStopReason("tool-calls", 1, 10, true, true)).toBe("needs_approval");
  });
});

describe("hasUnexecutedToolCall", () => {
  const call = { type: "tool-call", toolCallId: "c1", toolName: "t", input: {} } as const;
  function step(content: unknown[]): StepResult<ToolSet> {
    return { content } as unknown as StepResult<ToolSet>;
  }

  it("is true for a call with no result, error, approval request or response", () => {
    expect(hasUnexecutedToolCall(step([call]))).toBe(true);
  });

  it.each([
    ["result", { type: "tool-result", toolCallId: "c1", toolName: "t", output: "ok" }],
    ["error", { type: "tool-error", toolCallId: "c1", toolName: "t", error: new Error("x") }],
    ["approval request", { type: "tool-approval-request", approvalId: "a1", toolCall: call }],
    [
      "approval response",
      { type: "tool-approval-response", approvalId: "a1", approved: false, toolCall: call },
    ],
  ])("is false once the call has a %s", (_label, part) => {
    expect(hasUnexecutedToolCall(step([call, part]))).toBe(false);
  });

  it("is false with no step or no calls", () => {
    expect(hasUnexecutedToolCall(undefined)).toBe(false);
    expect(hasUnexecutedToolCall(step([{ type: "text", text: "hi" }]))).toBe(false);
  });
});
