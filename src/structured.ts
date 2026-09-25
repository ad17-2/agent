import { generateText, Output, streamText, type DeepPartial, type LanguageModel } from "ai";
import type { z } from "zod";
import { buildUserMessage } from "./message.js";
import type { Attachment, TokenUsage } from "./types.js";
import { toTokenUsage } from "./usage.js";

export interface GenerateStructuredOptions<T extends z.ZodType> {
  model: LanguageModel;
  schema: T;
  prompt: string;
  attachments?: Attachment[];
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: TokenUsage;
}

export interface StreamStructuredResult<T> {
  partial: AsyncIterable<DeepPartial<T>>;
  output: Promise<T>;
  usage: Promise<TokenUsage>;
}

export async function generateStructured<T extends z.ZodType>(
  options: GenerateStructuredOptions<T>
): Promise<StructuredResult<z.infer<T>>> {
  const { model, schema, prompt, attachments, maxOutputTokens, abortSignal } = options;

  const result = await generateText({
    model,
    messages: [buildUserMessage(prompt, attachments)],
    output: Output.object<z.infer<T>>({ schema }),
    maxOutputTokens,
    abortSignal,
  });

  return { data: result.output, usage: toTokenUsage(result.usage) };
}

export function streamStructured<T extends z.ZodType>(
  options: GenerateStructuredOptions<T>
): StreamStructuredResult<z.infer<T>> {
  const { model, schema, prompt, attachments, maxOutputTokens, abortSignal } = options;

  const result = streamText({
    model,
    messages: [buildUserMessage(prompt, attachments)],
    output: Output.object<z.infer<T>>({ schema }),
    maxOutputTokens,
    abortSignal,
  });

  // Reading `result.output` starts the SDK's promise, so a destructured `output` the caller never awaits
  // would reject unhandled on invalid JSON; the no-op catch marks it handled without changing what an await sees.
  const output = Promise.resolve(result.output);
  output.catch(() => {});
  const usage = Promise.resolve(result.usage).then(toTokenUsage);
  usage.catch(() => {});
  return { partial: result.partialOutputStream, output, usage };
}
