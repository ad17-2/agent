import { describe, it, expect } from "vitest";
import type { StepResult, ToolSet } from "ai";
import { StepRecorder } from "../src/agent/recorder.js";

const step = {
  stepNumber: 0,
  text: "",
  content: [],
  toolCalls: [{ toolCallId: "c1", toolName: "echo", input: { x: 1 } }],
  toolResults: [{ toolCallId: "c1", toolName: "echo", input: { x: 1 }, output: "ok" }],
  performance: { toolExecutionMs: { c1: 7 } },
} as unknown as StepResult<ToolSet>;

describe("StepRecorder.takeStep", () => {
  it("builds the records from the settled steps when onStepEnd never reported the step", async () => {
    const recorder = new StepRecorder(undefined);

    const taken = await recorder.takeStep(Promise.resolve([step]));

    expect(taken).toEqual({
      stepIndex: 0,
      toolsCalled: [{ name: "echo", input: { x: 1 }, output: "ok", durationMs: 7 }],
    });
  });

  it("returns no records only when the settled steps have none for that index", async () => {
    const recorder = new StepRecorder(undefined);

    const taken = await recorder.takeStep(Promise.resolve([]));

    expect(taken.toolsCalled).toEqual([]);
  });
});
