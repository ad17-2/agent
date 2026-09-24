import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import type { AgentResult, SerializedHistory, SerializedHistoryV1 } from "../src/types.js";
import { collect, streamModel, textResult, toolCallResult, usage } from "./helpers.js";

function mockModel(
  doGenerate: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"]
) {
  return new MockLanguageModelV4({ doGenerate });
}

describe("createAgent", () => {
  it("returns message and usage from a run", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Hello! How can I help?" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(15, 25),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "You are helpful.", tools: {} });
    const result = await agent.run("Hello");

    expect(result.message).toBe("Hello! How can I help?");
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(1);
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(25);
    expect(result.usage.totalTokens).toBe(40);
    expect(result.cost).toBeUndefined();
  });

  it("attaches cost only when pricing is set", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(1000, 500),
      warnings: [],
    }));

    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: {},
      pricing: { "mock-model-id": { inputPerMTok: 3, outputPerMTok: 15 } },
    });
    const result = await agent.run("Hello");

    // 1000 / 1e6 * 3 = 0.003; 500 / 1e6 * 15 = 0.0075
    expect(result.cost?.inputUsd).toBeCloseTo(0.003, 10);
    expect(result.cost?.outputUsd).toBeCloseTo(0.0075, 10);
    expect(result.cost?.totalUsd).toBeCloseTo(0.0105, 10);
    expect(result.cost?.unpricedModels).toEqual([]);
  });

  it("calls onToolCall and onToolResult callbacks", async () => {
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const greet = defineTool({
      description: "Greet someone",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    const model = mockModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "greet",
            input: JSON.stringify({ name: "World" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(),
        warnings: [],
      },
      {
        content: [{ type: "text", text: "I greeted World!" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      },
    ]);

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { greet },
      onToolCall,
      onToolResult,
    });

    await agent.run("Greet World");

    expect(onToolCall).toHaveBeenCalledWith("greet", { name: "World" });
    expect(onToolResult).toHaveBeenCalledWith("greet", "Hello, World!");
  });

  it("calls onStart, onStep, and onComplete hooks", async () => {
    const onStart = vi.fn();
    const onStep = vi.fn();
    const onComplete = vi.fn();

    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Done" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      onStart,
      onStep,
      onComplete,
    });

    await agent.run("Test input");

    expect(onStart).toHaveBeenCalledWith("Test input");
    expect(onStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 0, toolsCalled: [], textGenerated: "Done" })
    );
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Done", stopReason: "end_turn" })
    );
  });

  it("throws AgentError and calls onError when the API call fails", async () => {
    const onError = vi.fn();

    const model = mockModel(async () => {
      throw new Error("API error");
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      onError,
      retry: { maxAttempts: 1 },
    });

    await expect(agent.run("Test")).rejects.toThrow("API error");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: "api" });
  });

  it("tracks tool call duration", async () => {
    const greet = defineTool({
      description: "Greet someone",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => {
        await new Promise((r) => setTimeout(r, 20));
        return `Hello, ${name}!`;
      },
    });

    const model = mockModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "greet",
            input: JSON.stringify({ name: "World" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(),
        warnings: [],
      },
      {
        content: [{ type: "text", text: "Done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      },
    ]);

    const agent = createAgent({ model, systemPrompt: "Test", tools: { greet } });
    const result = await agent.run("Test");

    expect(result.toolsCalled).toHaveLength(1);
    expect(result.toolsCalled[0]!.durationMs).toBeGreaterThan(0);
  });

  it("returns an 'aborted' result (does not throw) when aborted before run", async () => {
    const controller = new AbortController();
    controller.abort();

    const model = mockModel(async () => ({
      content: [{ type: "text", text: "unused" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    const result = await agent.run("Test", { signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
  });

  it("clears history when clearHistory is called", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Response" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });

    await agent.run("First message");
    agent.clearHistory();
    await agent.run("Second message");

    const lastCall = model.doGenerateCalls[1];
    expect(lastCall).toBeDefined();
    expect(lastCall!.prompt.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("exports (v2) and imports history, replaying it on the next call", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Response" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent1 = createAgent({ model, systemPrompt: "Test", tools: {} });
    await agent1.run("Hello");
    const exported = agent1.exportHistory();

    expect(exported.version).toBe(2);
    expect(exported.messages.length).toBeGreaterThanOrEqual(2);
    expect(exported.exportedAt).toBeDefined();

    const model2 = mockModel(async () => ({
      content: [{ type: "text", text: "Response" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));
    const agent2 = createAgent({ model: model2, systemPrompt: "Test", tools: {} });
    agent2.importHistory(exported);
    await agent2.run("World");

    const lastCall = model2.doGenerateCalls[0];
    expect(lastCall).toBeDefined();
    expect(lastCall!.prompt.length).toBeGreaterThan(1);
  });

  it("converts a v1 (text-only) serialized history on import", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Response" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const v1History: SerializedHistoryV1 = {
      version: 1,
      messages: [
        { role: "user", content: "Hi from v1", timestamp: Date.now() },
        { role: "assistant", content: "Hello back", timestamp: Date.now() },
      ],
      exportedAt: Date.now(),
    };

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    agent.importHistory(v1History);
    await agent.run("Continue");

    const lastCall = model.doGenerateCalls[0];
    expect(lastCall).toBeDefined();
    expect(lastCall!.prompt.filter((m) => m.role !== "system")).toHaveLength(3);
  });

  it("throws on an unsupported history version", () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "unused" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });

    const invalidHistory = {
      version: 99,
      messages: [],
      exportedAt: Date.now(),
    } as unknown as SerializedHistory;

    expect(() => agent.importHistory(invalidHistory)).toThrow();
  });

  it("retries run() on transient errors", async () => {
    let attempts = 0;
    const model = mockModel(async () => {
      attempts++;
      if (attempts < 3) {
        throw new APICallError({
          message: "overloaded",
          url: "https://api.example",
          requestBodyValues: {},
          statusCode: 529,
          isRetryable: true,
        });
      }
      return {
        content: [{ type: "text", text: "Success" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      };
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });

    const result = await agent.run("Test");

    expect(result.message).toBe("Success");
    expect(attempts).toBe(3);
  });

  it("includes reasoning text in the result when extended thinking is enabled", async () => {
    const model = mockModel(async () => ({
      content: [
        { type: "reasoning", text: "Let me think..." },
        { type: "text", text: "Answer" },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      thinking: { enabled: true },
    });

    const result = await agent.run("Complex question");

    expect(result.thinking).toBe("Let me think...");
  });
});

describe("agent.stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("yields start event first", async () => {
    const model = streamModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Hello" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
    ]);

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    const events: unknown[] = [];
    for await (const event of agent.stream("Hello")) {
      events.push(event);
      if (event.type === "complete") break;
    }

    expect(events[0]).toEqual({ type: "start", timestamp: expect.any(Number) });
  });

  it("yields text-delta and text-complete events", async () => {
    const model = streamModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Hello " },
      { type: "text-delta", id: "1", delta: "World" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
    ]);

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    const events: unknown[] = [];
    for await (const event of agent.stream("Test")) {
      events.push(event);
      if (event.type === "complete") break;
    }

    const textDeltas = events.filter((e) => (e as { type: string }).type === "text-delta");
    expect(textDeltas).toEqual([
      { type: "text-delta", content: "Hello " },
      { type: "text-delta", content: "World" },
    ]);

    const textComplete = events.find((e) => (e as { type: string }).type === "text-complete");
    expect(textComplete).toEqual({ type: "text-complete", content: "Hello World" });
  });

  it("yields complete event with full result", async () => {
    const model = streamModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Done" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(10, 5) },
    ]);

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    let result: AgentResult | undefined;
    for await (const event of agent.stream("Test")) {
      if (event.type === "complete") {
        result = event.result;
        break;
      }
    }

    expect(result).toBeDefined();
    expect(result!.message).toBe("Done");
    expect(result!.usage.inputTokens).toBe(10);
    expect(result!.usage.outputTokens).toBe(5);
    expect(result!.stopReason).toBe("end_turn");
  });

  it("returns an 'error' result (does not throw) once output has started, and calls onError({ phase: 'api' })", async () => {
    const onError = vi.fn();
    const model = streamModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "partial" },
      { type: "error", error: new Error("Stream error") },
    ]);

    const agent = createAgent({ model, systemPrompt: "Test", tools: {}, onError });

    const events = await collect(agent.stream("Test"));

    expect(events.find((e) => e.type === "error")).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "complete", result: { stopReason: "error" } });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Stream error" }), {
      phase: "api",
    });
  });
});

