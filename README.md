# @ad17-2/agent

A tool-calling agent for TypeScript, built on the Vercel AI SDK 7 `ToolLoopAgent`. The SDK runs the loop: it calls the model, executes tools and feeds the results back. This package adds what a conversational agent needs around that loop. History keeps tool calls, tool results and attachments across turns, and survives export and import. Retries wrap each model call as middleware, so a failed step does not run earlier tools again. Stop reasons say why a run ended, including aborts and timeouts. It also adds per-model dollar cost, a context budget that trims and summarises old turns, telemetry naming, and tools loaded from MCP servers.

## Install

```bash
# .npmrc
@ad17-2:registry=https://npm.pkg.github.com
```

```bash
pnpm add @ad17-2/agent @ai-sdk/anthropic
```

Requires Node.js 22 or later. The package is ESM only. Any AI SDK provider works; the snippets use Anthropic.

## Quick start

```typescript
import { createAgent, defineTool, z } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const getWeather = defineTool({
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
  handler: async ({ city }) => ({ city, temperatureC: 22, conditions: "sunny" }),
});

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a weather assistant.",
  tools: { getWeather },
});

const result = await agent.run("What's the weather in Tokyo?");
console.log(result.message, result.stopReason, result.usage.totalTokens);

const followUp = await agent.run("And tomorrow?");
```

The second `run()` sees the first turn, including the tool call and its result.

## Examples

Every example runs with no API key. A `MockLanguageModelV4` from `ai/test` plays the model, and the example imports the built package as `@ad17-2/agent`.

```bash
pnpm examples                       # builds, then runs all of them
node examples/streaming.ts          # one example, after pnpm build
```

| Example | Shows |
|---------|-------|
| [`basic-tools.ts`](examples/basic-tools.ts) | `defineTool`, `run()`, the result's usage and stop reason |
| [`streaming.ts`](examples/streaming.ts) | every `AgentEvent`, a failing tool, a stream that fails mid-output |
| [`loop-control.ts`](examples/loop-control.ts) | `stopWhen: hasToolCall(...)`, `prepareStep` narrowing the tools per step |
| [`tool-features.ts`](examples/tool-features.ts) | `toModelOutput`, the input streaming hooks and events, `defineDynamicTool` |
| [`tool-approval.ts`](examples/tool-approval.ts) | a gated tool, `needs_approval`, resuming with `{ approvals }` |
| [`attachments-and-history.ts`](examples/attachments-and-history.ts) | an image turn, export and import, what the next model call receives |
| [`cost-and-context.ts`](examples/cost-and-context.ts) | a price table, `result.cost`, summarisation between turns |
| [`retry-and-timeouts.ts`](examples/retry-and-timeouts.ts) | a retried 529, a per-tool timeout, a run timeout |
| [`mcp.ts`](examples/mcp.ts) | `loadMcpTools` against a stdio MCP server |
| [`telemetry-console.ts`](examples/telemetry-console.ts) | OpenTelemetry spans printed to the console |
| [`streaming-structured.ts`](examples/streaming-structured.ts) | `streamStructured`, partial objects as the JSON arrives |
| [`ui-stream.ts`](examples/ui-stream.ts) | `uiStream()`, the UI message chunk types for one user message |

## Tools and runs

```typescript
const getWeather = defineTool({
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
  handler: async ({ city }) => ({ city, temperatureC: 22, conditions: "sunny" }),
});

const agent = createAgent({ model, systemPrompt: "You are a weather assistant.", tools: { getWeather } });
const result = await agent.run("What's the weather in Tokyo?");
// result.toolsCalled: [{ name: "getWeather", input: { city: "Tokyo" }, output: {...}, durationMs: 0.2 }]
// result.stopReason: "end_turn", result.iterations: 2
```

`tools` takes any AI SDK `ToolSet`, so tools built with the SDK's `tool()` work too. `defineTool` adds three things. The handler gets `{ abortSignal, toolCallId }`. An optional `onError` turns a thrown error into a return value the model sees. An optional `timeoutMs` bounds the call.

