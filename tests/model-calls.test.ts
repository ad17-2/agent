import { describe, it, expect, afterEach } from "vitest";
import { APICallError, customProvider } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import { createAgent } from "../src/agent/index.js";
import type { Message } from "../src/types.js";
import { usage } from "./helpers.js";

function textResult(text: string, inputTokens = 10) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(inputTokens),
    warnings: [],
  };
}

function overloaded() {
  return new APICallError({
    message: "overloaded",
    url: "https://api.example",
    requestBodyValues: {},
    statusCode: 529,
    isRetryable: true,
  });
}

/** Three turns with a tool call each, so there is history to summarise and content to prune. */
function history(): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < 3; i++) {
    messages.push({ role: "user", content: `question ${i}` });
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: "lookup", input: { i } }],
    });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${i}`,
          toolName: "lookup",
          output: { type: "text", value: `result ${i}` },
        },
      ],
    });
  }
  return messages;
}

describe("summariser retry layer", () => {
  it("a custom summarize.model goes through the package retry only: maxAttempts 1 means one call", async () => {
    const summarizer = new MockLanguageModelV4({
      doGenerate: async () => {
        throw overloaded();
      },
    });
    const agent = createAgent({
      model: new MockLanguageModelV4({ doGenerate: async () => textResult("ok") }),
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 1 },
      context: { maxInputTokens: 1, summarize: { model: summarizer, keepRecentTurns: 1 } },
    });
    agent.importHistory({ version: 2, messages: history(), exportedAt: Date.now() });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR" });
    expect(summarizer.doGenerateCalls).toHaveLength(1);
  }, 15_000);

  it("the agent model as summariser is not retried by the SDK on top of the package retry", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw overloaded();
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      retry: { maxAttempts: 1 },
      context: { maxInputTokens: 1, summarize: { keepRecentTurns: 1 } },
    });
    agent.importHistory({ version: 2, messages: history(), exportedAt: Date.now() });

    await expect(agent.run("go")).rejects.toMatchObject({ code: "API_ERROR" });
    expect(model.doGenerateCalls).toHaveLength(1);
  }, 15_000);
});

describe("string model ids", () => {
  afterEach(() => {
    globalThis.AI_SDK_DEFAULT_PROVIDER = undefined;
  });

  it("resolve per call, so a global provider set after createAgent is used", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => textResult("from mock") });
    const agent = createAgent({ model: "mock-model", systemPrompt: "Test", tools: {} });

    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: { "mock-model": model },
    });
    const result = await agent.run("go");

    expect(result.message).toBe("from mock");
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("concurrent runs", () => {
  it("keep trimForStep calibration per run, so a small run does not make an overlapping large run prune", async () => {
    let releaseA: () => void = () => {};
    const aStep0Started = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++;
        if (call === 1) {
          // run A, step 0: a tool call measured at 1000 input tokens (~4 chars/token); held until B finishes
          await aStep0Started;
          return {
            content: [
              { type: "tool-call" as const, toolCallId: "a-1", toolName: "lookup", input: "{}" },
            ],
            finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
            usage: usage(1000),
            warnings: [],
          };
        }
        return textResult("done", 1000);
      },
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {
        lookup: defineTool({
          description: "lookup",
          schema: z.object({}),
          handler: async () => "x",
        }),
      },
      context: { maxInputTokens: 3000 },
    });
    agent.importHistory({ version: 2, messages: history(), exportedAt: Date.now() });

    const runA = agent.run("a".repeat(4000));
    await new Promise((r) => setTimeout(r, 10));
    await agent.run("b");
    releaseA();
    await runA;

    const aStep1 = model.doGenerateCalls[2]!;
    expect(JSON.stringify(aStep1.prompt)).toContain("aaaa");
    expect(JSON.stringify(aStep1.prompt)).toContain("call-0");
  });
});
