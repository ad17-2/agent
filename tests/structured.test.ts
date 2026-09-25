import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateStructured, streamStructured } from "../src/structured.js";
import { streamModel, usage } from "./helpers.js";

describe("generateStructured", () => {
  it("returns parsed data matching schema", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ name: "Alice", age: 30 }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(50, 25),
        warnings: [],
      }),
    });

    const result = await generateStructured({ model, schema, prompt: "Extract person info" });

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("sends attachments as `{type:'file', mediaType, data}` parts before the prompt", async () => {
    const schema = z.object({ description: z.string() });

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ description: "A cat" }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(100, 10),
        warnings: [],
      }),
    });

    await generateStructured({
      model,
      schema,
      prompt: "Describe this image",
      attachments: [{ type: "image", source: "base64", base64: "aGVsbG8=", mimeType: "image/png" }],
    });

    const call = model.doGenerateCalls[0];
    expect(call).toBeDefined();

    const userMessage = call!.prompt.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const content = userMessage!.content as Array<{
      type: string;
      mediaType?: string;
      data?: unknown;
    }>;

    expect(content.map((part) => [part.type, part.mediaType])).toEqual([
      ["file", "image/png"],
      ["text", undefined],
    ]);
  });

  it("handles missing usage gracefully", async () => {
    const schema = z.object({ value: z.number() });

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ value: 42 }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const result = await generateStructured({ model, schema, prompt: "Get value" });

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it("passes the abort signal to generateText", async () => {
    const schema = z.object({ done: z.boolean() });
    const controller = new AbortController();

    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        expect(options.abortSignal).toBe(controller.signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ done: true }) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(10, 5),
          warnings: [],
        };
      },
    });

    await generateStructured({ model, schema, prompt: "Check", abortSignal: controller.signal });
  });

  it("passes maxOutputTokens to the model call", async () => {
    const schema = z.object({ text: z.string() });

    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        expect(options.maxOutputTokens).toBe(1000);
        return {
          content: [{ type: "text", text: JSON.stringify({ text: "hello" }) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(10, 5),
          warnings: [],
        };
      },
    });

    await generateStructured({ model, schema, prompt: "Get text", maxOutputTokens: 1000 });
  });
});

function jsonDeltas(...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "t" },
    ...deltas.map((delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t", delta })),
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(40, 12) },
  ];
}

describe("streamStructured", () => {
  it("yields partial objects as JSON deltas arrive, then resolves output and usage", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const model = streamModel(jsonDeltas('{"name":"Al', 'ice","age":', "30}"));

    const result = streamStructured({ model, schema, prompt: "Extract person info" });

    const partials: unknown[] = [];
    for await (const partial of result.partial) partials.push(partial);

    expect(partials).toEqual([{ name: "Al" }, { name: "Alice" }, { name: "Alice", age: 30 }]);
    expect(await result.output).toEqual({ name: "Alice", age: 30 });
    expect(await result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      totalTokens: 52,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("passes attachments, maxOutputTokens and the abort signal to the model call", async () => {
    const schema = z.object({ description: z.string() });
    const controller = new AbortController();
    const model = streamModel(jsonDeltas('{"description":"A cat"}'));

    const result = streamStructured({
      model,
      schema,
      prompt: "Describe this image",
      attachments: [{ type: "image", source: "base64", base64: "aGVsbG8=", mimeType: "image/png" }],
      maxOutputTokens: 500,
      abortSignal: controller.signal,
    });
    await result.output;

    const call = model.doStreamCalls[0]!;
    expect(call.maxOutputTokens).toBe(500);
    expect(call.abortSignal).toBe(controller.signal);
    const userMessage = call.prompt.find((m) => m.role === "user")!;
    expect(userMessage.content.map((part) => part.type)).toEqual(["file", "text"]);
  });

  it("rejects output when the streamed JSON does not match the schema", async () => {
    const schema = z.object({ age: z.number() });
    const model = streamModel(jsonDeltas('{"age":"thirty"}'));

    const result = streamStructured({ model, schema, prompt: "Get age" });

    await expect(result.output).rejects.toThrow();
  });

  it("returns the same promise on every read of output and usage", async () => {
    const result = streamStructured({
      model: streamModel(jsonDeltas('{"age":30}')),
      schema: z.object({ age: z.number() }),
      prompt: "Get age",
    });

    expect(result.output).toBe(result.output);
    expect(result.usage).toBe(result.usage);
    await result.output;
  });

  it("a destructured output that is never awaited does not reject unhandled on invalid JSON, and still rejects when awaited", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { partial, output } = streamStructured({
        model: streamModel(jsonDeltas("{bad")),
        schema: z.object({ a: z.number() }),
        prompt: "p",
      });
      for await (const _ of partial) {
        // drain
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      await expect(output).rejects.toThrow();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
