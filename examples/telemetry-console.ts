/**
 * Prints ai.* / agent.* spans to the console. Runs with no API key: the model is a
 * MockLanguageModelV4, so this only proves the telemetry wiring, not a real call.
 *
 *   pnpm example:telemetry
 */
import { registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { OpenTelemetry } from "@ai-sdk/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createAgent } from "@ad17-2/agent";

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
provider.register();

registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer("telemetry-console-example") }));

const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text", text: "Hello from the mock model!" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 6, text: 6, reasoning: undefined },
    },
    warnings: [],
  }),
});

const agent = createAgent({
  model,
  systemPrompt: "You are a release assistant.",
  tools: {},
  telemetry: { functionId: "telemetry-console-example" },
});

await agent.run("Summarize the latest release");

await provider.shutdown();
