import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NETWORK_ACTION_DEFINITIONS,
  NETWORK_CENTER_TABS,
  backupAgeText,
  deriveFleetView,
  filterFleet,
  selectPriorityIncidents,
  summarizeAruba,
  summarizeFleet,
  validateNetworkAction,
} from "@/lib/network-center/model";
import type { NetworkIncident } from "@/lib/network-center/contracts";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";

const buildings = [
  { id: "building-alpha", name: "Tòa Alpha", roomsCount: 18 },
  { id: "building-beta", name: "Tòa Beta", roomsCount: 24 },
  { id: "building-gamma", name: "Tòa Gamma", roomsCount: 12 },
];

const actor = {
  id: "user-operator-1",
  label: "Nguyễn An",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("network center deterministic model", () => {
  it("shows a truthful empty backup label instead of a negative age", () => {
    expect(backupAgeText(-1)).toBe("Chưa có bản");
    expect(backupAgeText(0)).toBe("0 giờ");
    expect(backupAgeText(12)).toBe("12 giờ");
  });

  it("uses fleet Aruba aggregates until detail pagination provides exact health", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();
    const site = fleet[0];
    site.arubaTotal = 500;
    site.arubaOnline = null;
    expect(summarizeAruba(site)).toEqual({ total: 500, online: null });
    delete site.arubaTotal;
    expect(summarizeAruba(site)).toEqual({
      total: site.arubaNodes.length,
      online: site.arubaNodes.filter((node) => node.status === "online").length,
    });
  });

  it("generates stable state from accessible physical buildings only", () => {
    const first = new DemoNetworkCenterRepository(buildings).listFleet();
    const second = new DemoNetworkCenterRepository(buildings).listFleet();

    expect(second).toEqual(first);
    expect(first.map((site) => site.buildingId)).toEqual(buildings.map((b) => b.id));
    expect(first.every((site) => site.arubaNodes.length >= 4 && site.arubaNodes.length <= 10)).toBe(true);
    expect(first.every((site) => !JSON.stringify(site).includes("192.168."))).toBe(true);
  });

  it("keeps WAN link state and throughput internally consistent", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();

    for (const site of fleet) {
      const wan = site.interfaces.find((networkInterface) => networkInterface.role === "wan")!;
      expect(site.router.wanStatus).toBe(wan.status);
      expect(site.router.downloadMbps).toBe(wan.rxMbps);
      expect(site.router.uploadMbps).toBe(wan.txMbps);
      if (wan.status === "down") {
        expect(wan.rxMbps).toBe(0);
        expect(wan.txMbps).toBe(0);
        expect(wan.utilizationPercent).toBe(0);
      }
    }
  });

  it("matches randomized flags to locally administered MACs and identifies sample sessions", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();

    for (const site of fleet) {
      expect(site.clients.length).toBeLessThanOrEqual(site.activeClients);
      for (const client of site.clients) {
        const firstOctet = Number.parseInt(client.macAddress.slice(0, 2), 16);
        expect(client.randomizedMac).toBe((firstOctet & 0b10) !== 0);
        expect((client as any).userIdentity).toMatch(/^demo-user-/);
        expect((client as any).sessionIdentity).toMatch(/^demo-session-/);
      }
    }
  });

  it("does not report an all-good site when an Aruba dependency is slow or offline", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();

    for (const site of fleet) {
      if (site.arubaNodes.some((node) => node.status !== "online")) {
        expect(site.health).not.toBe("online");
      }
    }
  });

  it("summarizes and filters fleet health, severity, backup, and search", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();
    const summary = summarizeFleet(fleet);

    expect(summary.online + summary.degraded + summary.offline).toBe(fleet.length);
    expect(summary.openIncidents).toBe(
      fleet.flatMap((site) => site.incidents).filter((incident) => incident.status !== "resolved").length,
    );
    expect(filterFleet(fleet, { search: "alpha" })).toHaveLength(1);
    expect(filterFleet(fleet, { health: fleet[0].health })).toContainEqual(fleet[0]);
    expect(filterFleet(fleet, { backup: fleet[0].backupStatus })).toContainEqual(fleet[0]);

    const incident = fleet.flatMap((site) => site.incidents)[0];
    if (incident) {
      expect(filterFleet(fleet, { severity: incident.severity }).some((site) => site.buildingId === incident.buildingId)).toBe(true);
    }
  });

  it("filters buildings whose current firmware differs from the target", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();
    for (const site of fleet) site.router.targetFirmware = site.router.firmware;
    fleet[1].router.targetFirmware = `${fleet[1].router.firmware}-target`;

    expect(filterFleet(fleet, { firmware: "drift" })).toEqual([fleet[1]]);
  });

  it("derives KPI totals and unresolved incidents from filtered buildings and severity", () => {
    const fleet = new DemoNetworkCenterRepository(buildings).listFleet();
    const scopedSite = fleet[0];
    const otherSite = fleet[1];
    const scopedIncident = scopedSite.incidents[0];
    const scopedOtherSeverity = scopedSite.incidents[1];
    const otherIncident = otherSite.incidents[0];
    scopedIncident.status = "open";
    scopedIncident.severity = "high";
    scopedOtherSeverity.status = "open";
    scopedOtherSeverity.severity = "critical";
    otherIncident.status = "open";
    otherIncident.severity = "critical";

    const view = deriveFleetView(fleet, {
      search: scopedSite.buildingName,
      severity: "high",
    });

    expect(view.fleet).toEqual([scopedSite]);
    expect(view.summary.online + view.summary.degraded + view.summary.offline).toBe(1);
    expect(view.summary.openIncidents).toBe(
      scopedSite.incidents.filter(
        (incident) => incident.status !== "resolved" && incident.severity === "high",
      ).length,
    );
    expect(view.incidents).toEqual(
      scopedSite.incidents.filter(
        (incident) => incident.status !== "resolved" && incident.severity === "high",
      ),
    );
    expect(view.incidents).not.toContain(otherIncident);
  });

  it("uses neutral Vietnamese wording for simulated DHCP renewal and reboot stages", () => {
    const renewDhcp = NETWORK_ACTION_DEFINITIONS.find((action) => action.type === "renew_dhcp_lease")!;
    const reboot = NETWORK_ACTION_DEFINITIONS.find((action) => action.type === "reboot_router")!;

    expect(renewDhcp.preview).toBe("Lease uplink: hiện tại → cấp lại địa chỉ");
    expect(renewDhcp.preview).not.toContain("yêu cầu");
    expect(reboot.description).not.toMatch(/validation|post-check/i);
    expect(reboot.preview).not.toMatch(/validation|post-check/i);
  });

  it("keeps every critical incident even when priority capacity is exceeded", () => {
    const critical = Array.from({ length: 10 }, (_, index) => makeIncident({
      id: `critical-${index}`,
      severity: "critical",
      openedAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    }));
    const high = makeIncident({ id: "high-newest", severity: "high", openedAt: "2026-08-01T10:00:00.000Z" });

    const selected = selectPriorityIncidents([...critical, high], 8);

    expect(selected).toHaveLength(10);
    expect(selected.every((incident) => incident.severity === "critical")).toBe(true);
    expect(selected.map((incident) => incident.id)).toEqual(
      [...critical].reverse().map((incident) => incident.id),
    );
  });

  it("fills remaining priority capacity by severity then newest opened time", () => {
    const incidents = [
      makeIncident({ id: "low-new", severity: "low", openedAt: "2026-08-04T10:00:00.000Z" }),
      makeIncident({ id: "high-old", severity: "high", openedAt: "2026-08-01T10:00:00.000Z" }),
      makeIncident({ id: "medium-new", severity: "medium", openedAt: "2026-08-03T10:00:00.000Z" }),
      makeIncident({ id: "critical-old", severity: "critical", openedAt: "2026-07-01T10:00:00.000Z" }),
      makeIncident({ id: "high-new", severity: "high", openedAt: "2026-08-05T10:00:00.000Z" }),
      makeIncident({ id: "critical-new", severity: "critical", openedAt: "2026-07-02T10:00:00.000Z" }),
      makeIncident({ id: "medium-old", severity: "medium", openedAt: "2026-08-02T10:00:00.000Z" }),
      makeIncident({ id: "low-old", severity: "low", openedAt: "2026-07-30T10:00:00.000Z" }),
      makeIncident({ id: "high-middle", severity: "high", openedAt: "2026-08-03T12:00:00.000Z" }),
    ];

    expect(selectPriorityIncidents(incidents, 8).map((incident) => incident.id)).toEqual([
      "critical-new",
      "critical-old",
      "high-new",
      "high-middle",
      "high-old",
      "medium-new",
      "medium-old",
      "low-new",
    ]);
  });

  it("exposes exactly ten stable URL-backed building tabs", () => {
    expect(NETWORK_CENTER_TABS.map((tab) => tab.value)).toEqual([
      "overview",
      "interfaces",
      "clients",
      "topology",
      "incidents",
      "configuration",
      "backups",
      "changes",
      "audit",
      "settings",
    ]);
  });
});

