import { describe, it, expect } from "vitest";
import { normalizeToolCalls } from "./tool-calls";
describe("normalizeToolCalls", () => {
  it("accepts flat Workers AI shape", () => {
    expect(normalizeToolCalls([{ name: "search_events", arguments: { city: "Aarhus" } }])).toEqual([
      { type: "function", function: { name: "search_events", arguments: '{"city":"Aarhus"}' } },
    ]);
  });
  it("keeps OpenAI shape and drops nameless", () => {
    expect(normalizeToolCalls([{ id: "1", function: { name: "x", arguments: "{}" } }, { foo: 1 }, null])).toEqual([
      { id: "1", type: "function", function: { name: "x", arguments: "{}" } },
    ]);
  });
});
