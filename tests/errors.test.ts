import { describe, it, expect } from "vitest";
import { AgentError } from "../src/errors.js";

describe("AgentError", () => {
  it("creates error with message and code", () => {
    const error = new AgentError("Something went wrong", "API_ERROR");

    expect(error.message).toBe("Something went wrong");
    expect(error.code).toBe("API_ERROR");
    expect(error.name).toBe("AgentError");
    expect(error.cause).toBeUndefined();
  });

  it("includes cause when provided", () => {
    const cause = new Error("Original error");
    const error = new AgentError("Wrapped error", "API_ERROR", cause);

    expect(error.cause).toBe(cause);
  });

  it("is detects AgentError instances", () => {
    const agentError = new AgentError("Test", "INVALID_HISTORY");
    const regularError = new Error("Test");

    expect(AgentError.is(agentError)).toBe(true);
    expect(AgentError.is(regularError)).toBe(false);
    expect(AgentError.is(null)).toBe(false);
    expect(AgentError.is(undefined)).toBe(false);
  });
});
