/** Normalise Workers AI tool calls to the OpenAI shape; drops nameless entries. */
export function normalizeToolCalls(calls: unknown[]): { id?: string; type: "function"; function: { name: string; arguments: string } }[] {
  const out: { id?: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const c of calls as any[]) {
    if (!c || typeof c !== "object") continue;
    const name = c.function?.name ?? c.name;
    if (typeof name !== "string" || !name) continue;
    const rawArgs = c.function?.arguments ?? c.arguments ?? {};
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
    out.push({ ...(typeof c.id === "string" ? { id: c.id } : {}), type: "function", function: { name, arguments: args } });
  }
  return out;
}