A tool that throws does not fail the run. The SDK sends the error to the model as the tool result, and the record in `toolsCalled` carries the message in `error`. `error` is absent on success.

A run stops after `maxIterations` model calls (default 10). `stopReason` maps the SDK's finish reason:

| `stopReason` | When |
|--------------|------|
| `end_turn` | The model finished its answer |
| `max_iterations` | The run hit `maxIterations` while the model still wanted tools |
| `stop_condition` | A `stopWhen` condition ended the run while the model still wanted tools |
| `needs_approval` | A gated tool is waiting for a decision; see [tool approval](#tool-approval) |
| `max_tokens` | The response hit `maxOutputTokens` (default 4096) |
| `content_filter` | The provider filtered the output |
| `aborted` | The caller's `abortSignal` fired |
| `timeout` | The run timeout fired |
| `error` | A streamed model call failed, or the provider finished with an error |
| `other` | Any other finish reason |

`aborted` and `timeout` come back as a result, not an exception, with an empty `message` and zero `usage`. A turn that ends this way is not added to history.

`model` also accepts a model id string. It resolves on every call through `globalThis.AI_SDK_DEFAULT_PROVIDER`, else the AI SDK gateway, so a provider registered after `createAgent` is used.

One agent can serve overlapping `run()` and `stream()` calls. Each call has its own model resolution, retry state and trimming calibration. History is shared: a call reads it when it starts and appends its turn when it ends, so overlapping calls do not see each other. Run turns in sequence when one must build on the last.

## Loop control

```typescript
const agent = createAgent({
  model,
  systemPrompt: "Research, then submit an answer.",
  tools: { search, submitAnswer },
  stopWhen: hasToolCall("submitAnswer"),
  prepareStep: ({ stepNumber }) =>
    stepNumber === 0
      ? { activeTools: ["search"] }
      : { activeTools: ["submitAnswer"], toolChoice: "required" },
});
// result.stopReason: "stop_condition", result.iterations: 2
```

`stopWhen` takes one SDK `StopCondition` or an array. `isStepCount`, `hasToolCall` and `isLoopFinished` are re-exported. The conditions are added to the `maxIterations` cap, never replace it, so a condition that never fires still stops at `maxIterations`.

`prepareStep` is the SDK's `PrepareStepFunction`. It runs before each model call and can set `activeTools`, `toolChoice`, `model`, `instructions`, `messages` or call settings for that step. With `context` set, it runs after trimming: it receives the trimmed `messages`, its fields win, and the trimmed messages are sent unless it returns its own.

## Tool features

```typescript
const searchOrders = defineTool({
  description: "Search orders by customer",
  schema: z.object({ customer: z.string() }),
  handler: async ({ customer }) => findOrders(customer),
  toModelOutput: (output, { input }) => ({ type: "text", value: `2 orders for ${input.customer}` }),
  onInputDelta: (delta, { toolCallId }) => console.log(toolCallId, delta),
});

const plugin = defineDynamicTool({
  description: "Call a plugin action",
  handler: async (input) => runPlugin(input), // input: unknown
});
```

`toModelOutput` maps the handler's result to the `ToolResultOutput` the model sees. `toolsCalled` and the `tool-call-complete` event keep the raw result.

`onInputStart`, `onInputDelta` and `onInputAvailable` get the same `{ abortSignal, toolCallId }` context as the handler. `onInputDelta` fires only in `stream()`. In `run()`, `onInputStart` fires right before `onInputAvailable`.

`defineDynamicTool` is for tools whose input is not known until run time. The handler gets the input unvalidated. `onError` and `timeoutMs` work as in `defineTool`.

## Tool approval

```typescript
const agent = createAgent({ model, systemPrompt, tools, toolApproval: { deleteFile: "user-approval" } });

let result = await agent.run("clean up the temp dir");
if (result.stopReason === "needs_approval") {
  const approvals = await askHuman(result.pendingApprovals); // [{ approvalId, approved, reason? }]
  result = await agent.run({ approvals }); // approved tools run, then the loop continues
}
```

`toolApproval` is the SDK's `ToolApprovalConfiguration`: a map from tool name to `"user-approval"`, `"approved"`, `"denied"`, `{ type, reason }` or a function of the input, or one function for every call. A `"user-approval"` call stops the run before the tool runs, with `stopReason: "needs_approval"` and one `PendingApproval` per gated call: `{ approvalId, toolCallId, toolName, input, reason? }`. `"approved"` and `"denied"` decide without stopping; a denied call is in `toolsCalled` with `error: "denied"` and the reason.

`run({ approvals })` answers the pending requests and continues the same turn: the approved tools run, denied ones give the model an `execution-denied` result with the reason, and the loop goes on. Every pending id must be decided exactly once, or the call throws `AgentError("INVALID_APPROVAL")` and history is untouched. A text turn while approvals are pending throws `AgentError("APPROVAL_PENDING")`. The resume does not call `onStart`, ignores `attachments`, and counts `iterations` from zero. The resumed tools are the first entries of its `toolsCalled`.

```typescript
for await (const evt of agent.stream("deploy it")) {
  if (evt.type === "approval-request") ui.showApprovalCard(evt.approval);
  if (evt.type === "complete" && evt.result.stopReason === "needs_approval") pending = evt.result.pendingApprovals;
}
for await (const evt of agent.stream({ approvals: decisions })) render(evt);
```

`stream()` yields `approval-request` as each gated call is issued, then ends with `complete` as usual. A resumed stream yields `tool-call-complete` for the approved tools before its first `step-complete`.

```typescript
// process A
const r = await agent.run("rotate the keys");
if (r.stopReason === "needs_approval") await db.save(sessionId, agent.exportHistory());

// process B, hours later
agent.importHistory(await db.load(sessionId));
const pending = agent.pendingApprovals(); // same ids as r.pendingApprovals
await agent.run({ approvals: pending.map((p) => ({ approvalId: p.approvalId, approved: policy(p) })) });
```

The request lives in history as the SDK's own `tool-approval-request` part, so `exportHistory()` carries it and `agent.pendingApprovals()` rebuilds the list from history. Eviction keeps the request and its answer in one turn, and a resume never summarises. Two limits: an approved tool that ran before an abort or timeout runs again on the next resume, so gated tools should be idempotent; and `conversation.ttlMs` expiry drops a pending turn like any other, so a wait longer than that goes through export and import.

## Streaming

```typescript
for await (const event of agent.stream("Where is order A1? Refund it.")) {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.content);
      break;
    case "tool-call-error":
      console.log(`${event.name} failed: ${event.error}`);
      break;
    case "step-complete":
      console.log(`step ${event.stepIndex}: ${event.usage.totalTokens} tokens`);
      break;
    case "complete":
      console.log(event.result.stopReason);
      break;
  }
}
```

| Event | Fields | Emitted |
|-------|--------|---------|
| `start` | `timestamp` | First, always |
| `thinking` | `content` | For each reasoning delta |
| `text-delta` | `content` | For each text delta |
| `tool-input-start` | `name`, `toolCallId` | When the model starts streaming a tool's input |
| `tool-input-delta` | `toolCallId`, `delta` | For each chunk of a tool's input |
| `tool-call-start` | `name`, `input`, `toolCallId` | When the model calls a tool |
| `tool-call-complete` | `name`, `output`, `toolCallId`, `durationMs` | When a tool returns |
| `tool-call-error` | `name`, `error`, `toolCallId` | When a tool throws or times out, or its approval is denied |
| `approval-request` | `approval` | When a gated tool waits for a decision; see [tool approval](#tool-approval) |
| `step-complete` | `stepIndex`, `toolsCalled`, `usage` | After each model call and its tools |
| `text-complete` | `content` | Once, with the final text |
| `error` | `error` | When a model call fails |
| `complete` | `result` | Last, with the same `AgentResult` as `run()` |

`stream()` does not throw on a failed run; invalid approvals or a text turn while approvals are pending throw as in `run()`. A failed model call yields `error`, then `complete` with `stopReason: "error"`, and calls `onError` with `phase: "api"`. An abort or timeout yields `complete` with `stopReason: "aborted"` or `"timeout"` and no `error` event.

Breaking out of the loop aborts the run. The in-flight model request and any running tool see the abort, the run timer is cleared, and the turn is not added to history. No further events or hooks run after a break.

## UI message streams

```typescript
import { createUIMessageStreamResponse, type UIMessage } from "@ad17-2/agent";

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();
  return createUIMessageStreamResponse({ stream: await agent.uiStream(messages) });
}
```

`uiStream(uiMessages, options)` runs the agent through the SDK's `createAgentUIStream` and returns its `UIMessageChunk` stream, the format `useChat` reads. The client owns the messages: `uiStream` does not read or write the agent's history, and `attachments` is ignored. `abortSignal`, `timeoutMs` and `traceId` work as in `run()`. An abort or timeout ends the stream, and cancelling the stream aborts the model call.

## Attachments and history

```typescript
const turn1 = await agent.run("What is in this image?", {
  attachments: [{ type: "image", source: "base64", base64: pixel, mimeType: "image/png" }],
});

const saved = JSON.stringify(agent.exportHistory());

const restored: SerializedHistory = JSON.parse(saved);
other.importHistory(restored);
const turn2 = await other.run("What colour was it?");
// turn 2's prompt: system, user [file(image/png), text], assistant, user
```

An attachment is an image (base64 or URL), a PDF (base64 or URL), or a file (base64 with `mimeType` and `filename`). Each becomes an SDK `{ type: "file" }` part placed before the text.

History stores the SDK's own `ModelMessage`s: user turns with their attachments, assistant text, tool calls and tool results. The next turn replays them unchanged. `exportHistory()` returns `{ version: 2, messages, exportedAt }`. `importHistory()` also accepts a version 1 export from 0.4.x and keeps its text. Any other version throws `AgentError("INVALID_HISTORY")`.

`conversation.maxMessages` (default 20) caps stored messages. Eviction drops whole turns, oldest first, so a tool result never loses its tool call. The newest turn is kept even when it alone is over the cap. `conversation.ttlMs` (default 10 minutes) clears history that has not changed for that long.

## Cost

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a release assistant.",
  tools: {},
  pricing: {
    "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
    "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  },
});

const result = await agent.run("Explain the release notes.");
// result.cost: { inputUsd: 0.0024, outputUsd: 0.004, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0.0064, unpricedModels: [] }
```

`pricing` maps a model's `modelId` to USD per million tokens. `result.cost` is present only when `pricing` is set. Each step is priced by the model that ran it. Cache reads and writes fall back to the input price when their own price is unset. Reasoning tokens bill as output. A model missing from the table is listed in `unpricedModels`, and its tokens are left out of `totalUsd`.

The package ships no prices. Example prices, as of 2026-09-24, from [claude.com/pricing](https://claude.com/pricing):

| Model | Input /MTok | Output /MTok | Cache read /MTok | Cache write /MTok |
|-------|-------------|--------------|------------------|-------------------|
| Claude Opus 5.5 | $4 | $20 | $0.20 | $5 |
| Claude Sonnet 5 | $2 | $10 | $0.20 | $2.50 |
| Claude Haiku 4.5 | $1 | $5 | $0.10 | $1.25 |

`costOf(usage, price)` and `sumCost(steps, table)` are exported for use with a raw `ToolLoopAgent`.

## Context budget

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a release assistant.",
  tools: {},
  context: {
    maxInputTokens: 60_000,
    summarize: { keepRecentTurns: 4, model: anthropic("claude-haiku-4-5") },
  },
});
```

`context.maxInputTokens` bounds the prompt in two places.

Between turns, before a run starts, the stored history is estimated at 4 characters per token. When it is over budget, every turn except the last `keepRecentTurns` (default 4) is summarised in one call. The summary becomes a leading `Summary of earlier conversation: ...` message. The cut falls on turn boundaries. Attachments reach the summariser as a short placeholder, never as base64. The summary call's usage and cost are added to that run's result. `summarize.model` defaults to the agent's model and goes through the same retry.

Inside a run, before each model call, the prompt is estimated again. The estimate is calibrated against the `inputTokens` the provider reported for earlier steps of the same run. When it is over budget, reasoning and tool content is pruned from history older than the current turn. The current turn is never pruned, because providers need its thinking blocks and tool calls unchanged.

`context.prune` sets the `pruneMessages` options used for that pruning: `{ reasoning, toolCalls }`, both `"all"` by default. `pruneMessages` is re-exported.

`estimateTokens`, `trimForStep` and `summarizeHistory` are exported for use with a raw `ToolLoopAgent`. Build one `trimForStep` per run, since it keeps calibration state.

## Retries

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  retry: { maxAttempts: 3, initialDelayMs: 50 },
});
// A 529 on the first attempt is retried after 50ms, then the run answers normally.
```

`retry` is the only retry layer. The SDK's own retries are off (`maxRetries: 0`), and the package retries each single model call as language model middleware. A failure on step 2 sends only step 2 again, so step 1's tools do not run again and `toolsCalled` has no duplicates. The summariser call goes through the same retry.

By default a call is retried when the provider marks the error retryable. That covers `APICallError` or `StreamProviderError` with `isRetryable`, such as 429, 5xx and overloaded, plus a failed connection or a timed-out request. A 400 or 401 is attempted once. Pass `retryOn` to decide yourself.

A streamed call is retried only until its first content part arrives. Provider metadata, such as Anthropic's `message_start`, is not content, so an overloaded error right after it is still retried. After content has streamed, a failure ends the stream with `stopReason: "error"`, because a replay would repeat text the caller already has.

Nothing is retried, and no backoff runs, after the run timeout or the caller's signal has fired. Failed attempts add no usage.

| `RetryConfig` | Default | |
|---------------|---------|--|
| `maxAttempts` | `3` | Attempts per model call, including the first |
| `backoff` | `"exponential"` | `"fixed"`, `"linear"` or `"exponential"` |
| `initialDelayMs` | `1000` | Delay before the second attempt |
| `maxDelayMs` | `30000` | Cap on any delay |
| `retryOn` | provider classification | `(error) => boolean` |

## Timeouts and cancellation

```typescript
const slowSearch = defineTool({
  description: "Search a slow index",
  schema: z.object({ query: z.string() }),
  handler: (_input, { abortSignal }) => slowCall(10_000, abortSignal),
  timeoutMs: 50,
});

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a data assistant.",
  tools: { slowSearch },
  timeout: { totalMs: 60_000, toolMs: 5_000 },
});

