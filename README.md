# @ad17-2/agent

Lightweight agentic loop for Claude powered by Vercel AI SDK.

## Installation

```bash
# .npmrc
@ad17-2:registry=https://npm.pkg.github.com

# install
pnpm add @ad17-2/agent
```

Requires Node.js >= 18.

## Quick Start

```typescript
import { createAgent, defineTool, anthropic, z } from "@ad17-2/agent";

const weatherTool = defineTool({
  name: "get_weather",
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
```

## API Reference

### `createAgent(options)`

Creates an agent instance with conversation history management and tool calling capabilities.

```typescript
import { createAgent, anthropic } from "@ad17-2/agent";

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
| `onToolCall` | `(name, input) => void` | No | - | Callback when a tool is called |
| `onToolResult` | `(name, result) => void` | No | - | Callback when a tool returns |

#### ConversationConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxMessages` | `number` | `20` | Maximum messages to retain in history |
| `ttlMs` | `number` | `600000` | Time-to-live for history (10 minutes) |

#### RunOptions

| Option | Type | Description |
|--------|------|-------------|
| `image` | `ImageInput` | Image input with `base64` and `mimeType` |
| `signal` | `AbortSignal` | Abort signal for cancellation |

#### AgentResult

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | The agent's final response |
| `toolsCalled` | `ToolCallRecord[]` | List of tools invoked during the run |
| `iterations` | `number` | Number of LLM steps taken |
| `stopReason` | `StopReason` | Why the agent stopped (`"end_turn"`, `"max_iterations"`, `"error"`, `"aborted"`) |

#### Methods

```typescript
// Run the agent with optional image input
const result = await agent.run("Describe this image", {
  image: { base64: "...", mimeType: "image/png" },
});

// Clear conversation history
agent.clearHistory();
```

---

### `defineTool(options)`

Creates a tool definition for use with the agent.

```typescript
import { defineTool, z } from "@ad17-2/agent";

const calculator = defineTool({
  name: "calculate",
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

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Tool identifier |
| `description` | `string` | Description shown to the LLM |
| `schema` | `ZodType` | Zod schema for input validation |
| `handler` | `(input, context) => Promise<unknown>` | Async function to execute the tool |

The `context` parameter provides:
- `signal?: AbortSignal` - Abort signal for cancellation

---

### `generateStructured(options)`

Extracts typed data from LLM responses using Zod schemas.

```typescript
import { generateStructured, anthropic, z } from "@ad17-2/agent";

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

### Re-exports

The package re-exports commonly used dependencies:

```typescript
import { anthropic, createAnthropic, z } from "@ad17-2/agent";

// anthropic - Pre-configured Anthropic provider
const model = anthropic("claude-sonnet-4-20250514");

// createAnthropic - Create custom Anthropic provider
const custom = createAnthropic({ apiKey: "..." });

// z - Zod for schema definitions
const schema = z.object({ name: z.string() });
```

## License

MIT
