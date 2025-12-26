import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

export interface GenerateStructuredOptions<T extends z.ZodTypeAny> {
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

export async function generateStructured<T extends z.ZodTypeAny>(
  options: GenerateStructuredOptions<T>
): Promise<StructuredResult<z.infer<T>>> {
  const { model, schema, prompt, image, maxTokens, signal } = options;

  const messages = image
    ? [
        {
          role: "user" as const,
          content: [
            { type: "image" as const, image: image.base64, mimeType: image.mimeType },
            { type: "text" as const, text: prompt },
          ],
        },
      ]
    : [{ role: "user" as const, content: prompt }];

  const result = await generateObject({
    model,
    schema,
    messages,
    maxOutputTokens: maxTokens,
    abortSignal: signal,
  });

  return {
    data: result.object as z.infer<T>,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}
