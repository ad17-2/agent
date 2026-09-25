import { describe, it, expect } from "vitest";
import { z } from "zod";
import { hasToolCall, isLoopFinished, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import { textResult, toolCallResult } from "./helpers.js";

const lookup = defineTool({
  description: "Look something up",
  schema: z.object({}),
  handler: async () => "found",
});

const finish = defineTool({
  description: "Finish the task",
  schema: z.object({}),
  handler: async () => "finished",
});

function toolNamesSent(model: MockLanguageModelV4, call: number): string[] {
  return (model.doGenerateCalls[call]?.tools ?? []).map((t) => t.name);
}

describe("stopWhen", () => {
  it("stops the loop when a custom condition fires, with stopReason 'stop_condition'", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("finish"), textResult("never reached")],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { lookup, finish },
      stopWhen: hasToolCall("finish"),
    });

    const result = await agent.run("go");

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.iterations).toBe(1);
    expect(result.stopReason).toBe("stop_condition");
    expect(result.toolsCalled).toEqual([expect.objectContaining({ name: "finish" })]);
  });

  it("accepts an array of conditions and stops on any of them", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult("lookup", {}, "call-1"),
        toolCallResult("finish", {}, "call-2"),
        textResult("never reached"),
      ],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { lookup, finish },
      stopWhen: [hasToolCall("nothing"), hasToolCall("finish")],
    });

    const result = await agent.run("go");

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.stopReason).toBe("stop_condition");
  });

  it("keeps the maxIterations cap when a custom condition never fires", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult("lookup", {}, "call-1"),
        toolCallResult("lookup", {}, "call-2"),
        textResult("past the cap"),
      ],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { lookup },
      maxIterations: 2,
      stopWhen: isLoopFinished(),
    });

    const result = await agent.run("go");

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.stopReason).toBe("max_iterations");
  });
});

describe("prepareStep", () => {
  it("narrows the tools sent to the model per step", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("lookup"), textResult("done")],
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { lookup, finish },
      prepareStep: ({ stepNumber }) => ({
        activeTools: stepNumber === 0 ? ["lookup"] : ["finish"],
      }),
    });

    await agent.run("go");

    expect(toolNamesSent(model, 0)).toEqual(["lookup"]);
    expect(toolNamesSent(model, 1)).toEqual(["finish"]);
  });

  describe("with a context budget", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "old", toolName: "lookup", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old",
            toolName: "lookup",
            output: { type: "text", value: "old result" },
          },
        ],
      },
      { role: "assistant", content: "earlier answer" },
    ];

    function budgetAgent(
      model: MockLanguageModelV4,
      prepareStep: Parameters<typeof createAgent>[0]["prepareStep"]
    ) {
      const agent = createAgent({
        model,
        systemPrompt: "Test",
        tools: { lookup, finish },
        // Summarising is skipped: history has one turn and keepRecentTurns covers it.
        context: { maxInputTokens: 1, summarize: { keepRecentTurns: 4 } },
        prepareStep,
      });
      agent.importHistory({ version: 2, messages: history, exportedAt: Date.now() });
      return agent;
    }

    it("runs after trimming: the hook sees the trimmed messages and the model gets them plus the hook's fields", async () => {
      const model = new MockLanguageModelV4({ doGenerate: [textResult("done")] });
      const seen: ModelMessage[][] = [];
      const agent = budgetAgent(model, ({ messages }) => {
        seen.push(messages);
        return { activeTools: ["finish"] };
      });

      await agent.run("now");

      expect(JSON.stringify(seen[0])).not.toContain("tool-call");
      expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain("tool-call");
      expect(toolNamesSent(model, 0)).toEqual(["finish"]);
    });

    it("sends the hook's own messages when it returns them", async () => {
      const model = new MockLanguageModelV4({ doGenerate: [textResult("done")] });
      const agent = budgetAgent(model, () => ({
        messages: [{ role: "user", content: "replaced by the hook" }],
      }));

      await agent.run("now");

      const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
      expect(prompt).toContain("replaced by the hook");
      expect(prompt).not.toContain("earlier question");
    });
  });
});
