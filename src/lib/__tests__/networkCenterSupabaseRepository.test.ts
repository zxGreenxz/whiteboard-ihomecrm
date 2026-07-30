import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  NetworkActionRequest,
  NetworkActor,
  NetworkBuilding,
  NetworkJob,
  NetworkSettings,
} from "@/lib/network-center/contracts";
import { networkCenterQueryKeys } from "@/lib/network-center/queryKeys";
import {
  NetworkCenterRepositoryError,
  SupabaseNetworkCenterRepository,
} from "@/lib/network-center/supabaseRepository";

type RpcResult = {
  data: unknown;
  error: null | { code?: string; message?: string; details?: string };
};

type RpcCall = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<RpcResult>;

type Repository = {
  listFleet(): Promise<NetworkBuilding[]>;
  getBuilding(buildingId: string, fallback?: NetworkBuilding): Promise<NetworkBuilding | null>;
  listArubaPage(
    buildingId: string,
    cursor?: { sortOrder: number; id: string } | null,
    limit?: number,
  ): Promise<{
    items: NetworkBuilding["arubaNodes"];
    nextCursor: { sortOrder: number; id: string } | null;
  }>;
  executeAction(
    buildingId: string,
    request: NetworkActionRequest,
    actor: NetworkActor,
    requestId?: string,
  ): Promise<NetworkJob>;
  getCommand(
    buildingId: string,
    lookup: { commandId?: string | null; requestId?: string | null },
  ): Promise<NetworkJob>;
  updateSettings(
    buildingId: string,
    settings: Partial<NetworkSettings>,
    actor: NetworkActor,
    requestId?: string,
    expectedVersion?: number,
  ): Promise<void>;
};

const RepositoryConstructor = SupabaseNetworkCenterRepository as unknown as new (
  rpc: RpcCall,
) => Repository;

const BUILDING_ID = "11111111-1111-4111-8111-111111111111";
const ROUTER_ID = "22222222-2222-4222-8222-222222222222";
const INCIDENT_ID = "33333333-3333-4333-8333-333333333333";
const INTERFACE_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const COMMAND_ID = "66666666-6666-4666-8666-666666666666";
const AUDIT_ID = "77777777-7777-4777-8777-777777777777";
const REQUEST_ID = "88888888-8888-4888-8888-888888888888";
const NOW = "2026-07-28T12:00:00.000Z";

