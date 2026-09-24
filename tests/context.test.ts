import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { estimateTokens, trimForStep, summarizeHistory } from "../src/context.js";
import type { ContextConfig, Message } from "../src/types.js";

function usage(inputTokens = 10, outputTokens = 5) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function summarizeModel(text = "summary of earlier turns") {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }),
  });
}

/** Builds `count` turns, each [user, assistant-with-tool-call, tool-result]. */
function buildTurns(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", content: `question ${i}` });
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: "lookup", input: { i } }],
    });
    messages.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `call-${i}`, toolName: "lookup", output: { type: "text", value: `result ${i}` } }],
    });
  }
  return messages;
}

describe("estimateTokens", () => {
  it("estimates chars/4", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "a".repeat(400) }];
    // JSON.stringify wraps the string in quotes, so 402 chars / 4 = 100.5 -> ceil 101
    expect(estimateTokens(messages)).toBe(101);
  });

  it("scales down with a larger charsPerToken calibration", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "a".repeat(800) }];
    expect(estimateTokens(messages, 8)).toBe(Math.ceil(802 / 8));
  });
});

function prepareStepOptions(
  messages: ModelMessage[],
  stepNumber: number
): Parameters<ReturnType<typeof trimForStep>>[0] {
  return {
    messages,
    steps: [],
    stepNumber,
    model: "mock",
    instructions: undefined,
    initialInstructions: undefined,
    initialMessages: messages,
    responseMessages: [],
    toolsContext: {},
    runtimeContext: {},
  };
}

describe("trimForStep", () => {
  it("does nothing under budget", async () => {
    const cfg: ContextConfig = { maxInputTokens: 1_000_000 };
    const prepareStep = trimForStep(cfg);
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

    const result = await prepareStep(prepareStepOptions(messages, 0));

    expect(result).toEqual({});
  });

  it("prunes old tool call/result content once over budget", async () => {
    const cfg: ContextConfig = { maxInputTokens: 1 };
    const prepareStep = trimForStep(cfg);
    const messages = buildTurns(5) as ModelMessage[];

    const result = await prepareStep(prepareStepOptions(messages, 5));

    expect(result?.messages).toBeDefined();
    expect(JSON.stringify(result?.messages)).not.toEqual(JSON.stringify(messages));
  });
});

describe("summarizeHistory", () => {
  it("leaves history untouched when turn count is within keepRecentTurns", async () => {
    const history = buildTurns(2);
    const cfg: ContextConfig = { maxInputTokens: 1, summarize: { keepRecentTurns: 4 } };

    const result = await summarizeHistory(history, cfg, summarizeModel());

    expect(result.messages).toEqual(history);
    expect(result.usage.inputTokens).toBe(0);
  });

  it("summarizes everything but the most recent turns, cutting only at turn boundaries", async () => {
    const history = buildTurns(6); // 6 turns * 3 messages = 18 messages
    const cfg: ContextConfig = { maxInputTokens: 1, summarize: { keepRecentTurns: 2 } };

    const result = await summarizeHistory(history, cfg, summarizeModel("earlier turns summarized"));

    // 1 summary message + last 2 turns (6 messages)
    expect(result.messages).toHaveLength(7);
    expect(result.messages[0]).toMatchObject({ role: "assistant", content: "earlier turns summarized" });
    expect(result.usage.inputTokens).toBe(10);

    // the kept turns must still contain matched tool-call/tool-result pairs, never split
    const kept = result.messages.slice(1);
    expect(kept[0]).toMatchObject({ role: "user", content: "question 4" });
    expect(kept[1]).toMatchObject({ role: "assistant" });
    expect(kept[2]).toMatchObject({ role: "tool" });
    const toolCallId = (kept[1] as { content: Array<{ toolCallId: string }> }).content[0]?.toolCallId;
    const resultToolCallId = (kept[2] as { content: Array<{ toolCallId: string }> }).content[0]?.toolCallId;
    expect(toolCallId).toBe(resultToolCallId);
  });
});
