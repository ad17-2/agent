import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAgent } from "../src/agent/index.js";

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

describe("providerOptions", () => {
  it("deep-merges caller providerOptions with thinking under the same provider key", async () => {
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
      thinking: { enabled: true, budgetTokens: 2048 },
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
        openai: { reasoningEffort: "low" },
      },
    });

    await agent.run("go");

    expect(model.doGenerateCalls[0]!.providerOptions).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 2048 },
        cacheControl: { type: "ephemeral" },
      },
      openai: { reasoningEffort: "low" },
    });
  });

  it("@ai-sdk/anthropic adds the thinking budget to max_tokens, so the 4096/10000 defaults are valid", async () => {
    let body: { max_tokens: number; thinking: { type: string; budget_tokens: number } } | undefined;
    const provider = createAnthropic({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });
    const agent = createAgent({
      model: provider("claude-sonnet-4-5"),
      systemPrompt: "Test",
      tools: {},
      thinking: { enabled: true },
    });

    await agent.run("go");

    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(body?.max_tokens).toBe(4096 + 10000);
  });
});
