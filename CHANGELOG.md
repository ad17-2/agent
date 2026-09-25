# Changelog

## [0.6.0] - Unreleased

### Breaking

- `AgentOptions.maxTokens` is `maxOutputTokens`.
- `TimeoutConfig.{runTimeoutMs, toolTimeoutMs}` is `{totalMs, toolMs}`, the names the AI SDK's `TimeoutConfiguration` uses. `RunOptions.timeoutMs` is unchanged and overrides `totalMs` for one call.
- `RunOptions.signal`, `GenerateStructuredOptions.signal` and `ToolContext.signal` are `abortSignal`.
- `ToolCallRecord.error` is the failure message (`string`), present only when the call failed. `errorMessage` is removed.
- `ThinkingConfig.enabled` is removed. Setting `thinking` enables extended thinking.
- Error code `TOOL_VALIDATION` is `INVALID_HISTORY`. `TOOL_NOT_FOUND`, `TOOL_EXECUTION`, `MAX_ITERATIONS` and `ABORTED` are removed; nothing threw them.
- `generateStructured`: `maxTokens` is `maxOutputTokens`, `image` is replaced by `attachments` (the `RunOptions` shape), and `usage` is a full `TokenUsage`.
- `ErrorContext` is a union: `toolName` exists only when `phase` is `"tool"`.
- A run that a stop condition ends while the model still wants tools has `stopReason: "stop_condition"`. It was `"other"`.

### Fixed

- `RunOptions.traceId` is used as the telemetry `functionId` for that run. Only the agent-level `traceId` was used.
- The `step-complete` stream event carries the step's tool records, including failed calls. It was always empty.
- Tool durations come from the SDK's per-step timing, so a run cannot report another run's duration when tool call ids repeat.
- A successful `ToolCallRecord` has no `error` key.

### Changed

- `generateStructured` accepts PDFs and files as well as images.
- `DefinedTool`, `ProviderOptions`, `ImageMimeType` and `AttachmentMimeType` are exported.
- `package.json` declares `sideEffects: false`.
- Runnable examples for every feature under `examples/`, run by `pnpm examples` and in CI.
- `AgentOptions.stopWhen` adds SDK stop conditions to the `maxIterations` cap. `isStepCount`, `hasToolCall`, `isLoopFinished` and the `StopCondition` type are re-exported.
- `AgentOptions.prepareStep` runs the SDK's `PrepareStepFunction` before each step, after context trimming. The `PrepareStepFunction` type is re-exported.
- `ContextConfig.prune` sets the `pruneMessages` options for in-run trimming. `pruneMessages` is re-exported.
- `defineTool` takes `toModelOutput`, `onInputStart`, `onInputDelta` and `onInputAvailable`. The `ToolResultOutput` type is exported.
- `defineDynamicTool` defines a tool whose input is not known until run time.
- `stream()` yields `tool-input-start` and `tool-input-delta` events.
- `streamStructured` streams structured output: `partial` objects as the JSON arrives, then `output` and `usage`.
- `agent.uiStream(uiMessages)` returns the SDK's UI message stream for a chat UI. It does not touch history. `createUIMessageStreamResponse`, `UIMessage` and `UIMessageChunk` are re-exported.

### Migrating from 0.5.x

| 0.5.x | 0.6.0 |
|-------|-------|
| `createAgent({ maxTokens })` | `createAgent({ maxOutputTokens })` |
| `timeout: { runTimeoutMs, toolTimeoutMs }` | `timeout: { totalMs, toolMs }` |
| `agent.run(input, { signal })` | `agent.run(input, { abortSignal })` |
| `handler: (input, { signal })` | `handler: (input, { abortSignal })` |
| `record.error === true`, `record.errorMessage` | `record.error !== undefined`, `record.error` |
| `thinking: { enabled: true, budgetTokens }` | `thinking: { budgetTokens }` |
| `thinking: { enabled: false }` | omit `thinking` |
| `error.code === "TOOL_VALIDATION"` | `error.code === "INVALID_HISTORY"` |
| `generateStructured({ image: { base64, mimeType } })` | `generateStructured({ attachments: [{ type: "image", source: "base64", base64, mimeType }] })` |
| `generateStructured({ maxTokens, signal })` | `generateStructured({ maxOutputTokens, abortSignal })` |

## [0.5.0] - 2026-09-24

### Breaking Changes

- Requires Node.js >= 22 and `ai` 7. The loop is built on `ToolLoopAgent`.
- Serialized history is version 2 and stores the SDK's `ModelMessage`s. `importHistory()` still accepts version 1.
- `ImageInput`, `ContentBlock` and `RunOptions.image` are removed.
- `stopReason` is mapped from the SDK's finish reason. Aborts and timeouts return a result instead of throwing.
- `retry.retryOn` defaults to the provider's retryable flag, so a 400 is attempted once.

### Migrating from 0.4.x

