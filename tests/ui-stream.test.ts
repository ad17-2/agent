import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { UIMessage, UIMessageChunk } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createAgent } from "../src/agent/index.js";
import { streamModel, usage } from "./helpers.js";

const hello: UIMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] };

async function chunkTypes(stream: ReadableStream<UIMessageChunk>): Promise<string[]> {
  const types: string[] = [];
  for await (const chunk of stream) types.push(chunk.type);
  return types;
}

/** Streams one text delta every few ms until the signal fires, then errors like an aborted fetch body. */
function tickingStreamModel() {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "1" });
        },
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 5));
          if (abortSignal?.aborted) {
            controller.error(abortSignal.reason);
            return;
          }
          controller.enqueue({ type: "text-delta", id: "1", delta: "x" });
        },
      }),
    }),
  });
}

describe("uiStream", () => {
  it("streams UI message chunks for the given messages and leaves history untouched", async () => {
    const model = streamModel([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hello" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
    ]);
    const info = vi.fn();
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    });

    const types = await chunkTypes(await agent.uiStream([hello], { traceId: "t-1" }));

    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    expect(model.doStreamCalls[0]!.prompt.at(-1)).toMatchObject({ role: "user" });
    expect(info).toHaveBeenCalledWith("Agent uiStream started", { traceId: "t-1" });
    expect(agent.exportHistory().messages).toEqual([]);
  });

  it("ends the stream when the caller's abort signal fires", async () => {
    const controller = new AbortController();
    const agent = createAgent({ model: tickingStreamModel(), systemPrompt: "Test", tools: {} });

    const stream = await agent.uiStream([hello], { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    const types = await chunkTypes(stream);

    expect(types).toContain("text-delta");
    expect(types).not.toContain("finish");
  });

  it("aborts the model call when the consumer cancels the stream", async () => {
    const model = tickingStreamModel();
    const agent = createAgent({ model, systemPrompt: "Test", tools: {} });

    const reader = (await agent.uiStream([hello])).getReader();
    while ((await reader.read()).value?.type !== "text-delta");
    await reader.cancel();

    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(true);
  });

  it("ends the stream when the run timeout fires", async () => {
    const agent = createAgent({ model: tickingStreamModel(), systemPrompt: "Test", tools: {} });

    const types = await chunkTypes(await agent.uiStream([hello], { timeoutMs: 20 }));

    expect(types).toContain("text-delta");
    expect(types).not.toContain("finish");
  });
});
