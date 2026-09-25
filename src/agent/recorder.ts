import type { StepResult, ToolSet } from "ai";
import type { AgentHooks, ToolCallRecord } from "../types.js";

function toolCallRecords(step: StepResult<ToolSet>): ToolCallRecord[] {
  const errorsById = new Map(
    step.content
      .filter(
        (part): part is Extract<typeof part, { type: "tool-error" }> => part.type === "tool-error"
      )
      .map((part) => [part.toolCallId, part])
  );
  const resultsById = new Map(step.toolResults.map((result) => [result.toolCallId, result]));
  const requestedIds = new Set<string>();
  const deniedById = new Map<string, string | undefined>();
  for (const part of step.content) {
    if (part.type === "tool-approval-request") requestedIds.add(part.toolCall.toolCallId);
    if (part.type === "tool-approval-response" && !part.approved) {
      deniedById.set(part.toolCall.toolCallId, part.reason);
    }
  }

  return step.toolCalls.flatMap((call) => {
    const errorPart = errorsById.get(call.toolCallId);
    const result = resultsById.get(call.toolCallId);
    const denied = deniedById.has(call.toolCallId);
    // A call waiting for a human never ran, so it has no record until the resume.
    if (!errorPart && !result && !denied && requestedIds.has(call.toolCallId)) return [];

    const record: ToolCallRecord = {
      name: call.toolName,
      input: call.input,
      output: result?.output,
      durationMs: step.performance.toolExecutionMs[call.toolCallId] ?? 0,
    };
    if (errorPart) {
      record.error =
        errorPart.error instanceof Error ? errorPart.error.message : String(errorPart.error);
    } else if (denied) {
      const reason = deniedById.get(call.toolCallId);
      record.error = reason === undefined ? "denied" : `denied: ${reason}`;
    }
    return [record];
  });
}

/** Per-turn step state: the single owner of toolsCalled and the step index for run() and stream(). */
export class StepRecorder {
  readonly toolsCalled: ToolCallRecord[] = [];
  /** Filled by onToolExecutionEnd, which the SDK awaits before it enqueues the tool-result part. */
  readonly toolTimings: Map<string, number> = new Map();
  /** Steps that have ended. */
  stepIndex = 0;
  private readonly onStep: AgentHooks["onStep"];
  private readonly byStep: ToolCallRecord[][] = [];
  private taken = 0;
  private wake: (() => void) | undefined;

  constructor(onStep: AgentHooks["onStep"]) {
    this.onStep = onStep;
  }

  onToolExecutionEnd(event: { toolCall: { toolCallId: string }; toolExecutionMs: number }): void {
    this.toolTimings.set(event.toolCall.toolCallId, event.toolExecutionMs);
  }

  async onStepEnd(step: StepResult<ToolSet>): Promise<void> {
    const stepTools = toolCallRecords(step);
    this.toolsCalled.push(...stepTools);
    await this.onStep?.({
      stepIndex: step.stepNumber,
      toolsCalled: stepTools,
      textGenerated: step.text,
    });
    this.byStep[step.stepNumber] = stepTools;
    this.stepIndex = step.stepNumber + 1;
    this.wake?.();
  }

  /**
   * The next step's records for the stream's step-complete event. The SDK enqueues `finish-step`
   * before it runs `onStepEnd`, so this waits for the step to end. If the stream settles first,
   * the records are built from the settled steps instead, so a lost callback cannot read as "no tools".
   */
  async takeStep(
    settled: PromiseLike<ReadonlyArray<StepResult<ToolSet>> | undefined>
  ): Promise<{ stepIndex: number; toolsCalled: ToolCallRecord[] }> {
    const stepIndex = this.taken++;
    let records = this.byStep[stepIndex];
    while (!records) {
      const steps = await Promise.race([
        new Promise<undefined>((resolve) => {
          this.wake = () => resolve(undefined);
        }),
        settled,
      ]);
      records = this.byStep[stepIndex];
      if (steps) {
        records ??= steps[stepIndex] ? toolCallRecords(steps[stepIndex]) : [];
        break;
      }
    }
    return { stepIndex, toolsCalled: records ?? [] };
  }
}
