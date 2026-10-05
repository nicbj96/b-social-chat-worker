/** Plan §6 P163–166 / M38: model-derived intent proposal.
 * The model may only PROPOSE a change; the change itself is validated against
 * the shared SearchIntent contract here — invalid values, unknown fields and
 * Danish/English phrasing are rejected, never guessed into a contract value.
 * The proposal envelope carries current/proposed intents and an honest diff;
 * applying it is the caller's job through the deterministic retrieval path.
 */
import { parseSearchIntent, searchIntentKey, type SearchIntent } from "./discovery-contract";

export const INTENT_PROPOSAL_VERSION = 1;

/** Top-level intent fields the model may propose. Everything else — city,
 * coordinates baked into a string, opening hours, free-text filters — is an
 * unknown field and is rejected by name. */
const ALLOWED_CHANGE_FIELDS = ["query", "queryShareable", "kind", "tags", "geography", "date", "price", "sort"] as const;

export interface IntentFieldChange { field: string; from: unknown; to: unknown; label: { da: string; en: string } }
export interface IntentProposal {
  version: 1;
  proposalId: string;
  current: SearchIntent;
  proposed: SearchIntent;
  changes: IntentFieldChange[];
}
export type ProposalOutcome =
  | { accepted: true; proposal: IntentProposal }
  | { accepted: false; reason: "invalid_current_intent" | "invalid_change" | "unknown_fields" | "invalid_proposed_intent" | "no_change"; invalid_fields?: string[] };

const FIELD_LABELS: Record<string, { da: string; en: string }> = {
  query: { da: "Søgeord", en: "Search query" },
  queryShareable: { da: "Søgeord kan deles", en: "Search query shareable" },
  kind: { da: "Type (event/sted)", en: "Type (event/place)" },
  tags: { da: "Tags", en: "Tags" },
  geography: { da: "Geografi", en: "Geography" },
  date: { da: "Dato", en: "Dates" },
  price: { da: "Pris", en: "Price" },
  sort: { da: "Sortering", en: "Sort order" },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** FNV-1a over the semantic keys: stable across turns without crypto. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Value shown in the diff. Private GPS coordinates are never rendered — the
 * diff is honest about WHAT changed without leaking exact position into chat. */
function valueLabel(field: string, value: unknown): unknown {
  if (field === "geography" && isPlainObject(value) && value.kind === "radius" && value.source === "gps") {
    return { kind: "radius", radiusKm: value.radiusKm, source: "gps", shareable: value.shareable, position: "private" };
  }
  return value;
}

function diffIntents(current: SearchIntent, proposed: SearchIntent): IntentFieldChange[] {
  const keys: (keyof SearchIntent)[] = ["query", "queryShareable", "kind", "tags", "geography", "date", "price", "sort"];
  const changes: IntentFieldChange[] = [];
  for (const key of keys) {
    const from = key === "tags" ? (current.tags?.selected ?? null) : current[key];
    const to = key === "tags" ? (proposed.tags?.selected ?? null) : proposed[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes.push({ field: key, from: valueLabel(key, from), to: valueLabel(key, to), label: FIELD_LABELS[key] });
    }
  }
  return changes;
}

export function proposeIntentChange(currentIntent: unknown, change: unknown): ProposalOutcome {
  if (!isPlainObject(change)) return { accepted: false, reason: "invalid_change" };
  let current: SearchIntent;
  try { current = parseSearchIntent(currentIntent); } catch { return { accepted: false, reason: "invalid_current_intent" }; }

  const unknownFields = Object.keys(change).filter(k => !(ALLOWED_CHANGE_FIELDS as readonly string[]).includes(k));
  if (unknownFields.length > 0) return { accepted: false, reason: "unknown_fields", invalid_fields: unknownFields };

  const changeKeys = Object.keys(change);
  if (changeKeys.length === 0) return { accepted: false, reason: "no_change" };

  let merged: unknown = { ...current };
  const dirty: unknown = { ...current };
  for (const key of changeKeys) {
    const value = change[key];
    if (key === "tags") {
      // The model may only propose selected slugs; expansion provenance stays
      // ours. Explicit [] = intentionally no tags; null = stop inheriting.
      if (value === null) { (dirty as Record<string, unknown>).tags = undefined; continue; }
      if (!isPlainObject(value) || !("selected" in value) || !Array.isArray((value as { selected: unknown }).selected)) {
        return { accepted: false, reason: "invalid_proposed_intent" };
      }
      (dirty as Record<string, unknown>).tags = {
        selected: (value as { selected: string[] }).selected,
        expanded: (value as { selected: string[] }).selected,
        provenance: "selection",
        taxonomyVersion: "v1",
      };
      continue;
    }
    if (value === undefined) return { accepted: false, reason: "invalid_proposed_intent" };
    (dirty as Record<string, unknown>)[key] = value;
  }
  merged = dirty;

  let proposed: SearchIntent;
  try { proposed = parseSearchIntent(merged); } catch { return { accepted: false, reason: "invalid_proposed_intent" }; }

  const changes = diffIntents(current, proposed);
  if (changes.length === 0) return { accepted: false, reason: "no_change" };

  const proposalId = fnv1a(JSON.stringify([searchIntentKey(current), searchIntentKey(proposed)]));
  return { accepted: true, proposal: { version: 1, proposalId, current, proposed, changes } };
}
