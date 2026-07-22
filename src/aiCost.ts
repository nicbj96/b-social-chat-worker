// AI cost accounting for the chat worker.
//
// The item asked for "token/$ accounting". Cloudflare structurally does not give
// it to us: env.AI.run() returns the model output and nothing about usage, and
// no neuron or token count appears in the response headers either (checked live
// 2026-07-23). So actual spend cannot be READ at the worker.
//
// What CAN be done, and is the honest version of the request, is to COUNT calls
// per model and multiply by each model's PUBLISHED neuron rate. That yields an
// estimate, clearly labelled as one, from the only inputs available. It is also
// the input every real budget needs first -- you cannot cap what you do not
// count. See the Budgets item, which is blocked on exactly this.
//
// Neurons, not tokens: Workers AI bills in neurons, and the free allowance is
// 10.000 neurons/day. These rates are per-call ESTIMATES from Cloudflare's
// published pricing; they are approximate by nature (a longer prompt costs more)
// and are here to answer "which model dominates our spend and are we near the
// free tier", not to reconcile an invoice to the neuron.

/** Rough neurons per call, by model. Order-of-magnitude, not exact. */
const NEURONS_PER_CALL: Record<string, number> = {
  "@cf/meta/llama-4-scout-17b-16e-instruct": 55, // the main chat model, per turn
  "@cf/baai/bge-m3": 3, // embeddings — cheap, but called per search
  "@cf/openai/whisper": 40, // transcription
  "@cf/black-forest-labs/flux-1-schnell": 250, // image generation — the expensive one
  "@cf/llava-hf/llava-1.5-7b-hf": 60, // vision
};
const DEFAULT_NEURONS = 30; // an unrecognised model still counts as something

// Per-isolate counters. Same tradeoff as the ingest request counter: safe
// because a Worker isolate serialises its own requests, and it degrades to an
// undercount rather than a wrong answer if that ever changes. This is telemetry,
// not billing, so an occasional lost increment is acceptable.
const callsByModel: Record<string, number> = {};

/**
 * Wrap env.AI.run so every model call is counted in one place.
 *
 * Ten call sites across six models funnel through here, so there is a single
 * spot to keep honest rather than ten to remember. The signature mirrors
 * env.AI.run exactly, so adoption is a rename.
 */
export async function runAiCounted(
  ai: { run: (model: string, input: unknown) => Promise<unknown> },
  model: string,
  input: unknown,
): Promise<unknown> {
  callsByModel[model] = (callsByModel[model] ?? 0) + 1;
  return ai.run(model, input);
}

export interface AiCostSnapshot {
  calls_by_model: Record<string, number>;
  total_calls: number;
  estimated_neurons: number;
}

/** Current estimate for this isolate. */
export function aiCostSnapshot(): AiCostSnapshot {
  let neurons = 0;
  let total = 0;
  for (const [model, n] of Object.entries(callsByModel)) {
    total += n;
    neurons += n * (NEURONS_PER_CALL[model] ?? DEFAULT_NEURONS);
  }
  return { calls_by_model: { ...callsByModel }, total_calls: total, estimated_neurons: neurons };
}

/** Test seam. */
export function __resetAiCost(): void {
  for (const k of Object.keys(callsByModel)) delete callsByModel[k];
}
