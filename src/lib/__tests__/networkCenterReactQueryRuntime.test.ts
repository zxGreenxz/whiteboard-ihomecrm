import { describe, expect, it } from "vitest";

import {
  NETWORK_CENTER_REALTIME_TABLES,
  resolveNetworkCenterMode,
  resolveNetworkCenterRealtimeTarget,
  selectNetworkCenterRepository,
} from "@/lib/network-center/runtime";

describe("Network Center React Query runtime", () => {
  it("uses production unless demo mode is selected explicitly", () => {
    expect(resolveNetworkCenterMode(undefined)).toBe("production");
    expect(resolveNetworkCenterMode("")).toBe("production");
    expect(resolveNetworkCenterMode("development")).toBe("production");
    expect(resolveNetworkCenterMode("production")).toBe("production");
    expect(resolveNetworkCenterMode(" DEMO ")).toBe("demo");

    const production = { kind: "production" };
    const demo = { kind: "demo" };
    expect(selectNetworkCenterRepository("production", production, demo)).toBe(production);
    expect(selectNetworkCenterRepository("demo", production, demo)).toBe(demo);
  });

  it("subscribes only to the five sanitized Realtime projections", () => {
    expect(NETWORK_CENTER_REALTIME_TABLES).toEqual([
      "network_device_current",
      "network_interface_current",
      "network_incidents",
      "network_command_events",
      "network_worker_heartbeats",
    ]);
    expect(NETWORK_CENTER_REALTIME_TABLES).not.toContain("network_commands");
    expect(NETWORK_CENTER_REALTIME_TABLES).not.toContain("network_device_samples");
  });

  it("targets building invalidation without trusting payloads as cached domain state", () => {
    expect(resolveNetworkCenterRealtimeTarget(
      "network_device_current",
      { new: { building_id: " BUILDING-A " }, old: {} },
      "building-selected",
    )).toEqual({ invalidateFleet: true, buildingIds: ["building-a"] });

    expect(resolveNetworkCenterRealtimeTarget(
      "network_command_events",
      { new: { command_id: "command-a" } },
      " BUILDING-SELECTED ",
    )).toEqual({ invalidateFleet: true, buildingIds: ["building-selected"] });

    expect(resolveNetworkCenterRealtimeTarget(
      "network_worker_heartbeats",
      { new: { status: "ONLINE" } },
      undefined,
    )).toEqual({ invalidateFleet: true, buildingIds: [] });
  });
});
