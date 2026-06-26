import { describe, it, expect } from "vitest";
import { isValidUuid, isSafeEntityId, clampString, clampNumber } from "./validate";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("isValidUuid", () => {
  it("accepts a valid UUID", () => {
    expect(isValidUuid(UUID)).toBe(true);
    expect(isValidUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidUuid(UUID.toUpperCase())).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(isValidUuid("123")).toBe(false);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid(`${UUID}"`)).toBe(false);
    expect(isValidUuid(`${UUID},${UUID}`)).toBe(false);
    expect(isValidUuid("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidUuid(123 as unknown)).toBe(false);
    expect(isValidUuid(null as unknown)).toBe(false);
    expect(isValidUuid(undefined as unknown)).toBe(false);
    expect(isValidUuid({} as unknown)).toBe(false);
  });
});

describe("isSafeEntityId", () => {
  it("accepts a valid UUID", () => {
    expect(isSafeEntityId(UUID)).toBe(true);
  });

  it("accepts plain digit ids", () => {
    expect(isSafeEntityId("1")).toBe(true);
    expect(isSafeEntityId("4242")).toBe(true);
    expect(isSafeEntityId("12345678901234567890")).toBe(true);
  });

  it("rejects injection payloads", () => {
    expect(isSafeEntityId("1&select=*")).toBe(false);
    expect(isSafeEntityId("1&user_id=eq.x")).toBe(false);
    expect(isSafeEntityId('1"')).toBe(false);
    expect(isSafeEntityId("(1)")).toBe(false);
    expect(isSafeEntityId("1 or 1=1")).toBe(false);
    expect(isSafeEntityId("eq.1")).toBe(false);
    expect(isSafeEntityId("abc")).toBe(false);
  });

  it("rejects overlong values", () => {
    expect(isSafeEntityId("1".repeat(21))).toBe(false); // too long for digits
    expect(isSafeEntityId("a".repeat(65))).toBe(false); // exceeds 64 cap
  });

  it("rejects empty and non-strings", () => {
    expect(isSafeEntityId("")).toBe(false);
    expect(isSafeEntityId(123 as unknown)).toBe(false);
    expect(isSafeEntityId(null as unknown)).toBe(false);
    expect(isSafeEntityId(undefined as unknown)).toBe(false);
  });
});

describe("clampString", () => {
  it("returns the string unchanged when under the cap", () => {
    expect(clampString("hej", 10)).toBe("hej");
    expect(clampString("hej", 3)).toBe("hej");
  });

  it("truncates strings over the cap", () => {
    expect(clampString("abcdef", 3)).toBe("abc");
    expect(clampString("a".repeat(5000), 4000)).toHaveLength(4000);
  });

  it("preserves Danish characters within the cap", () => {
    expect(clampString("smørrebrød på Vesterbro", 100)).toBe("smørrebrød på Vesterbro");
  });

  it("coerces non-strings to empty string", () => {
    expect(clampString(123 as unknown, 10)).toBe("");
    expect(clampString(null as unknown, 10)).toBe("");
    expect(clampString(undefined as unknown, 10)).toBe("");
    expect(clampString({} as unknown, 10)).toBe("");
    expect(clampString(["a"] as unknown, 10)).toBe("");
  });
});

describe("clampNumber", () => {
  it("passes through in-range values unchanged", () => {
    expect(clampNumber(10, 1, 50, 5)).toBe(10);
    expect(clampNumber(0.3, 0, 1, 0.5)).toBe(0.3);
  });

  it("returns the boundary values when exactly at min/max", () => {
    expect(clampNumber(1, 1, 50, 10)).toBe(1);
    expect(clampNumber(50, 1, 50, 10)).toBe(50);
    expect(clampNumber(0, 0, 1, 0.3)).toBe(0);
    expect(clampNumber(1, 0, 1, 0.3)).toBe(1);
  });

  it("clamps below-min values up to min", () => {
    expect(clampNumber(0, 1, 50, 10)).toBe(1);
    expect(clampNumber(-5, 1, 50, 10)).toBe(1);
    expect(clampNumber(-0.2, 0, 1, 0.3)).toBe(0);
  });

  it("clamps above-max values down to max", () => {
    expect(clampNumber(9999, 1, 50, 10)).toBe(50);
    expect(clampNumber(5, 0, 1, 0.3)).toBe(1);
  });

  it("falls back for NaN, Infinity, and non-numbers", () => {
    expect(clampNumber(NaN, 1, 50, 10)).toBe(10);
    expect(clampNumber(Infinity, 1, 50, 10)).toBe(10);
    expect(clampNumber(-Infinity, 1, 50, 10)).toBe(10);
    expect(clampNumber("20" as unknown, 1, 50, 10)).toBe(10);
    expect(clampNumber(null as unknown, 1, 50, 10)).toBe(10);
    expect(clampNumber(undefined as unknown, 1, 50, 10)).toBe(10);
    expect(clampNumber({} as unknown, 1, 50, 10)).toBe(10);
  });
});