const result = await agent.run("Export everything", { timeoutMs: 100, abortSignal: controller.signal });
// result.stopReason: "timeout"
```

`timeout.totalMs` bounds a whole run. `RunOptions.timeoutMs` overrides it for one call, and `0` turns it off. When it fires, the run returns `stopReason: "timeout"` and calls `onError` with `phase: "timeout"`.

`RunOptions.abortSignal` cancels a run. The run returns `stopReason: "aborted"` and calls no `onError`.

A tool's `timeoutMs`, else `timeout.toolMs`, bounds each tool call. When it fires, the tool's `abortSignal` is aborted and the call fails with a timeout error. The model sees that error, and `onError` gets `phase: "tool"`. A handler that ignores its signal is abandoned at that point, so it cannot hang the run. A tool cut off by the run timeout or the caller's abort is not reported to `onError` as a tool failure.

Unset or `0` means no timeout. The run timer is cleared on every exit, so a finished run does not keep the process alive.

## Telemetry

```typescript
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";

registerTelemetry(new OpenTelemetry({ tracer }));

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a release assistant.",
  tools: {},
  telemetry: { functionId: "release-assistant" },
});
```

`telemetry` is the SDK's `TelemetryOptions`, passed to every call. The package registers no exporter; call the SDK's `registerTelemetry` yourself. The telemetry `functionId` is `telemetry.functionId`, else the run's `RunOptions.traceId`, else the agent's `traceId`.

`examples/telemetry-console.ts` prints the spans with a `ConsoleSpanExporter`. `examples/telemetry-langfuse.ts` sends them to Langfuse and needs real keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `ANTHROPIC_API_KEY`).

## MCP

```typescript
import { loadMcpTools } from "@ad17-2/agent/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

