import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { estimateTokens, trimForStep, summarizeHistory } from "../src/context.js";
import type { ContextConfig, Message } from "../src/types.js";

function usage(inputTokens = 10, outputTokens = 5) {
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

type PrepareStepOptions = Parameters<ReturnType<typeof trimForStep>>[0];
type ResponseMessages = PrepareStepOptions["responseMessages"];

function prepareStepOptions(
  messages: ModelMessage[],
  stepNumber: number,
  overrides: Partial<PrepareStepOptions> = {}
): PrepareStepOptions {
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
    ...overrides,
  };
}

/** A completed step whose only field trimForStep reads is usage.inputTokens. */
function stepWithInputTokens(inputTokens: number): PrepareStepOptions["steps"][number] {
  return { usage: { inputTokens } } as unknown as PrepareStepOptions["steps"][number];
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

  it("calibrates chars/token from the previous step's own prompt and measured inputTokens", async () => {
    // step 0's prompt is ~420 chars and the model measured 420 tokens for it (1 char/token).
    // step 1 adds a 2000-char response. Calibrated: ~2420 tokens > 1000 budget, so prune.
    // Dividing step 1's chars by step 0's tokens (the old bug) gives ~5.8 chars/token and
    // ~420 tokens, and the raw chars/4 default gives ~605: both stay under budget.
    const cfg: ContextConfig = { maxInputTokens: 1000 };
    const prepareStep = trimForStep(cfg);
    const history: ModelMessage[] = [
      { role: "user", content: "a".repeat(300) },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c0", toolName: "lookup", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c0",
            toolName: "lookup",
            output: { type: "text", value: "b".repeat(20) },
          },
        ],
      },
    ];
    const initialMessages = [...history, { role: "user", content: "now" } as const];
    const responseMessages: ResponseMessages = [{ role: "assistant", content: "r".repeat(2000) }];

    const step0 = await prepareStep(
      prepareStepOptions(initialMessages, 0, { initialMessages, responseMessages: [] })
    );
    expect(step0).toEqual({});

    const step1 = await prepareStep(
      prepareStepOptions([...initialMessages, ...responseMessages], 1, {
        initialMessages,
        responseMessages,
        steps: [stepWithInputTokens(420)],
      })
    );
    expect(step1?.messages).toBeDefined();
    expect(JSON.stringify(step1?.messages)).not.toContain("tool-call");
  });

  it("resets calibration per run", async () => {
    const cfg: ContextConfig = { maxInputTokens: 150 };
    const prepareStep = trimForStep(cfg);
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(300) },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c0", toolName: "lookup", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c0",
            toolName: "lookup",
            output: { type: "text", value: "b" },
          },
        ],
      },
      { role: "user", content: "now" },
    ];

    await prepareStep(prepareStepOptions(messages, 0));
    const pruned = await prepareStep(
      prepareStepOptions(messages, 1, { steps: [stepWithInputTokens(400)] })
    );
    expect(pruned?.messages).toBeDefined();

    // a fresh run (stepNumber 0) must start from the default ratio again: under budget, no pruning
    const fresh = await prepareStep(prepareStepOptions(messages, 0));
    expect(fresh).toEqual({});
  });

  it("never touches the current run's messages, only history before this run's user message", async () => {
    const cfg: ContextConfig = { maxInputTokens: 1 };
    const prepareStep = trimForStep(cfg);
    const history = buildTurns(2) as ModelMessage[];
    const runUser: ModelMessage = { role: "user", content: "current question" };
    const runResponses: ResponseMessages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking about it" },
          { type: "tool-call", toolCallId: "run-1", toolName: "lookup", input: { q: 1 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "run-1",
            toolName: "lookup",
            output: { type: "text", value: "run result" },
          },
        ],
      },
    ];
    const initialMessages = [...history, runUser];
    const messages = [...initialMessages, ...runResponses];

    const result = await prepareStep(
      prepareStepOptions(messages, 1, {
        initialMessages,
        responseMessages: runResponses,
      })
    );

    expect(result?.messages).toBeDefined();
    const kept = result?.messages ?? [];
    expect(kept.slice(-3)).toEqual([runUser, ...runResponses]);
    expect(JSON.stringify(kept.slice(0, -3))).not.toContain("tool-call");
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
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: "Summary of earlier conversation: earlier turns summarized",
    });
    expect(result.usage.inputTokens).toBe(10);

    // the kept turns must still contain matched tool-call/tool-result pairs, never split
    const kept = result.messages.slice(1);
    expect(kept[0]).toMatchObject({ role: "user", content: "question 4" });
    expect(kept[1]).toMatchObject({ role: "assistant" });
    expect(kept[2]).toMatchObject({ role: "tool" });
    const toolCallId = (kept[1] as { content: Array<{ toolCallId: string }> }).content[0]
      ?.toolCallId;
    const resultToolCallId = (kept[2] as { content: Array<{ toolCallId: string }> }).content[0]
      ?.toolCallId;
    expect(toolCallId).toBe(resultToolCallId);
  });
});

describe("summarizeHistory attachments", () => {
  it("replaces file and image parts with a short placeholder in the summariser prompt", async () => {
    const base64 = "A".repeat(20_000);
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "file", data: base64, mediaType: "image/png" },
          { type: "file", data: base64, mediaType: "text/csv", filename: "data.csv" },
          { type: "image", image: base64, mediaType: "image/jpeg" },
          { type: "text", text: "what is in these?" },
        ],
      },
      { role: "assistant", content: "two files and a picture" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "welcome" },
    ];
    const model = summarizeModel();
    const cfg: ContextConfig = { maxInputTokens: 1, summarize: { keepRecentTurns: 1 } };

    await summarizeHistory(history, cfg, model);

    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt.length).toBeLessThan(2_000);
    expect(prompt).not.toContain("AAAA");
    expect(prompt).toContain("image/png");
    expect(prompt).toContain("text/csv");
    expect(prompt).toContain("data.csv");
    expect(prompt).toContain("image/jpeg");
    expect(prompt).toContain("what is in these?");
  });
});
