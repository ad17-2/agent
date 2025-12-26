import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { createAgent } from "./agent.js";
import { defineTool } from "./tool.js";
import { AgentError } from "./errors.js";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return {
    ...original,
    generateText: vi.fn(),
  };
});

import { generateText } from "ai";
const mockGenerateText = vi.mocked(generateText);

const mockModel = { modelId: "test-model" } as Parameters<typeof createAgent>[0]["model"];

const createMockResult = (overrides: {
  text?: string;
  steps?: object[];
  finishReason?: string;
}) => ({
  text: overrides.text ?? "Response",
  steps: overrides.steps ?? [{}],
  finishReason: overrides.finishReason ?? "stop",
  toolCalls: [],
  toolResults: [],
  usage: { inputTokens: 10, outputTokens: 20 },
  content: [],
  reasoning: undefined,
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

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an agent with run and clearHistory methods", () => {
    const agent = createAgent({
      model: mockModel,
      systemPrompt: "You are helpful.",
      tools: {},
    });

    expect(agent.run).toBeInstanceOf(Function);
    expect(agent.clearHistory).toBeInstanceOf(Function);
  });

  it("returns message from generateText result", async () => {
    mockGenerateText.mockResolvedValue(createMockResult({
      text: "Hello! How can I help?",
    }));

    const agent = createAgent({
      model: mockModel,
      systemPrompt: "You are helpful.",
      tools: {},
    });

    const result = await agent.run("Hello");

    expect(result.message).toBe("Hello! How can I help?");
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(1);
  });

  it("reports max_iterations when finish reason is length", async () => {
    mockGenerateText.mockResolvedValue(createMockResult({
      text: "Partial response...",
      steps: [{}, {}, {}],
      finishReason: "length",
    }));

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
      const tools = options.tools as Record<string, { execute?: Function }>;
      if (tools?.greet?.execute) {
        await tools.greet.execute({ name: "World" }, { toolCallId: "call-1" });
      }
      
      const onStepFinish = options.onStepFinish as Function;
      if (onStepFinish) {
        onStepFinish({
          toolCalls: [{ toolName: "greet", toolCallId: "call-1", input: { name: "World" } }],
          toolResults: [{ output: "Hello, World!" }],
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
      const tools = options.tools as Record<string, { execute?: Function }>;
      if (tools?.greet?.execute) {
        await tools.greet.execute({ name: "World" }, { toolCallId: "call-1" });
      }

      const onStepFinish = options.onStepFinish as Function;
      if (onStepFinish) {
        onStepFinish({
          toolCalls: [{ toolName: "greet", toolCallId: "call-1", input: { name: "World" } }],
          toolResults: [{ output: "Hello, World!" }],
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

    await expect(agent.run("Test", { signal: controller.signal })).rejects.toThrow(
      AgentError
    );
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
});
