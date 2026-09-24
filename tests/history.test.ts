import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAgent } from "../src/agent/index.js";
import { HistoryManager } from "../src/agent/history.js";
import { defineTool } from "../src/tool.js";
import type { Message, SerializedHistoryV1 } from "../src/types.js";

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

/** One tool-calling run: [user, assistant(tool-call), tool(result), assistant(text)]. */
function toolCallingModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call++;
      return call % 2 === 1
        ? {
            content: [
              { type: "tool-call", toolCallId: `call-${call}`, toolName: "echo", input: "{}" },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: usage(),
            warnings: [],
          }
        : {
            content: [{ type: "text", text: `answer ${call}` }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: usage(),
            warnings: [],
          };
    },
  });
}

const echo = defineTool({
  description: "Echo",
  schema: z.object({}),
  handler: async () => "echoed",
});

interface AnthropicBody {
  messages: Array<{
    role: "user" | "assistant";
    content: Array<{ type: string; id?: string; tool_use_id?: string }>;
  }>;
}

/** A real Anthropic provider whose fetch captures the request body and answers with a canned reply. */
function capturingAnthropic() {
  const bodies: AnthropicBody[] = [];
  const provider = createAnthropic({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as AnthropicBody);
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
  return { model: provider("claude-sonnet-4-5"), bodies };
}

function assertWellFormed(body: AnthropicBody) {
  expect(body.messages[0]?.role).toBe("user");
  const toolUseIds = new Set<string>();
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) toolUseIds.add(block.id);
      if (block.type === "tool_result") {
        expect(toolUseIds.has(block.tool_use_id ?? "")).toBe(true);
      }
    }
  }
}

describe("history eviction keeps whole turns", () => {
  it.each([2, 3])(
    "maxMessages %i: an evicted tool-calling history replays as a valid Anthropic request",
    async (maxMessages) => {
      const agent = createAgent({
        model: toolCallingModel(),
        systemPrompt: "Test",
        tools: { echo },
        conversation: { maxMessages },
      });
      await agent.run("first");
      const exported = agent.exportHistory();

      expect(exported.messages[0]?.role).toBe("user");
      // the newest turn (4 messages) exceeds maxMessages, so it is kept whole
      expect(exported.messages).toHaveLength(4);

      const { model, bodies } = capturingAnthropic();
      const replay = createAgent({ model, systemPrompt: "Test", tools: { echo } });
      replay.importHistory(exported);
      await replay.run("second");

      expect(bodies).toHaveLength(1);
      assertWellFormed(bodies[0]!);
      expect(bodies[0]!.messages.some((m) => m.content.some((b) => b.type === "tool_result"))).toBe(
        true
      );
    }
  );

  it("evicts the oldest whole turn once a newer one fits", async () => {
    const agent = createAgent({
      model: toolCallingModel(),
      systemPrompt: "Test",
      tools: { echo },
      conversation: { maxMessages: 5 },
    });
    await agent.run("first");
    await agent.run("second");

    const { messages } = agent.exportHistory();
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ role: "user", content: "second" });
  });

  it("drops leading messages that precede the first user message on import", () => {
    const history = new HistoryManager({ maxMessages: 20, ttlMs: 1000 });
    const messages: Message[] = [
      { role: "assistant", content: "orphan" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    history.import({ version: 2, messages, exportedAt: Date.now() });

    expect(history.get()).toEqual(messages.slice(1));
  });
});

describe("v1 import", () => {
  it("keeps text blocks and drops tool-use/tool-result blocks", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      }),
    });
    const v1: SerializedHistoryV1 = {
      version: 1,
      messages: [
        { role: "user", content: "look it up" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "t1", name: "lookup", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here" },
            { type: "text", text: "it is." },
          ],
        },
      ],
      exportedAt: Date.now(),
    };

    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });
    agent.importHistory(v1);
    await agent.run("next");

    const prompt = model.doGenerateCalls[0]!.prompt.filter((m) => m.role !== "system");
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(JSON.stringify(prompt)).not.toContain("tool_use");
    expect(JSON.stringify(prompt)).not.toContain("tool_result");
    expect(JSON.stringify(prompt)).toContain("Looking.");
    expect(prompt[2]?.content).toEqual([{ type: "text", text: "Here\nit is." }]);
  });
});

describe("history import version check", () => {
  it("rejects an unknown version and names it", () => {
    const history = new HistoryManager({ maxMessages: 20, ttlMs: 60_000 });
    const future = JSON.parse('{"version":3,"messages":[],"exportedAt":0}');
    expect(() => history.import(future)).toThrow("Unsupported history version: 3");
  });
});
