import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import type { AgentResult, SerializedHistory, SerializedHistoryV1 } from "../src/types.js";

function usage(inputTokens = 10, outputTokens = 20) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function mockModel(
  doGenerate: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"]
) {
  return new MockLanguageModelV4({ doGenerate });
}

describe("createAgent", () => {
  it("creates an agent with run, stream, clearHistory, exportHistory, importHistory methods", () => {
    const agent = createAgent({
      model: mockModel(async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      })),
      systemPrompt: "You are helpful.",
      tools: {},
    });

    expect(agent.run).toBeInstanceOf(Function);
    expect(agent.stream).toBeInstanceOf(Function);
    expect(agent.clearHistory).toBeInstanceOf(Function);
    expect(agent.exportHistory).toBeInstanceOf(Function);
    expect(agent.importHistory).toBeInstanceOf(Function);
  });

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

  it("reports max_tokens when finish reason is length", async () => {
    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Partial response..." }],
      finishReason: { unified: "length", raw: "length" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    const result = await agent.run("Test");

    expect(result.stopReason).toBe("max_tokens");
  });

  it("reports max_iterations when a tool-call run hits the step cap", async () => {
    const echo = defineTool({
      description: "Echo",
      schema: z.object({ value: z.string() }),
      handler: async ({ value }) => value,
    });

    const model = mockModel(async () => ({
      content: [
        { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: JSON.stringify({ value: "hi" }) },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "Test", tools: { echo }, maxIterations: 1 });
    const result = await agent.run("Test");

    expect(result.stopReason).toBe("max_iterations");
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
          { type: "tool-call", toolCallId: "call-1", toolName: "greet", input: JSON.stringify({ name: "World" }) },
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
          { type: "tool-call", toolCallId: "call-1", toolName: "greet", input: JSON.stringify({ name: "World" }) },
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

  it("uses the logger when provided", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const model = mockModel(async () => ({
      content: [{ type: "text", text: "Response" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }));

    const agent = createAgent({ model, systemPrompt: "Test", tools: {}, logger });
    await agent.run("Hello");

    expect(logger.info).toHaveBeenCalled();
  });

  it("retries run() on transient errors", async () => {
    let attempts = 0;
    const model = mockModel(async () => {
      attempts++;
      if (attempts < 3) throw new Error("Transient error");
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

  function streamModel(chunks: LanguageModelV4StreamPart[]) {
    return new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
    });
  }

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

  it("returns an 'error' result (does not throw) once output has started", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "partial" },
            { type: "error", error: new Error("Stream error") },
          ],
        }),
      }),
    });

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });

    const events: unknown[] = [];
    for await (const event of agent.stream("Test")) {
      events.push(event);
    }

    const errorEvent = events.find((e) => (e as { type: string }).type === "error");
    expect(errorEvent).toBeDefined();

    const completeEvent = events.find((e) => (e as { type: string }).type === "complete") as
      | { type: "complete"; result: AgentResult }
      | undefined;
    expect(completeEvent?.result.stopReason).toBe("error");
  });
});

describe("createAgent with a context budget", () => {
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
