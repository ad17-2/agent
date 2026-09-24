# @ad17-2/agent

Lightweight agentic loop powered by Vercel AI SDK 7 (`ToolLoopAgent`).

## Installation

```bash
# .npmrc
@ad17-2:registry=https://npm.pkg.github.com

# install
pnpm add @ad17-2/agent
```

You also need a model provider (e.g., `@ai-sdk/anthropic`, `@ai-sdk/openai`):

```bash
pnpm add @ai-sdk/anthropic
```

Requires Node.js >= 22 (ESM only). Development on this repo is done on Node 26; CI runs both Node 22 and Node 26.

## Quick Start

```typescript
import { createAgent, defineTool, z } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const weatherTool = defineTool({
  description: "Get the current weather for a location",
  schema: z.object({
    location: z.string().describe("City name"),
  }),
  handler: async ({ location }) => {
    return { temperature: 22, conditions: "sunny", location };
  },
});

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant with access to weather data.",
  tools: { get_weather: weatherTool },
});

const result = await agent.run("What's the weather in Tokyo?");
console.log(result.message);
console.log(result.usage); // { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }
```

## Migrating from 0.4.x

- **Node >= 22 required.** The package is ESM only and built on `ai` 7's `ToolLoopAgent`.
- **History is version 2.** `SerializedHistory.messages` are now the SDK's own `ModelMessage`s (tool calls and results survive export/import), not the old text-only shape. `agent.importHistory()` still accepts a version-1 export and converts it (text-only, no tool calls) on the way in.
- **`ImageInput` and the old `ContentBlock` type are gone.** Use `RunOptions.attachments` (unchanged shape) for images, PDFs, and files.
- **`RunOptions.image` (already deprecated in 0.4.x) is removed.** Use `attachments`.
- **`AgentResult.stopReason` values are now accurate.** `max_tokens` (the output-token cap) and `max_iterations` (the step cap) were previously conflated; `content_filter`, `aborted`, `timeout`, and `other` are now real, reachable values instead of being thrown as `AgentError("ABORTED")`. See [StopReason](#agentresult) below.
- **`TokenUsage` gained fields.** `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens` are now populated (previously always `0` or absent).
- **Tool call timeouts now abort the tool's `signal`**, not just race it — see [Timeout Configuration](#timeout-configuration).
- **`retry.retryOn` no longer defaults to retrying everything.** The default follows the provider's own classification (429, 5xx, overloaded, failed connections); a 400 or 401 is attempted once. Pass your own `retryOn` to keep the old behaviour — see [RetryConfig](#retryconfig).

## API Reference

### `createAgent(options)`

Creates an agent instance with conversation history management and tool calling capabilities.

```typescript
import { createAgent } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
});

const result = await agent.run("Hello!");
```

#### AgentOptions

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `model` | `LanguageModel` | Yes | - | Vercel AI SDK language model instance, or a `provider:model` id string, resolved on every call like the SDK does (through `globalThis.AI_SDK_DEFAULT_PROVIDER`, else the gateway), so a provider registered after `createAgent` is honoured |
| `systemPrompt` | `string` | Yes | - | System prompt for the agent |
| `tools` | `Record<string, Tool>` | Yes | - | Map of tool names to tool definitions |
| `maxIterations` | `number` | No | `10` | Maximum tool-calling iterations per run |
| `maxTokens` | `number` | No | `4096` | Maximum output tokens per response |
| `conversation` | `ConversationConfig` | No | - | Conversation history settings |
| `thinking` | `ThinkingConfig` | No | - | Extended thinking configuration |
| `providerOptions` | `ProviderOptions` | No | - | Provider-specific call options, merged per provider key over `thinking` (so `anthropic.thinking` survives extra `anthropic` options) |
| `retry` | `RetryConfig` | No | - | Retry configuration with backoff |
| `timeout` | `TimeoutConfig` | No | - | Timeout configuration |
| `pricing` | `PriceTable` | No | - | Per-model USD pricing; enables `result.cost` |
| `context` | `ContextConfig` | No | - | Context budget and summarization ([details](#context-budget)) |
| `telemetry` | `TelemetryOptions` | No | - | Forwarded to the SDK's `ToolLoopAgent` ([details](#telemetry)) |
| `logger` | `Logger` | No | - | Logger for tracing/debugging |
| `traceId` | `string` | No | - | Trace ID for request correlation; also used as the telemetry `functionId` when `telemetry.functionId` is unset |
| `onStart` | `(input) => void` | No | - | Called when agent run begins |
| `onStep` | `(step) => void` | No | - | Called after each step completes |
| `onToolCall` | `(name, input) => void` | No | - | Called when a tool is invoked |
| `onToolResult` | `(name, result) => void` | No | - | Called when a tool returns |
| `onError` | `(error, context) => void` | No | - | Called on errors with phase context |
| `onComplete` | `(result) => void` | No | - | Called when agent run completes |

#### ConversationConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxMessages` | `number` | `20` | Maximum messages to retain in history. Eviction drops whole turns (a turn starts at a user message), oldest first, so a tool result is never separated from its tool call and history always starts with a user message. The newest turn is always kept, even when it alone exceeds the cap |
| `ttlMs` | `number` | `600000` | Time-to-live for history (10 minutes) |

#### ThinkingConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable extended thinking |
| `budgetTokens` | `number` | `10000` | Token budget for thinking |

#### RetryConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Maximum retry attempts |
| `backoff` | `BackoffStrategy` | `"exponential"` | `"fixed"`, `"linear"`, or `"exponential"` |
| `initialDelayMs` | `number` | `1000` | Initial delay between retries |
| `maxDelayMs` | `number` | `30000` | Maximum delay between retries |
| `retryOn` | `(error) => boolean` | the SDK's own classification | Predicate deciding whether a failed call is retried. The default retries what the provider marks retryable (`APICallError`/`StreamProviderError` with `isRetryable: true`: 429, 5xx, overloaded) plus a failed connection or a timed-out request; a 400 or 401 is attempted once |

An explicit `undefined` for any field takes that field's default.

`retry` is the only retry layer for every model call `createAgent` makes, the steps of `run()`/`stream()` and the history summariser alike (a custom `summarize.model` is wrapped the same way): the SDK's own retries are disabled (`maxRetries: 0`) and the package's retry runs as a language-model middleware around each single model call, so a transient failure on step 2 re-issues only that call: step 1's tools are not re-executed and `toolsCalled` is not duplicated. `generateStructured` is the exception: it takes a raw model and no `retry`, so it keeps the SDK's default retries (up to 2, only for errors the provider marks retryable). Failed attempts contribute no usage (a rejected call reports none). For `stream()`, a call is retried only while no content part (text, reasoning, tool call, file or source) has been delivered; provider metadata such as Anthropic's `message_start` does not count, so an `overloaded_error` right after it is still retried. The failed attempt's stream is cancelled before the next one starts. Once output has started, a failure is returned as `stopReason: "error"` plus an `error` event, since replaying would duplicate text the caller already saw. Nothing is retried, and no backoff sleep runs, once the run timeout or the caller's signal has fired.

#### TimeoutConfig

| Option | Type | Description |
|--------|------|-------------|
| `runTimeoutMs` | `number` | Global timeout for the entire run; `0` or unset means no timeout |
| `toolTimeoutMs` | `number` | Default timeout for tool execution; `0` or unset means no timeout |

#### RunOptions

| Option | Type | Description |
|--------|------|-------------|
| `attachments` | `Attachment[]` | Array of images, PDFs, or files |
| `signal` | `AbortSignal` | Abort signal for cancellation |
| `timeoutMs` | `number` | Override run timeout for this call; `0` disables it for this call even when `timeout.runTimeoutMs` is set |
| `traceId` | `string` | Override trace ID for this call |

#### AgentResult

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | The agent's final response |
| `toolsCalled` | `ToolCallRecord[]` | List of tools invoked during the run |
| `iterations` | `number` | Number of LLM steps taken |
| `stopReason` | `StopReason` | `"end_turn"`, `"max_iterations"`, `"max_tokens"`, `"content_filter"`, `"error"`, `"aborted"`, `"timeout"`, `"other"` |
| `usage` | `TokenUsage` | Token usage statistics, including any history-summarization usage folded in ([details](#context-budget)) |
| `cost` | `Cost` \| `undefined` | Present only when `pricing` is set ([details](#cost-tracking)) |
| `thinking` | `string` | Extended thinking output (if enabled) |

`aborted` and `timeout` are returned as a result (with empty `message` and zero `usage`), never thrown. Which one you get depends on which signal fired: the run timeout (`timeout.runTimeoutMs` / `RunOptions.timeoutMs`) yields `timeout` and calls `onError` with `phase: "timeout"`; the caller's `RunOptions.signal` yields `aborted` and calls no `onError`. Error message text is never used to tell them apart, so an API error that happens to say "timed out" is still thrown as `AgentError("API_ERROR")`. A run ended by either signal appends nothing to history.

#### TokenUsage

| Property | Type | Description |
|----------|------|-------------|
| `inputTokens` | `number` | Input tokens consumed |
| `outputTokens` | `number` | Output tokens generated (includes reasoning tokens) |
| `totalTokens` | `number` | Total tokens used |
| `cacheReadTokens` | `number` | Prompt-cache read tokens |
| `cacheWriteTokens` | `number` | Prompt-cache write tokens |
| `reasoningTokens` | `number` | Reasoning tokens (also counted in `outputTokens`) |

#### Methods

```typescript
// Run the agent
const result = await agent.run("Hello!");

// Clear conversation history
agent.clearHistory();

// Export history for persistence
const history = agent.exportHistory();
localStorage.setItem("agent-history", JSON.stringify(history));

// Import history (accepts a version-1 or version-2 export)
const saved = JSON.parse(localStorage.getItem("agent-history"));
agent.importHistory(saved);
```

One agent instance supports overlapping `run()`/`stream()` calls: each call resolves its own model, retry state and context-trimming calibration. Conversation history is the one shared thing: a run reads it when it starts and appends its own turn when it finishes, so overlapping runs do not see each other's turn and the stored order is completion order. Run calls sequentially when a turn must build on the previous one.

---

### Streaming

Use `agent.stream()` to receive real-time events during agent execution:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: { search: searchTool },
});

for await (const event of agent.stream("Search for TypeScript tutorials")) {
  switch (event.type) {
    case "start":
      console.log("Started at:", event.timestamp);
      break;
    case "text-delta":
      process.stdout.write(event.content);
      break;
    case "text-complete":
      console.log("\nComplete:", event.content);
      break;
    case "tool-call-start":
      console.log(`Calling ${event.name}...`);
      break;
    case "tool-call-complete":
      console.log(`${event.name} completed in ${event.durationMs}ms`);
      break;
    case "tool-call-error":
      console.error(`${event.name} failed:`, event.error);
      break;
    case "step-complete":
      console.log(`Step ${event.stepIndex} usage:`, event.usage);
      break;
    case "thinking":
      console.log("Thinking:", event.content);
      break;
    case "complete":
      console.log("Result:", event.result);
      break;
    case "error":
      console.error("Error:", event.error);
      break;
  }
}
```

Breaking out of the `for await` loop (after any event, including `start`) aborts the run's signal, which cancels the in-flight model request and any tool still running with that signal, clears the run timer, and appends nothing to history: the partial turn is discarded, so the next `run()`/`stream()` continues from the last completed turn. No further event is delivered after a break (no `complete`, no `onError`, no `onComplete`). A mid-stream abort or timeout that the consumer keeps iterating through ends the stream with a `complete` event whose `result.stopReason` is `"aborted"` or `"timeout"`; no `error` event is emitted and `onError` is not called with `phase: "api"`.

#### AgentEvent Types

| Event Type | Properties | Description |
|------------|------------|-------------|
| `start` | `timestamp` | Agent run started |
| `text-delta` | `content` | Incremental text chunk |
| `text-complete` | `content` | Full text response |
| `tool-call-start` | `name`, `input`, `toolCallId` | Tool invocation started |
| `tool-call-complete` | `name`, `output`, `toolCallId`, `durationMs` | Tool completed |
| `tool-call-error` | `name`, `error`, `toolCallId` | Tool failed |
| `step-complete` | `stepIndex`, `toolsCalled`, `usage` | LLM step completed |
| `thinking` | `content` | Extended thinking output |
| `complete` | `result` | Agent run completed |
| `error` | `error` | Agent run failed |

---

### Attachments

Pass images, PDFs, or files with your messages:

```typescript
// Multiple images
const result = await agent.run("Compare these images", {
  attachments: [
    { type: "image", source: "base64", base64: img1, mimeType: "image/png" },
    { type: "image", source: "base64", base64: img2, mimeType: "image/jpeg" },
  ],
});

// URL-based image
const result = await agent.run("Describe this image", {
  attachments: [
    { type: "image", source: "url", url: "https://example.com/image.png" },
  ],
});

// PDF document
const result = await agent.run("Summarize this document", {
  attachments: [
    { type: "pdf", source: "base64", base64: pdfData },
  ],
});

// Generic file
const result = await agent.run("Process this file", {
  attachments: [
    { type: "file", base64: fileData, mimeType: "text/csv", filename: "data.csv" },
  ],
});
```

#### Attachment Types

| Type | Source | Required Fields |
|------|--------|-----------------|
| `image` | `base64` | `base64`, `mimeType` |
| `image` | `url` | `url` |
| `pdf` | `base64` | `base64` |
| `pdf` | `url` | `url` |
| `file` | - | `base64`, `mimeType`, `filename` |

Attachments are stored in history as the SDK's own `{ type: "file", mediaType, data }` parts and survive export/import and later turns.

---

### Cost tracking

Set `pricing` to a per-model USD price table (keyed by the language model's `modelId`) to have `result.cost` populated on every `run()`/`stream()` result:

```typescript
import { createAgent, costOf, sumCost } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  pricing: {
    "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  },
});

const result = await agent.run("Hello!");
result.cost?.totalUsd;
```

#### ModelPrice

| Property | Type | Description |
|----------|------|--------------|
| `inputPerMTok` | `number` | USD per million non-cached input tokens |
| `outputPerMTok` | `number` | USD per million output tokens (reasoning tokens bill as output) |
| `cacheReadPerMTok` | `number` \| `undefined` | Falls back to `inputPerMTok` |
| `cacheWritePerMTok` | `number` \| `undefined` | Falls back to `inputPerMTok` |

#### Cost

| Property | Type | Description |
|----------|------|--------------|
| `inputUsd`, `outputUsd`, `cacheReadUsd`, `cacheWriteUsd`, `totalUsd` | `number` | USD cost by category |
| `unpricedModels` | `string[]` | modelIds seen in the run with no entry in `pricing`; their tokens are excluded from `totalUsd` |

`costOf(usage, price)` and `sumCost(steps, table)` are also exported directly, for pricing a single `LanguageModelUsage` or a caller's own array of `{ model, usage }` steps (e.g. from a raw `ToolLoopAgent`).

**Example pricing, as of 2026-09-24** (source: [claude.com/pricing](https://claude.com/pricing) — check current prices before using in production; caching write shown at the standard 5-minute TTL):

| Model | Input /MTok | Output /MTok | Cache read /MTok | Cache write /MTok |
|-------|-------------|---------------|-------------------|---------------------|
| Claude Opus 5.5 | $4 | $20 | $0.20 | $5 |
| Claude Sonnet 5 | $2 | $10 | $0.20 | $2.50 |
| Claude Haiku 4.5 | $1 | $5 | $0.10 | $1.25 |

---

### Context budget

Set `context` to bound how much history is sent to the model:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  context: {
    maxInputTokens: 60_000,
    summarize: { keepRecentTurns: 4 }, // model defaults to the agent's own model
  },
});
```

Two mechanisms work together:

- **`prepareStep` trimming**, active on every model call within a run: once the estimated tokens for a step's messages exceed `maxInputTokens`, reasoning and tool call/result content is pruned (via the SDK's `pruneMessages`) from the history that precedes the current run's user message. The current run's own messages are never touched, so thinking blocks and tool calls the provider needs returned unchanged stay intact. The estimate is `overhead + chars / ratio`: instructions and tool schemas count in `inputTokens` but not in message chars, so both terms are solved from the last two steps' (prompt chars, measured `inputTokens`) pairs. With one pair the overhead is taken as 0 and the ratio as chars/tokens, which overestimates and prunes early rather than late; with none it is chars/4. Calibration is per run.
- **Between-turn summarization**, run before a `run()`/`stream()` call whose stored history is already over budget: every turn except the most recent `keepRecentTurns` is summarized via `generateText` into one leading user message (`Summary of earlier conversation: ...`), cutting only at turn boundaries so a tool call is never separated from its result and history still starts with a user message. File and image parts are replaced with a short `[attachment: <mediaType> <filename>]` placeholder in the summarizer prompt, so base64 payloads are never sent to it. The summary call's own usage (and cost, when `pricing` is set) is folded into that run's `usage`/`cost`.

#### ContextConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxInputTokens` | `number` | - | Token budget that triggers trimming/summarization |
| `summarize.model` | `LanguageModel` | the agent's `model` | Model used to generate the summary |
| `summarize.keepRecentTurns` | `number` | `4` | Turns kept verbatim; everything older is summarized |
| `summarize.instructions` | `string` | a generic summarization prompt | System prompt for the summarization call |

`estimateTokens`, `trimForStep`, and `summarizeHistory` are also exported directly for use with a raw `ToolLoopAgent`. `summarizeHistory(history, cfg, model)` makes one `generateText` call on `model` with `maxRetries: 0` (it does not read `cfg.summarize.model`; `createAgent` picks that for it), so wrap the model yourself if you want retries. `trimForStep(cfg)` returns a `prepareStep` whose calibration state belongs to that function: build one per run.

---

### Telemetry

`telemetry` (the SDK's own `TelemetryOptions`) is forwarded straight into `ToolLoopAgent`. `traceId` (agent- or run-level) is used as `telemetry.functionId` when the caller doesn't already set one — `ai` 7 does not expose a `metadata` field on `TelemetryOptions` to attach a trace id to directly.

The package itself does not register an exporter; call the SDK's `registerTelemetry` with an integration before creating the agent.

```typescript
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { createAgent } from "@ad17-2/agent";

registerTelemetry(new OpenTelemetry());

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  telemetry: { functionId: "release-assistant" },
});
```

See:

- `examples/telemetry-console.ts` — `@ai-sdk/otel` + a `NodeTracerProvider`/`ConsoleSpanExporter`, driven by a `MockLanguageModelV4` so it runs with no API key: `pnpm example:telemetry`.
- `examples/telemetry-langfuse.ts` — `@langfuse/vercel-ai-sdk` + `@langfuse/otel` against a real Anthropic call; reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, and `ANTHROPIC_API_KEY` from env. Its wiring (`examples/langfuse-setup.ts`) is verified without keys by `tests/telemetry-langfuse.test.ts`: a local receiver gets the OTLP/HTTP JSON export at `/api/public/otel/v1/traces`, with the Basic auth header and the `invoke_agent`, `step` and `chat` spans.

---

### MCP

`loadMcpTools` is exported from the `@ad17-2/agent/mcp` subpath, not the package root, so core usage never pulls in `@ai-sdk/mcp` (an optional peer dependency — install it yourself: `pnpm add @ai-sdk/mcp`).

Only MCP tools are supported: `loadMcpTools` calls `client.tools()` and nothing else, so server prompts and resources are out of scope and not loaded.

```typescript
import { createAgent, defineTool, z } from "@ad17-2/agent";
import { loadMcpTools } from "@ad17-2/agent/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { anthropic } from "@ai-sdk/anthropic";

const mcp = await loadMcpTools([
  { name: "github", transport: { type: "http", url: process.env.GITHUB_MCP_URL! } },
  { name: "local-tools", transport: new Experimental_StdioMCPTransport({ command: "my-mcp-server" }) },
]);

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a release assistant.",
  // local tools win on a name clash with MCP tools — it's an ordinary object spread
  tools: { ...mcp.tools, myLocalTool: defineTool({ /* ... */ }) },
});

await agent.run("List open PRs");
await mcp.close();
```

#### McpServer

| Property | Type | Description |
|----------|------|--------------|
| `name` | `string` | Used in the `MCP_TOOL_CONFLICT` error message |
| `transport` | `{ type: "http" \| "sse", url, ... }` \| `MCPTransport` | An inline HTTP/SSE config, or a transport instance (e.g. `Experimental_StdioMCPTransport`) |
| `prefix` | `string` \| `undefined` | Opt-in: this server's tool names become `` `${prefix}${name}` `` |

A tool name clash **between two MCP servers** throws `AgentError("MCP_TOOL_CONFLICT")`. A clash between an MCP tool and one of your own local tools is not checked by `loadMcpTools` or `createAgent` — it's resolved by ordinary object-spread precedence in the `tools` you build. If any server fails to connect, every client already opened is closed before the error is rethrown.

---

### Hooks

The hooks system provides lifecycle callbacks for monitoring and debugging:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: { search: searchTool },

  onStart: async (input) => {
    console.log("Agent started with:", input);
  },

  onStep: async (step) => {
    console.log(`Step ${step.stepIndex}: ${step.toolsCalled.length} tools called`);
    console.log("Text generated:", step.textGenerated);
  },

  onToolCall: async (name, input) => {
    console.log(`Calling tool: ${name}`, input);
  },

  onToolResult: async (name, result) => {
    console.log(`Tool ${name} returned:`, result);
  },

  onError: async (error, context) => {
    console.error(`Error in ${context.phase}:`, error.message);
    if (context.toolName) {
      console.error(`Tool: ${context.toolName}`);
    }
  },

  onComplete: async (result) => {
    console.log("Agent completed:", result.stopReason);
    console.log("Total tokens:", result.usage.totalTokens);
  },
});
```

#### Error Context Phases

| Phase | Description |
|-------|-------------|
| `tool` | Error occurred during tool execution, including a per-tool `timeoutMs` / `toolTimeoutMs` expiry |
| `api` | Error occurred during API call |
| `timeout` | The run timeout fired (the result has `stopReason: "timeout"`) |

A tool cut off by the run's own signal (the run timeout or the caller's `RunOptions.signal`) is not also reported with `phase: "tool"`: a run timeout calls `onError` once, with `phase: "timeout"`, and a caller abort calls it not at all. A tool that fails with its own error at that moment (anything other than the abort reason or an `AbortError`) is still reported with `phase: "tool"`.

---

### `defineTool(options)`

Creates a tool definition for use with the agent.

```typescript
import { defineTool, z } from "@ad17-2/agent";

const calculator = defineTool({
  description: "Perform arithmetic calculations",
  schema: z.object({
    expression: z.string().describe("Math expression to evaluate"),
  }),
  handler: async ({ expression }) => {
    return { result: eval(expression) };
  },
});
```

#### ToolOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `description` | `string` | Yes | Description shown to the LLM |
| `schema` | `ZodType` | Yes | Zod schema for input validation |
| `handler` | `(input, context) => Promise<unknown>` | Yes | Async function to execute the tool |
| `onError` | `(context) => unknown` | No | Error recovery handler |
| `timeoutMs` | `number` | No | Timeout for this specific tool |

#### ToolContext

The `context` parameter provides:
- `signal?: AbortSignal` - Abort signal for cancellation. On timeout, this signal is aborted (not just raced) so a cooperative handler can stop immediately.
- `toolCallId?: string` - Unique identifier for this tool call

#### Tool Error Recovery

Handle errors gracefully without failing the agent:

```typescript
const fetchTool = defineTool({
  description: "Fetch data from URL",
  schema: z.object({ url: z.string().url() }),
  handler: async ({ url }) => {
    const response = await fetch(url);
    return response.json();
  },
  onError: async ({ error, input }) => {
    // Return fallback instead of throwing
    return { error: error.message, url: input.url, fallback: true };
  },
  timeoutMs: 5000,
});
```

---

### `generateStructured(options)`

Extracts typed data from LLM responses using Zod schemas, built on `generateText({ output: Output.object({ schema }) })`. It has no `retry` option and keeps the SDK's default retries (up to 2 extra attempts, only for errors the provider marks retryable).

```typescript
import { generateStructured, z } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const result = await generateStructured({
  model: anthropic("claude-sonnet-5"),
  schema: z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    confidence: z.number().min(0).max(1),
    summary: z.string(),
  }),
  prompt: "Analyze: 'This product exceeded my expectations!'",
});

