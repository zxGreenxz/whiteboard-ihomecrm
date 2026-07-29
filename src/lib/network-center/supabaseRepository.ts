import { supabase } from "@/integrations/supabase/client";
import type {
  ArubaPage,
  ArubaPageCursor,
  ConfigDiff,
  MaintenanceInput,
  MaintenanceWindow,
  NetworkActionRequest,
  NetworkActor,
  NetworkBuilding,
  NetworkCenterRepository,
  NetworkJob,
  NetworkSettings,
} from "./contracts";
import {
  NETWORK_CENTER_ARUBA_MAX_PAGE_SIZE,
  NETWORK_CENTER_ARUBA_PAGE_SIZE,
  NETWORK_CENTER_PAGE_SIZE,
  mapNetworkCenterArubaPage,
  mapNetworkCenterExecuteResult,
  mapNetworkCenterFleetItem,
  mergeNetworkCenterBuilding,
  parseNetworkCenterAcknowledgementResult,
  parseNetworkCenterArubaPage,
  parseNetworkCenterAuditPage,
  parseNetworkCenterBuilding,
  parseNetworkCenterCancellationResult,
  parseNetworkCenterClientPage,
  parseNetworkCenterCommandPage,
  parseNetworkCenterDiff,
  parseNetworkCenterExecuteResult,
  parseNetworkCenterFleet,
  parseNetworkCenterMaintenanceResult,
  parseNetworkCenterSettingsResult,
  parseNetworkCenterSnapshotRequestResult,
  type NetworkCenterBuildingDto,
} from "./dto";

export type NetworkCenterRpcResult = {
  data: unknown;
  error: null | { code?: string; message?: string };
};

export type NetworkCenterRpcCall = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<NetworkCenterRpcResult>;

const boundSupabaseRpc = supabase.rpc.bind(supabase) as unknown as NetworkCenterRpcCall;

const defaultRpc: NetworkCenterRpcCall = async (name, args) => {
  const result = await boundSupabaseRpc(name, args);
  return { data: result.data, error: result.error };
};

export class NetworkCenterRepositoryError extends Error {
  readonly rpcName?: string;
  readonly code?: string;

  constructor(message: string, options?: { rpcName?: string; code?: string }) {
    super(message);
    this.name = "NetworkCenterRepositoryError";
    this.rpcName = options?.rpcName;
    this.code = options?.code;
  }
}

function requestId(value?: string): string {
  return value ?? crypto.randomUUID();
}

function actionName(type: NetworkActionRequest["type"]): string {
  return type.toUpperCase();
}

export class SupabaseNetworkCenterRepository implements NetworkCenterRepository {
  constructor(private readonly rpc: NetworkCenterRpcCall = defaultRpc) {}

  async listFleet(): Promise<NetworkBuilding[]> {
    const fleet = await this.call(
      "network_center_list_fleet_v1",
      undefined,
      parseNetworkCenterFleet,
    );
    const details = await Promise.all(
      fleet.items.map((item) => this.fetchBuildingDto(item.buildingId)),
    );
    return fleet.items.map((item, index) => {
      const building = mapNetworkCenterFleetItem(item, details[index]);
      return building;
    });
  }

  async getBuilding(
    buildingId: string,
    fallback?: NetworkBuilding,
  ): Promise<NetworkBuilding | null> {
    const normalizedBuildingId = buildingId.trim().toLowerCase();
    let base = fallback;
    if (!base) {
      const fleet = await this.listFleet();
      base = fleet.find((item) => item.buildingId === normalizedBuildingId);
    }
    if (!base) return null;

    const detail = await this.fetchBuildingDto(normalizedBuildingId);
    const [clients, commands, audit] = await Promise.all([
      this.call(
        "network_center_list_clients_v1",
        {
          p_building_id: normalizedBuildingId,
          p_before_seen_at: null,
          p_before_id: null,
          p_limit: NETWORK_CENTER_PAGE_SIZE,
        },
        parseNetworkCenterClientPage,
      ),
      this.call(
        "network_center_list_commands_v1",
        {
          p_building_id: normalizedBuildingId,
          p_before_created_at: null,
          p_before_id: null,
          p_limit: NETWORK_CENTER_PAGE_SIZE,
        },
        parseNetworkCenterCommandPage,
      ),
      this.call(
        "network_center_list_audit_v1",
        {
          p_building_id: normalizedBuildingId,
          p_before_occurred_at: null,
          p_before_id: null,
          p_limit: NETWORK_CENTER_PAGE_SIZE,
        },
        parseNetworkCenterAuditPage,
      ),
    ]);
    const building = mergeNetworkCenterBuilding(
      base,
      detail,
      [],
      clients.items,
      commands.items,
      audit.items,
    );
    return building;
  }

