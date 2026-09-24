import { registerTelemetry } from "ai";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/**
 * Registers the Langfuse OTel pipeline. The span processor exports OTLP/HTTP JSON to
 * `${LANGFUSE_BASE_URL}/api/public/otel/v1/traces`, authenticated with the two keys.
 */
export function setupLangfuse(): { shutdown(): Promise<void> } {
  const langfuseSpanProcessor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });

  const provider = new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] });
  provider.register();

  registerTelemetry(new LangfuseVercelAiSdkIntegration());

  return {
    async shutdown() {
      await langfuseSpanProcessor.forceFlush();
      await provider.shutdown();
    },
  };
}
