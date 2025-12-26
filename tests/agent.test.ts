import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { createAgent } from "../src/agent.js";
import { defineTool } from "../src/tool.js";
import { AgentError } from "../src/errors.js";
import type { AgentResult, SerializedHistory } from "../src/types.js";

vi.mock("ai", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

import { generateText, streamText } from "ai";
const mockGenerateText = vi.mocked(generateText);
const mockStreamText = vi.mocked(streamText);

const mockModel = { modelId: "test-model" } as Parameters<typeof createAgent>[0]["model"];

type ExecuteFn = (args: unknown, opts: unknown) => Promise<unknown>;
type StepFinishFn = (data: {
  toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>;
  toolResults: Array<{ output: unknown }>;
  text: string;
}) => void;

const createMockResult = (overrides: {
  text?: string;
  steps?: object[];
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  reasoning?: unknown;
}) =>
  ({
    text: overrides.text ?? "Response",
    steps: overrides.steps ?? [{}],
    finishReason: overrides.finishReason ?? "stop",
    toolCalls: [],
    toolResults: [],
    usage: {
      inputTokens: overrides.usage?.inputTokens ?? 10,
      outputTokens: overrides.usage?.outputTokens ?? 20,
    },
    reasoning: overrides.reasoning,
    content: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    request: {},
    response: {},
    warnings: [],
    providerMetadata: {},
    experimental_providerMetadata: {},
    toDataStreamResponse: () => new Response(),
    pipeDataStreamToResponse: () => {},
    toTextStreamResponse: () => new Response(),
    pipeTextStreamToResponse: () => {},
  }) as unknown as Awaited<ReturnType<typeof generateText>>;

function createMockStreamResult(overrides: {
  textDeltas?: string[];
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: "stop" | "length";
  error?: Error;
}) {
  const textDeltas = overrides.textDeltas ?? ["Hello"];
  const finalText = overrides.text ?? textDeltas.join("");

  async function* mockFullStream() {
    if (overrides.error) {
      throw overrides.error;
    }
    for (const text of textDeltas) {
      yield { type: "text-delta" as const, text };
    }
  }

  return {
    fullStream: mockFullStream(),
    text: Promise.resolve(finalText),
    usage: Promise.resolve(overrides.usage ?? { inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve(overrides.finishReason ?? "stop"),
    steps: Promise.resolve([{}]),
    reasoning: Promise.resolve(undefined),
  } as unknown as ReturnType<typeof streamText>;
}

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an agent with run, stream, clearHistory, exportHistory, importHistory methods", () => {
    const agent = createAgent({
      model: mockModel,
      systemPrompt: "You are helpful.",
      tools: {},
    });

    expect(agent.run).toBeInstanceOf(Function);
    expect(agent.stream).toBeInstanceOf(Function);
    expect(agent.clearHistory).toBeInstanceOf(Function);
    expect(agent.exportHistory).toBeInstanceOf(Function);
    expect(agent.importHistory).toBeInstanceOf(Function);
  });

  it("returns message and usage from generateText result", async () => {
    mockGenerateText.mockResolvedValue(
      createMockResult({
        text: "Hello! How can I help?",
        usage: { inputTokens: 15, outputTokens: 25 },
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "You are helpful.",
      tools: {},
    });

    const result = await agent.run("Hello");

    expect(result.message).toBe("Hello! How can I help?");
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(1);
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(25);
    expect(result.usage.totalTokens).toBe(40);
  });

  it("reports max_iterations when finish reason is length", async () => {
    mockGenerateText.mockResolvedValue(
      createMockResult({
        text: "Partial response...",
        steps: [{}, {}, {}],
        finishReason: "length",
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    const result = await agent.run("Test");

    expect(result.stopReason).toBe("max_iterations");
  });

  it("calls onToolCall and onToolResult callbacks", async () => {
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const greetTool = defineTool({
      description: "Greet someone",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    mockGenerateText.mockImplementation(async (options) => {
      const tools = options.tools as Record<string, { execute?: ExecuteFn }>;
      if (tools?.greet?.execute) {
        await tools.greet.execute({ name: "World" }, { toolCallId: "call-1" });
      }

      const onStepFinish = options.onStepFinish as StepFinishFn | undefined;
      if (onStepFinish) {
        onStepFinish({
          toolCalls: [{ toolName: "greet", toolCallId: "call-1", input: { name: "World" } }],
          toolResults: [{ output: "Hello, World!" }],
          text: "",
        });
      }

      return createMockResult({ text: "I greeted World!" });
    });

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: { greet: greetTool },
      onToolCall,
      onToolResult,
    });

    await agent.run("Greet World");

    expect(onToolCall).toHaveBeenCalledWith("greet", { name: "World" });
    expect(onToolResult).toHaveBeenCalledWith("greet", "Hello, World!");
  });

  it("calls onStart, onStep, and onComplete hooks", async () => {
    const onStart = vi.fn();
    const onStep = vi.fn();
    const onComplete = vi.fn();

    mockGenerateText.mockImplementation(async (options) => {
      const onStepFinish = options.onStepFinish as StepFinishFn | undefined;
      if (onStepFinish) {
        onStepFinish({ toolCalls: [], toolResults: [], text: "Step 1" });
      }
      return createMockResult({ text: "Done" });
    });

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
      onStart,
      onStep,
      onComplete,
    });

    await agent.run("Test input");

    expect(onStart).toHaveBeenCalledWith("Test input");
    expect(onStep).toHaveBeenCalledWith({
      stepIndex: 0,
      toolsCalled: [],
      textGenerated: "Step 1",
    });
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Done",
        stopReason: "end_turn",
      })
    );
  });

  it("calls onError hook when API fails", async () => {
    const onError = vi.fn();

    mockGenerateText.mockRejectedValue(new Error("API error"));

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
      onError,
    });

    await expect(agent.run("Test")).rejects.toThrow(AgentError);
    expect(onError).toHaveBeenCalledWith(expect.any(AgentError), { phase: "api" });
  });

  it("tracks tool call duration", async () => {
    const greetTool = defineTool({
      description: "Greet someone",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => {
        await new Promise((r) => setTimeout(r, 50));
        return `Hello, ${name}!`;
      },
    });

    mockGenerateText.mockImplementation(async (options) => {
      const tools = options.tools as Record<string, { execute?: ExecuteFn }>;
      if (tools?.greet?.execute) {
        await tools.greet.execute({ name: "World" }, { toolCallId: "call-1" });
      }

      const onStepFinish = options.onStepFinish as StepFinishFn | undefined;
      if (onStepFinish) {
        onStepFinish({
          toolCalls: [{ toolName: "greet", toolCallId: "call-1", input: { name: "World" } }],
          toolResults: [{ output: "Hello, World!" }],
          text: "",
        });
      }

      return createMockResult({ text: "Done" });
    });

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: { greet: greetTool },
    });

    const result = await agent.run("Test");

    expect(result.toolsCalled).toHaveLength(1);
    expect(result.toolsCalled[0]!.durationMs).toBeGreaterThan(0);
  });

  it("throws AgentError when aborted before run", async () => {
    const controller = new AbortController();
    controller.abort();

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    await expect(agent.run("Test", { signal: controller.signal })).rejects.toThrow(AgentError);
  });

  it("clears history when clearHistory is called", async () => {
    mockGenerateText.mockResolvedValue(createMockResult({ text: "Response" }));

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    await agent.run("First message");
    agent.clearHistory();
    await agent.run("Second message");

    const lastCall = mockGenerateText.mock.calls[1];
    expect(lastCall).toBeDefined();
    const messages = lastCall![0].messages as Array<{ role: string; content: string }>;

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Second message");
  });

  it("exports and imports history", async () => {
    mockGenerateText.mockResolvedValue(createMockResult({ text: "Response" }));

    const agent1 = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    await agent1.run("Hello");
    const exported = agent1.exportHistory();

    expect(exported.version).toBe(1);
    expect(exported.messages).toHaveLength(2);
    expect(exported.exportedAt).toBeDefined();

    const agent2 = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    agent2.importHistory(exported);
    await agent2.run("World");

    const lastCall = mockGenerateText.mock.calls[1];
    expect(lastCall).toBeDefined();
    const messages = lastCall![0].messages as Array<{ role: string; content: string }>;

    expect(messages).toHaveLength(3);
  });

  it("throws on invalid history version", () => {
    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    const invalidHistory = {
      version: 99 as 1,
      messages: [],
      exportedAt: Date.now(),
    } as SerializedHistory;

    expect(() => agent.importHistory(invalidHistory)).toThrow(AgentError);
  });

  it("uses logger when provided", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockGenerateText.mockResolvedValue(createMockResult({ text: "Response" }));

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
      logger,
    });

    await agent.run("Hello");

    expect(logger.info).toHaveBeenCalled();
  });

  it("retries on transient errors", async () => {
    let attempts = 0;
    mockGenerateText.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("Transient error");
      }
      return createMockResult({ text: "Success" });
    });

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
      retry: {
        maxAttempts: 3,
        initialDelayMs: 10,
      },
    });

    const result = await agent.run("Test");

    expect(result.message).toBe("Success");
    expect(attempts).toBe(3);
  });

  it("includes reasoning in result when extended thinking is enabled", async () => {
    mockGenerateText.mockResolvedValue(
      createMockResult({
        text: "Answer",
        reasoning: [{ text: "Let me think..." }],
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
      thinking: { enabled: true },
    });

    const result = await agent.run("Complex question");

    expect(result.thinking).toBe("Let me think...");
  });
});

