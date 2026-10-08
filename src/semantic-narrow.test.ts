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
  it("drops a coordless row whose address is another town; keeps one naming the city", () => {
    const kbh = cityToBBox("København");
    const rows = [
      { id: "kert", latitude: null, longitude: null, location: "Anexet, Lundsgårdsvej 15, Kerteminde, 5300", date: "2026-11-12T19:00:00Z" },
      { id: "kbh", latitude: null, longitude: null, location: "Drop inn, Kompagnistræde 34, Copenhagen", date: "2026-10-10T21:00:00Z" },
      { id: "nul", latitude: null, longitude: null, location: null, title: "Kan ikke offentliggøres endnu", date: "2026-11-20T19:00:00Z" },
    ];
    expect(narrowSemanticEvents(rows, kbh, null, 25, "København").map(r => r.id)).toEqual(["kbh"]);
  });
});

import { resolveDateWindow } from "./date-window";
describe("English and week date windows", () => {
  const now = new Date("2026-10-08T10:00:00Z"); // Thursday
  it("tonight / today / tomorrow / denne uge / this week", () => {
    expect(resolveDateWindow("what is on in copenhagen tonight", now)?.label).toBe("i aften");
    expect(resolveDateWindow("anything today?", now)?.label).toBe("i dag");
    expect(resolveDateWindow("tomorrow in aarhus", now)?.label).toBe("i morgen");
    const w = resolveDateWindow("er der noget gratis i odense i denne uge", now)!;
    expect(w.label).toBe("denne uge");
    expect(w.to).toBe("2026-10-11T22:00:00.000Z");
    expect(resolveDateWindow("this week", now)?.label).toBe("denne uge");
  });
});
