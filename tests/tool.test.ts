import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import { executeOptions } from "./helpers.js";

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

    const result = await tool.execute!({ name: "World" }, executeOptions("test-id"));

    expect(result).toBe("Hello, World!");
  });

  it("passes abort signal to handler via context", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const tool = defineTool({
      description: "Check signal",
      schema: z.object({}),
      handler: async (_, ctx) => {
        receivedSignal = ctx.abortSignal;
        return "done";
      },
    });

    await tool.execute!({}, executeOptions("test-id", controller.signal));

    expect(receivedSignal).toBe(controller.signal);
  });

  it("passes toolCallId to handler via context", async () => {
    let receivedToolCallId: string | undefined;

    const tool = defineTool({
      description: "Check toolCallId",
      schema: z.object({}),
      handler: async (_, ctx) => {
        receivedToolCallId = ctx.toolCallId;
        return "done";
      },
    });

    await tool.execute!({}, executeOptions("my-tool-call-123"));

    expect(receivedToolCallId).toBe("my-tool-call-123");
  });

  it("calls onError handler when tool throws", async () => {
    const onError = vi.fn().mockReturnValue({ error: "handled" });

    const tool = defineTool({
      description: "Failing tool",
      schema: z.object({ value: z.number() }),
      handler: async () => {
        throw new Error("Tool failed");
      },
      onError,
    });

    const result = await tool.execute!({ value: 42 }, executeOptions("error-test"));

    expect(onError).toHaveBeenCalledWith({
      error: expect.any(Error),
      input: { value: 42 },
      toolCallId: "error-test",
    });
    expect(result).toEqual({ error: "handled" });
  });

  it("propagates error when no onError handler", async () => {
    const tool = defineTool({
      description: "Failing tool",
      schema: z.object({}),
      handler: async () => {
        throw new Error("Unhandled error");
      },
    });

    await expect(tool.execute!({}, executeOptions("test"))).rejects.toThrow("Unhandled error");
  });

  it("carries timeoutMs for agent/tool-wrapper.ts to enforce, without racing it itself", async () => {
    const tool = defineTool({
      description: "Slow tool",
      schema: z.object({}),
      handler: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "completed";
      },
      timeoutMs: 5,
    });

    expect(tool.timeoutMs).toBe(5);

    const result = await tool.execute!({}, executeOptions("fast-test"));

    expect(result).toBe("completed");
  });

  it("onError can return async value", async () => {
    const tool = defineTool({
      description: "Async error handler",
      schema: z.object({}),
      handler: async () => {
        throw new Error("Failed");
      },
      onError: async ({ error }) => {
        await new Promise((r) => setTimeout(r, 10));
        return { recovered: true, message: error.message };
      },
    });

    const result = await tool.execute!({}, executeOptions("async-error"));

    expect(result).toEqual({ recovered: true, message: "Failed" });
  });
});