const mcp = await loadMcpTools([
  {
    name: "fixture",
    transport: new Experimental_StdioMCPTransport({ command: process.execPath, args: [server] }),
    prefix: "fixture_",
  },
  { name: "github", transport: { type: "http", url: process.env.GITHUB_MCP_URL! } },
]);

try {
  const agent = createAgent({ model, systemPrompt: "You are a helpful assistant.", tools: mcp.tools });
  await agent.run("Echo a greeting");
} finally {
  await mcp.close();
}
```

`loadMcpTools` lives in the `@ad17-2/agent/mcp` subpath, so the core never imports `@ai-sdk/mcp`. Install it yourself: `pnpm add @ai-sdk/mcp`.

A server's `transport` is an inline `{ type: "http" | "sse", url }` config or a transport instance such as `Experimental_StdioMCPTransport`. `prefix` renames that server's tools to `${prefix}${name}`. Two servers exposing the same final name throw `AgentError("MCP_TOOL_CONFLICT")`. When one server fails to connect, the clients already open are closed before the error is rethrown. Only tools are loaded; MCP prompts and resources are not.

A clash between an MCP tool and a local tool is not checked. The object spread you pass as `tools` decides which one wins.

## Structured output

```typescript
import { generateStructured, z } from "@ad17-2/agent";

