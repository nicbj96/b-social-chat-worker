import { describe, expect, it } from "vitest";
import { resolveDateWindow } from "./date-window";

// 2026-10-05 is a Monday; Copenhagen is CEST (UTC+2) until 2026-10-25.
const MON = new Date("2026-10-05T10:00:00Z");
const WED = new Date("2026-10-07T10:00:00Z");
const FRI = new Date("2026-10-09T10:00:00Z");
const SUN = new Date("2026-10-11T10:00:00Z");

describe("resolveDateWindow (Europe/Copenhagen)", () => {
  it("returns null when the message names no date", () => {
    expect(resolveDateWindow("noget for børn i Aarhus", WED)).toBeNull();
  });

  it("resolves 'på søndag' on a Wednesday to the coming Sunday, local midnight to midnight", () => {
    const w = resolveDateWindow("noget for børn på søndag i Aarhus", WED)!;
    expect(w.from).toBe("2026-10-10T22:00:00.000Z"); // Sun 00:00 CEST
    expect(w.to).toBe("2026-10-11T22:00:00.000Z"); // Mon 00:00 CEST
    expect(w.label).toBe("søndag");
  });

  it("'søndag' on a Sunday means today; on a Monday it means six days ahead", () => {
    expect(resolveDateWindow("søndag", SUN)!.from).toBe("2026-10-10T22:00:00.000Z");
    expect(resolveDateWindow("fredag", MON)!.from).toBe("2026-10-08T22:00:00.000Z");
  });

  it("'i morgen' and 'i dag' use the Copenhagen calendar day, not the UTC one", () => {
    // 23:30Z on Oct 7 is already Oct 8 01:30 in Copenhagen.
    const late = new Date("2026-10-07T23:30:00Z");
    expect(resolveDateWindow("i dag", late)!.from).toBe("2026-10-07T22:00:00.000Z");
    expect(resolveDateWindow("i morgen", late)!.from).toBe("2026-10-08T22:00:00.000Z");
    expect(resolveDateWindow("i morgen", late)!.to).toBe("2026-10-09T22:00:00.000Z");
  });

  it("'i aften' is 17:00 to local midnight", () => {
    const w = resolveDateWindow("jazz i aften", WED)!;
    expect(w.from).toBe("2026-10-07T15:00:00.000Z");
    expect(w.to).toBe("2026-10-07T22:00:00.000Z");
  });

  it("handles the DST change (clocks go back 2026-10-25)", () => {
    const sat = new Date("2026-10-24T10:00:00Z");
    const w = resolveDateWindow("søndag", sat)!;
    expect(w.from).toBe("2026-10-24T22:00:00.000Z"); // still CEST at 00:00
    expect(w.to).toBe("2026-10-25T23:00:00.000Z"); // 25 h day, midnight is CET
  });

  describe("weekend = Friday 17:00 to Sunday 23:59 local", () => {
    const from = "2026-10-09T15:00:00.000Z"; // Fri 17:00 CEST
    const to = "2026-10-11T22:00:00.000Z"; // Mon 00:00 CEST (exclusive)
    it.each([
      ["Monday", MON],
      ["Wednesday", WED],
      ["Friday morning", new Date("2026-10-09T06:00:00Z")],
      ["Friday evening", new Date("2026-10-09T18:00:00Z")],
      ["Saturday", new Date("2026-10-10T10:00:00Z")],
      ["Sunday 23:30 local", new Date("2026-10-11T21:30:00Z")],
    ])("on %s gives the current/upcoming weekend", (_n, now) => {
      const w = resolveDateWindow("jazz i Aarhus i weekenden", now)!;
      expect(w.from).toBe(from);
      expect(w.to).toBe(to);
      expect(w.label).toBe("i weekenden");
    });
    it("rolls to the NEXT weekend once Sunday is over", () => {
      const w = resolveDateWindow("i weekenden", new Date("2026-10-11T22:30:00Z"))!; // Mon 00:30 local
      expect(w.from).toBe("2026-10-16T15:00:00.000Z");
      expect(w.to).toBe("2026-10-18T22:00:00.000Z");
    });
    it("also matches 'denne weekend' / 'weekend'", () => {
      expect(resolveDateWindow("denne weekend", WED)).not.toBeNull();
      expect(resolveDateWindow("find events this weekend", WED)).not.toBeNull();
    });
  });
});
