// Pure, side-effect-free validators + sanitizers for the chat worker.
// Kept in their own module so they can be unit-tested without any Worker
// bindings (see validate.test.ts). Do NOT import Worker/env state here.

// Strict UUID v1–v5 shape (8-4-4-4-12 hex, with a version/variant nibble).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Plain digit id (e.g. a bigint primary key), bounded length.
const DIGITS_RE = /^[0-9]{1,20}$/;

/**
 * True iff `value` is a valid UUID string.
 * Used to validate broadcast user_ids before building a PostgREST `in.()`
 * filter, so a crafted value can't inject extra params/operators.
 */
export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * True iff `value` is a "plausible" entity id we are willing to interpolate
 * into a PostgREST URL: a UUID OR a short run of digits. Anything containing
 * `&`, `=`, quotes, parens, operators, whitespace, etc. is rejected — those
 * are the characters an attacker would use to append filters/operators to
 * `?id=eq.<value>`. Callers MUST still encodeURIComponent the value.
 */
export function isSafeEntityId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 64) return false;
  return UUID_RE.test(value) || DIGITS_RE.test(value);
}

/**
 * Coerce `value` to a string and hard-truncate it to `max` chars. Non-strings
 * become "" (we never want to inject `[object Object]`/`undefined` into the
 * system prompt). Used to clamp user-controlled context fields that get
 * injected into the LLM system prompt (prompt-injection / cost blowup guard).
 */
export function clampString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}
