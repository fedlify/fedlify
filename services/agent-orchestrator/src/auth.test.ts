import { describe, expect, it } from "vitest";
import { bearerAuthorized } from "./auth.js";

const token = ["orch", "token", "value"].join("-");

describe("bearerAuthorized", () => {
  it("accepts only the exact bearer token", () => {
    expect(bearerAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(bearerAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(bearerAuthorized(`bearer ${token}`, token)).toBe(false);
    expect(bearerAuthorized(token, token)).toBe(false);
  });
  it("fails closed without a header or a configured token", () => {
    expect(bearerAuthorized(undefined, token)).toBe(false);
    expect(bearerAuthorized(`Bearer ${token}`, undefined)).toBe(false);
    expect(bearerAuthorized("Bearer ", "")).toBe(false);
  });
});
