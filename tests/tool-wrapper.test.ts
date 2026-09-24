import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import { wrapToolsWithCallbacks } from "../src/agent/tool-wrapper.js";

describe("wrapToolsWithCallbacks", () => {
  it("aborts the handler's signal when the per-tool timeout elapses", async () => {
    let sawAbort = false;

    const cooperative = defineTool({
      description: "Cooperative tool",
      schema: z.object({}),
      handler: (_input, ctx) => {
        return new Promise((resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("cancelled"));
          });
        });
      },
      timeoutMs: 20,
    });

    const wrapped = wrapToolsWithCallbacks({ cooperative }, new Map(), undefined, {});

    await expect(
      wrapped.cooperative!.execute!({}, { toolCallId: "t1", abortSignal: undefined, messages: [] })
    ).rejects.toThrow();

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

    const wrapped = wrapToolsWithCallbacks({ uncooperative }, new Map(), undefined, {});

    await expect(
      wrapped.uncooperative!.execute!({}, { toolCallId: "t1", abortSignal: undefined, messages: [] })
    ).rejects.toThrow();

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

    const wrapped = wrapToolsWithCallbacks({ slow }, new Map(), undefined, {}, { toolTimeoutMs: 20 });

    await expect(
      wrapped.slow!.execute!({}, { toolCallId: "t1", abortSignal: undefined, messages: [] })
    ).rejects.toThrow();

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

    const wrapped = wrapToolsWithCallbacks({ fast }, new Map(), undefined, {});

    await wrapped.fast!.execute!({}, { toolCallId: "t1", abortSignal: undefined, messages: [] });

    expect(sawAbort).toBe(false);
  });

  it("records call duration and invokes onToolCall/onToolResult", async () => {
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const timings = new Map<string, number>();

    const greet = defineTool({
      description: "Greet",
      schema: z.object({ name: z.string() }),
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    const wrapped = wrapToolsWithCallbacks({ greet }, timings, undefined, {
      onToolCall,
      onToolResult,
    });

    const result = await wrapped.greet!.execute!(
      { name: "World" },
      { toolCallId: "call-1", abortSignal: undefined, messages: [] }
    );

    expect(result).toBe("Hello, World!");
    expect(onToolCall).toHaveBeenCalledWith("greet", { name: "World" });
    expect(onToolResult).toHaveBeenCalledWith("greet", "Hello, World!");
    expect(timings.get("call-1")).toBeGreaterThanOrEqual(0);
  });
});
