/**
 * Sends spans to Langfuse via OpenTelemetry. Needs a real Anthropic call and a Langfuse
 * project, so this is NOT run as part of verification here (see docs/design.md /
 * the report for why) — it documents the wiring only.
 *
 * Env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, ANTHROPIC_API_KEY
 *
 *   pnpm exec tsx examples/telemetry-langfuse.ts
 */
import { registerTelemetry } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createAgent } from "../src/index.js";

const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
});

const provider = new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] });
provider.register();

registerTelemetry(new LangfuseVercelAiSdkIntegration());

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a release assistant.",
  tools: {},
  telemetry: { functionId: "telemetry-langfuse-example" },
});

const result = await agent.run("Summarize the latest release in one sentence");
console.log(result.message);

await langfuseSpanProcessor.forceFlush();
await provider.shutdown();
