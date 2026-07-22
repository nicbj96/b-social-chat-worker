import { describe, expect, it } from "vitest";
import { GOLDEN_SET, scoreGoldenSet } from "./golden-set";
import { inferDiscoveryIntent } from "./discovery-fallback";

// The suite unit tests could not replace: does the whole intent layer still
// give a sensible reading of a normal question? Every rule behind the
// Nordjylland bug was individually correct.

describe("golden set", () => {
  it("scores 100% -- any failure below names the query and why it is in the set", () => {
    const result = scoreGoldenSet((q) => inferDiscoveryIntent(q, undefined));
    if (result.failures.length > 0) {
      const detail = result.failures
        .map((f) => `  "${f.query}"\n    ${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}\n    why this case exists: ${f.note}`)
        .join("\n");
      throw new Error(`${result.failures.length} of ${result.total} golden cases failed:\n${detail}`);
    }
    expect(result.passed).toBe(result.total);
  });

  // A golden set that quietly shrinks stops being a safety net. This is the
  // cheapest possible guard against someone deleting the case that annoys them.
  it("keeps at least 20 cases and every case carries a reason", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(20);
    for (const c of GOLDEN_SET) {
      expect(c.note, `case "${c.query}" has no note`).toBeTruthy();
      expect(c.query.trim().length).toBeGreaterThan(2);
    }
  });

  // The set is worthless if it cannot fail. This proves the scorer actually
  // compares, rather than passing everything it is handed.
  it("fails loudly when the intent layer regresses", () => {
    const broken = scoreGoldenSet(() => ({ kind: "both" })); // never infers a city
    expect(broken.failures.length).toBeGreaterThan(10);
    expect(broken.failures.some((f) => f.query.includes("Nordjylland"))).toBe(true);
  });
});
