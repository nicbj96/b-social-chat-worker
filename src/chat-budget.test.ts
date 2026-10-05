import { describe, expect, it } from "vitest";
import { TurnBudget, CHAT_TURN_BUDGET, TurnBudgetExceeded } from "./chat-budget";

// Plan §9 P186–190: en almindelig discoverytur højst to modelkald og ét
// embeddingkald som startbudget, med ærlige caps og deterministisk fallback.
describe("TurnBudget — bounded startbudget per turn", () => {
  it("allows exactly two model calls and one embedding call per turn", () => {
    const b = new TurnBudget();
    b.reserveModel(); b.reserveModel();
    b.reserveEmbedding();
    expect(b.snapshot()).toEqual({ model_calls: 2, embedding_calls: 1, caps: CHAT_TURN_BUDGET });
  });

  it("refuses a third model call with an honest named cap", () => {
    const b = new TurnBudget();
    b.reserveModel(); b.reserveModel();
    expect(() => b.reserveModel()).toThrow(TurnBudgetExceeded);
    try { b.reserveModel(); } catch (e) {
      expect(e).toBeInstanceOf(TurnBudgetExceeded);
      expect((e as TurnBudgetExceeded).resource).toBe("model_calls");
      expect((e as TurnBudgetExceeded).cap).toBe(2);
    }
  });

  it("refuses a second embedding call", () => {
    const b = new TurnBudget();
    b.reserveEmbedding();
    expect(() => b.reserveEmbedding()).toThrow(TurnBudgetExceeded);
  });

  it("snapshot exposes the caps so callers can state them honestly", () => {
    expect(CHAT_TURN_BUDGET).toEqual({ model_calls: 2, embedding_calls: 1 });
    const b = new TurnBudget();
    expect(b.snapshot().caps).toEqual(CHAT_TURN_BUDGET);
    expect(b.snapshot().model_calls).toBe(0);
  });

  it("a fresh turn starts from zero — no cross-turn accumulation", () => {
    const first = new TurnBudget(); first.reserveModel();
    const second = new TurnBudget();
    expect(() => { second.reserveModel(); second.reserveModel(); }).not.toThrow();
  });
});
