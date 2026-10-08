import { describe, it, expect } from "vitest";
import { narrowSemanticEvents } from "./semantic-narrow";
import { cityToBBox } from "./city-bbox";
const aarhus = cityToBBox("Aarhus");
const ev = (id: string, lat: number, lng: number, date: string) => ({ id, latitude: lat, longitude: lng, date });
describe("narrowSemanticEvents", () => {
  it("drops Randers/Lund-style neighbours outside 25 km of the city", () => {
    const rows = [ev("in", 56.155, 10.21, "2026-10-10T20:00:00Z"), ev("randers", 56.4607, 10.0364, "2026-10-10T20:00:00Z")];
    expect(narrowSemanticEvents(rows, aarhus, null).map(r => r.id)).toEqual(["in"]);
  });
  it("keeps only the asked date window", () => {
    const w = { from: "2026-10-09T22:00:00Z", to: "2026-10-11T22:00:00Z", label: "weekend" } as any;
    const rows = [ev("sat", 56.155, 10.21, "2026-10-10T20:00:00Z"), ev("later", 56.155, 10.21, "2026-10-24T16:00:00Z")];
    expect(narrowSemanticEvents(rows, aarhus, w).map(r => r.id)).toEqual(["sat"]);
  });
  it("no city and no window = unchanged", () => {
    const rows = [ev("a", 0, 0, "x")];
    expect(narrowSemanticEvents(rows, null, null)).toEqual(rows);
  });
});