const { data, usage } = await generateStructured({
  model: anthropic("claude-sonnet-5"),
  schema: z.object({ sentiment: z.enum(["positive", "negative", "neutral"]), summary: z.string() }),
  prompt: "Analyze: 'This product exceeded my expectations!'",
  attachments: [{ type: "pdf", source: "url", url: "https://example.com/review.pdf" }],
});
```

`generateStructured` makes a `generateText` call with `Output.object({ schema })`. It takes `attachments`, `maxOutputTokens` and `abortSignal` like a run, and returns `usage` as `TokenUsage`. It has no `retry` option and keeps the SDK's default retries.

```typescript
import { streamStructured } from "@ad17-2/agent";

const { partial, output, usage } = streamStructured({ model, schema, prompt });
for await (const draft of partial) render(draft);
const data = await output;
```

`streamStructured` takes the same options and makes a `streamText` call. `partial` yields a deep-partial object each time the parsed JSON grows. `output` resolves to the validated object and rejects when it does not match the schema. `usage` resolves to `TokenUsage`.

## Thinking and provider options

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a reasoning assistant.",
  tools: {},
  thinking: { budgetTokens: 20_000 },
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
});
// result.thinking: the final step's reasoning text
```

Setting `thinking` enables Anthropic extended thinking with `budgetTokens` (default 10000). `providerOptions` is passed to every call and merged per provider key over `thinking`, so extra `anthropic` options keep the thinking setting.

