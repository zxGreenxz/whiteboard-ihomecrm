import { describe, expect, it } from "vitest";

import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";
import { synchronizeDemoNetworkCenterRepository } from "@/lib/network-center/repositoryLifecycle";

const actor = { id: "user-1", label: "Nguyễn An" };

describe("network center repository lifecycle", () => {
  it("creates identical snapshots and an empty diff when sanitized config is unchanged", () => {
    const repository = new DemoNetworkCenterRepository([
      { id: "building-a", name: "Tòa A", roomsCount: 10 },
    ]);

    const first = repository.captureConfiguration("building-a", "Bản chụp thứ nhất", actor);
    const second = repository.captureConfiguration("building-a", "Bản chụp thứ hai", actor);
    const diff = repository.compareRevisions("building-a", first.id, second.id);

    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.hash).toBe(first.hash);
    expect(second.changeCount).toBe(0);
    expect(diff.changeCount).toBe(0);
    expect(diff.lines).toEqual([
      { kind: "context", text: "@@ Bản chụp thứ nhất → Bản chụp thứ hai @@" },
    ]);
  });

  it("reuses one service instance and preserves mutations across building metadata/order changes", () => {
    const repository = new DemoNetworkCenterRepository([
      { id: "building-a", name: "Tòa A", roomsCount: 10 },
      { id: "building-b", name: "Tòa B", roomsCount: 20 },
    ]);
    const site = repository.getBuilding("building-a")!;
    const incident = site.incidents.find((candidate) => candidate.status === "open")!;

    repository.acknowledgeIncident(site.buildingId, incident.id, actor);
    repository.createMaintenance(site.buildingId, {
      durationMinutes: 30,
      reason: "Kiểm tra đường truyền tầng một",
    }, actor);
    repository.captureConfiguration(site.buildingId, "Ảnh chụp thủ công", actor);
    repository.updateSettings(site.buildingId, { pollingSeconds: 120 }, actor);

    const synchronized = synchronizeDemoNetworkCenterRepository(repository, [
      { id: "building-b", name: "Tòa B", roomsCount: 21 },
      { id: "building-a", name: "Tòa A đổi tên", roomsCount: 11 },
    ]);
    const updated = synchronized.getBuilding("building-a")!;

    expect(synchronized).toBe(repository);
    expect(synchronized.listFleet().map((candidate) => candidate.buildingId)).toEqual(["building-b", "building-a"]);
    expect(updated.buildingName).toBe("Tòa A đổi tên");
    expect(updated.roomsCount).toBe(11);
    expect(updated.incidents.find((candidate) => candidate.id === incident.id)?.status).toBe("acknowledged");
    expect(updated.maintenance).not.toBeNull();
    expect(updated.revisions[0].source).toBe("manual");
    expect(updated.settings.pollingSeconds).toBe(120);
    expect(updated.audit.some((record) => record.actorId === actor.id)).toBe(true);
  });

  it("preserves historical target names while new events use the renamed building", () => {
    const repository = new DemoNetworkCenterRepository([
      { id: "building-a", name: "Tòa A", roomsCount: 10 },
    ]);
    const historicalJob = repository.executeAction("building-a", {
      type: "flush_dns_cache",
      reason: "Làm mới DNS trước khi đổi tên",
      fields: {},
    }, actor);
    const historicalAudit = repository.getBuilding("building-a")!.audit.find(
      (record) => record.actionType === "flush_dns_cache",
    )!;

    synchronizeDemoNetworkCenterRepository(repository, [
      { id: "building-a", name: "Tòa A đổi tên", roomsCount: 11 },
    ]);
    const renamed = repository.getBuilding("building-a")!;

    expect(renamed.buildingName).toBe("Tòa A đổi tên");
    expect(renamed.jobs.find((job) => job.id === historicalJob.id)?.target.buildingName).toBe("Tòa A");
    expect(renamed.audit.find((record) => record.id === historicalAudit.id)?.target.buildingName).toBe("Tòa A");

    const newJob = repository.executeAction("building-a", {
      type: "flush_dns_cache",
      reason: "Làm mới DNS sau khi đổi tên",
      fields: {},
    }, actor);
    const newAudit = repository.getBuilding("building-a")!.audit.find(
      (record) => record.actionType === "flush_dns_cache" && record.id !== historicalAudit.id,
    )!;

    expect(newJob.target.buildingName).toBe("Tòa A đổi tên");
    expect(newAudit.target.buildingName).toBe("Tòa A đổi tên");
  });
});
