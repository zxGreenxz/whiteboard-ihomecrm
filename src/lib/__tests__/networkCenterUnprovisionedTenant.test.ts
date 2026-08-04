import { describe, expect, it } from "vitest";

import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { parseNetworkCenterBuilding } from "@/lib/network-center/dto";
import { SupabaseNetworkCenterRepository } from "@/lib/network-center/supabaseRepository";

/**
 * Án lệ production 04/08/2026 (ptcrm.vercel.app/network-center):
 * tài khoản chủ thấy 36 toà nhà thuộc 3 tổ chức; 17 toà của tổ chức
 * `cccc…0001` CHƯA có dòng `network_site_settings` nào. RPC
 * `network_center_get_building_v1` trả HTTP 200 với `settings` toàn null —
 * một trạng thái RỖNG hợp lệ — nhưng zod bắt buộc `settings.version` là số
 * dương nên `listFleet()` ném lỗi cho CẢ hạm đội → thẻ đỏ "Không tải được toà
 * nhà" + 144 POST `network_center_get_building_v1` trong 25 giây.
 *
 * Payload dưới đây chép nguyên văn từ wire (đã đổi tên toà).
 */
const UNPROVISIONED_BUILDING_ID = "c32d4465-6a78-4e1a-bf10-6905cca9ec3c";
const PROVISIONED_BUILDING_ID = "59c6fc2c-2369-4ec8-b253-1ac64abb2f45";
const DENIED_BUILDING_ID = "1eae0e82-9c58-4dba-aeb4-13ade8e1a146";
const ROUTER_ID = "f375a073-3e7f-4b17-9e4f-b1d63298a64d";

function unprovisionedBuildingPayload(buildingId = UNPROVISIONED_BUILDING_ID) {
  return {
    router: null,
    settings: {
      version: null,
      backupHour: null,
      changesPaused: null,
      pollingSeconds: null,
      alertSensitivity: null,
      dependencyGrouping: null,
    },
    incidents: [],
    revisions: [],
    buildingId,
    interfaces: [],
    roomsCount: 40,
    maintenance: null,
    buildingName: "Toà chưa cấu hình",
    rolloutState: "OFF",
  };
}

function provisionedBuildingPayload(buildingId = PROVISIONED_BUILDING_ID) {
  return {
    ...unprovisionedBuildingPayload(buildingId),
    buildingName: "Toà đã cấu hình",
    router: {
      id: ROUTER_ID,
      identity: "MikroTik — Toà đã cấu hình",
      externalKey: "slot:primary",
      model: null,
      firmware: null,
      targetFirmware: null,
      lifecycleStatus: "UNPROVISIONED",
      reachable: false,
      healthStatus: "UNKNOWN",
      lastSeenAt: null,
      cpuPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      temperatureC: null,
      voltageV: null,
      pppoeState: null,
      connectionCount: null,
    },
    settings: {
      version: 1,
      backupHour: "03:00",
      changesPaused: false,
      pollingSeconds: 60,
      alertSensitivity: "standard",
      dependencyGrouping: true,
    },
  };
}

function fleetItem(overrides: Record<string, unknown>) {
  return {
    routerId: null,
    reachable: false,
    arubaCount: 0,
    buildingId: UNPROVISIONED_BUILDING_ID,
    cpuPercent: null,
    lastSeenAt: null,
    pppoeState: null,
    roomsCount: 40,
    mttrSeconds: null,
    routerModel: null,
    buildingName: "Toà chưa cấu hình",
    healthStatus: "UNKNOWN",
    lastBackupAt: null,
    rolloutState: "OFF",
    activeClients: 0,
    openIncidents: 0,
    uptimePercent: null,
    routerIdentity: null,
    targetFirmware: null,
    connectionCount: null,
    lifecycleStatus: null,
    memoryUsedBytes: null,
    routerosVersion: null,
    memoryTotalBytes: null,
    maintenanceActive: false,
    ...overrides,
  };
}

const EMPTY_PAGE = { items: [], nextCursor: null };

type RpcResult = {
  data: unknown;
  error: null | { code?: string; message?: string; details?: string };
};

interface Harness {
  repository: {
    listFleet(): Promise<NetworkBuilding[]>;
    getBuilding(buildingId: string, fallback?: NetworkBuilding): Promise<NetworkBuilding | null>;
  };
  calls: string[];
  buildingCalls: string[];
}

function harness(options: {
  fleetItems: ReturnType<typeof fleetItem>[];
  detail?: (buildingId: string) => RpcResult;
  fleetError?: NonNullable<RpcResult["error"]>;
}): Harness {
  const calls: string[] = [];
  const buildingCalls: string[] = [];
  const rpc = async (name: string, args?: Record<string, unknown>): Promise<RpcResult> => {
    calls.push(name);
    if (name === "network_center_list_fleet_v1") {
      if (options.fleetError) return { data: null, error: options.fleetError };
      return { data: { items: options.fleetItems }, error: null };
    }
    if (name === "network_center_get_building_v1") {
      const buildingId = String(args?.p_building_id ?? "");
      buildingCalls.push(buildingId);
      if (options.detail) return options.detail(buildingId);
      return { data: unprovisionedBuildingPayload(buildingId), error: null };
    }
    return { data: EMPTY_PAGE, error: null };
  };
  const repository = new (SupabaseNetworkCenterRepository as unknown as new (
    call: typeof rpc,
  ) => Harness["repository"])(rpc);
  return { repository, calls, buildingCalls };
}

