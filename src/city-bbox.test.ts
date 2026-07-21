import { describe, expect, it } from "vitest";
import { cityToBBox, KNOWN_CITIES } from "./city-bbox";

describe("city → bounding box", () => {
  it("resolves the cities people actually name, in any spelling", () => {
    for (const name of ["Aalborg", "aalborg", "ÅLBORG", "Ålborg"]) {
      const box = cityToBBox(name);
      expect(box, name).not.toBeNull();
      // Aalborg is at 57.05N 9.92E — the box must contain it.
      expect(box!.s).toBeLessThan(57.0488);
      expect(box!.n).toBeGreaterThan(57.0488);
      expect(box!.w).toBeLessThan(9.9217);
      expect(box!.e).toBeGreaterThan(9.9217);
    }
    for (const name of ["København", "Kobenhavn", "Copenhagen", "CPH", "kbh"]) {
      const box = cityToBBox(name);
      expect(box, name).not.toBeNull();
      expect(box!.s).toBeLessThan(55.6761);
      expect(box!.n).toBeGreaterThan(55.6761);
    }
  });

  it("does not put Aalborg inside the Copenhagen box (the actual bug)", () => {
    const cph = cityToBBox("København")!;
    const aalborgLat = 57.0488;
    expect(aalborgLat > cph.n).toBe(true);
  });

  it("handles a district suffix", () => {
    expect(cityToBBox("Aalborg Øst")).not.toBeNull();
    expect(cityToBBox("København K")).not.toBeNull();
    expect(cityToBBox("Aarhus N")).not.toBeNull();
  });

  it("returns null for unknown or empty input, so the search stays UNFILTERED", () => {
    expect(cityToBBox("")).toBeNull();
    expect(cityToBBox(null)).toBeNull();
    expect(cityToBBox(undefined)).toBeNull();
    expect(cityToBBox("Atlantis")).toBeNull();
  });


  it("carries the country, so a coordinate-less foreign row cannot leak in", () => {
    // First live probe of this feature returned a Finnish festival (no coords)
    // for an Aalborg question; the country is what stops that.
    expect(cityToBBox("Aalborg")!.country).toBe("DK");
    expect(cityToBBox("København")!.country).toBe("DK");
    expect(cityToBBox("Malmö")!.country).toBe("SE");
    expect(cityToBBox("Oslo")!.country).toBe("NO");
  });

  it("covers the Danish cities the product cares about", () => {
    for (const key of ["kobenhavn", "aarhus", "odense", "aalborg", "esbjerg", "randers", "roskilde"]) {
      expect(KNOWN_CITIES).toContain(key);
    }
  });
});