console.log(result.data);
// { sentiment: "positive", confidence: 0.95, summary: "..." }

console.log(result.usage);
// { inputTokens: 42, outputTokens: 18 }
```

#### GenerateStructuredOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `model` | `LanguageModel` | Yes | Vercel AI SDK language model |
| `schema` | `ZodType` | Yes | Zod schema defining output structure |
| `prompt` | `string` | Yes | Text prompt for extraction |
| `image` | `{ base64, mimeType }` | No | Optional image input |
| `maxTokens` | `number` | No | Maximum output tokens |
| `signal` | `AbortSignal` | No | Abort signal for cancellation |

#### StructuredResult

| Property | Type | Description |
|----------|------|-------------|
| `data` | `T` | Parsed data matching the schema |
| `usage` | `{ inputTokens, outputTokens }` | Token usage statistics |

---

### Extended Thinking

Enable extended thinking for complex reasoning tasks:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a reasoning assistant.",
  tools: {},
  thinking: {
    enabled: true,
    budgetTokens: 20000, // Token budget for thinking
  },
});

const result = await agent.run("Solve this complex problem...");
console.log(result.thinking); // The model's reasoning process
```

---

### Timeout Configuration

Configure timeouts at multiple levels:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {
    slow_tool: defineTool({
      description: "A slow operation",
      schema: z.object({}),
      handler: async () => { /* ... */ },
      timeoutMs: 30000, // Per-tool timeout
    }),
  },
  timeout: {
    runTimeoutMs: 120000, // Global timeout for entire run
  },
});

