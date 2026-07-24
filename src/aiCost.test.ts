import { describe, it, expect, beforeEach } from "vitest";
import { runAiCounted, aiCostSnapshot, __resetAiCost, setAiUsageReporter, neuronsFor } from "./aiCost";

// ---------------------------------------------------------------------------
// AI cost accounting.
//
// This is an ESTIMATE by necessity -- Cloudflare returns no usage to the Worker
// -- so the tests pin the two things that must be true of an honest estimate:
// every model call is counted exactly once, and the expensive model dominates
// the neuron total the way its published rate says it should. A cost figure
// that under-counts calls, or that weights every model equally, would mislead a
// budget decision worse than no figure.
// ---------------------------------------------------------------------------
const fakeAi = { run: async (_m: string, _i: unknown) => ({ ok: true }) };

describe("aiCost", () => {
  beforeEach(() => __resetAiCost());

  it("counts every call, per model", async () => {
    await runAiCounted(fakeAi, "@cf/meta/llama-4-scout-17b-16e-instruct", {});
    await runAiCounted(fakeAi, "@cf/meta/llama-4-scout-17b-16e-instruct", {});
    await runAiCounted(fakeAi, "@cf/baai/bge-m3", {});
    const snap = aiCostSnapshot();
    expect(snap.calls_by_model["@cf/meta/llama-4-scout-17b-16e-instruct"]).toBe(2);
    expect(snap.calls_by_model["@cf/baai/bge-m3"]).toBe(1);
    expect(snap.total_calls).toBe(3);
  });

  it("passes the model output straight through", async () => {
    const out = await runAiCounted(fakeAi, "@cf/baai/bge-m3", {});
    expect(out).toEqual({ ok: true });
  });

  // The per-isolate counters die with the isolate, so the DB total depends on
  // this reporter firing on EVERY call — a missed call is silently lost spend.
  it("reports every call to the usage sink, with that model's neuron rate", async () => {
    const seen: { model: string; neurons: number }[] = [];
    setAiUsageReporter((model, neurons) => seen.push({ model, neurons }));
    try {
      await runAiCounted(fakeAi, "@cf/meta/llama-4-scout-17b-16e-instruct", {});
      await runAiCounted(fakeAi, "@cf/baai/bge-m3", {});
      expect(seen).toEqual([
        { model: "@cf/meta/llama-4-scout-17b-16e-instruct", neurons: neuronsFor("@cf/meta/llama-4-scout-17b-16e-instruct") },
        { model: "@cf/baai/bge-m3", neurons: neuronsFor("@cf/baai/bge-m3") },
      ]);
    } finally {
      setAiUsageReporter(null);
    }
  });

  // Telemetry is never worth failing a user's answer for.
  it("still returns the model output when the usage sink throws", async () => {
    setAiUsageReporter(() => { throw new Error("db down"); });
    try {
      await expect(runAiCounted(fakeAi, "@cf/baai/bge-m3", {})).resolves.toEqual({ ok: true });
      expect(aiCostSnapshot().total_calls).toBe(1);
    } finally {
      setAiUsageReporter(null);
    }
  });

  it("weights image generation far above an embedding", async () => {
    // One flux call must cost more neurons than many embeddings -- if it does
    // not, the estimate is useless for spotting what actually drives spend.
    __resetAiCost();
    await runAiCounted(fakeAi, "@cf/black-forest-labs/flux-1-schnell", {});
    const flux = aiCostSnapshot().estimated_neurons;
    __resetAiCost();
    for (let i = 0; i < 10; i++) await runAiCounted(fakeAi, "@cf/baai/bge-m3", {});
    const embeds = aiCostSnapshot().estimated_neurons;
    expect(flux).toBeGreaterThan(embeds);
  });

  it("an unknown model still counts, rather than silently costing zero", async () => {
    await runAiCounted(fakeAi, "@cf/some/future-model", {});
    const snap = aiCostSnapshot();
    expect(snap.total_calls).toBe(1);
    expect(snap.estimated_neurons).toBeGreaterThan(0);
  });
});