describe("agent.stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("yields start event first", async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult({
        textDeltas: ["Hello"],
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    const events: unknown[] = [];
    const generator = agent.stream("Hello");

    for await (const event of generator) {
      events.push(event);
      if (event.type === "complete") break;
    }

    expect(events[0]).toEqual({ type: "start", timestamp: expect.any(Number) });
  });

  it("yields text-delta and text-complete events", async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult({
        textDeltas: ["Hello ", "World"],
        text: "Hello World",
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    const events: unknown[] = [];
    for await (const event of agent.stream("Test")) {
      events.push(event);
      if (event.type === "complete") break;
    }

    const textDeltas = events.filter((e: unknown) => (e as { type: string }).type === "text-delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text-delta", content: "Hello " });
    expect(textDeltas[1]).toEqual({ type: "text-delta", content: "World" });

    const textComplete = events.find(
      (e: unknown) => (e as { type: string }).type === "text-complete"
    );
    expect(textComplete).toEqual({ type: "text-complete", content: "Hello World" });
  });

  it("yields complete event with full result", async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult({
        textDeltas: ["Done"],
        text: "Done",
        usage: { inputTokens: 10, outputTokens: 5 },
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    let result: AgentResult | undefined;
    for await (const event of agent.stream("Test")) {
      if (event.type === "complete") {
        result = event.result;
        break;
      }
    }

    expect(result).toBeDefined();
    expect(result!.message).toBe("Done");
    expect(result!.usage.inputTokens).toBe(10);
    expect(result!.usage.outputTokens).toBe(5);
    expect(result!.stopReason).toBe("end_turn");
  });

  it("yields error event on failure", async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult({
        error: new Error("Stream error"),
      })
    );

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "Test",
      tools: {},
    });

    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of agent.stream("Test")) {
        events.push(event);
      }
    }).rejects.toThrow();

    const errorEvent = events.find((e: unknown) => (e as { type: string }).type === "error");
    expect(errorEvent).toBeDefined();
  });
});
