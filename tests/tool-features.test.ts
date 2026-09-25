import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { defineDynamicTool, defineTool, type ToolContext } from "../src/tool.js";
import { collect, streamModel, textResult, toolCallResult, usage } from "./helpers.js";

const textStep: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: "Done" },
  { type: "text-end", id: "1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
];

function streamedToolStep(toolName: string, deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "call-1", toolName },
    ...deltas.map(
      (delta): LanguageModelV4StreamPart => ({
        type: "tool-input-delta",
        id: "call-1",
        delta,
      })
    ),
    { type: "tool-input-end", id: "call-1" },
    { type: "tool-call", toolCallId: "call-1", toolName, input: deltas.join("") },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage() },
  ];
}

describe("defineTool toModelOutput", () => {
  it("sends the converted output to the model in place of the raw handler result", async () => {
    const received: unknown[] = [];
    const search = defineTool({
      description: "Search",
      schema: z.object({ q: z.string() }),
      handler: async ({ q }) => ({ hits: [q, q], raw: "x".repeat(100) }),
      toModelOutput: (output, { toolCallId, input }) => {
        received.push({ output, toolCallId, input });
        return { type: "text", value: `2 hits for ${input.q}` };
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("search", { q: "cats" }), textResult("done")],
    });
    const agent = createAgent({ model, systemPrompt: "Test", tools: { search } });

    const result = await agent.run("go");

    const prompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(prompt).toContain("2 hits for cats");
    expect(prompt).not.toContain("xxxx");
    expect(received).toEqual([
      {
        output: { hits: ["cats", "cats"], raw: "x".repeat(100) },
        toolCallId: "call-1",
        input: { q: "cats" },
      },
    ]);
    expect(result.toolsCalled[0]?.output).toEqual({ hits: ["cats", "cats"], raw: "x".repeat(100) });
  });
});

describe("defineTool input hooks", () => {
  it("calls onInputStart and onInputAvailable with the tool context on a run", async () => {
    const calls: Array<[string, unknown, ToolContext]> = [];
    const greet = defineTool({
      description: "Greet",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `hi ${name}`,
      onInputStart: (ctx) => {
        calls.push(["start", undefined, ctx]);
      },
      onInputAvailable: (input, ctx) => {
        calls.push(["available", input, ctx]);
      },
    });
    const agent = createAgent({
      model: new MockLanguageModelV4({
        doGenerate: [toolCallResult("greet", { name: "Ann" }), textResult("done")],
      }),
      systemPrompt: "Test",
      tools: { greet },
    });

    await agent.run("go");

    expect(calls).toEqual([
      ["start", undefined, { toolCallId: "call-1", abortSignal: expect.any(AbortSignal) }],
      [
        "available",
        { name: "Ann" },
        { toolCallId: "call-1", abortSignal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it("calls onInputDelta for each streamed input chunk", async () => {
    const deltas: Array<[string, string | undefined]> = [];
    const greet = defineTool({
      description: "Greet",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `hi ${name}`,
      onInputDelta: (delta, ctx) => {
        deltas.push([delta, ctx.toolCallId]);
      },
    });
    const agent = createAgent({
      model: streamModel(streamedToolStep("greet", ['{"name":', '"Ann"}']), textStep),
      systemPrompt: "Test",
      tools: { greet },
    });

    await collect(agent.stream("go"));

    expect(deltas).toEqual([
      ['{"name":', "call-1"],
      ['"Ann"}', "call-1"],
    ]);
  });
});

describe("agent.stream tool input events", () => {
  it("emits tool-input-start and tool-input-delta before tool-call-start", async () => {
    const greet = defineTool({
      description: "Greet",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `hi ${name}`,
    });
    const agent = createAgent({
      model: streamModel(streamedToolStep("greet", ['{"name":', '"Ann"}']), textStep),
      systemPrompt: "Test",
      tools: { greet },
    });

    const events = await collect(agent.stream("go"));

    const inputEvents = events.filter(
      (e) =>
        e.type === "tool-input-start" ||
        e.type === "tool-input-delta" ||
        e.type === "tool-call-start"
    );
    expect(inputEvents).toEqual([
      { type: "tool-input-start", name: "greet", toolCallId: "call-1" },
      { type: "tool-input-delta", toolCallId: "call-1", delta: '{"name":' },
      { type: "tool-input-delta", toolCallId: "call-1", delta: '"Ann"}' },
      { type: "tool-call-start", name: "greet", input: { name: "Ann" }, toolCallId: "call-1" },
    ]);
  });
});

describe("defineDynamicTool in an agent", () => {
  const lookup = defineDynamicTool({
    description: "Look up anything",
    handler: async (input) => ({ echoed: input }),
  });

  it("runs the handler with the raw input and records the call", async () => {
    const agent = createAgent({
      model: new MockLanguageModelV4({
        doGenerate: [toolCallResult("lookup", { key: "a" }), textResult("done")],
      }),
      systemPrompt: "Test",
      tools: { lookup },
    });

    const result = await agent.run("go");

    expect(result.toolsCalled).toEqual([
      {
        name: "lookup",
        input: { key: "a" },
        output: { echoed: { key: "a" } },
        durationMs: expect.any(Number),
      },
    ]);
    expect(result.message).toBe("done");
  });

  it("reports the call through the stream's tool events and step records", async () => {
    const agent = createAgent({
      model: streamModel(streamedToolStep("lookup", ['{"key":"a"}']), textStep),
      systemPrompt: "Test",
      tools: { lookup },
    });

    const events = await collect(agent.stream("go"));

    expect(events).toContainEqual({
      type: "tool-call-start",
      name: "lookup",
      input: { key: "a" },
      toolCallId: "call-1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-call-complete",
        name: "lookup",
        output: { echoed: { key: "a" } },
      })
    );
    const firstStep = events.find((e) => e.type === "step-complete");
    expect(firstStep).toMatchObject({
      toolsCalled: [{ name: "lookup", input: { key: "a" }, output: { echoed: { key: "a" } } }],
    });
  });

  it("enforces its timeoutMs through the agent's tool wrapper", async () => {
    const slow = defineDynamicTool({
      description: "Slow",
      handler: () => new Promise(() => {}),
      timeoutMs: 5,
    });
    const agent = createAgent({
      model: new MockLanguageModelV4({
        doGenerate: [toolCallResult("slow"), textResult("done")],
      }),
      systemPrompt: "Test",
      tools: { slow },
    });

    const result = await agent.run("go");

    expect(result.toolsCalled[0]).toMatchObject({ name: "slow", error: expect.any(String) });
  });
});
