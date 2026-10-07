/** Normalise Workers AI tool calls to the OpenAI shape; drops nameless entries. */
export function normalizeToolCalls(calls: unknown[]): { id: string; type: "function"; function: { name: string; arguments: string } }[] {
  const out: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const c of calls as any[]) {
    if (!c || typeof c !== "object") continue;
    const name = c.function?.name ?? c.name;
    if (typeof name !== "string" || !name) continue;
    const rawArgs = c.function?.arguments ?? c.arguments ?? {};
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
    // Follow-up calls are validated OpenAI-style: every tool call needs an id
    // that the matching role:"tool" message echoes as tool_call_id.
    const id = typeof c.id === "string" && c.id ? c.id : `call_${out.length}_${name}`.slice(0, 64);
    out.push({ id, type: "function", function: { name, arguments: args } });
  }
  return out;
}