function makeIncident(overrides: Partial<NetworkIncident> & Pick<NetworkIncident, "id" | "severity" | "openedAt">): NetworkIncident {
  return {
    buildingId: "building-alpha",
    title: overrides.id,
    detail: "Chi tiết sự cố mô phỏng cục bộ",
    status: "open",
    ...overrides,
  };
}

describe("network center demo mutations", () => {
  it("acknowledges incidents and appends an audit entry", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const site = repository.listFleet().find((candidate) => candidate.incidents.length > 0)!;
    const incident = site.incidents[0];
    const auditCount = site.audit.length;

    repository.acknowledgeIncident(site.buildingId, incident.id, actor as any);
    const updated = repository.getBuilding(site.buildingId)!;

    expect(updated.incidents.find((candidate) => candidate.id === incident.id)?.status).toBe("acknowledged");
    expect(updated.audit).toHaveLength(auditCount + 1);
    expect(updated.audit[0]).toEqual(expect.objectContaining({
      actor: actor.label,
      actorId: actor.id,
      actionType: "acknowledge_incident",
      reason: incident.title,
    }));
  });

  it("uses execution time and hides maintenance outside its active window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:15:00.000Z"));
    const repository = new DemoNetworkCenterRepository(buildings);
    const buildingId = buildings[0].id;

    const maintenance = repository.createMaintenance(buildingId, {
      durationMinutes: 45,
      reason: "Kiểm tra kết nối định kỳ",
    }, actor as any);
    expect(maintenance.startsAt).toBe("2026-07-24T08:15:00.000Z");
    expect(repository.getBuilding(buildingId)?.maintenance?.id).toBe(maintenance.id);
    expect(summarizeFleet(repository.listFleet()).activeMaintenance).toBe(1);

    vi.advanceTimersByTime(46 * 60_000);
    expect(repository.getBuilding(buildingId)?.maintenance).toBeNull();
    expect(summarizeFleet(repository.listFleet()).activeMaintenance).toBe(0);
  });

  it("captures deterministic snapshots and returns pair-specific redacted diffs", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const buildingId = buildings[0].id;
    const before = repository.getBuilding(buildingId)!;

    const manual = repository.captureConfiguration(buildingId, "Ảnh chụp trước bảo trì", actor as any);
    const after = repository.getBuilding(buildingId)!;
    const seededDiff = repository.compareRevisions(
      buildingId,
      before.revisions[1].id,
      before.revisions[0].id,
    );
    const manualDiff = repository.compareRevisions(
      buildingId,
      before.revisions[0].id,
      after.revisions[0].id,
    );

    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(Object.keys((manual as any).snapshot)).not.toHaveLength(0);
    expect((seededDiff as any).changeCount).toBe(before.revisions[0].changeCount);
    expect((manualDiff as any).changeCount).toBe(manual.changeCount);
    expect(manualDiff.lines.filter((line) => line.kind === "added")).toHaveLength(manual.changeCount);
    expect(manualDiff.lines).not.toEqual(seededDiff.lines);
    expect(JSON.stringify(after.revisions)).toContain("[ĐÃ ẨN]");
    expect(JSON.stringify(manualDiff)).not.toMatch(/(password|secret|token|community)=((?!\[ĐÃ ẨN\]).)+/i);
    expect(() => repository.compareRevisions(buildingId, after.revisions[0].id, after.revisions[0].id)).toThrow();
  });

  it("keeps identical hashes and an empty diff for repeated unchanged captures", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const buildingId = buildings[0].id;

    const first = repository.captureConfiguration(buildingId, "Ảnh chụp thủ công một", actor as any);
    const second = repository.captureConfiguration(buildingId, "Ảnh chụp thủ công hai", actor as any);
    const diff = repository.compareRevisions(buildingId, first.id, second.id);

    expect(second.hash).toBe(first.hash);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.changeCount).toBe(0);
    expect(diff.changeCount).toBe(0);
    expect(diff.lines.filter((line) => line.kind !== "context")).toEqual([]);
  });

  it("requires router identity and a live unprotected LAN target for port cycling", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const site = repository.getBuilding(buildings[0].id)!;
    const target = site.interfaces.find((networkInterface) =>
      networkInterface.role === "lan" && !networkInterface.protected && networkInterface.status === "up"
    )!;

    expect(target).toBeDefined();
    expect(() => repository.executeAction(site.buildingId, {
      type: "cycle_access_port",
      reason: "Kiểm tra lại cổng truy cập tầng hai",
      fields: { interfaceId: target.id, durationSeconds: 10 },
      confirmation: "sai-router",
    }, actor as any)).toThrow("định danh router");

    const downSite = structuredClone(site);
    const downTarget = downSite.interfaces.find((networkInterface) => networkInterface.id === target.id)!;
    downTarget.status = "down";
    expect(() => validateNetworkAction(downSite, {
      type: "cycle_access_port",
      reason: "Kiểm tra lại cổng truy cập tầng hai",
      fields: { interfaceId: target.id, durationSeconds: 10 },
      confirmation: site.router.identity,
    })).toThrow("đang down");
  });

  it("retains typed action parameters, target, actor, validation, and reconciliation", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const site = repository.getBuilding(buildings[0].id)!;
    const target = site.interfaces.find((networkInterface) =>
      networkInterface.role === "lan" && !networkInterface.protected && networkInterface.status === "up"
    )!;

    const job = repository.executeAction(site.buildingId, {
      type: "cycle_access_port",
      reason: "Kiểm tra lại cổng truy cập tầng hai",
      fields: { interfaceId: target.id, durationSeconds: 10 },
      confirmation: site.router.identity,
    }, actor as any);

    expect(job).toEqual(expect.objectContaining({
      actor,
      target: expect.objectContaining({
        buildingId: site.buildingId,
        routerIdentity: site.router.identity,
        interfaceId: target.id,
      }),
      parameters: { interfaceId: target.id, durationSeconds: 10 },
      validation: expect.objectContaining({ status: "passed" }),
      rollback: expect.objectContaining({ status: "not_required" }),
      reconciliation: expect.objectContaining({ status: "matched" }),
    }));
    expect(job.stages.find((stage) => stage.key === "execution")?.detail).toContain(target.name);
    expect(job.stages.find((stage) => stage.key === "execution")?.detail).toContain("10 giây");
    expect(job.stages.find((stage) => stage.key === "post_check")?.detail).toContain("UP");

    const updated = repository.getBuilding(site.buildingId)!;
    expect(updated.interfaces.find((networkInterface) => networkInterface.id === target.id)?.status).toBe("up");
    expect(updated.revisions[0].source).toBe("pre_action");
    expect(updated.audit[0]).toEqual(expect.objectContaining({
      actor: actor.label,
      actorId: actor.id,
      actionType: "cycle_access_port",
      reason: "Kiểm tra lại cổng truy cập tầng hai",
      validation: expect.stringContaining("danh sách được phép"),
      result: expect.stringContaining(target.name),
    }));
  });

  it("validates router identity for reboot actions with a localized message", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const site = repository.getBuilding(buildings[0].id)!;

    expect(() => repository.executeAction(site.buildingId, {
      type: "reboot_router",
      reason: "Khởi động lại để kiểm tra",
      fields: {},
      confirmation: "sai-router",
    }, actor as any)).toThrow("định danh router");

    const job = repository.executeAction(site.buildingId, {
      type: "reboot_router",
      reason: "Khởi động lại sau khi kiểm tra sức khỏe",
      fields: {},
      confirmation: site.router.identity,
    }, actor as any);

    expect(job.status).toBe("success");
    expect(job.stages.map((stage) => stage.key)).toEqual([
      "validation",
      "backup",
      "execution",
      "post_check",
      "success",
    ]);
    expect(JSON.stringify(repository.getBuilding(site.buildingId))).not.toMatch(/approval|approve|reject/i);
  });

  it("rejects invalid settings at the repository boundary", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const buildingId = buildings[0].id;

    expect(() => repository.updateSettings(buildingId, { pollingSeconds: 29 }, actor as any)).toThrow("30");
    expect(() => repository.updateSettings(buildingId, { pollingSeconds: 45.5 }, actor as any)).toThrow("số nguyên");
    expect(() => repository.updateSettings(buildingId, { backupHour: "" }, actor as any)).toThrow("HH:mm");
    expect(() => repository.updateSettings(buildingId, { backupHour: "24:00" }, actor as any)).toThrow("HH:mm");
    expect(() => repository.updateSettings(buildingId, { alertSensitivity: "loud" as any }, actor as any)).toThrow(/ngưỡng/i);
  });

  it("records the authenticated actor for every audit-producing mutation", () => {
    const repository = new DemoNetworkCenterRepository(buildings);
    const site = repository.getBuilding(buildings[0].id)!;
    const incident = site.incidents.find((candidate) => candidate.status === "open")!;

    repository.acknowledgeIncident(site.buildingId, incident.id, actor as any);
    const maintenance = repository.createMaintenance(site.buildingId, {
      durationMinutes: 30,
      reason: "Kiểm tra đường truyền tầng một",
    }, actor as any);
    repository.cancelMaintenance(site.buildingId, maintenance.id, actor as any);
    repository.captureConfiguration(site.buildingId, "Ảnh chụp thủ công", actor as any);
    repository.updateSettings(site.buildingId, { pollingSeconds: 90 }, actor as any);

    const audit = repository.getBuilding(site.buildingId)!.audit.slice(0, 5);
    expect(audit.map((record: any) => record.actionType)).toEqual([
      "update_settings",
      "capture_configuration",
      "cancel_maintenance",
      "create_maintenance",
      "acknowledge_incident",
    ]);
    expect(audit.every((record: any) => record.actor === actor.label && record.actorId === actor.id)).toBe(true);
  });
});
