import { describe, expect, it } from "vitest";

import {
  directoryFreshness,
  OPENCLAW_CRM_EVENT_TYPES,
  scheduleActions,
  type SalesGroupView,
} from "../schedules";

const NOW = "2026-08-03T12:00:00.000Z";

const group: SalesGroupView = {
  targetId: "t1",
  displayName: "Nhóm khách VIP",
  memberCount: 12,
  directoryVersion: 4,
  directoryRefreshedAt: "2026-08-03T06:00:00.000Z",
  directoryExpiresAt: "2026-08-04T06:00:00.000Z",
  isAllowed: true,
  allowlistVersion: 2,
};

describe("schedule actions", () => {
  it("never offers Activate or Resume", () => {
    // No function in the migration set performs that transition, so a button for it
    // would be a control that cannot work. Pinned as the SHAPE of the result, so
    // adding one has to break a test rather than slip in.
    const actions = scheduleActions({ canManage: true, status: "PAUSED" });
    expect(Object.keys(actions).sort()).toEqual(["cancel", "pause"]);
  });

  it("covers exactly the statuses the CHECK constraint allows", () => {
    // An earlier version invented "RUNNING" and omitted "ACTIVE" - the one status
    // that means live and sending - so a running schedule rendered with a blank
    // label. Driving every real status here is what keeps the copy table complete.
    for (const status of ["PAUSED", "ACTIVE", "CANCELLED", "COMPLETE"] as const) {
      const actions = scheduleActions({ canManage: true, status });
      expect(Object.keys(actions).sort(), status).toEqual(["cancel", "pause"]);
    }
  });

  it("withholds pause for a schedule that is already paused or finished", () => {
    expect(scheduleActions({ canManage: true, status: "PAUSED" }).pause.blockedBy).toBe("STATUS");
    expect(scheduleActions({ canManage: true, status: "CANCELLED" }).pause.blockedBy).toBe("STATUS");
    expect(scheduleActions({ canManage: true, status: "ACTIVE" }).pause.enabled).toBe(true);
  });

  it("still allows cancelling a paused schedule", () => {
    // Pausing and cancelling are different outcomes: a paused schedule can still be
    // resumed by an operator outside this UI, a cancelled one cannot.
    expect(scheduleActions({ canManage: true, status: "PAUSED" }).cancel.enabled).toBe(true);
    expect(scheduleActions({ canManage: true, status: "CANCELLED" }).cancel.enabled).toBe(false);
  });

  it("offers nothing without the managing permission", () => {
    const actions = scheduleActions({ canManage: false, status: "ACTIVE" });
    expect(actions.pause.blockedBy).toBe("PERMISSION");
    expect(actions.cancel.blockedBy).toBe("PERMISSION");
  });
});

describe("directory freshness", () => {
  it("prefers the expiry the server computed over recomputing 24 hours", () => {
    expect(directoryFreshness(group, NOW)).toBe("FRESH");
    expect(directoryFreshness({ ...group, directoryExpiresAt: "2026-08-03T11:00:00.000Z" }, NOW))
      .toBe("STALE");
  });

  it("falls back to the 24-hour rule when no expiry is given", () => {
    expect(directoryFreshness({ ...group, directoryExpiresAt: null }, NOW)).toBe("FRESH");
    expect(directoryFreshness({
      ...group, directoryExpiresAt: null, directoryRefreshedAt: "2026-08-01T06:00:00.000Z",
    }, NOW)).toBe("STALE");
  });

  it("says UNKNOWN rather than guessing on an unparseable timestamp", () => {
    expect(directoryFreshness({
      ...group, directoryExpiresAt: null, directoryRefreshedAt: "not-a-date",
    }, NOW)).toBe("UNKNOWN");
    expect(directoryFreshness(group, "not-a-date")).toBe("UNKNOWN");
  });
});

describe("CRM event types", () => {
  it("names the table each event's CHECK constraint actually pairs it with", () => {
    // A regex like /^public\./ accepts any invented table name, and one shipped:
    // `sales_task_due` was labelled `public.sales_tasks`, a table that exists
    // nowhere, while the constraint pairs it with `lead_activities`.
    expect(OPENCLAW_CRM_EVENT_TYPES.map(event => [event.eventType, event.canonicalSource]))
      .toEqual([
        ["lead_created_or_assigned", "public.leads"],
        ["room_became_available", "public.rooms"],
        ["sales_task_due", "public.lead_activities"],
      ]);
  });

  it("carries exactly the three the CHECK constraint allows, with their sources", () => {
    // There is no RPC to enumerate them - the source of truth is a CHECK constraint -
    // so this list is hardcoded and its provenance is part of the contract.
    expect(OPENCLAW_CRM_EVENT_TYPES.map(event => event.eventType)).toEqual([
      "lead_created_or_assigned",
      "room_became_available",
      "sales_task_due",
    ]);
    for (const event of OPENCLAW_CRM_EVENT_TYPES) {
      expect(event.canonicalSource, event.eventType).toMatch(/^public\./u);
      expect(event.label.length, event.eventType).toBeGreaterThan(0);
    }
  });
});
