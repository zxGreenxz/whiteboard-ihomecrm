import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applySavedRouteOrder,
  buildGoogleMapsLegUrl,
  buildGoogleMapsRouteChunks,
  coerceSavedRoutePlan,
  findPreviousRouteCoordinates,
  haversineKm,
  improveRouteTwoOpt,
  isActiveRouteCandidate,
  nearestNeighborRoute,
  normalizePriorityBucket,
  optimizeRouteByPriority,
  optimizeActiveRouteByPriority,
  reconcileRouteOrder,
  routeDistanceKm,
  type RouteCoordinates,
  type V5RouteStop,
} from "../v5Routing";

type Stop = V5RouteStop & { name: string };

const origin: RouteCoordinates = { latitude: 10.775, longitude: 106.7 };

const stop = (
  building_id: string,
  priority_bucket: number | string,
  latitude: number | null,
  longitude: number | null,
): Stop => ({ building_id, name: building_id, priority_bucket, latitude, longitude });

describe("v5Routing", () => {
  it("normalizes the numeric and named RPC priority buckets", () => {
    expect(normalizePriorityBucket(0)).toBe(0);
    expect(normalizePriorityBucket("visit_due")).toBe(1);
    expect(normalizePriorityBucket("DUE_SOON")).toBe(2);
    expect(normalizePriorityBucket("checked_today")).toBe(4);
  });

  it("uses haversine distance in kilometres", () => {
    const oneDegreeNorth = { latitude: 11.775, longitude: 106.7 };
    expect(haversineKm(origin, oneDegreeNorth)).toBeCloseTo(111.19, 1);
  });

  it("treats the placeholder coordinate 0,0 as unroutable", () => {
    const route = optimizeRouteByPriority([
      stop("valid", 0, 10.776, 106.701),
      stop("placeholder", 0, 0, 0),
    ], origin);
    expect(route.map((item) => item.building_id)).toEqual(["valid", "placeholder"]);
  });

  it("nearest-neighbor visits the closest remaining building deterministically", () => {
    const route = nearestNeighborRoute([
      stop("far", 0, 10.9, 106.9),
      stop("near", 0, 10.776, 106.701),
      stop("middle", 0, 10.8, 106.72),
    ], origin);
    expect(route.map((item) => item.building_id)).toEqual(["near", "middle", "far"]);
  });

  it("2-opt never lengthens an open route", () => {
    const route = [
      stop("a", 0, 10.8, 106.8),
      stop("b", 0, 10.7, 106.8),
      stop("c", 0, 10.8, 106.6),
      stop("d", 0, 10.7, 106.6),
    ];
    const improved = improveRouteTwoOpt(route, origin);
    expect(routeDistanceKm(improved, origin)).toBeLessThanOrEqual(routeDistanceKm(route, origin));
    expect(new Set(improved.map((item) => item.building_id))).toEqual(new Set(route.map((item) => item.building_id)));
  });

  it("optimizes inside buckets while preserving bucket precedence and unroutable stops", () => {
    const route = optimizeRouteByPriority([
      stop("due-far", 1, 10.9, 106.9),
      stop("full-far", 0, 10.88, 106.88),
      stop("due-near", 1, 10.776, 106.701),
      stop("full-no-gps", 0, null, null),
      stop("full-near", 0, 10.777, 106.702),
      stop("fresh", 3, 10.78, 106.71),
    ], origin);

    expect(route.map((item) => item.building_id)).toEqual([
      "full-near", "full-far", "full-no-gps", "due-far", "due-near", "fresh",
    ]);
    expect(route.map((item) => normalizePriorityBucket(item.priority_bucket))).toEqual([0, 0, 0, 1, 1, 3]);
  });

  it("restores today's manual drag order globally across priority buckets", () => {
    const route = applySavedRouteOrder([
      stop("full-a", 0, 10.7, 106.7),
      stop("full-b", 0, 10.8, 106.8),
      stop("visit-a", 1, 10.9, 106.9),
    ], "2026-07-21", {
      version: 1,
      date: "2026-07-21",
      building_ids: ["visit-a", "full-b", "full-a"],
      mode: "manual",
      updated_at: "2026-07-21T08:00:00.000Z",
    });
    expect(route.map((item) => item.building_id)).toEqual(["visit-a", "full-b", "full-a"]);
  });

  it("uses the latest server order when today's saved mode is priority", () => {
    const route = applySavedRouteOrder([
      stop("full-new", 0, 10.7, 106.7),
      stop("full-old", 0, 10.8, 106.8),
      stop("visit", 1, 10.9, 106.9),
    ], "2026-07-21", {
      version: 1,
      date: "2026-07-21",
      building_ids: ["visit", "full-old", "full-new"],
      mode: "priority",
      updated_at: "2026-07-21T08:00:00.000Z",
    });
    expect(route.map((item) => item.building_id)).toEqual(["full-new", "full-old", "visit"]);
  });

  it("restores optimized order inside current buckets and inserts new stops into their server bucket", () => {
    const route = applySavedRouteOrder([
      stop("new-full", 0, 10.7, 106.7),
      stop("saved-full", 0, 10.8, 106.8),
      stop("new-visit", 1, 10.9, 106.9),
      stop("saved-visit", 1, 11, 107),
    ], "2026-07-21", {
      version: 1,
      date: "2026-07-21",
      building_ids: ["saved-visit", "saved-full"],
      mode: "optimized",
      updated_at: "2026-07-21T08:00:00.000Z",
    });
    expect(route.map((item) => item.building_id)).toEqual([
      "saved-full", "new-full", "saved-visit", "new-visit",
    ]);
  });

  it("puts a newly assigned urgent stop before lower buckets only in optimized mode", () => {
    const serverRoute = [
      stop("new-urgent", 0, 10.7, 106.7),
      stop("saved-visit", 1, 10.8, 106.8),
      stop("saved-soon", 2, 10.9, 106.9),
    ];
    const savedIds = ["saved-soon", "saved-visit"];

    expect(reconcileRouteOrder(serverRoute, savedIds, "manual").map((item) => item.building_id))
      .toEqual(["saved-soon", "saved-visit", "new-urgent"]);
    expect(reconcileRouteOrder(serverRoute, savedIds, "optimized").map((item) => item.building_id))
      .toEqual(["new-urgent", "saved-visit", "saved-soon"]);
    expect(reconcileRouteOrder(serverRoute, savedIds, "priority")).toEqual(serverRoute);
  });

  it("reconciles dirty ids with fresh payloads, removed stops, and new assignments", () => {
    const refreshedVisit = { ...stop("visit", 1, 10.8, 106.8), name: "fresh-payload" };
    const newUrgent = stop("new-urgent", 0, 10.7, 106.7);
    const refreshedSoon = { ...stop("soon", 2, 10.9, 106.9), name: "fresh-soon" };
    const activeMissions = [newUrgent, refreshedVisit, refreshedSoon];
    const dirtyIds = ["removed", "soon", "visit"];

    const manual = reconcileRouteOrder(activeMissions, dirtyIds, "manual");
    expect(manual.map((item) => item.building_id)).toEqual(["soon", "visit", "new-urgent"]);
    expect(manual[0]).toBe(refreshedSoon);
    expect(manual[1]).toBe(refreshedVisit);

    const optimized = reconcileRouteOrder(activeMissions, dirtyIds, "optimized");
    expect(optimized.map((item) => item.building_id)).toEqual(["new-urgent", "visit", "soon"]);
    expect(optimized[1]).toBe(refreshedVisit);
  });

  it("keeps completed-today stops out of the saved route used for the next mission", () => {
    const completed = { ...stop("completed", 4, 10.7, 106.7), checked_today: true };
    const active = stop("active", 1, 10.8, 106.8);
    const route = applySavedRouteOrder(
      [completed, active].filter(isActiveRouteCandidate),
      "2026-07-21",
      {
        version: 1,
        date: "2026-07-21",
        building_ids: ["completed", "active"],
        mode: "manual",
        updated_at: "2026-07-21T08:00:00.000Z",
      },
    );
    expect(route.map((item) => item.building_id)).toEqual(["active"]);
  });

  it("ignores a saved order from another date and appends newly assigned buildings", () => {
    const route = applySavedRouteOrder([
      stop("a", 0, 10.7, 106.7),
      stop("b", 0, 10.8, 106.8),
      stop("new", 0, 10.9, 106.9),
    ], "2026-07-21", {
      version: 1,
      date: "2026-07-20",
      building_ids: ["b", "a"],
      mode: "manual",
      updated_at: "2026-07-20T08:00:00.000Z",
    });
    expect(route.map((item) => item.building_id)).toEqual(["a", "b", "new"]);
  });

  it("sanitizes malformed and duplicate persisted ids", () => {
    expect(coerceSavedRoutePlan({
      version: 1,
      date: "2026-07-21",
      building_ids: ["a", "a", 1, "b", ""],
      mode: "optimized",
      updated_at: "2026-07-21T08:00:00.000Z",
    })).toEqual({
      version: 1,
      date: "2026-07-21",
      building_ids: ["a", "b"],
      mode: "optimized",
      updated_at: "2026-07-21T08:00:00.000Z",
    });
    expect(coerceSavedRoutePlan({ date: 123, building_ids: [] })).toBeNull();
  });

  it("defaults unknown persisted modes to server priority order", () => {
    expect(coerceSavedRoutePlan({
      version: 1,
      date: "2026-07-21",
      building_ids: ["a"],
      mode: "future-mode",
      updated_at: "",
    })?.mode).toBe("priority");
  });

  it("builds one Google Maps URL per leg and uses the previous routable stop", () => {
    const route = [
      stop("a", 0, 10.8, 106.8),
      stop("no-gps", 0, null, null),
      stop("b", 0, 10.9, 106.9),
    ];
    const previous = findPreviousRouteCoordinates(route, 2, origin);
    expect(previous).toEqual({ latitude: 10.8, longitude: 106.8 });

    const url = buildGoogleMapsLegUrl(route[2], previous);
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("origin")).toBe("10.8,106.8");
    expect(parsed.searchParams.get("destination")).toBe("10.9,106.9");
    expect(parsed.searchParams.get("travelmode")).toBe("driving");
  });

  it("falls back to a building label when GPS coordinates are absent", () => {
    const url = buildGoogleMapsLegUrl({ label: "65 Nguyễn Thái Học" });
    expect(new URL(url!).searchParams.get("destination")).toBe("65 Nguyễn Thái Học");
  });

  it("builds Google Maps chunks with at most four stops and explicit waypoints", () => {
    const route = Array.from({ length: 9 }, (_, index) => (
      stop(`b-${index}`, index % 3, 10.7 + index * 0.01, 106.6 + index * 0.01)
    ));
    const chunks = buildGoogleMapsRouteChunks(route, origin);
    expect(chunks.map((chunk) => chunk.stop_ids.length)).toEqual([4, 4, 1]);
    expect(new URL(chunks[0].url).searchParams.get("waypoints")?.split("|")).toHaveLength(3);
    expect(new URL(chunks[1].url).searchParams.get("origin")).toBe("10.73,106.63");
  });

  it("property: optimizer is a permutation and never crosses priority buckets", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.record({
        id: fc.integer({ min: 1, max: 10_000 }),
        bucket: fc.integer({ min: 0, max: 4 }),
        latitude: fc.double({ min: 10.3, max: 11.2, noNaN: true, noDefaultInfinity: true }),
        longitude: fc.double({ min: 106.2, max: 107.1, noNaN: true, noDefaultInfinity: true }),
      }), { selector: (item) => item.id, minLength: 1, maxLength: 30 }),
      (items) => {
        const input = items.map((item) => stop(String(item.id), item.bucket, item.latitude, item.longitude));
        const optimized = optimizeRouteByPriority(input, origin);
        expect(optimized.map((item) => item.building_id).sort()).toEqual(input.map((item) => item.building_id).sort());
        const buckets = optimized.map((item) => normalizePriorityBucket(item.priority_bucket));
        expect(buckets).toEqual([...buckets].sort((left, right) => left - right));
      },
    ));
  });

  it("property: manual snapshots keep global order and append new assignments in server order", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 25 }),
      (ids) => {
        const input = ids.map((id, index) => stop(String(id), index % 3, 10.7, 106.7));
        const savedIds = ids.slice(0, -1).reverse().map(String);
        const todayPlan = {
          version: 1,
          date: "2026-07-21",
          building_ids: [...savedIds, savedIds[0], "not-assigned"],
          mode: "manual",
          updated_at: "2026-07-21T08:00:00.000Z",
        };
        expect(applySavedRouteOrder(input, "2026-07-21", todayPlan).map((item) => item.building_id))
          .toEqual([...savedIds, String(ids.at(-1))]);
        expect(applySavedRouteOrder(input, "2026-07-22", todayPlan).map((item) => item.building_id))
          .toEqual(ids.map(String));
      },
    ));
  });

  it("property: optimized snapshots preserve saved order per current bucket and place new stops in-bucket", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.record({
        id: fc.integer({ min: 1, max: 10_000 }),
        bucket: fc.integer({ min: 0, max: 4 }),
      }), { selector: (item) => item.id, minLength: 2, maxLength: 25 }),
      (items) => {
        const input = items.map((item) => stop(String(item.id), item.bucket, 10.7, 106.7));
        const savedIds = items.slice(0, -1).reverse().map((item) => String(item.id));
        const savedSet = new Set(savedIds);
        const buckets = [...new Set(items.map((item) => item.bucket))].sort((left, right) => left - right);
        const expected = buckets.flatMap((bucket) => [
          ...savedIds.filter((id) => items.some((item) => String(item.id) === id && item.bucket === bucket)),
          ...items
            .filter((item) => item.bucket === bucket && !savedSet.has(String(item.id)))
            .map((item) => String(item.id)),
        ]);

        expect(reconcileRouteOrder(input, savedIds, "optimized").map((item) => item.building_id))
          .toEqual(expected);
      },
    ));
  });

  it("property: priority mode always preserves the latest server ordering", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.record({
        id: fc.integer({ min: 1, max: 10_000 }),
        bucket: fc.integer({ min: 0, max: 4 }),
      }), { selector: (item) => item.id, minLength: 1, maxLength: 25 }),
      (items) => {
        const input = items.map((item) => stop(String(item.id), item.bucket, 10.7, 106.7));
        const plan = {
          version: 1,
          date: "2026-07-21",
          building_ids: input.map((item) => item.building_id).reverse(),
          mode: "priority",
          updated_at: "2026-07-21T08:00:00.000Z",
        };
        expect(applySavedRouteOrder(input, "2026-07-21", plan)).toEqual(input);
      },
    ));
  });

  it("property: checked-today buildings never enter active optimization or Maps chunks", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.record({
        id: fc.integer({ min: 1, max: 10_000 }),
        checked: fc.boolean(),
        bucket: fc.integer({ min: 0, max: 4 }),
      }), { selector: (item) => item.id, minLength: 1, maxLength: 30 }),
      (items) => {
        const input = items.map((item, index) => ({
          ...stop(String(item.id), item.bucket, 10.7 + index * 0.001, 106.7 + index * 0.001),
          checked_today: item.checked,
        }));
        const expectedIds = input.filter(isActiveRouteCandidate).map((item) => item.building_id).sort();
        expect(optimizeActiveRouteByPriority(input, origin).map((item) => item.building_id).sort()).toEqual(expectedIds);
        expect(buildGoogleMapsRouteChunks(input, origin).flatMap((chunk) => chunk.stop_ids).sort()).toEqual(expectedIds);
      },
    ));
  });
});
