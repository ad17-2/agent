import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { context, propagation, trace } from "@opentelemetry/api";
import { createAgent } from "../src/agent/index.js";
import { setupLangfuse } from "../examples/langfuse-setup.ts";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const otlpTraceRequest = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              name: z.string(),
              attributes: z.array(
                z.object({
                  key: z.string(),
                  value: z.object({ stringValue: z.string().optional() }),
                })
              ),
            })
          ),
        })
      ),
    })
  ),
});

async function startReceiver() {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("receiver not on TCP");
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => {
  globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  trace.disable();
  context.disable();
  propagation.disable();
  vi.unstubAllEnvs();
});

describe("telemetry-langfuse example wiring", () => {
  it("exports the agent's spans as OTLP JSON to the Langfuse traces endpoint", async () => {
    const receiver = await startReceiver();
    vi.stubEnv("LANGFUSE_BASE_URL", receiver.baseUrl);
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");

    const langfuse = setupLangfuse();
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const agent = createAgent({
      model,
      systemPrompt: "Test",
      tools: {},
      telemetry: { functionId: "langfuse-wiring-test" },
    });

    await agent.run("Hello");
    await langfuse.shutdown();
    await receiver.close();

    const traceRequests = receiver.requests.filter((r) => r.url === "/api/public/otel/v1/traces");
    expect(traceRequests.length).toBeGreaterThan(0);
    const [first] = traceRequests;
    expect(first?.method).toBe("POST");
    expect(first?.headers["content-type"]).toBe("application/json");
    expect(first?.headers.authorization).toBe(
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`
    );

    const spans = traceRequests.flatMap((r) =>
      otlpTraceRequest
        .parse(JSON.parse(r.body))
        .resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
    );
    const names = spans.map((s) => s.name);
    const agentNames = spans.flatMap((s) =>
      s.attributes.filter((a) => a.key === "gen_ai.agent.name").map((a) => a.value.stringValue)
    );

    expect([...names].sort()).toEqual([
      "chat mock-model-id",
      "invoke_agent mock-model-id",
      "step 1",
    ]);
    expect(agentNames).toEqual(["langfuse-wiring-test"]);
  });
});
