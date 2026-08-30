import { describe, expect, it } from "vitest";

import { corroborate } from "@/lib/data/corroborate";
import { OfflineMiss, fetchCached } from "@/lib/data/http";
import { footprints, geocode } from "@/lib/data/osm";
import { checkDeveloper, findContractor, findNotices } from "@/lib/data/registers";

/**
 * Ported from tests/test_data.py — same 24 assertions. Runs entirely
 * offline against the committed cache and register fixtures. No network, no
 * keys, no flakiness. Warm the cache with real responses and these same
 * tests then assert against real data.
 */

const TODAY = "2026-08-30";
const SITE = "Willow Park Block A, Kilimani";
const LAT = -1.2921;
const LON = 36.7827;

describe("cache behaviour", () => {
  it("geocode resolves from cache", async () => {
    const g = await geocode(SITE);
    expect(["exact", "approximate"]).toContain(g.confidence);
  });

  it("coordinates parsed", async () => {
    const g = await geocode(SITE);
    expect(Math.abs(g.latitude - LAT)).toBeLessThan(0.05);
  });

  it("offline miss raises", async () => {
    await expect(
      fetchCached("https://nominatim.openstreetmap.org/search?q=nothing-cached"),
    ).rejects.toBeInstanceOf(OfflineMiss);
  });
});

describe("building footprints", () => {
  it("buildings counted", async () => {
    const f = await footprints(LAT, LON, 200);
    expect(f.buildingCount).toBe(3);
  });

  it("under-construction flagged", async () => {
    const f = await footprints(LAT, LON, 200);
    expect(f.buildingsUnderConstruction).toBe(1);
  });

  it("land use captured", async () => {
    const f = await footprints(LAT, LON, 200);
    expect(f.landuse).toContain("residential");
  });

  it("nearest distance computed", async () => {
    const f = await footprints(LAT, LON, 200);
    expect(f.nearestBuildingM).not.toBeNull();
  });

  it("coverage caveat present", async () => {
    const f = await footprints(LAT, LON, 200);
    expect(f.note).toContain("absence as unknown");
  });
});

describe("Kenyan registers", () => {
  it("name matching ignores Ltd/Limited", () => {
    const c = findContractor("Willow Park Developments Limited"); // suffix differs
    expect(c?.status).toBe("active");
  });

  it("unknown company returns nothing", () => {
    expect(findContractor("Nonexistent Co")).toBeNull();
  });

  it("gazette notice found", () => {
    expect(findNotices("Kilimani Heights Ltd").length).toBe(1);
  });

  it("notice typed", () => {
    expect(findNotices("Kilimani Heights Ltd")[0]!.noticeType).toBe("winding-up");
  });
});

describe("developer verdicts", () => {
  it("clean developer clears", () => {
    const clear = checkDeveloper("Willow Park Developments Ltd", "EBK/PR/2026/00812", TODAY);
    expect(clear.verdict).toBe("clear");
  });

  it("no flags raised", () => {
    const clear = checkDeveloper("Willow Park Developments Ltd", "EBK/PR/2026/00812", TODAY);
    expect(clear.flags).toEqual([]);
  });

  it("deregistered plus winding-up stops it", () => {
    const bad = checkDeveloper("Kilimani Heights Ltd", null, TODAY);
    expect(bad.verdict).toBe("do not proceed");
  });

  it("both reasons surfaced", () => {
    const bad = checkDeveloper("Kilimani Heights Ltd", null, TODAY);
    expect(bad.flags.length).toBe(2);
  });

  it("lapsed licence is conditional, not fatal", () => {
    const lapsed = checkDeveloper("Athi Ridge Properties Ltd", "EBK/PR/2026/00999", TODAY);
    expect(lapsed.verdict).toBe("proceed with conditions");
  });

  it("unregistered project flagged", () => {
    const lapsed = checkDeveloper("Athi Ridge Properties Ltd", "EBK/PR/2026/00999", TODAY);
    expect(lapsed.projectRegistered).toBe(false);
  });

  it("absence from the register is flagged", () => {
    const unknown = checkDeveloper("Backstreet Homes Ltd", null, TODAY);
    expect(unknown.flags.length).toBe(1);
  });
});

describe("site corroboration", () => {
  it("clean site clears", async () => {
    const ok = await corroborate(SITE, "Willow Park Developments Ltd", LAT, LON, "EBK/PR/2026/00812", 200, 500, TODAY);
    expect(ok.verdict).toBe("clear");
  });

  it("positive signals recorded", async () => {
    const ok = await corroborate(SITE, "Willow Park Developments Ltd", LAT, LON, "EBK/PR/2026/00812", 200, 500, TODAY);
    expect(ok.corroborating.length).toBeGreaterThanOrEqual(2);
  });

  it("no adverse findings", async () => {
    const ok = await corroborate(SITE, "Willow Park Developments Ltd", LAT, LON, "EBK/PR/2026/00812", 200, 500, TODAY);
    expect(ok.findings).toEqual([]);
  });

  it("insolvent developer stops it", async () => {
    const bad = await corroborate(SITE, "Kilimani Heights Ltd", LAT, LON, null, 200, 500, TODAY);
    expect(bad.verdict).toBe("do not proceed");
  });

  it("coordinates far from the named site are flagged", async () => {
    const drifted = await corroborate(SITE, "Willow Park Developments Ltd", -1.35, 36.9, "EBK/PR/2026/00812", 200, 500, TODAY);
    expect(
      drifted.findings.some((f) => f.includes("from where the site name resolves")),
    ).toBe(true);
  });
});
