export type AgentErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_VALIDATION"
  | "TOOL_EXECUTION"
  | "API_ERROR"
  | "MAX_ITERATIONS"
  | "ABORTED"
  | "MCP_TOOL_CONFLICT";

export class AgentError extends Error {
  override readonly name = "AgentError";

  constructor(
    message: string,
    public readonly code: AgentErrorCode,
    public override readonly cause?: Error
  ) {
    super(message);
  }

  static is(error: unknown): error is AgentError {
    return error instanceof AgentError;
  }
}
