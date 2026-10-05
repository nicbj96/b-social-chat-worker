// Plan §9 P186–191 / M41: finite budget and deadline on the chat path.
//
// Unit contract for chat-provider.ts — the deadline, the session budget
// ledger, the resource caps and the provider-degradation classification.
// The worker.fetch-level RED probes live in index.budget-deadline.test.ts;
// these tests pin the named errors and honest behaviours in isolation.
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_TURN_DEADLINE_MS,
  RESOURCE_CAPS,
  SESSION_CHAT_BUDGET,
  ResourceCapExceeded,
  TurnDeadline,
  TurnDeadlineExceeded,
  assertEmbeddingDims,
  capReplyBytes,
  capRows,
  classifyProviderFailure,
  consumeSessionTurnBudget,
  degradationNotice,
  sessionBudgetKey,
} from "./chat-provider";
import { TurnBudgetExceeded } from "./chat-budget";

describe("turn deadline", () => {
  it("has a finite default and a named error distinct from model/upstream failure", () => {
    expect(CHAT_TURN_DEADLINE_MS).toBeGreaterThan(0);
    const d = new TurnDeadline(0, 0);
    expect(() => d.check(1)).toThrow(TurnDeadlineExceeded);
    try {
      new TurnDeadline(0, 0).check(1);
      expect.unreachable("check must throw");
    } catch (e) {
      expect((e as TurnDeadlineExceeded).code).toBe("turn_deadline_exceeded");
      // NOT the turn budget error and NOT a generic Error subclass contract:
      expect(e instanceof TurnBudgetExceeded).toBe(false);
      expect(e instanceof Error).toBe(true);
    }
  });

  it("check() does not throw while time remains", () => {
    expect(() => new TurnDeadline(1_000, 0).check(500)).not.toThrow();
  });

  it("race() resolves the value when the promise wins", async () => {
    const d = new TurnDeadline(1_000, Date.now());
    await expect(d.race(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("race() rejects with the named deadline error when the wall clock wins", async () => {
    const d = new TurnDeadline(20, Date.now());
    await expect(d.race(new Promise(() => {}))).rejects.toThrow(TurnDeadlineExceeded);
  });
});

describe("session budget ledger (account-scoped)", () => {
  it("charges one turn against the configured cap and stays allowed under it", async () => {
    const consume = vi.fn(async () => ({ success: true, retryAfterSeconds: 0 }));
    const decision = await consumeSessionTurnBudget({ consume } as any, "acct-1", 1);
    expect(decision.allowed).toBe(true);
    expect(decision.persisted).toBe(true);
    expect(consume).toHaveBeenCalledWith(SESSION_CHAT_BUDGET.turns, SESSION_CHAT_BUDGET.window_hours * 3_600_000, 1);
  });

  it("is a NAMED exhaustion when the cap is reached — allowed:false plus retry", async () => {
    const store = { consume: async () => ({ success: false, retryAfterSeconds: 300 }) };
    const decision = await consumeSessionTurnBudget(store as any, "acct-1", 1);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(300);
  });

  it("fails OPEN on a missing or broken store (budget store outage never takes chat down)", async () => {
    const missing = await consumeSessionTurnBudget(undefined, "acct-1", 1);
    expect(missing.allowed).toBe(true);
    expect(missing.persisted).toBe(false);
    const broken = await consumeSessionTurnBudget({ consume: async () => { throw new Error("DO down"); } } as any, "acct-1", 1);
    expect(broken.allowed).toBe(true);
    expect(broken.persisted).toBe(false);
  });

  it("keys account-scoped, never user-name-plain for anon", () => {
    expect(sessionBudgetKey("user-7", "v1:abcdef")).toBe("session-chat-budget:v2:account:user-7");
    const anon = sessionBudgetKey(null, "v1:abcdef");
    expect(anon).toBe("session-chat-budget:v2:anon:abcdef");
    expect(anon).not.toContain("user");
  });
});

describe("resource caps", () => {
  it("accepts an embedding vector within the cap and rejects one over it by name", () => {
    expect(() => assertEmbeddingDims(new Array(RESOURCE_CAPS.embedding_dims).fill(0.1))).not.toThrow();
    try {
      assertEmbeddingDims(new Array(RESOURCE_CAPS.embedding_dims + 1).fill(0.1));
      expect.unreachable("over-cap vector must throw");
    } catch (e) {
      expect(e instanceof ResourceCapExceeded).toBe(true);
      expect((e as ResourceCapExceeded).cap).toBe("embedding_dims");
      expect(String(e)).toContain("cap_exceeded_embedding_dims");
    }
    expect(() => assertEmbeddingDims(undefined)).toThrow(ResourceCapExceeded);
    expect(() => assertEmbeddingDims("not-a-vector")).toThrow(ResourceCapExceeded);
  });

  it("caps row collections honestly (flagged, not silently kept)", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: String(i) }));
    const capped = capRows(rows);
    expect(capped.rows).toHaveLength(RESOURCE_CAPS.rows);
    expect(capped.capped).toBe(true);
    const small = capRows([{ id: "a" }]);
    expect(small.capped).toBe(false);
    expect(small.rows).toHaveLength(1);
  });

  it("caps the reply payload bytes and flags the truncation", () => {
    const long = { reply: "x".repeat(RESOURCE_CAPS.response_bytes + 10) };
    const capped = capReplyBytes(long);
    expect(capped.capped).toBe(true);
    expect(JSON.stringify(capped.payload).length).toBeLessThanOrEqual(RESOURCE_CAPS.response_bytes);
    const small = capReplyBytes({ reply: "hej" });
    expect(small.capped).toBe(false);
    expect(small.payload.reply).toBe("hej");
  });
});

