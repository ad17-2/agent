# Changelog

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
