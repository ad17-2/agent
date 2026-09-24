import { generateText, Output, type LanguageModel, type ModelMessage } from "ai";
import type { z } from "zod";

export interface GenerateStructuredOptions<T extends z.ZodType> {
  model: LanguageModel;
  schema: T;
  prompt: string;
  image?: {
    base64: string;
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  };
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export async function generateStructured<T extends z.ZodType>(
  options: GenerateStructuredOptions<T>
): Promise<StructuredResult<z.infer<T>>> {
  const { model, schema, prompt, image, maxTokens, signal } = options;

  const messages: ModelMessage[] = image
    ? [
        {
          role: "user",
          content: [
            { type: "file", data: image.base64, mediaType: image.mimeType },
            { type: "text", text: prompt },
          ],
        },
      ]
    : [{ role: "user", content: prompt }];

  const result = await generateText({
    model,
    messages,
    output: Output.object({ schema }),
    maxOutputTokens: maxTokens,
    abortSignal: signal,
  });

  return {
    data: result.output as z.infer<T>,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}