describe("provider degradation contract", () => {
  it("classifies 429/quota, timeout and other upstream failures into distinct named reasons", () => {
    expect(classifyProviderFailure(new Error("429 too many requests"))).toBe("provider_429");
    expect(classifyProviderFailure(new Error("quota exceeded for account"))).toBe("provider_429");
    expect(classifyProviderFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("provider_timeout");
    expect(classifyProviderFailure(new Error("operation timed out after 5000ms"))).toBe("provider_timeout");
    expect(classifyProviderFailure(new Error("Workers AI 500 upstream"))).toBe("provider_error");
  });

  it("uses structured status/code first and never misclassifies on a loose substring", () => {
    expect(classifyProviderFailure(Object.assign(new Error("upstream"), { status: 429 }))).toBe("provider_429");
    expect(classifyProviderFailure(Object.assign(new Error("upstream"), { statusCode: 429 }))).toBe("provider_429");
    expect(classifyProviderFailure(Object.assign(new Error("upstream"), { cause: { status: 429 } }))).toBe("provider_429");
    expect(classifyProviderFailure(Object.assign(new Error("upstream"), { code: "rate_limit_exceeded" }))).toBe("provider_429");
    expect(classifyProviderFailure(Object.assign(new Error("upstream"), { status: 504 }))).toBe("provider_timeout");
    expect(classifyProviderFailure(Object.assign(new Error("upstream"), { code: "ETIMEDOUT" }))).toBe("provider_timeout");
    // Loose substrings inside ids/names must NOT classify:
    expect(classifyProviderFailure(new Error("lookup of event id 4290-429-abc failed"))).toBe("provider_error");
    expect(classifyProviderFailure(new Error("record 429 not found"))).toBe("provider_error");
    expect(classifyProviderFailure(new Error("place timeout-cafe-1 failed"))).toBe("provider_error");
    expect(classifyProviderFailure(Object.assign(new Error("429"), { status: 500 }))).toBe("provider_error");
  });

  it("carries an explicit degradation notice — never a silent fallback answer", () => {
    const n = degradationNotice("provider_429", 60);
    expect(n.degraded).toBe(true);
    expect(n.reason).toBe("provider_429");
    expect(n.retry_after_seconds).toBe(60);
    expect(typeof n.notice).toBe("string");
    expect(n.notice.length).toBeGreaterThan(10);
    const deadline = degradationNotice("turn_deadline_exceeded");
    expect(deadline.reason).toBe("turn_deadline_exceeded");
    expect(deadline.notice).toContain("Tidsgrænsen");
  });
});
