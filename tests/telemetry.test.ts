import { describe, it, expect } from "vitest";
import { registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { OpenTelemetry } from "@ai-sdk/otel";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createAgent } from "../src/agent/index.js";

function usage(inputTokens = 10, outputTokens = 20) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

describe("telemetry", () => {
  it("forwards telemetry to the SDK and exports real ai.* spans", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer("telemetry-test") }));

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      }),
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      telemetry: { functionId: "my-function" },
    });

    await agent.run("Hello");
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.attributes["gen_ai.agent.name"] === "my-function")).toBe(true);

    exporter.reset();
    await provider.shutdown();
  });

  it("defaults telemetry.functionId to traceId when functionId is not set", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer("telemetry-test-traceid") }));

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      }),
    });

    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      telemetry: {},
      traceId: "trace-from-agent-options",
    });

    await agent.run("Hello");
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.attributes["gen_ai.agent.name"] === "trace-from-agent-options")).toBe(true);

    exporter.reset();
    await provider.shutdown();
  });
});
