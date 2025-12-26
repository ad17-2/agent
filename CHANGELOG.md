# Changelog

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
