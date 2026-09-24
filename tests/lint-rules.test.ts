import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));

const oxlintReport = z.object({ diagnostics: z.array(z.object({ code: z.string() })) });

function run(args: string[]) {
  return spawnSync("pnpm", args, { cwd: root, encoding: "utf8" });
}

describe("oxlint rules", () => {
  it("reports every rule the config relies on for the violations fixture", () => {
    const result = run([
      "exec",
      "oxlint",
      "--type-aware",
      "--format",
      "json",
      "tests/fixtures/lint-violations.ts",
    ]);
    const codes = new Set(
      oxlintReport.parse(JSON.parse(result.stdout)).diagnostics.map((d) => d.code)
    );

    expect(result.status).toBe(1);
    for (const code of [
      "typescript(no-floating-promises)",
      "typescript(no-misused-promises)",
      "typescript(await-thenable)",
      "typescript(no-explicit-any)",
      "typescript(consistent-type-imports)",
      "eslint(no-unused-vars)",
      "eslint(no-console)",
    ]) {
      expect(codes, code).toContain(code);
    }
  });

  it("keeps `pnpm lint` clean", () => {
    const result = run(["run", "--silent", "lint"]);

    expect(result.stdout + result.stderr).not.toMatch(/\b(error|warning)\b/i);
    expect(result.status).toBe(0);
  });
});