  async listArubaPage(
    buildingId: string,
    cursor: ArubaPageCursor | null = null,
    limit = NETWORK_CENTER_ARUBA_PAGE_SIZE,
  ): Promise<ArubaPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > NETWORK_CENTER_ARUBA_MAX_PAGE_SIZE) {
      throw new NetworkCenterRepositoryError(
        `Kích thước trang Aruba phải từ 1 đến ${NETWORK_CENTER_ARUBA_MAX_PAGE_SIZE}`,
      );
    }
    const normalizedBuildingId = buildingId.trim().toLowerCase();
    const page = await this.call(
      "network_center_list_aruba_v1",
      {
        p_building_id: normalizedBuildingId,
        p_after_sort_order: cursor?.sortOrder ?? null,
        p_after_id: cursor?.id ?? null,
        p_limit: limit,
      },
      parseNetworkCenterArubaPage,
    );
    return mapNetworkCenterArubaPage(page);
  }

  async acknowledgeIncident(
    _buildingId: string,
    incidentId: string,
    _actor: NetworkActor,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.call(
      "network_center_ack_incident_v1",
      { p_incident_id: incidentId, p_request_id: requestId(idempotencyKey) },
      parseNetworkCenterAcknowledgementResult,
    );
  }

  async createMaintenance(
    buildingId: string,
    input: MaintenanceInput,
    _actor: NetworkActor,
    idempotencyKey?: string,
  ): Promise<MaintenanceWindow> {
    const result = await this.call(
      "network_center_create_maintenance_v1",
      {
        p_building_id: buildingId,
        p_duration_minutes: input.durationMinutes,
        p_reason: input.reason,
        p_request_id: requestId(idempotencyKey),
      },
      parseNetworkCenterMaintenanceResult,
    );
    return {
      id: result.id,
      reason: result.reason,
      startsAt: result.startsAt,
      endsAt: result.endsAt,
      durationMinutes: Math.max(
        0,
        Math.round((Date.parse(result.endsAt) - Date.parse(result.startsAt)) / 60_000),
      ),
    };
  }

  async cancelMaintenance(
    buildingId: string,
    maintenanceId: string,
    _actor: NetworkActor,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.call(
      "network_center_cancel_maintenance_v1",
      {
        p_building_id: buildingId,
        p_maintenance_id: maintenanceId,
        p_request_id: requestId(idempotencyKey),
      },
      parseNetworkCenterCancellationResult,
    );
  }

  async captureConfiguration(
    buildingId: string,
    label: string,
    _actor: NetworkActor,
    idempotencyKey?: string,
  ): Promise<void> {
    const building = await this.requireBuilding(buildingId);
    const routerId = this.requireWritableRouter(building);
    await this.call(
      "network_center_request_snapshot_v1",
      {
        p_device_id: routerId,
        p_label: label,
        p_request_id: requestId(idempotencyKey),
      },
      parseNetworkCenterSnapshotRequestResult,
    );
  }

  async compareRevisions(
    buildingId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<ConfigDiff> {
    return this.call(
      "network_center_compare_snapshots_v1",
      {
        p_building_id: buildingId,
        p_from_snapshot_id: fromRevisionId,
        p_to_snapshot_id: toRevisionId,
      },
      parseNetworkCenterDiff,
    );
  }

  async executeAction(
    buildingId: string,
    request: NetworkActionRequest,
    actor: NetworkActor,
    idempotencyKey?: string,
  ): Promise<NetworkJob> {
    const building = await this.requireBuilding(buildingId);
    const routerId = this.requireWritableRouter(building);
    const result = await this.call(
      "network_center_execute_action_v1",
      {
        p_device_id: routerId,
        p_action_type: actionName(request.type),
        p_reason: request.reason,
        p_parameters: request.fields,
        p_confirmation: request.confirmation ?? null,
        p_request_id: requestId(idempotencyKey),
      },
      parseNetworkCenterExecuteResult,
    );
    return mapNetworkCenterExecuteResult(building, result, actor);
  }

  async updateSettings(
    buildingId: string,
    settings: Partial<NetworkSettings>,
    _actor: NetworkActor,
    idempotencyKey?: string,
    expectedVersion?: number,
  ): Promise<void> {
    if (!Number.isInteger(expectedVersion) || (expectedVersion ?? 0) < 1) {
      throw new NetworkCenterRepositoryError("Thiếu phiên bản cài đặt đang hiển thị");
    }
    await this.call(
      "network_center_update_settings_v1",
      {
        p_building_id: buildingId,
        p_settings: settings,
        p_expected_version: expectedVersion,
        p_request_id: requestId(idempotencyKey),
      },
      parseNetworkCenterSettingsResult,
    );
  }

  private async fetchBuildingDto(buildingId: string): Promise<NetworkCenterBuildingDto> {
    const normalizedBuildingId = buildingId.trim().toLowerCase();
    return this.call(
      "network_center_get_building_v1",
      { p_building_id: normalizedBuildingId },
      parseNetworkCenterBuilding,
    );
  }

  private async requireBuilding(buildingId: string): Promise<NetworkBuilding> {
    const normalizedBuildingId = buildingId.trim().toLowerCase();
    const fleet = await this.call(
      "network_center_list_fleet_v1",
      undefined,
      parseNetworkCenterFleet,
    );
    const fleetItem = fleet.items.find((item) => item.buildingId === normalizedBuildingId);
    if (!fleetItem) {
      throw new NetworkCenterRepositoryError("Tòa nhà không thuộc phạm vi Network Center");
    }
    const detail = await this.fetchBuildingDto(normalizedBuildingId);
    return mapNetworkCenterFleetItem(fleetItem, detail);
  }

  private requireWritableRouter(building: NetworkBuilding): string {
    if (
      !building.router.id ||
      !["ONLINE", "OFFLINE"].includes(building.router.lifecycleStatus)
    ) {
      throw new NetworkCenterRepositoryError("MikroTik chưa được kết nối để thực thi thao tác");
    }
    return building.router.id;
  }

  private async call<T>(
    rpcName: string,
    args: Record<string, unknown> | undefined,
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: NetworkCenterRpcResult;
    try {
      response = await this.rpc(rpcName, args);
    } catch {
      throw new NetworkCenterRepositoryError("Không thể kết nối dịch vụ Network Center", {
        rpcName,
      });
    }
    if (response.error) {
      const message = rpcName === "network_center_update_settings_v1"
        && response.error.code === "40001"
        ? "Cài đặt đã thay đổi; vui lòng tải lại trước khi lưu"
        : "Dịch vụ Network Center từ chối yêu cầu";
      throw new NetworkCenterRepositoryError(message, {
        rpcName,
        code: response.error.code,
      });
    }
    if (response.data === null || response.data === undefined) {
      throw new NetworkCenterRepositoryError("Dịch vụ Network Center trả về dữ liệu rỗng", {
        rpcName,
      });
    }
    try {
      return parse(response.data);
    } catch {
      throw new NetworkCenterRepositoryError("Dữ liệu Network Center không đúng hợp đồng", {
        rpcName,
      });
    }
  }
}

export const supabaseNetworkCenterRepository = new SupabaseNetworkCenterRepository();