describe("agent.stream events", () => {
  const echo = defineTool({
    description: "Echo",
    schema: z.object({}),
    handler: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "echoed";
    },
  });

  const boom = defineTool({
    description: "Throws",
    schema: z.object({}),
    handler: async () => {
      throw new Error("boom");
    },
  });

  function toolStep(toolName: string, toolCallId = "call-1"): LanguageModelV4StreamPart[] {
    return [
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Let me think" },
      { type: "reasoning-end", id: "r1" },
      { type: "tool-call", toolCallId, toolName, input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage() },
    ];
  }

  const textStep: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "Done" },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(3, 4) },
  ];

  it("emits thinking for reasoning deltas", async () => {
    const agent = createAgent({
      model: streamModel(toolStep("echo"), textStep),
      systemPrompt: "Test",
      tools: { echo },
    });

    const events = await collect(agent.stream("go"));

    expect(events).toContainEqual({ type: "thinking", content: "Let me think" });
  });

  it("emits tool-call-start with the parsed input", async () => {
    const agent = createAgent({
      model: streamModel(toolStep("echo"), textStep),
      systemPrompt: "Test",
      tools: { echo },
    });

    const events = await collect(agent.stream("go"));

    expect(events).toContainEqual({
      type: "tool-call-start",
      name: "echo",
      input: {},
      toolCallId: "call-1",
    });
  });

  it("emits tool-call-complete with the output and a measured duration", async () => {
    const agent = createAgent({
      model: streamModel(toolStep("echo"), textStep),
      systemPrompt: "Test",
      tools: { echo },
    });

    const events = await collect(agent.stream("go"));

    const complete = events.find((e) => e.type === "tool-call-complete");
    expect(complete).toMatchObject({ name: "echo", output: "echoed", toolCallId: "call-1" });
    expect(complete).toHaveProperty("durationMs", expect.any(Number));
    expect((complete as { durationMs: number }).durationMs).toBeGreaterThan(0);
  });

  it("emits tool-call-error when the tool throws", async () => {
    const agent = createAgent({
      model: streamModel(toolStep("boom"), textStep),
      systemPrompt: "Test",
      tools: { boom },
    });

    const events = await collect(agent.stream("go"));

    expect(events).toContainEqual({
      type: "tool-call-error",
      name: "boom",
      error: "boom",
      toolCallId: "call-1",
    });
  });

  it("emits step-complete per step with that step's usage", async () => {
    const agent = createAgent({
      model: streamModel(toolStep("echo"), textStep),
      systemPrompt: "Test",
      tools: { echo },
    });

    const events = await collect(agent.stream("go"));

    const steps = events.filter((e) => e.type === "step-complete");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ stepIndex: 0, usage: { inputTokens: 10, outputTokens: 20 } });
    expect(steps[1]).toMatchObject({ stepIndex: 1, usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it("step-complete carries the step's own tool records, including a failed one", async () => {
    const twoToolStep: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: "{}" },
      { type: "tool-call", toolCallId: "call-2", toolName: "boom", input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage() },
    ];
    const agent = createAgent({
      model: streamModel(twoToolStep, textStep),
      systemPrompt: "Test",
      tools: { echo, boom },
    });

    const events = await collect(agent.stream("go"));

    const types = events.map((e) => e.type);
    const step0 = types.indexOf("step-complete");
    expect(step0).toBeGreaterThan(types.indexOf("tool-call-complete"));
    expect(step0).toBeGreaterThan(types.indexOf("tool-call-error"));
    expect(step0).toBeLessThan(types.indexOf("text-delta"));
    expect(events[step0]).toMatchObject({
      stepIndex: 0,
      toolsCalled: [
        { name: "echo", output: "echoed", error: undefined },
        { name: "boom", output: undefined, error: true, errorMessage: "boom" },
      ],
    });
    expect(events.filter((e) => e.type === "step-complete")[1]).toMatchObject({
      stepIndex: 1,
      toolsCalled: [],
    });
  });

  it("measures each run's tool durations on their own, even when tool call ids repeat", async () => {
    // Timers can fire up to ~1ms early against the SDK's clock, so compare against half the delay.
    const slowMs = 80;
    let calls = 0;
    const sometimesSlow = defineTool({
      description: "Slow on the first call only",
      schema: z.object({}),
      handler: async () => {
        if (calls++ === 0) await new Promise((r) => setTimeout(r, slowMs));
        return "ok";
      },
    });
    const agent = createAgent({
      model: streamModel(toolStep("sometimesSlow"), textStep, toolStep("sometimesSlow"), textStep),
      systemPrompt: "Test",
      tools: { sometimesSlow },
    });

    const first = await collect(agent.stream("one"));
    const second = await collect(agent.stream("two"));

    const durationOf = (events: typeof first) =>
      (events.find((e) => e.type === "tool-call-complete") as { durationMs: number }).durationMs;
    const recordOf = (events: typeof first) =>
      (events.at(-1) as { result: AgentResult }).result.toolsCalled[0]!.durationMs;
    expect(durationOf(first)).toBeGreaterThanOrEqual(slowMs / 2);
    expect(recordOf(first)).toBeGreaterThanOrEqual(slowMs / 2);
    expect(durationOf(second)).toBeLessThan(slowMs / 2);
    expect(recordOf(second)).toBeLessThan(slowMs / 2);
  });

  it("calls onStep for every step", async () => {
    const onStep = vi.fn();
    const agent = createAgent({
      model: streamModel(toolStep("echo"), textStep),
      systemPrompt: "Test",
      tools: { echo },
      onStep,
    });

    await collect(agent.stream("go"));

    expect(onStep).toHaveBeenCalledTimes(2);
    expect(onStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stepIndex: 0,
        toolsCalled: [expect.objectContaining({ name: "echo" })],
      })
    );
    expect(onStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ stepIndex: 1, toolsCalled: [], textGenerated: "Done" })
    );
  });

  it("appends the turn to history", async () => {
    const agent = createAgent({ model: streamModel(textStep), systemPrompt: "Test", tools: {} });

    await collect(agent.stream("hello there"));

    expect(agent.exportHistory().messages).toMatchObject([
      { role: "user", content: "hello there" },
      { role: "assistant" },
    ]);
  });

  it("attaches cost when pricing is set", async () => {
    const agent = createAgent({
      model: streamModel(textStep),
      systemPrompt: "Test",
      tools: {},
      pricing: { "mock-model-id": { inputPerMTok: 3, outputPerMTok: 15 } },
    });

    const events = await collect(agent.stream("go"));

    // 3 / 1e6 * 3 + 4 / 1e6 * 15
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      result: { cost: { totalUsd: 6.9e-5 } },
    });
  });
});

