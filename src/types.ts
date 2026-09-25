import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  pruneMessages,
  StopCondition,
  TelemetryOptions,
  Tool,
  ToolApprovalConfiguration,
  ToolLoopAgentSettings,
  ToolSet,
  UIMessage,
  UIMessageChunk,
} from "ai";

/** Provider-specific call options, e.g. `{ anthropic: { thinking: {...} } }`; the SDK's own type (JSON values only). */
export type ProviderOptions = NonNullable<ToolLoopAgentSettings["providerOptions"]>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryConfig {
  maxAttempts?: number;
  backoff?: BackoffStrategy;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: Error) => boolean;
}

export interface TimeoutConfig {
  totalMs?: number;
  toolMs?: number;
}

/** Setting `thinking` enables extended thinking. */
export interface ThinkingConfig {
  budgetTokens?: number;
}

export type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type AttachmentMimeType = ImageMimeType | "application/pdf";

interface BaseAttachment {
  name?: string;
}

export interface Base64ImageAttachment extends BaseAttachment {
  type: "image";
  source: "base64";
  base64: string;
  mimeType: ImageMimeType;
}

export interface UrlImageAttachment extends BaseAttachment {
  type: "image";
  source: "url";
  url: string;
}

export interface Base64PdfAttachment extends BaseAttachment {
  type: "pdf";
  source: "base64";
  base64: string;
}

export interface UrlPdfAttachment extends BaseAttachment {
  type: "pdf";
  source: "url";
  url: string;
}

export interface FileAttachment extends BaseAttachment {
  type: "file";
  base64: string;
  mimeType: string;
  filename: string;
}

export type Attachment =
  | Base64ImageAttachment
  | UrlImageAttachment
  | Base64PdfAttachment
  | UrlPdfAttachment
  | FileAttachment;

export interface ConversationConfig {
  maxMessages?: number;
  ttlMs?: number;
}

export interface ContextConfig {
  maxInputTokens: number;
  summarize?: { model?: LanguageModel; keepRecentTurns?: number; instructions?: string };
  /** How `pruneMessages` trims history once over budget; both default to `"all"`. */
  prune?: {
    reasoning?: Parameters<typeof pruneMessages>[0]["reasoning"];
    toolCalls?: Parameters<typeof pruneMessages>[0]["toolCalls"];
  };
}

// History is stored as the SDK's own messages, so nothing is lost on replay.
export type Message = ModelMessage & { timestamp?: number };

export interface SerializedHistory {
  version: 2;
  messages: Message[];
  exportedAt: number;
}

/** A version-1 (pre-ai-7) serialized history, kept only for import conversion. */
export interface SerializedHistoryV1 {
  version: 1;
  messages: Array<{
    role: "user" | "assistant";
    content: string | unknown[];
    timestamp?: number;
  }>;
  exportedAt: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface Cost {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
  unpricedModels: string[];
}

/** A tool call waiting for a human decision; `approvalId` is what `ApprovalDecision` answers. */
export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  /** Set when the provider runs the tool; the decision is then forwarded to the model. */
  providerExecuted?: true;
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/** A new message, or the decisions that resume a run stopped with `needs_approval`. */
export type AgentInput = string | { approvals: ApprovalDecision[] };

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  /** The failure message; present only when the call failed. */
  error?: string;
}

export type AgentEvent =
  | { type: "start"; timestamp: number }
  | { type: "text-delta"; content: string }
  | { type: "text-complete"; content: string }
  | { type: "tool-input-start"; name: string; toolCallId: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | { type: "tool-call-start"; name: string; input: unknown; toolCallId: string }
  | {
      type: "tool-call-complete";
      name: string;
      output: unknown;
      toolCallId: string;
      durationMs: number;
    }
  | { type: "tool-call-error"; name: string; error: string; toolCallId: string }
  | { type: "step-complete"; stepIndex: number; toolsCalled: ToolCallRecord[]; usage: TokenUsage }
  | { type: "thinking"; content: string }
  | { type: "approval-request"; approval: PendingApproval }
  | { type: "complete"; result: AgentResult }
  | { type: "error"; error: Error };

export interface StepInfo {
  stepIndex: number;
  toolsCalled: ToolCallRecord[];
  textGenerated: string;
}

export type ErrorContext =
  | { phase: "tool"; toolName: string }
  | { phase: "api" }
  | { phase: "timeout" };

export interface AgentHooks {
  onStart?: (input: string) => void | Promise<void>;
  onStep?: (step: StepInfo) => void | Promise<void>;
  onToolCall?: (toolName: string, input: unknown) => void | Promise<void>;
  onToolResult?: (toolName: string, result: unknown) => void | Promise<void>;
  onError?: (error: Error, context: ErrorContext) => void | Promise<void>;
  onComplete?: (result: AgentResult) => void | Promise<void>;
}

export interface AgentOptions extends AgentHooks {
  model: LanguageModel;
  systemPrompt: string;
  tools: ToolSet;
  maxIterations?: number;
  /** Extra stop conditions; the loop still stops at `maxIterations`. */
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  /** Runs before each step, after context trimming; its fields win and its `messages` replace the trimmed ones. */
  prepareStep?: PrepareStepFunction<ToolSet>;
  /** Which tools need approval before they run; `"user-approval"` stops the run with `needs_approval`. */
  toolApproval?: ToolApprovalConfiguration<ToolSet, { traceId?: string }>;
  maxOutputTokens?: number;
  conversation?: ConversationConfig;
  thinking?: ThinkingConfig;
  providerOptions?: ProviderOptions;
  retry?: RetryConfig;
  timeout?: TimeoutConfig;
  pricing?: PriceTable;
  context?: ContextConfig;
  telemetry?: TelemetryOptions;
  logger?: Logger;
  traceId?: string;
}

export interface RunOptions {
  attachments?: Attachment[];
  abortSignal?: AbortSignal;
  /** Overrides `timeout.totalMs` for this call; `0` disables it. */
  timeoutMs?: number;
  traceId?: string;
}

export type StopReason =
  | "end_turn"
  | "max_iterations"
  | "max_tokens"
  | "content_filter"
  | "error"
  | "aborted"
  | "timeout"
  | "stop_condition"
  | "needs_approval"
  | "other";

export interface AgentResult {
  message: string;
  toolsCalled: ToolCallRecord[];
  iterations: number;
  stopReason: StopReason;
  usage: TokenUsage;
  cost?: Cost;
  thinking?: string;
  /** Present only when `stopReason` is `"needs_approval"`. */
  pendingApprovals?: PendingApproval[];
}

export interface Agent {
  run(input: AgentInput, options?: RunOptions): Promise<AgentResult>;
  stream(
    input: AgentInput,
    options?: RunOptions
  ): AsyncGenerator<AgentEvent, AgentResult, undefined>;
  /** The approvals the last turn is waiting on, read from history; `[]` when there are none. */
  pendingApprovals(): PendingApproval[];
  /** Streams the SDK's UI message chunks for client-owned messages; history is neither read nor written. */
  uiStream(uiMessages: UIMessage[], options?: RunOptions): Promise<ReadableStream<UIMessageChunk>>;
  clearHistory(): void;
  exportHistory(): SerializedHistory;
  importHistory(history: SerializedHistory | SerializedHistoryV1): void;
}

export type { Tool, ToolSet };
