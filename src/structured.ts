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

  // Getters keep the SDK's promises lazy: one the caller never reads cannot reject unhandled.
  return {
    partial: result.partialOutputStream,
    get output() {
      return Promise.resolve(result.output);
    },
    get usage() {
      return Promise.resolve(result.usage).then(toTokenUsage);
    },
  };
}