- Use Node.js 22 or later. The package is ESM only and built on `ai` 7's `ToolLoopAgent`.
- Serialized history is version 2: `messages` are the SDK's `ModelMessage`s, so tool calls and results survive export and import. `importHistory()` still accepts a version 1 export and keeps its text.
- `ImageInput` and `ContentBlock` are removed. Pass images, PDFs and files in `RunOptions.attachments`, which keeps its shape.
- `RunOptions.image` is removed. Use `attachments`.
- `stopReason` values follow the SDK's finish reason. The output-token cap is `max_tokens` and the step cap is `max_iterations`. `content_filter`, `aborted`, `timeout` and `other` are returned. Aborts and timeouts return a result instead of throwing `AgentError("ABORTED")`.
- `TokenUsage` reports `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens`.
- A tool timeout aborts the tool's signal instead of only racing it.
- `retry.retryOn` defaults to the provider's own classification (429, 5xx, overloaded, failed connections), so a 400 or 401 is attempted once. Pass your own `retryOn` to retry everything.

### Added

- Per-model dollar cost on `AgentResult.cost`, from a caller-supplied `pricing` table.
- Token-budget context management: old tool results are pruned during a run, and old turns are summarised between runs.
- The `telemetry` option is forwarded to the SDK's OpenTelemetry integration. Examples for a console exporter and Langfuse.
- `@ad17-2/agent/mcp`: `loadMcpTools()` loads tools from MCP servers.
- `providerOptions`, deep-merged per provider over `thinking`.
- `TokenUsage` reports cache read/write and reasoning tokens.

### Fixed

- Turns with images or attachments, and tool calls and results, are kept in history. They used to be dropped on the next run.
- An output-token cap was reported as `max_iterations`, and the step cap as `end_turn`.
- A retry repeated tools that had already run. Retries now wrap each model call.
- `stream()` retries a failed call before any content arrives. Breaking out of the loop cancels the request.
- History eviction keeps tool calls and their results in the same turn.
- `timeout.toolTimeoutMs` was documented but never read. Tool timeouts now abort the tool's signal.
- The `tool-call-error` and `step-complete` stream events are now emitted.

### Tooling

- Linting moved to oxlint (type-aware), formatting to Biome, and the build to tsdown. TypeScript 7, Vitest 5 and pnpm 12. Package checks use publint and attw.

## [0.4.1] - 2025-12-26

### Changed

- **Internal refactor**: Reorganized codebase into modular architecture with no functional changes.
  - `src/agent/` - Agent factory, history manager, tool wrapper
  - `src/message/` - Message building utilities
  - `src/utils/` - Retry, timeout, and async utilities
- **Tests relocated**: Moved from `src/*.test.ts` to `tests/` folder.

## [0.4.0] - 2025-12-26

### Breaking Changes

- **Removed `anthropic` re-export**: Users should now import providers directly from `@ai-sdk/anthropic` or other provider packages. This makes the SDK truly model-agnostic.
- **`image` option deprecated**: Use `attachments` array instead for multi-modal inputs.

### Added

- **Streaming support**: New `agent.stream()` method returns `AsyncGenerator<AgentEvent>` for real-time responses with events: `start`, `text-delta`, `text-complete`, `tool-call-start`, `tool-call-complete`, `thinking`, `step-complete`, `complete`, `error`.
- **Token usage tracking**: `AgentResult.usage` now includes `inputTokens`, `outputTokens`, and `totalTokens`.
- **Extended hooks system**: New lifecycle callbacks `onStart`, `onStep`, `onError`, `onComplete` in addition to existing `onToolCall` and `onToolResult`.
- **Tool error recovery**: `defineTool()` now accepts `onError` handler to gracefully recover from tool failures instead of crashing.
- **History serialization**: New `agent.exportHistory()` and `agent.importHistory()` methods for persisting conversation state.
- **Multi-attachment support**: New `attachments` option in `RunOptions` supporting multiple images (base64/URL), PDFs (base64/URL), and generic files.
- **Extended thinking**: New `thinking` option with `enabled` and `budgetTokens` for Claude's extended thinking mode.
- **Timeout configuration**: Global `timeout.runTimeoutMs`, `timeout.toolTimeoutMs` in agent options, and per-tool `timeoutMs` in `defineTool()`.
- **Retry configuration**: New `retry` option with `maxAttempts`, `backoff` (fixed/linear/exponential), `initialDelayMs`, `maxDelayMs`, and `retryOn` predicate.
- **Logging support**: New `logger` option accepting a `Logger` interface with `debug`, `info`, `warn`, `error` methods.
- **Trace ID support**: New `traceId` option at agent and run level for distributed tracing.
- **Tool context enhancement**: `ToolContext` now includes `toolCallId` in addition to `signal`.

### Changed

- Test suite expanded from 19 to 36 tests covering all new functionality.

## [0.3.0] - 2025-12-26

### Breaking Changes

- **`defineTool`**: Removed unused `name` property from `ToolOptions`. Tool names are determined by the key in the tools object passed to `createAgent`.

### Fixed

- **`durationMs`**: Tool call duration is now measured accurately instead of always being `0`.
- **`ToolContext.signal`**: Abort signal is now correctly passed to tool handlers.

### Added

- Test suite with 19 tests covering agent, tool, structured output, and error handling.

## [0.2.0] - 2025-12-26

### Added

- `generateStructured()` for extracting typed data from LLM responses using Zod schemas.

## [0.1.0] - 2025-12-26

### Added

- Initial release.
- `createAgent()` with conversation history management and tool calling.
- `defineTool()` helper for creating tools.
- Re-exports: `anthropic`, `createAnthropic`, `z` (Zod).