describe("agent.run tool records", () => {
  it("marks a failed tool call with error and errorMessage", async () => {
    const boom = defineTool({
      description: "Throws",
      schema: z.object({}),
      handler: async () => {
        throw new Error("boom");
      },
    });
    const model = mockModel([toolCallResult("boom"), textResult("recovered")]);
    const agent = createAgent({ model, systemPrompt: "Test", tools: { boom } });

    const result = await agent.run("go");

    expect(result.message).toBe("recovered");
    expect(result.toolsCalled).toEqual([
      {
        name: "boom",
        input: {},
        output: undefined,
        durationMs: expect.any(Number),
        error: true,
        errorMessage: "boom",
      },
    ]);
  });
});

describe("createAgent with a context budget", () => {
  function overBudgetAgent(pricing?: {
    [modelId: string]: { inputPerMTok: number; outputPerMTok: number };
  }) {
    const model = mockModel(async () => textResult("answer", 10, 20));
    const summarizer = mockModel(async () => textResult("SUMMARY", 7, 3));
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      pricing,
      context: { maxInputTokens: 1, summarize: { model: summarizer, keepRecentTurns: 0 } },
    });
    agent.importHistory({
      version: 2,
      messages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
      exportedAt: Date.now(),
    });
    return agent;
  }

  it("folds the summariser's usage into the run's usage", async () => {
    const result = await overBudgetAgent().run("now");

    expect(result.usage).toMatchObject({ inputTokens: 17, outputTokens: 23, totalTokens: 40 });
  });

  it("folds the summariser's cost into the run's cost", async () => {
    const result = await overBudgetAgent({
      "mock-model-id": { inputPerMTok: 3, outputPerMTok: 15 },
    }).run("now");

    // input 17 * 3 / 1e6, output 23 * 15 / 1e6
    expect(result.cost?.inputUsd).toBeCloseTo(5.1e-5, 12);
    expect(result.cost?.outputUsd).toBeCloseTo(3.45e-4, 12);
    expect(result.cost?.totalUsd).toBeCloseTo(3.96e-4, 12);
  });

  it("summarizes over-budget history before the next call, and never splits a tool call from its result", async () => {
    let callIndex = 0;
    const model = mockModel(async () => {
      callIndex++;
      if (callIndex === 1) {
        // first run: makes a tool call
        return {
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: usage(),
          warnings: [],
        };
      }
      if (callIndex === 2) {
        // continuation after the tool result, within the same run() call
        return {
          content: [{ type: "text", text: "first answer" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(),
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "second answer" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      };
    });

    const summarizer = mockModel(async () => ({
      content: [{ type: "text", text: "SUMMARY: earlier turn discussed lookups" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {
        lookup: defineTool({
          description: "look something up",
          schema: z.object({}),
          handler: async () => "looked up",
        }),
      },
      context: { maxInputTokens: 1, summarize: { model: summarizer, keepRecentTurns: 0 } },
    });

    await agent.run("First question that triggers a tool call");
    const result = await agent.run("Second question");

    expect(result.message).toBe("second answer");

    const secondRunCall = model.doGenerateCalls[2];
    expect(secondRunCall).toBeDefined();

    const promptText = JSON.stringify(secondRunCall!.prompt);
    expect(promptText).toContain("SUMMARY: earlier turn discussed lookups");
    expect(promptText).toContain("Second question");

    // the tool call and its result from the first turn must have been summarized away together,
    // not split (no orphaned call-1 reference left dangling in the prompt sent to the model)
    expect(promptText).not.toContain("call-1");
  });

  it("does not summarize when history is under the configured budget", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      context: { maxInputTokens: 1_000_000 },
    });

    await agent.run("First");
    await agent.run("Second");

    const secondCall = model.doGenerateCalls[1];
    const promptText = JSON.stringify(secondCall!.prompt);
    expect(promptText).toContain("First");
    expect(promptText).toContain("Second");
  });
});