// Override timeout per call
const result = await agent.run("Do something", {
  timeoutMs: 60000,
});
```

A run timeout returns `stopReason: "timeout"` and calls `onError` with `phase: "timeout"`; a caller abort via `RunOptions.signal` returns `stopReason: "aborted"` without an `onError` call. `0` means no timeout. The timer is cleared on every exit path of `run()` and `stream()`, including a stream consumer that stops iterating after any event, so a finished run does not keep the process alive.

---

### Retry Configuration

Configure automatic retry with backoff strategies. Retries apply to each model call individually (see [RetryConfig](#retryconfig)):

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  retry: {
    maxAttempts: 3,
    backoff: "exponential", // "fixed", "linear", or "exponential"
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    retryOn: (error) => {
      // Only retry rate limit errors
      return error.message.includes("rate limit");
    },
  },
});
```

---

### Logging

Integrate with your logging system:

```typescript
import { createAgent, type Logger } from "@ad17-2/agent";

const logger: Logger = {
  debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta),
  info: (msg, meta) => console.info(`[INFO] ${msg}`, meta),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta),
};

const agent = createAgent({
  model: anthropic("claude-sonnet-5"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
  logger,
  traceId: "request-123", // Correlate logs
});
```

---

### Error Handling

The SDK provides typed errors for handling failures:

