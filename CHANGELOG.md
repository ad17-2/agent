# Changelog

## [Unreleased]

### Fixed

- The `step-complete` stream event always had an empty `toolsCalled`; it now carries the step's tool records, including failed calls.

## [0.5.0] - 2026-09-24

### Breaking Changes

See [Migrating from 0.4.x](README.md#migrating-from-04x) for the full list.

- Requires Node.js >= 22 and `ai` 7. The loop is built on `ToolLoopAgent`.
- Serialized history is version 2 and stores the SDK's `ModelMessage`s. `importHistory()` still accepts version 1.
- `ImageInput`, `ContentBlock` and `RunOptions.image` are removed.
- `stopReason` is mapped from the SDK's finish reason. Aborts and timeouts return a result instead of throwing.
- `retry.retryOn` defaults to the provider's retryable flag, so a 400 is attempted once.

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
