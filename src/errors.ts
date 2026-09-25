export type AgentErrorCode =
  | "API_ERROR"
  | "INVALID_HISTORY"
  | "MCP_TOOL_CONFLICT"
  | "INVALID_APPROVAL"
  | "APPROVAL_PENDING";

export class AgentError extends Error {
  override readonly name = "AgentError";
  readonly code: AgentErrorCode;
  override readonly cause?: Error;

  constructor(message: string, code: AgentErrorCode, cause?: Error) {
    super(message);
    this.code = code;
    this.cause = cause;
  }

  static is(error: unknown): error is AgentError {
    return error instanceof AgentError;
  }
}
