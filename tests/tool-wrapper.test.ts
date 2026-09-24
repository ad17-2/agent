import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import { wrapToolsWithCallbacks } from "../src/agent/tool-wrapper.js";
import { executeOptions } from "./helpers.js";

describe("wrapToolsWithCallbacks", () => {
  it("aborts the handler's signal when the per-tool timeout elapses", async () => {
    let sawAbort = false;

    const cooperative = defineTool({
      description: "Cooperative tool",
      schema: z.object({}),
      handler: (_input, ctx) => {
        return new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("cancelled"));
          });
        });
      },
      timeoutMs: 20,
    });

    const wrapped = wrapToolsWithCallbacks({ cooperative }, undefined, {});

    await expect(wrapped.cooperative!.execute!({}, executeOptions("t1"))).rejects.toThrow();

    expect(sawAbort).toBe(true);
  });

  it("still bounds the call when a handler ignores the abort signal, so the run never hangs", async () => {
    let sawAbort = false;

    const uncooperative = defineTool({
      description: "Ignores its signal",
      schema: z.object({}),
      handler: async (_input, ctx) => {
        ctx.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return "done";
      },
      timeoutMs: 20,
    });

    const wrapped = wrapToolsWithCallbacks({ uncooperative }, undefined, {});

    await expect(wrapped.uncooperative!.execute!({}, executeOptions("t1"))).rejects.toThrow();

    expect(sawAbort).toBe(true);
  });

  it("falls back to the agent-level toolTimeoutMs when the tool has none of its own", async () => {
    let sawAbort = false;

    const slow = defineTool({
      description: "Slow tool",
      schema: z.object({}),
      handler: async (_input, ctx) => {
        ctx.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return "done";
      },
    });

    const wrapped = wrapToolsWithCallbacks({ slow }, undefined, {}, { toolTimeoutMs: 20 });

    await expect(wrapped.slow!.execute!({}, executeOptions("t1"))).rejects.toThrow();

    expect(sawAbort).toBe(true);
  });

  it("does not abort when no timeout is configured", async () => {
    let sawAbort = false;

    const fast = defineTool({
      description: "Fast tool",
      schema: z.object({}),
      handler: async (_input, ctx) => {
        ctx.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        return "done";
      },
    });

    const wrapped = wrapToolsWithCallbacks({ fast }, undefined, {});

    await wrapped.fast!.execute!({}, executeOptions("t1"));

    expect(sawAbort).toBe(false);
  });

  it("invokes onToolCall and onToolResult around the handler", async () => {
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const greet = defineTool({
      description: "Greet",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    const wrapped = wrapToolsWithCallbacks({ greet }, undefined, { onToolCall, onToolResult });

    const result = await wrapped.greet!.execute!({ name: "World" }, executeOptions("call-1"));

    expect(result).toBe("Hello, World!");
    expect(onToolCall).toHaveBeenCalledWith("greet", { name: "World" });
    expect(onToolResult).toHaveBeenCalledWith("greet", "Hello, World!");
  });

  it("still reports a tool's own error when the run signal fires at the same moment", async () => {
    const onError = vi.fn();
    const controller = new AbortController();
    const buggy = defineTool({
      description: "fails on its own",
      schema: z.object({}),
      handler: () => {
        controller.abort(new Error("run timed out"));
        throw new Error("invalid API key");
      },
    });

    const wrapped = wrapToolsWithCallbacks({ buggy }, undefined, { onError });

    await expect(
      wrapped.buggy!.execute!({}, executeOptions("t1", controller.signal))
    ).rejects.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "invalid API key" }), {
      phase: "tool",
      toolName: "buggy",
    });
  });
});
