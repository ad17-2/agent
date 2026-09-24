import { describe, it, expect, vi, afterEach } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import type { AgentEvent } from "../src/types.js";
import { collect, usage } from "./helpers.js";

/** Behaves like a real HTTP call: never resolves on its own, rejects with the signal's reason once aborted. */
function hangingModel() {
  return new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }),
  });
}

/** Streams one text delta every few ms until the signal fires, then errors like an aborted fetch body. */
function tickingStreamModel(counters: { pulls: number }) {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "1" });
        },
        async pull(controller) {
          counters.pulls++;
          await new Promise((r) => setTimeout(r, 5));
          if (abortSignal?.aborted) {
            controller.error(abortSignal.reason);
            return;
          }
          controller.enqueue({ type: "text-delta", id: "1", delta: "x" });
        },
      }),
    }),
  });
}

describe("in-flight abort and timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("run(): a run timeout is reported as timeout without a retry backoff, and calls onError({ phase: 'timeout' })", async () => {
    const onError = vi.fn();
    const model = hangingModel();
    const agent = createAgent({ model, systemPrompt: "Test", tools: {}, onError });

    const started = Date.now();
    const result = await agent.run("go", { timeoutMs: 20 });

    expect(result.stopReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(500);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: "timeout" });
  });

  it("run(): a caller abort is reported as aborted without a retry backoff and without onError", async () => {
    const onError = vi.fn();
    const model = hangingModel();
    const agent = createAgent({ model, systemPrompt: "Test", tools: {}, onError });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const started = Date.now();
    const result = await agent.run("go", { abortSignal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(500);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("run(): an API error whose message says 'timed out' is still an API_ERROR", async () => {
    const onError = vi.fn();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream request timed out");
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      onError,
      retry: { maxAttempts: 1 },
    });

    await expect(agent.run("go")).rejects.toMatchObject({
      code: "API_ERROR",
      message: "upstream request timed out",
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: "api" });
  });

  it("stream(): a caller abort mid-stream ends with stopReason aborted, no error event, no onError", async () => {
    const onError = vi.fn();
    const counters = { pulls: 0 };
    const model = tickingStreamModel(counters);
    const agent = createAgent({ model, systemPrompt: "Test", tools: {}, onError });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const event of agent.stream("go", { abortSignal: controller.signal })) {
      events.push(event);
      if (events.filter((e) => e.type === "text-delta").length === 2) controller.abort();
    }

    expect(events.map((e) => e.type)).not.toContain("error");
    expect(events.at(-1)).toMatchObject({ type: "complete", result: { stopReason: "aborted" } });
    expect(onError).not.toHaveBeenCalled();
  });

  it("stream(): a run timeout mid-stream ends with stopReason timeout and onError({ phase: 'timeout' })", async () => {
    const onError = vi.fn();
    const model = tickingStreamModel({ pulls: 0 });
    const agent = createAgent({ model, systemPrompt: "Test", tools: {}, onError });

    const events = await collect(agent.stream("go", { timeoutMs: 30 }));

    expect(events.map((e) => e.type)).not.toContain("error");
    expect(events.at(-1)).toMatchObject({ type: "complete", result: { stopReason: "timeout" } });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: "timeout" });
  });

  it("stream(): breaking out of for-await cancels the model call and leaves history untouched", async () => {
    const counters = { pulls: 0 };
    const model = tickingStreamModel(counters);
    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });

    let deltas = 0;
    for await (const event of agent.stream("go")) {
      if (event.type === "text-delta" && ++deltas === 2) break;
    }

    await new Promise((r) => setTimeout(r, 30));
    const pullsAfterBreak = counters.pulls;
    await new Promise((r) => setTimeout(r, 50));

    expect(counters.pulls).toBe(pullsAfterBreak);
    expect(agent.exportHistory().messages).toEqual([]);
  });

  it("stream(): breaking right after the start event still clears the run timer", async () => {
    vi.useFakeTimers();
    const model = tickingStreamModel({ pulls: 0 });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      timeout: { totalMs: 60_000 },
    });

    for await (const event of agent.stream("go")) {
      expect(event.type).toBe("start");
      break;
    }

    expect(vi.getTimerCount()).toBe(0);
  });

  it("run(): timeoutMs 0 means no timeout", async () => {
    const onError = vi.fn();
    const model = hangingModel();
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      timeout: { totalMs: 20 },
      onError,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await agent.run("go", { timeoutMs: 0, abortSignal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(onError).not.toHaveBeenCalled();
  });

  it("run(): a tool cut off by the run timeout is reported once, as the timeout, not also as a tool error", async () => {
    const onError = vi.fn();
    const ignoresSignal = defineTool({
      description: "never checks its signal",
      schema: z.object({}),
      handler: () => new Promise(() => {}),
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call", toolCallId: "t1", toolName: "slow", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(),
        warnings: [],
      }),
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { slow: ignoresSignal },
      onError,
    });

    const result = await agent.run("go", { timeoutMs: 30 });

    expect(result.stopReason).toBe("timeout");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: "timeout" });
  });

  it("leaves no timer behind after a run that finishes before its timeout", async () => {
    vi.useFakeTimers();
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      }),
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      timeout: { totalMs: 60_000 },
    });

    const result = await agent.run("go");

    expect(result.stopReason).toBe("end_turn");
    expect(vi.getTimerCount()).toBe(0);
  });
});
