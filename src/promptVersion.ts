// ---------------------------------------------------------------------------
// promptVersion — which prompt produced this answer.
// ---------------------------------------------------------------------------
// The system prompt is an inline string literal with no version, hash or
// changelog. So when an answer is wrong there is no way to tell which prompt
// produced it: edit the prompt, redeploy, and every previous answer silently
// becomes unattributable. "It used to say something different" is not a thing
// anyone can check.
//
// This derives an identifier FROM THE TEXT rather than asking anyone to
// remember to bump a number. A hand-maintained version is a version that is
// wrong the first time someone edits in a hurry — the same failure as a test
// restating a constant instead of importing it.
//
// Not a cryptographic hash and not trying to be: this is for identity and
// change-detection, where FNV-1a is sufficient, sync (crypto.subtle is async
// and this runs at module load) and dependency-free.
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Deterministic across runtimes, which is the whole point. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // >>> 0 keeps it unsigned; the multiply is the FNV prime via shifts so it
    // stays exact in 32 bits rather than drifting through float64.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A short, stable identifier for a prompt's exact content.
 *
 * Whitespace-normalised first, so reflowing a paragraph does not read as a
 * change of meaning — but any change to the WORDS produces a different id.
 */
export function promptVersion(prompt: string): string {
  return fnv1a(prompt.replace(/\s+/g, " ").trim());
}
