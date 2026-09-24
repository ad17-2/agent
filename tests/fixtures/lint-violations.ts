// One deliberate violation per rule .oxlintrc.json enables explicitly; asserted by
// tests/lint-rules.test.ts. Excluded from `pnpm lint` and typecheck.
import { ToolSet } from "ai";

async function work(): Promise<number> {
  return 1;
}

export function floating(): void {
  work();
}

export function misused(): void {
  [1].forEach(async () => {
    await work();
  });
}

export async function awaitsNonThenable(): Promise<void> {
  await 1;
}

export const loose: any = 1;

export function unused(): void {
  const neverRead = 1;
}

export const tools: ToolSet = {};

export function logs(): void {
  console.log("hi");
}