```typescript
import { AgentError } from "@ad17-2/agent";

try {
  const result = await agent.run("Hello");
} catch (error) {
  if (AgentError.is(error)) {
    switch (error.code) {
      case "API_ERROR":
        console.log("API call failed:", error.message);
        break;
      case "TOOL_EXECUTION":
        console.log("Tool failed:", error.message);
        break;
      case "MAX_ITERATIONS":
        console.log("Reached iteration limit");
        break;
      case "MCP_TOOL_CONFLICT":
        console.log("Two MCP servers exposed the same tool name:", error.message);
        break;
    }
  }
}
```

`run()`/`stream()` no longer throw `AgentError("ABORTED")` on abort or timeout — those are returned as a result (`stopReason: "aborted"` / `"timeout"`) instead.

#### Error Codes

| Code | Description |
|------|-------------|
| `API_ERROR` | API call to the model failed |
| `TOOL_EXECUTION` | Tool handler threw an error |
| `TOOL_VALIDATION` | Tool input failed schema validation |
| `TOOL_NOT_FOUND` | Referenced tool does not exist |
| `MAX_ITERATIONS` | Exceeded maximum iterations |
| `ABORTED` | Reserved; no longer thrown by `run()`/`stream()` (see above) |
| `MCP_TOOL_CONFLICT` | Two MCP servers passed to `loadMcpTools` exposed the same tool name |

---

### Re-exports

The package re-exports commonly used dependencies:

```typescript
import { z } from "@ad17-2/agent";

// z - Zod for schema definitions
const schema = z.object({ name: z.string() });
```

For model providers, install and import them directly:

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

const model = anthropic("claude-sonnet-5");
```

## License

MIT
