import { describe, it, expect } from "vitest";
import { z } from "zod";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import type { AgentEvent } from "../src/types.js";

function usage(inputTokens = 10, outputTokens = 20) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

const textChunks: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: "Hello" },
  { type: "text-end", id: "1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
];

async function collect(events: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("retry is per model call", () => {
  it("runs a tool exactly once when step 2 fails transiently, and counts only successful usage", async () => {
    let handlerCalls = 0;
    const echo = defineTool({
      description: "Echo",
      schema: z.object({}),
      handler: async () => {
        handlerCalls++;
        return "echoed";
      },
    });

    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++;
        if (call === 1) {
          return {
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "echo", input: "{}" }],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: usage(10, 5),
            warnings: [],
          };
        }
        if (call === 2) throw new Error("Transient error");
        return {
          content: [{ type: "text", text: "Success" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(30, 7),
          warnings: [],
        };
      },
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { echo },
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });
    const result = await agent.run("go");

    expect(result.message).toBe("Success");
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(handlerCalls).toBe(1);
    expect(result.toolsCalled).toHaveLength(1);
    expect(result.iterations).toBe(2);
    expect(result.usage.inputTokens).toBe(40);
    expect(result.usage.outputTokens).toBe(12);
  });

  it("gives up after maxAttempts and throws API_ERROR", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("still failing");
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 2, initialDelayMs: 1 },
    });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR" });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("honours retryOn", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("fatal");
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 3, initialDelayMs: 1, retryOn: (e) => !e.message.includes("fatal") },
    });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR" });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("stream: a doStream failure before the first chunk is retried and completes without an error event", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call++;
        if (call === 1) throw new Error("connect failed");
        return { stream: simulateReadableStream({ chunks: textChunks }) };
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });

    const events = await collect(agent.stream("go"));

    expect(events.map((e) => e.type)).not.toContain("error");
    const complete = events.find((e) => e.type === "complete");
    expect(complete).toMatchObject({ result: { message: "Hello", stopReason: "end_turn" } });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("stream: an error part arriving before any content is retried", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call++;
        return {
          stream: simulateReadableStream({
            chunks:
              call === 1
                ? [
                    { type: "stream-start", warnings: [] },
                    { type: "error", error: new Error("overloaded") },
                  ]
                : textChunks,
          }),
        };
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });

    const events = await collect(agent.stream("go"));

    expect(events.map((e) => e.type)).not.toContain("error");
    expect(events.find((e) => e.type === "complete")).toMatchObject({
      result: { message: "Hello", stopReason: "end_turn" },
    });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("stream: is not retried once content has been delivered", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "partial" },
            { type: "error", error: new Error("mid-stream") },
          ],
        }),
      }),
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });

    const events = await collect(agent.stream("go"));

    expect(events.map((e) => e.type)).toContain("error");
    expect(events.find((e) => e.type === "complete")).toMatchObject({
      result: { stopReason: "error" },
    });
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