describe("Network Center — tenant chưa được provisioning", () => {
  it("đọc payload settings toàn null thành trạng thái RỖNG, không phải lỗi hợp đồng", () => {
    const parsed = parseNetworkCenterBuilding(unprovisionedBuildingPayload());
    expect(parsed.settings).toBeNull();
    expect(parsed.router).toBeNull();
    expect(parsed.buildingId).toBe(UNPROVISIONED_BUILDING_ID);
  });

  it("vẫn coi settings SAI KIỂU là lỗi hợp đồng thật", () => {
    const broken = unprovisionedBuildingPayload();
    broken.settings = {
      ...broken.settings,
      version: 1,
      pollingSeconds: 5,
    } as unknown as typeof broken.settings;
    expect(() => parseNetworkCenterBuilding(broken)).toThrow();
  });

  it("một toà chưa provisioning KHÔNG được làm hỏng cả hạm đội", async () => {
    const { repository } = harness({
      fleetItems: [
        fleetItem({ buildingId: UNPROVISIONED_BUILDING_ID, openIncidents: 1 }),
        fleetItem({
          buildingId: PROVISIONED_BUILDING_ID,
          buildingName: "Toà đã cấu hình",
          routerId: ROUTER_ID,
          routerIdentity: "MikroTik — Toà đã cấu hình",
          lifecycleStatus: "UNPROVISIONED",
        }),
      ],
      detail: (buildingId) => ({
        data: buildingId === PROVISIONED_BUILDING_ID
          ? provisionedBuildingPayload(buildingId)
          : unprovisionedBuildingPayload(buildingId),
        error: null,
      }),
    });

    const fleet = await repository.listFleet();
    expect(fleet).toHaveLength(2);
    const unprovisioned = fleet.find((item) => item.buildingId === UNPROVISIONED_BUILDING_ID)!;
    expect(unprovisioned.settings).toBeNull();
    expect(unprovisioned.settingsVersion).toBeNull();
    expect(unprovisioned.detailError).toBeUndefined();
    const provisioned = fleet.find((item) => item.buildingId === PROVISIONED_BUILDING_ID)!;
    expect(provisioned.settings?.pollingSeconds).toBe(60);
    expect(provisioned.settingsVersion).toBe(1);
  });

  it("lỗi chi tiết THẬT của một toà chỉ hạ cấp dòng đó và được đánh dấu rõ", async () => {
    const { repository } = harness({
      fleetItems: [
        fleetItem({
          buildingId: DENIED_BUILDING_ID,
          buildingName: "Toà bị từ chối",
          routerId: ROUTER_ID,
          openIncidents: 2,
        }),
        fleetItem({
          buildingId: PROVISIONED_BUILDING_ID,
          buildingName: "Toà đã cấu hình",
          routerId: ROUTER_ID,
        }),
      ],
      detail: (buildingId) => (buildingId === DENIED_BUILDING_ID
        ? { data: null, error: { code: "42501", message: "permission denied" } }
        : { data: provisionedBuildingPayload(buildingId), error: null }),
    });

    const fleet = await repository.listFleet();
    expect(fleet).toHaveLength(2);
    const denied = fleet.find((item) => item.buildingId === DENIED_BUILDING_ID)!;
    expect(denied.detailError).toBeTruthy();
    // KHÔNG bịa dữ liệu thay thế: hàng vẫn chỉ mang số liệu của chính RPC hạm đội.
    expect(denied.settings).toBeNull();
    expect(denied.incidents).toEqual([]);
  });

  it("lỗi THẬT của chính RPC hạm đội vẫn nổi lên thành lỗi", async () => {
    const { repository } = harness({
      fleetItems: [],
      fleetError: { code: "42501", message: "permission denied" },
    });
    await expect(repository.listFleet()).rejects.toThrow();
  });

  it("không gọi chi tiết cho toà mà chính RPC hạm đội nói là rỗng", async () => {
    const { repository, calls, buildingCalls } = harness({
      fleetItems: [
        fleetItem({ buildingId: UNPROVISIONED_BUILDING_ID }),
        fleetItem({
          buildingId: PROVISIONED_BUILDING_ID,
          buildingName: "Toà đã cấu hình",
          routerId: ROUTER_ID,
        }),
        fleetItem({ buildingId: DENIED_BUILDING_ID, buildingName: "Toà có sự cố", openIncidents: 3 }),
      ],
      detail: (buildingId) => ({
        data: provisionedBuildingPayload(buildingId),
        error: null,
      }),
    });

    await repository.listFleet();
    expect(buildingCalls).not.toContain(UNPROVISIONED_BUILDING_ID);
    expect(buildingCalls).toContain(PROVISIONED_BUILDING_ID);
    expect(buildingCalls).toContain(DENIED_BUILDING_ID);
    expect(calls.filter((name) => name === "network_center_list_fleet_v1")).toHaveLength(1);
  });

  it("trang chi tiết toà chưa provisioning trả trạng thái rỗng thay vì ném lỗi", async () => {
    const { repository } = harness({
      fleetItems: [fleetItem({ buildingId: UNPROVISIONED_BUILDING_ID })],
    });
    const fleet = await repository.listFleet();
    const building = await repository.getBuilding(UNPROVISIONED_BUILDING_ID, fleet[0]);
    expect(building).not.toBeNull();
    expect(building!.settings).toBeNull();
    expect(building!.settingsVersion).toBeNull();
    expect(building!.router.lifecycleStatus).toBe("UNPROVISIONED");
  });
});