## Hooks and logging

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: { search },
  logger: console,
  traceId: "request-123",
  onStep: ({ stepIndex, toolsCalled }) => console.log(stepIndex, toolsCalled.length),
  onError: (error, context) => console.error(context.phase, error.message),
});
```

| Hook | Called |
|------|--------|
| `onStart(input)` | Before the first model call; not on a resume with `{ approvals }` |
| `onStep(step)` | After each step, with its tool records and text |
| `onToolCall(name, input)` | Before a tool runs |
| `onToolResult(name, output)` | After a tool returns |
| `onError(error, context)` | With `phase` `"tool"` (and `toolName`), `"api"` or `"timeout"` |
| `onComplete(result)` | After a run that finished without an error, abort or timeout |

Hooks are awaited. A `logger` gets `debug`, `info`, `warn` and `error` calls with a message and metadata.

## Errors

```typescript
try {
  agent.importHistory(saved);
  await agent.run("Hello");
} catch (error) {
  if (AgentError.is(error)) {
    switch (error.code) {
      case "API_ERROR":
        console.log("Run failed:", error.cause);
        break;
      case "INVALID_HISTORY":
        console.log("Unsupported history:", error.message);
        break;
      case "MCP_TOOL_CONFLICT":
        console.log("Duplicate MCP tool:", error.message);
        break;
    }
  }
}
```

| Code | Thrown by |
|------|-----------|
| `API_ERROR` | `run()`, when a model call fails after retries or a hook throws; `cause` is the original error |
| `INVALID_HISTORY` | `importHistory()`, for a `version` other than 1 or 2 |
| `INVALID_APPROVAL` | `run({ approvals })` and `stream({ approvals })`, for an unknown, duplicate or missing id, or when nothing is pending |
| `APPROVAL_PENDING` | `run(text)` and `stream(text)`, while approvals are pending |
| `MCP_TOOL_CONFLICT` | `loadMcpTools()`, when two servers expose the same tool name |

Tool failures, aborts and timeouts are not thrown; see [Tools and runs](#tools-and-runs).

## API reference

The types are exported from the package root. This section lists what the types do not say.

`createAgent(options)`

| Option | Default | |
|--------|---------|--|
| `model` | required | A `LanguageModel` or a model id string |
| `systemPrompt` | required | Sent as the SDK's `instructions` |
| `tools` | required | Any `ToolSet`; `{}` for none |
| `maxIterations` | `10` | Model calls per run |
| `stopWhen` | none | Extra stop conditions; see [loop control](#loop-control) |
| `prepareStep` | none | Per-step overrides; see [loop control](#loop-control) |
| `toolApproval` | none | The SDK's `ToolApprovalConfiguration`; see [tool approval](#tool-approval) |
| `maxOutputTokens` | `4096` | Per model call |
| `conversation` | `{ maxMessages: 20, ttlMs: 600000 }` | See [history](#attachments-and-history) |
| `thinking` | off | See [thinking](#thinking-and-provider-options) |
| `providerOptions` | none | Merged per provider over `thinking` |
| `retry` | see [retries](#retries) | An explicit `undefined` field takes its default |
| `timeout` | none | `{ totalMs, toolMs }` |
| `pricing` | none | Enables `result.cost` |
| `context` | none | `{ maxInputTokens, summarize?, prune? }` |
| `telemetry` | none | The SDK's `TelemetryOptions` |
| `logger`, `traceId` | none | |
| hooks | none | See [hooks](#hooks-and-logging) |

`agent.run(input, options)` and `agent.stream(input, options)`

`input` is a string, or `{ approvals: ApprovalDecision[] }` to resume a run stopped with `needs_approval`.

| Option | |
|--------|--|
| `attachments` | Images, PDFs or files for this turn; ignored on a resume |
| `abortSignal` | Cancels the run; the result has `stopReason: "aborted"` |
| `timeoutMs` | Overrides `timeout.totalMs`; `0` disables it |
| `traceId` | Log trace id and telemetry `functionId` for this run |

`AgentResult`

| Field | |
|-------|--|
| `message` | Final text |
| `toolsCalled` | `{ name, input, output, durationMs, error? }` per tool call |
| `iterations` | Model calls made |
| `stopReason` | See [stop reasons](#tools-and-runs) |
| `usage` | Input, output, total, cache read, cache write and reasoning tokens, summed over steps and any summary call |
| `cost` | Present when `pricing` is set |
| `thinking` | The final step's reasoning text, when there is any |
| `pendingApprovals` | Present when `stopReason` is `needs_approval`; see [tool approval](#tool-approval) |

`defineTool(options)`

| Option | |
|--------|--|
| `description`, `schema`, `handler` | required |
| `onError` | Turns a thrown error into the result the model sees |
| `timeoutMs` | Bounds the call; overrides `timeout.toolMs` |
| `toModelOutput` | `(output, { toolCallId, input }) => ToolResultOutput` |
| `onInputStart`, `onInputDelta`, `onInputAvailable` | See [tool features](#tool-features) |

`defineDynamicTool(options)` takes `description`, `handler`, `onError` and `timeoutMs`.

`agent.uiStream(uiMessages, options)` returns a `ReadableStream<UIMessageChunk>` for a chat UI. It takes the same options except `attachments` and leaves history alone. See [UI message streams](#ui-message-streams).

`generateStructured(options)` and `streamStructured(options)` take `{ model, schema, prompt, attachments?, maxOutputTokens?, abortSignal? }`. See [structured output](#structured-output).

`agent.pendingApprovals()` returns the approvals the last turn is waiting on, read from history.

`agent.clearHistory()`, `agent.exportHistory()` and `agent.importHistory(history)` manage the stored conversation.

## How it works

`createAgent` builds one `ToolLoopAgent`. Its `prepareCall` supplies three things per call: the model, wrapped in the retry middleware; a fresh `trimForStep` for the context budget; and the telemetry options with this run's `functionId`. Tools are wrapped once, when the agent is created, to add hooks, logging and timeouts.

`run()` and `stream()` share one turn lifecycle in `src/agent/index.ts`:

1. `openTurn` logs the start, arms the run signal and creates a `StepRecorder` for this call. The run signal joins the run timer, the caller's `abortSignal` and an internal cancel, and remembers which one fired.
2. `startTurn` returns early if the signal already fired. Otherwise it calls `onStart`, summarises history if it is over budget, and builds the user message with its attachments. The prompt is the stored history plus that message.
3. The SDK runs the loop. `run()` calls `generate`. `stream()` calls `stream` and maps each stream part to an `AgentEvent`. The SDK reports each finished step to the recorder.
4. `finishTurn` appends the user message and the SDK's response messages to history, maps the finish reason to a stop reason, adds any summary usage and cost, and calls `onComplete`.

A signal that fires at any point ends the turn through `endBySignal`. It returns `aborted` or `timeout` and leaves history as it was.

The retry middleware (`src/utils/retry.ts`) sits between the SDK and the provider. The SDK loop sees one model call, however many attempts it took. For a stream, the middleware reads ahead to the first content part before it hands the stream on. A failure before that point is thrown and retried. After it, the stream passes through.

The `StepRecorder` (`src/agent/recorder.ts`) owns the tool records for one call. It builds them from the SDK's step results, with durations from the SDK's own timing. The SDK emits a stream's `finish-step` part before it reports the step, so `stream()` waits for the recorder before it yields `step-complete`. Each call has its own recorder, so overlapping runs keep separate records even when tool call ids repeat.

## Development

Development uses Node 26 and pnpm 12. CI runs on Node 22 and 26.

```bash
pnpm install
pnpm test            # vitest
pnpm lint            # oxlint, type-aware
pnpm format:check    # biome
pnpm typecheck       # src, tests and examples
pnpm build           # tsdown to dist/
pnpm check:package   # packs the tarball, then attw and publint
pnpm examples        # builds, then runs every example
```

Tests use `MockLanguageModelV4`, so the real SDK loop, tool execution and stream parsing run without a network. Three tests check the tooling and integrations end to end:

- `tests/lint-rules.test.ts` runs oxlint on `tests/fixtures/lint-violations.ts`, which breaks each configured rule once, and asserts each rule reports. It also asserts `pnpm lint` is clean.
- `tests/telemetry-langfuse.test.ts` points the Langfuse example setup at a local HTTP receiver and decodes the OTLP export: the auth header, the `functionId`, and the agent, step and model spans.
- `tests/mcp.test.ts` starts `tests/fixtures/mcp-server.mjs` as a real MCP server over stdio and runs an agent against its tool.

See [CHANGELOG.md](CHANGELOG.md) for release notes and migration steps.

## License

MIT
