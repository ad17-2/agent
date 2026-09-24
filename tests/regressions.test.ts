import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createAgent } from "../src/agent/index.js";
import { defineTool } from "../src/tool.js";
import { usage } from "./helpers.js";

// Pre-ai-7 regressions: multimodal history loss and wrong stop reasons.

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("regressions (fixed by the ai 7 rebuild)", () => {
  it("a) turn 2's prompt still carries turn 1's image and text", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(10, 5),
        warnings: [],
      }),
    });

    const agent = createAgent({
      model,
      systemPrompt: "You are a test agent.",
      tools: {},
    });

    await agent.run("turn one", {
      attachments: [
        { type: "image", source: "base64", base64: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    });
    await agent.run("turn two");

    const secondCall = model.doGenerateCalls[1];
    expect(secondCall).toBeDefined();

    const turnOneUserMessage = secondCall!.prompt.find(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("turn one")
    );

    expect(turnOneUserMessage).toBeDefined();

    const content = turnOneUserMessage!.content as Array<{ type: string }>;
    expect(content.some((part) => part.type === "file" || part.type === "image")).toBe(true);
  });

  it("b) a 'length' finish is reported as max_tokens, not max_iterations", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Partial response..." }],
        finishReason: { unified: "length", raw: "length" },
        usage: usage(10, 5),
        warnings: [],
      }),
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
    });

    const result = await agent.run("Test");

    expect(result.stopReason).toBe("max_tokens");
  });

  it("c) a step-capped tool-call run is reported as max_iterations, not end_turn", async () => {
    const echoTool = defineTool({
      description: "Echo the input",
      schema: z.object({ value: z.string() }),
      handler: async ({ value }) => value,
    });

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "echo",
            input: JSON.stringify({ value: "hi" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(10, 5),
        warnings: [],
      }),
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: { echo: echoTool },
      maxIterations: 1,
    });

    const result = await agent.run("Test");

    expect(result.stopReason).toBe("max_iterations");
  });
});
