# @ad17-2/agent

Lightweight agentic loop powered by Vercel AI SDK.

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

Requires Node.js >= 18.

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
  model: anthropic("claude-sonnet-4-20250514"),
  systemPrompt: "You are a helpful assistant with access to weather data.",
  tools: { get_weather: weatherTool },
});

const result = await agent.run("What's the weather in Tokyo?");
console.log(result.message);
console.log(result.usage); // { inputTokens: 150, outputTokens: 42, totalTokens: 192 }
```

## API Reference

### `createAgent(options)`

Creates an agent instance with conversation history management and tool calling capabilities.

```typescript
import { createAgent } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const agent = createAgent({
  model: anthropic("claude-sonnet-4-20250514"),
  systemPrompt: "You are a helpful assistant.",
  tools: {},
});

const result = await agent.run("Hello!");
```

#### AgentOptions

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `model` | `LanguageModel` | Yes | - | Vercel AI SDK language model instance |
| `systemPrompt` | `string` | Yes | - | System prompt for the agent |
| `tools` | `Record<string, Tool>` | Yes | - | Map of tool names to tool definitions |
| `maxIterations` | `number` | No | `10` | Maximum tool-calling iterations per run |
| `maxTokens` | `number` | No | `4096` | Maximum output tokens per response |
| `conversation` | `ConversationConfig` | No | - | Conversation history settings |
| `thinking` | `ThinkingConfig` | No | - | Extended thinking configuration |
| `retry` | `RetryConfig` | No | - | Retry configuration with backoff |
| `timeout` | `TimeoutConfig` | No | - | Timeout configuration |
| `logger` | `Logger` | No | - | Logger for tracing/debugging |
| `traceId` | `string` | No | - | Trace ID for request correlation |
| `onStart` | `(input) => void` | No | - | Called when agent run begins |
| `onStep` | `(step) => void` | No | - | Called after each step completes |
| `onToolCall` | `(name, input) => void` | No | - | Called when a tool is invoked |
| `onToolResult` | `(name, result) => void` | No | - | Called when a tool returns |
| `onError` | `(error, context) => void` | No | - | Called on errors with phase context |
| `onComplete` | `(result) => void` | No | - | Called when agent run completes |

#### ConversationConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxMessages` | `number` | `20` | Maximum messages to retain in history |
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
| `retryOn` | `(error) => boolean` | `() => true` | Predicate to determine if error is retryable |

#### TimeoutConfig

| Option | Type | Description |
|--------|------|-------------|
| `runTimeoutMs` | `number` | Global timeout for the entire run |
| `toolTimeoutMs` | `number` | Default timeout for tool execution |

#### RunOptions

| Option | Type | Description |
|--------|------|-------------|
| `attachments` | `Attachment[]` | Array of images, PDFs, or files |
| `image` | `ImageInput` | (Deprecated) Use `attachments` instead |
| `signal` | `AbortSignal` | Abort signal for cancellation |
| `timeoutMs` | `number` | Override run timeout for this call |
| `traceId` | `string` | Override trace ID for this call |

#### AgentResult

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | The agent's final response |
| `toolsCalled` | `ToolCallRecord[]` | List of tools invoked during the run |
| `iterations` | `number` | Number of LLM steps taken |
| `stopReason` | `StopReason` | `"end_turn"`, `"max_iterations"`, `"error"`, `"aborted"`, `"timeout"` |
| `usage` | `TokenUsage` | Token usage statistics |
| `thinking` | `string` | Extended thinking output (if enabled) |

#### TokenUsage

| Property | Type | Description |
|----------|------|-------------|
| `inputTokens` | `number` | Input tokens consumed |
| `outputTokens` | `number` | Output tokens generated |
| `totalTokens` | `number` | Total tokens used |

#### Methods

```typescript
// Run the agent
const result = await agent.run("Hello!");

// Clear conversation history
agent.clearHistory();

// Export history for persistence
const history = agent.exportHistory();
localStorage.setItem("agent-history", JSON.stringify(history));

// Import history
const saved = JSON.parse(localStorage.getItem("agent-history"));
agent.importHistory(saved);
```

---

### Streaming

Use `agent.stream()` to receive real-time events during agent execution:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-4-20250514"),
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

#### AgentEvent Types

| Event Type | Properties | Description |
|------------|------------|-------------|
| `start` | `timestamp` | Agent run started |
| `text-delta` | `content` | Incremental text chunk |
| `text-complete` | `content` | Full text response |
| `tool-call-start` | `name`, `input`, `toolCallId` | Tool invocation started |
| `tool-call-complete` | `name`, `output`, `toolCallId`, `durationMs` | Tool completed |
| `tool-call-error` | `name`, `error`, `toolCallId` | Tool failed |
| `step-complete` | `stepIndex`, `toolsCalled` | LLM step completed |
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

---

### Hooks

The hooks system provides lifecycle callbacks for monitoring and debugging:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-4-20250514"),
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
| `tool` | Error occurred during tool execution |
| `api` | Error occurred during API call |
| `timeout` | Request timed out |

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
- `signal?: AbortSignal` - Abort signal for cancellation
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

Extracts typed data from LLM responses using Zod schemas.

```typescript
import { generateStructured, z } from "@ad17-2/agent";
import { anthropic } from "@ai-sdk/anthropic";

const result = await generateStructured({
  model: anthropic("claude-sonnet-4-20250514"),
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
| `image` | `ImageInput` | No | Optional image input |
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
  model: anthropic("claude-sonnet-4-20250514"),
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
  model: anthropic("claude-sonnet-4-20250514"),
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

---

### Retry Configuration

Configure automatic retry with backoff strategies:

```typescript
const agent = createAgent({
  model: anthropic("claude-sonnet-4-20250514"),
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
  model: anthropic("claude-sonnet-4-20250514"),
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
      case "ABORTED":
        console.log("Request was cancelled or timed out");
        break;
      case "API_ERROR":
        console.log("API call failed:", error.message);
        break;
      case "TOOL_EXECUTION":
        console.log("Tool failed:", error.message);
        break;
      case "MAX_ITERATIONS":
        console.log("Reached iteration limit");
        break;
    }
  }
}
```

#### Error Codes

| Code | Description |
|------|-------------|
| `ABORTED` | Request was cancelled or timed out |
| `API_ERROR` | API call to the model failed |
| `TOOL_EXECUTION` | Tool handler threw an error |
| `TOOL_VALIDATION` | Tool input failed schema validation |
| `TOOL_NOT_FOUND` | Referenced tool does not exist |
| `MAX_ITERATIONS` | Exceeded maximum iterations |

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

const model = anthropic("claude-sonnet-4-20250514");
```

## License

MIT
