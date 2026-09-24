import { describe, it, expect } from "vitest";
import { z } from "zod";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import { collect, usage } from "./helpers.js";

function apiError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://api.example",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

const textChunks: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: "Hello" },
  { type: "text-end", id: "1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
];

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
        if (call === 2) throw apiError(529);
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
        throw apiError(503);
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
        if (call === 1) throw apiError(503);
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
                    { type: "error", error: apiError(529) },
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

describe("retry config defaults", () => {
  it("an explicit undefined maxAttempts falls back to the default 3, not forever", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++;
        if (call <= 3) throw apiError(529);
        return {
          content: [{ type: "text", text: "late" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(),
          warnings: [],
        };
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: undefined, initialDelayMs: 1 },
    });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR" });
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("an explicit undefined retryOn falls back to the default predicate", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError(529);
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { retryOn: undefined, initialDelayMs: 1 },
    });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR", message: "HTTP 529" });
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("does not retry an error the provider marks non-retryable (400)", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError(400);
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { initialDelayMs: 1 },
    });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR", message: "HTTP 400" });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("retries an error the provider marks retryable (529)", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++;
        if (call === 1) throw apiError(529);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(),
          warnings: [],
        };
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { initialDelayMs: 1 },
    });

    const result = await agent.run("go");

    expect(result.message).toBe("ok");
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});

describe("stream retry boundary", () => {
  it("cancels a failed attempt's stream before retrying", async () => {
    let call = 0;
    let cancels = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call++;
        if (call > 1) return { stream: simulateReadableStream({ chunks: textChunks }) };
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "error", error: apiError(529) });
            },
            cancel() {
              cancels++;
            },
          }),
        };
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 2, initialDelayMs: 1 },
    });

    const events = await collect(agent.stream("go"));

    expect(events.find((e) => e.type === "complete")).toMatchObject({
      result: { message: "Hello", stopReason: "end_turn" },
    });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(cancels).toBe(1);
  });

  it("anthropic: an overloaded_error after message_start (before any content) is retried", async () => {
    const sse = (events: Array<{ type: string } & Record<string, unknown>>) =>
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const messageStart = {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    };
    const bodies = [
      sse([
        messageStart,
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
      sse([
        messageStart,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ]),
    ];
    let fetches = 0;
    const fetch: typeof globalThis.fetch = async () =>
      new Response(bodies[fetches++], {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const anthropic = createAnthropic({ apiKey: "test-key", fetch });
    const agent = createAgent({
      model: anthropic("claude-sonnet-5"),
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 2, initialDelayMs: 1 },
    });

    const events = await collect(agent.stream("go"));

    expect(events.map((e) => e.type)).not.toContain("error");
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(1);
    expect(events.find((e) => e.type === "complete")).toMatchObject({
      result: { message: "Hello", stopReason: "end_turn" },
    });
    expect(fetches).toBe(2);
  });
});
