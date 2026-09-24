/**
 * Sends spans to Langfuse via OpenTelemetry. The run itself needs a real Anthropic call and
 * a Langfuse project. The wiring in `langfuse-setup.ts` is verified without keys by
 * tests/telemetry-langfuse.test.ts, which points it at a local OTLP receiver.
 *
 * Env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, ANTHROPIC_API_KEY
 *
 *   node examples/telemetry-langfuse.ts
 */
import { anthropic } from "@ai-sdk/anthropic";
import { createAgent } from "@ad17-2/agent";
import { setupLangfuse } from "./langfuse-setup.ts";

const langfuse = setupLangfuse();

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a release assistant.",
  tools: {},
  telemetry: { functionId: "telemetry-langfuse-example" },
});

const result = await agent.run("Summarize the latest release in one sentence");
console.log(result.message);

await langfuse.shutdown();
