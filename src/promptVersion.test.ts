import { describe, expect, it } from "vitest";
import { fnv1a, promptVersion } from "./promptVersion";
import { SYSTEM_PROMPT } from "./system-prompt";

/**
 * The value of this is that it changes when the prompt's MEANING changes and
 * not otherwise. A version that drifts on reformatting is noise; one that
 * stays put through an edit is a lie.
 */
describe("promptVersion", () => {
  it("is stable for identical text", () => {
    expect(promptVersion("hello world")).toBe(promptVersion("hello world"));
  });

  it("changes when a word changes", () => {
    expect(promptVersion("answer in Danish")).not.toBe(promptVersion("answer in English"));
  });

  it("survives reflowing without changing", () => {
    // Rewrapping a paragraph is not a change of instruction.
    expect(promptVersion("a b   c")).toBe(promptVersion("a\n b\nc"));
    expect(promptVersion("  padded  ")).toBe(promptVersion("padded"));
  });

  it("changes when a rule is REMOVED, which is the case that matters most", () => {
    const withRule = "1. Only recommend content in the database.\n2. Answer in Danish.";
    const without = "1. Only recommend content in the database.";
    expect(promptVersion(withRule)).not.toBe(promptVersion(without));
  });

  it("is a short hex id", () => {
    expect(promptVersion(SYSTEM_PROMPT)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("distinguishes single-character edits", () => {
    // A hash that collides on near-identical prompts would be useless here.
    const ids = new Set(["a", "b", "aa", "ab", "ba"].map(promptVersion));
    expect(ids.size).toBe(5);
  });
});

describe("fnv1a", () => {
  it("stays inside 32 bits", () => {
    // Drifting into float64 would make the id runtime-dependent.
    for (const s of ["", "x", "a".repeat(5000), SYSTEM_PROMPT]) {
      expect(fnv1a(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("has a known value for the empty string (FNV offset basis)", () => {
    expect(fnv1a("")).toBe("811c9dc5");
  });
});
