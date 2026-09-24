import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { generateStructured } from "../src/structured.js";

function usage(inputTokens = 50, outputTokens = 25) {
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
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);
  });

  it("converts image input to a `{type:'file', mediaType, data}` part", async () => {
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
      image: { base64: "aGVsbG8=", mimeType: "image/png" },
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

    expect(content.some((part) => part.type === "file" && part.mediaType === "image/png")).toBe(
      true
    );
    expect(content.every((part) => part.type !== "image")).toBe(true);
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

    await generateStructured({ model, schema, prompt: "Check", signal: controller.signal });
  });

  it("maps maxTokens to the SDK's maxOutputTokens call param", async () => {
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

    await generateStructured({ model, schema, prompt: "Get text", maxTokens: 1000 });
  });
});
