import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool } from "./tool.js";

describe("defineTool", () => {
  it("creates a tool with description and schema", () => {
    const tool = defineTool({
      description: "Add two numbers",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      handler: async ({ a, b }) => ({ result: a + b }),
    });

    expect(tool.description).toBe("Add two numbers");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.execute).toBeInstanceOf(Function);
  });

  it("executes handler with parsed input", async () => {
    const tool = defineTool({
      description: "Greet user",
      schema: z.object({
        name: z.string(),
      }),
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    const result = await tool.execute!({ name: "World" }, {
      toolCallId: "test-id",
      abortSignal: undefined,
      messages: [],
    });

    expect(result).toBe("Hello, World!");
  });

  it("passes abort signal to handler via context", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const tool = defineTool({
      description: "Check signal",
      schema: z.object({}),
      handler: async (_, ctx) => {
        receivedSignal = ctx.signal;
        return "done";
      },
    });

    await tool.execute!({}, {
      toolCallId: "test-id",
      abortSignal: controller.signal,
      messages: [],
    });

    expect(receivedSignal).toBe(controller.signal);
  });
});