function uuidFor(index: number): string {
  return `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function fleetResponse(overrides: Record<string, unknown> = {}) {
  return {
    items: [{
      buildingId: BUILDING_ID,
      buildingName: "Tòa Demo",
      roomsCount: 24,
      routerId: ROUTER_ID,
      routerIdentity: "MikroTik — Tòa Demo",
      routerModel: null,
      targetFirmware: null,
      lifecycleStatus: "UNPROVISIONED",
      reachable: false,
      healthStatus: "UNKNOWN",
      lastSeenAt: null,
      routerosVersion: null,
      cpuPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      pppoeState: null,
      connectionCount: null,
      arubaCount: 101,
      openIncidents: 1,
      activeClients: 1,
      lastBackupAt: null,
      uptimePercent: null,
      mttrSeconds: null,
      maintenanceActive: false,
      ...overrides,
    }],
  };
}

function buildingResponse(overrides: Record<string, unknown> = {}) {
  return {
    buildingId: BUILDING_ID,
    buildingName: "Tòa Demo",
    roomsCount: 24,
    router: {
      id: ROUTER_ID,
      identity: "MikroTik — Tòa Demo",
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
    interfaces: [{
      id: INTERFACE_ID,
      name: "ether1 · WAN",
      key: "ether1",
      role: "WAN",
      protected: true,
      enabled: true,
      linkState: "DOWN",
      rxBps: 0,
      txBps: 0,
      utilizationPercent: 0,
      errors: 0,
      discards: 0,
      queueDrops: 0,
    }],
    incidents: [{
      id: INCIDENT_ID,
      title: "Router chưa kết nối",
      detail: "Chưa nhận được heartbeat",
      severity: "WARNING",
      status: "OPEN",
      openedAt: NOW,
      acknowledgedAt: null,
    }],
    maintenance: null,
    revisions: [],
    settings: {
      pollingSeconds: 60,
      backupHour: "03:00",
      alertSensitivity: "standard",
      dependencyGrouping: true,
      changesPaused: false,
      version: 7,
    },
    ...overrides,
  };
}

function arubaItem(index: number) {
  return {
    id: uuidFor(index),
    name: `Aruba ${index}`,
    model: "AP-515",
    externalKey: `aruba-${index}`,
    lifecycleStatus: "ONLINE",
    reachable: true,
    healthStatus: "HEALTHY",
    lastSeenAt: NOW,
    address: `198.19.0.${index}`,
  };
}

function createRpcHarness(options?: {
  fleet?: unknown;
  fleetError?: RpcResult["error"];
  clientItems?: unknown[];
  connected?: boolean;
}) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const connected = options?.connected ?? false;
  const rpc: RpcCall = async (name, args) => {
    calls.push({ name, args });
    switch (name) {
      case "network_center_list_fleet_v1":
        return {
          data: options && "fleet" in options
            ? options.fleet
            : fleetResponse(connected
              ? {
                lifecycleStatus: "ONLINE",
                reachable: true,
                healthStatus: "HEALTHY",
                routerModel: "RB5009",
                routerosVersion: "7.20.1",
                lastSeenAt: NOW,
              }
              : {}),
          error: options?.fleetError ?? null,
        };
      case "network_center_get_building_v1":
        return {
          data: buildingResponse(connected
            ? {
              router: {
                ...buildingResponse().router,
                model: "RB5009",
                firmware: "7.20.1",
                lifecycleStatus: "ONLINE",
                reachable: true,
                healthStatus: "HEALTHY",
                lastSeenAt: NOW,
              },
            }
            : {}),
          error: null,
        };
      case "network_center_list_aruba_v1": {
        const afterId = args?.p_after_id;
        return afterId
          ? { data: { items: [arubaItem(101)], nextCursor: null }, error: null }
          : {
            data: {
              items: Array.from({ length: 100 }, (_, index) => arubaItem(index + 1)),
              nextCursor: { sortOrder: 100, id: uuidFor(100) },
            },
            error: null,
          };
      }
      case "network_center_list_clients_v1":
        return {
          data: {
            items: options?.clientItems ?? [{
              id: CLIENT_ID,
              hostname: "Điện thoại demo",
              address: "198.18.0.10",
              macAddress: "02:00:00:00:00:01",
              sessionType: "LEASE",
              connectionType: "DHCP",
              roomHint: "P.101",
              customerName: null,
              roomId: null,
              contractId: null,
              customerId: null,
              rxBps: 1_000_000,
              txBps: 500_000,
              randomizedMac: true,
              sessionIdentity: "session-1",
              lastSeenAt: NOW,
              expiresAt: "2026-07-28T12:10:00.000Z",
            }],
            nextCursor: null,
          },
          error: null,
        };
      case "network_center_list_commands_v1":
        return {
          data: {
            items: [{
              id: COMMAND_ID,
              actionType: "FLUSH_DNS_CACHE",
              reason: "Làm mới DNS để kiểm tra",
              parameters: {},
              target: {
                buildingId: BUILDING_ID,
                buildingName: "Tòa Demo",
                deviceId: ROUTER_ID,
                routerIdentity: "MikroTik — Tòa Demo",
              },
              requestedBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              status: "PENDING",
              attemptCount: 0,
              result: null,
              rollback: null,
              reconciliationState: "NOT_REQUIRED",
              createdAt: NOW,
              startedAt: null,
              finishedAt: null,
            }],
            nextCursor: null,
          },
          error: null,
        };
      case "network_center_get_command_v1":
        return {
          data: {
            id: COMMAND_ID,
            actionType: "FLUSH_DNS_CACHE",
            reason: "Làm mới DNS để kiểm tra",
            parameters: {},
            target: {
              buildingId: BUILDING_ID,
              buildingName: "Tòa Demo",
              deviceId: ROUTER_ID,
              routerIdentity: "MikroTik — Tòa Demo",
            },
            requestedBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "RUNNING",
            attemptCount: 1,
            result: null,
            rollback: null,
            reconciliationState: "NONE",
            transitionVersion: 2,
            createdAt: NOW,
            startedAt: NOW,
            finishedAt: null,
          },
          error: null,
        };
      case "network_center_list_audit_v1":
        return {
          data: {
            items: [{
              id: AUDIT_ID,
              at: NOW,
              actorType: "USER",
              actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              workerId: null,
              action: "flush_dns_cache",
              targetType: "device",
              targetId: ROUTER_ID,
              target: {
                buildingId: BUILDING_ID,
                buildingName: "Tòa Demo",
                routerIdentity: "MikroTik — Tòa Demo",
              },
              reason: "Làm mới DNS để kiểm tra",
              validation: { permission: "network_center.execute" },
              result: { status: "QUEUED" },
              outcome: "ACCEPTED",
              commandId: COMMAND_ID,
            }],
            nextCursor: null,
          },
          error: null,
        };
      case "network_center_execute_action_v1":
        return {
          data: {
            commandId: COMMAND_ID,
            status: "QUEUED",
            actionType: "FLUSH_DNS_CACHE",
            reason: "Làm mới DNS để kiểm tra",
            parameters: {},
            target: {
              buildingId: BUILDING_ID,
              buildingName: "Tòa Demo",
              deviceId: ROUTER_ID,
              routerIdentity: "MikroTik — Tòa Demo",
            },
          },
          error: null,
        };
      case "network_center_update_settings_v1":
        return {
          data: {
            pollingSeconds: 90,
            backupHour: "03:00",
            alertSensitivity: "standard",
            dependencyGrouping: true,
            changesPaused: false,
            version: 8,
          },
          error: null,
        };
      default:
        throw new Error(`Unexpected RPC ${name}`);
    }
  };
  return { calls, rpc };
}

describe("Network Center Supabase repository boundary", () => {
  it("provides focused DTO, query-key, and repository modules", () => {
    for (const relativePath of [
      "../network-center/dto.ts",
      "../network-center/queryKeys.ts",
      "../network-center/supabaseRepository.ts",
    ]) {
      expect(existsSync(resolve(import.meta.dirname, relativePath))).toBe(true);
    }
  });

  it("exports the production parsing, cache-key, and repository API", async () => {
    const [dtoModule, keyModule, repositoryModule] = await Promise.all([
      import("../network-center/dto"),
      import("../network-center/queryKeys"),
      import("../network-center/supabaseRepository"),
    ]);
    const dto = dtoModule as Record<string, unknown>;
    const keys = keyModule.networkCenterQueryKeys as Record<string, unknown>;
    const repository = repositoryModule as Record<string, unknown>;
    const repositoryClass = repositoryModule.SupabaseNetworkCenterRepository as unknown as {
      prototype: Record<string, unknown>;
    };

    expect(typeof dto.parseNetworkCenterFleet).toBe("function");
    expect(typeof dto.parseNetworkCenterBuilding).toBe("function");
    expect(typeof keys.fleet).toBe("function");
    expect(typeof keys.building).toBe("function");
    expect(typeof repository.NetworkCenterRepositoryError).toBe("function");
    expect(typeof repositoryClass.prototype.listFleet).toBe("function");
    expect(typeof repositoryClass.prototype.getBuilding).toBe("function");
    expect(typeof repositoryClass.prototype.getCommand).toBe("function");
  });

  it("builds stable identity-scoped keys independent of organization order", () => {
    expect(networkCenterQueryKeys.fleet(" User-A ", ["ORG-Z", "org-a", "org-a"])).toEqual([
      "network-center",
      "user-a",
      "fleet",
      ["org-a", "org-z"],
    ]);
    expect(networkCenterQueryKeys.building(" User-A ", " ORG-A ", BUILDING_ID.toUpperCase())).toEqual([
      "network-center",
      "user-a",
      "org-a",
      "building",
      BUILDING_ID,
    ]);
    expect(networkCenterQueryKeys.aruba(" User-A ", " ORG-A ", BUILDING_ID.toUpperCase())).toEqual([
      "network-center",
      "user-a",
      "org-a",
      "building",
      BUILDING_ID,
      "aruba",
    ]);
  });

  it("loads only the first Aruba page with an explicit cursor for incremental loading", async () => {
    const harness = createRpcHarness();
    const repository = new RepositoryConstructor(harness.rpc);

    const fleet = await repository.listFleet();
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({
      buildingId: BUILDING_ID,
      health: "offline",
      backupStatus: "stale",
      backupAgeHours: -1,
      arubaTotal: 101,
      arubaOnline: null,
      activeClients: 1,
      router: {
        id: ROUTER_ID,
        model: "Chưa xác định",
        firmware: "Chưa kết nối",
        lastSeenLabel: "Chưa kết nối",
      },
    });
    expect(fleet[0].incidents).toHaveLength(1);

    const building = await repository.getBuilding(BUILDING_ID, fleet[0]);
    expect(building).not.toBeNull();
    expect(building!.arubaNodes).toHaveLength(0);
    expect(building).toMatchObject({
      arubaTotal: 101,
      arubaOnline: null,
    });
    expect(building!.clients).toHaveLength(1);
    expect(building!.clients[0]).toMatchObject({ rxMbps: 1, txMbps: 0.5 });
    expect(building!.jobs).toHaveLength(1);
    expect(building!.audit).toHaveLength(1);
    expect(building as NetworkBuilding & { settingsVersion: number }).toMatchObject({
      settingsVersion: 7,
    });

    const arubaCalls = harness.calls.filter((call) => call.name === "network_center_list_aruba_v1");
    const buildingCalls = harness.calls.filter(
      (call) => call.name === "network_center_get_building_v1",
    );
    expect(buildingCalls).toHaveLength(2);
    expect(arubaCalls).toHaveLength(0);

    const firstPage = await repository.listArubaPage(BUILDING_ID);
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.nextCursor).toEqual({ sortOrder: 100, id: uuidFor(100) });
    expect(harness.calls.at(-1)?.args).toMatchObject({ p_limit: 100, p_after_id: null });

    const nextPage = await repository.listArubaPage(BUILDING_ID, firstPage.nextCursor);
    expect(nextPage.items).toHaveLength(1);
    expect(nextPage.nextCursor).toBeNull();
    expect(harness.calls.filter((call) => call.name === "network_center_list_aruba_v1")).toHaveLength(2);
    expect(harness.calls.at(-1)?.args).toMatchObject({
      p_limit: 100,
      p_after_sort_order: 100,
      p_after_id: uuidFor(100),
    });
  });

  it("accepts bounded Aruba pages up to 250 and rejects a larger request before RPC", async () => {
    const harness = createRpcHarness();
    const repository = new RepositoryConstructor(harness.rpc);

    await repository.listArubaPage(BUILDING_ID, null, 250);
    expect(harness.calls.at(-1)).toMatchObject({
      name: "network_center_list_aruba_v1",
      args: { p_limit: 250 },
    });

    const callsBeforeReject = harness.calls.length;
    await expect(repository.listArubaPage(BUILDING_ID, null, 251)).rejects.toBeInstanceOf(
      NetworkCenterRepositoryError,
    );
    expect(harness.calls).toHaveLength(callsBeforeReject);
  });

  it("rejects null, backend errors, and overfilled bounded pages without leaking raw details", async () => {
    const nullRepository = new RepositoryConstructor(createRpcHarness({ fleet: null }).rpc);
    await expect(nullRepository.listFleet()).rejects.toBeInstanceOf(NetworkCenterRepositoryError);

    const failedRepository = new RepositoryConstructor(createRpcHarness({
      fleetError: { code: "42501", message: "password=do-not-leak" },
    }).rpc);
    const failure = await failedRepository.listFleet().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkCenterRepositoryError);
    expect(String((failure as Error).message)).not.toContain("do-not-leak");
    expect(Object.prototype.hasOwnProperty.call(failure, "cause")).toBe(false);

    const thrownRepository = new RepositoryConstructor(async () => {
      throw new Error("password=do-not-leak");
    });
    const thrown = await thrownRepository.listFleet().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NetworkCenterRepositoryError);
    expect(Object.prototype.hasOwnProperty.call(thrown, "cause")).toBe(false);
    expect(String((thrown as Error).message)).not.toContain("do-not-leak");

    const oversizedClients = Array.from({ length: 101 }, (_, index) => ({
      id: uuidFor(index + 200),
      hostname: null,
      address: null,
      macAddress: null,
      sessionType: "UNKNOWN",
      connectionType: "UNKNOWN",
      roomHint: null,
      customerName: null,
      roomId: null,
      contractId: null,
      customerId: null,
      rxBps: null,
      txBps: null,
      randomizedMac: false,
      sessionIdentity: `session-${index}`,
      lastSeenAt: NOW,
      expiresAt: "2026-07-28T12:10:00.000Z",
    }));
    const oversizedHarness = createRpcHarness({ clientItems: oversizedClients });
    const oversizedRepository = new RepositoryConstructor(oversizedHarness.rpc);
    const fleet = await oversizedRepository.listFleet();
    await expect(oversizedRepository.getBuilding(BUILDING_ID, fleet[0])).rejects.toBeInstanceOf(
      NetworkCenterRepositoryError,
    );
  });

  it("keeps actor identity server-derived and reuses caller-provided idempotency keys", async () => {
    const harness = createRpcHarness({ connected: true });
    const repository = new RepositoryConstructor(harness.rpc);
    const [site] = await repository.listFleet();
    const actor = { id: "browser-user-id", label: "Nhân viên mạng" };
    const request: NetworkActionRequest = {
      type: "flush_dns_cache",
      reason: "Làm mới DNS để kiểm tra",
      fields: {},
    };

    const first = await repository.executeAction(site.buildingId, request, actor, REQUEST_ID);
    const second = await repository.executeAction(site.buildingId, request, actor, REQUEST_ID);
    expect(first).toMatchObject({ id: COMMAND_ID, status: "running", action: "flush_dns_cache" });
    expect(second.id).toBe(first.id);
    expect(harness.calls.filter((call) => call.name === "network_center_get_command_v1"))
      .toHaveLength(2);

    await repository.updateSettings(
      site.buildingId,
      { pollingSeconds: 90 },
      actor,
      REQUEST_ID,
      6,
    );
    const executeCalls = harness.calls.filter(
      (call) => call.name === "network_center_execute_action_v1",
    );
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0].args).toEqual(executeCalls[1].args);
    expect(executeCalls[0].args).toEqual({
      p_device_id: ROUTER_ID,
      p_action_type: "FLUSH_DNS_CACHE",
      p_reason: "Làm mới DNS để kiểm tra",
      p_parameters: {},
      p_confirmation: null,
      p_request_id: REQUEST_ID,
    });
    expect(JSON.stringify(executeCalls)).not.toContain(actor.id);

    const settingsCall = harness.calls.find(
      (call) => call.name === "network_center_update_settings_v1",
    );
    expect(settingsCall?.args).toEqual({
      p_building_id: BUILDING_ID,
      p_settings: { pollingSeconds: 90 },
      p_expected_version: 6,
      p_request_id: REQUEST_ID,
    });
    expect(JSON.stringify(settingsCall)).not.toContain(actor.id);
  });

  it("recovers the exact existing command from typed semantic duplicate details", async () => {
    const harness = createRpcHarness({ connected: true });
    const rpc: RpcCall = async (name, args) => {
      if (name === "network_center_execute_action_v1") {
        return {
          data: null,
          error: {
            code: "P0001",
            message: "Equivalent command intent already exists",
            details: JSON.stringify({
              code: "NETWORK_CENTER_DUPLICATE_INTENT",
              commandId: COMMAND_ID,
              actionType: "FLUSH_DNS_CACHE",
              cooldownSeconds: 30,
            }),
          },
        };
      }
      return harness.rpc(name, args);
    };
    const repository = new RepositoryConstructor(rpc);
    const [site] = await repository.listFleet();

    const restored = await repository.executeAction(site.buildingId, {
      type: "flush_dns_cache",
      reason: "Làm mới DNS để kiểm tra",
      fields: {},
    }, { id: "browser-user-id", label: "Nhân viên" }, REQUEST_ID);

    expect(restored).toMatchObject({ id: COMMAND_ID, status: "running" });
    expect(harness.calls.at(-1)).toMatchObject({
      name: "network_center_get_command_v1",
      args: {
        p_building_id: BUILDING_ID,
        p_command_id: COMMAND_ID,
        p_request_id: null,
      },
    });
  });

  it("recovers an ambiguous submission by exact frozen request id", async () => {
    const harness = createRpcHarness({ connected: true });
    const repository = new RepositoryConstructor(harness.rpc);

    const command = await repository.getCommand(BUILDING_ID, { requestId: REQUEST_ID });

    expect(command.id).toBe(COMMAND_ID);
    expect(harness.calls.at(-1)).toMatchObject({
      name: "network_center_get_command_v1",
      args: {
        p_building_id: BUILDING_ID,
        p_command_id: null,
        p_request_id: REQUEST_ID,
      },
    });
  });

  it("keeps UNCERTAIN as a first-class exact command status", async () => {
    const harness = createRpcHarness({ connected: true });
    const rpc: RpcCall = async (name, args) => name === "network_center_get_command_v1"
      ? {
        data: {
          ...(await harness.rpc(name, args)).data as Record<string, unknown>,
          status: "UNCERTAIN",
          reconciliationState: "REQUIRED",
        },
        error: null,
      }
      : harness.rpc(name, args);
    const repository = new RepositoryConstructor(rpc);

    const command = await repository.getCommand(BUILDING_ID, { commandId: COMMAND_ID });
    expect(command.status).toBe("uncertain");
    expect(command.reconciliation.status).toBe("uncertain");
  });

  it("does not enumerate unlimited Aruba inventory before a mutation", async () => {
    const harness = createRpcHarness({ connected: true });
    const repository = new RepositoryConstructor(harness.rpc);
    const [site] = await repository.listFleet();

    await repository.executeAction(site.buildingId, {
      type: "flush_dns_cache",
      reason: "Kiểm tra không tải Aruba khi thao tác",
      fields: {},
    }, { id: "browser-user-id", label: "Nhân viên" });

    expect(harness.calls.filter((call) => call.name === "network_center_list_aruba_v1")).toHaveLength(0);
  });

  it("surfaces a sanitized actionable settings-version conflict", async () => {
    const repository = new RepositoryConstructor(async () => ({
      data: null,
      error: { code: "40001", message: "database-detail=do-not-leak" },
    }));

    const failure = await repository.updateSettings(
      BUILDING_ID,
      { pollingSeconds: 90 },
      { id: "browser-user-id", label: "Nhân viên" },
      REQUEST_ID,
      7,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NetworkCenterRepositoryError);
    expect(String((failure as Error).message)).toMatch(/đã thay đổi.*tải lại/i);
    expect(String((failure as Error).message)).not.toContain("do-not-leak");
  });

  it("does not reuse a building DTO across a later permission or backend boundary", async () => {
    const harness = createRpcHarness({ connected: true });
    let failDetails = false;
    const rpc: RpcCall = async (name, args) => {
      if (failDetails && name === "network_center_get_building_v1") {
        return { data: null, error: { code: "42501", message: "out-of-scope" } };
      }
      return harness.rpc(name, args);
    };
    const repository = new RepositoryConstructor(rpc);
    const [site] = await repository.listFleet();
    failDetails = true;

    await expect(repository.executeAction(site.buildingId, {
      type: "flush_dns_cache",
      reason: "Kiểm tra boundary",
      fields: {},
    }, { id: "browser-user-id", label: "Nhân viên" })).rejects.toBeInstanceOf(
      NetworkCenterRepositoryError,
    );
  });
});
