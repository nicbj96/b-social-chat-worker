import { describe, expect, it } from "vitest";
import { normalizeCategory, REAL_CATEGORY_SLUGS } from "./category-vocabulary";

describe("category vocabulary normalisation", () => {
  it("maps the legacy vocabulary this worker used to advertise", () => {
    // These three were in the tool schema and the system prompt, and matched
    // nothing in the database — every category-filtered search returned 0 rows.
    expect(normalizeCategory("mad_hangout")).toBe("mad-drikke");
    expect(normalizeCategory("aktiv_sport")).toBe("motion-fitness");
    expect(normalizeCategory("natur")).toBe("natur-outdoor");
  });

  it("maps the words a model actually emits, in both languages", () => {
    expect(normalizeCategory("musik")).toBe("musik-lyd");
    expect(normalizeCategory("concert")).toBe("musik-lyd");
    expect(normalizeCategory("Food")).toBe("mad-drikke");
    expect(normalizeCategory("restaurants")).toBe("mad-drikke");
    expect(normalizeCategory("museum")).toBe("kultur-kunst");
    expect(normalizeCategory("kids")).toBe("børn-familie");
    expect(normalizeCategory("running")).toBe("motion-fitness");
    expect(normalizeCategory("fodbold")).toBe("sport-tilskuer");
  });

  it("passes real slugs through untouched", () => {
    for (const slug of REAL_CATEGORY_SLUGS) {
      expect(normalizeCategory(slug)).toBe(slug);
    }
  });

  it("tolerates underscore/dash and whitespace slips", () => {
    expect(normalizeCategory("musik_lyd")).toBe("musik-lyd");
    expect(normalizeCategory(" Mad Drikke ")).toBe("mad-drikke");
  });

  it("returns null for anything unmappable, so the search stays UNFILTERED", () => {
    // An unfiltered (broader) answer is recoverable; an empty one is not.
    expect(normalizeCategory("")).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
    expect(normalizeCategory("quantum-basketweaving")).toBeNull();
  });
});
