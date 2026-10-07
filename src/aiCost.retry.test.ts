import { describe, it, expect } from "vitest";
import { runAiCounted, isTransientAiError } from "./aiCost";
describe("runAiCounted transient retry", () => {
  it("retries once on 3040 capacity and succeeds", async () => {
    let n = 0;
    const ai = { run: async () => { n++; if (n === 1) throw new Error("3040: Capacity temporarily exceeded, please try again."); return { response: "ok" }; } };
    expect(await runAiCounted(ai, "@cf/meta/llama-4-scout-17b-16e-instruct", {})).toEqual({ response: "ok" });
    expect(n).toBe(2);
  });
  it("does not retry quota errors", async () => {
    let n = 0;
    const ai = { run: async () => { n++; throw new Error("3036: daily free allocation exceeded"); } };
    await expect(runAiCounted(ai, "m", {})).rejects.toThrow("3036");
    expect(n).toBe(1);
  });
  it("classifies codes", () => {
    expect(isTransientAiError(new Error("4009: An internal server error occured."))).toBe(true);
    expect(isTransientAiError(new Error("502 bad gateway"))).toBe(true);
    expect(isTransientAiError(new Error("429 too many"))).toBe(false);
  });
});
