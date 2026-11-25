import type { ZodType } from "zod";
import { supabase } from "@/integrations/supabase/client";
import {
  cameraAlertDeliveriesSchema, cameraAlertSettingsViewSchema, cameraAlertTestResultSchema, cameraAlertZaloGroupsSchema,
  cameraBuildingMutesSchema, cameraBuildingSchema, cameraChannelMuteClearSchema, cameraChannelMuteSchema, cameraEventsSchema,
  cameraIncidentAcknowledgementSchema, cameraIncidentsSchema,
  type CameraAlertDeliveryQuery, type CameraAlertRepository, type CameraAlertSettingsPatch, type CameraChannelMuteInput,
  type CameraEventCursor, type CameraRecorder, type CameraRepository, type CameraScope,
} from "./cameraContracts";
import { NetworkCenterRepositoryError, type NetworkCenterRpcCall } from "./supabaseRepository";

const rpc: NetworkCenterRpcCall = (name, args) =>
  (supabase.rpc as unknown as NetworkCenterRpcCall)(name, args);

function checkScope(scope: CameraScope, rows: Array<Pick<CameraRecorder, "organization_id" | "building_id">>) {
  if (rows.some((row) => row.organization_id !== scope.organizationId || row.building_id !== scope.buildingId)) {
    throw new NetworkCenterRepositoryError("Dữ liệu camera không khớp tòa nhà đang chọn.", { code: "CAMERA_SCOPE_MISMATCH" });
  }
}

export class SupabaseCameraRepository implements CameraRepository {
  constructor(private readonly call: NetworkCenterRpcCall = rpc) {}

  private async read(name: string, args: Record<string, unknown>) {
    const { data, error } = await this.call(name, args);
    if (error) {
      const message = error.code === "42501" ? "Bạn không có quyền xem camera của tòa nhà này."
        : error.code === "PGRST301" || error.code === "PGRST302" ? "Phiên đăng nhập đã hết hạn. Đăng nhập lại để xem camera."
          : error.code === "PGRST202" || error.code === "42883" ? "Dịch vụ theo dõi camera chưa được triển khai."
            : "Không thể tải dữ liệu camera. Vui lòng thử lại.";
      throw new NetworkCenterRepositoryError(message, { code: error.code, rpcName: name });
    }
    return data;
  }

  async getBuilding(scope: CameraScope) {
    const parsed = cameraBuildingSchema.safeParse(await this.read("camera_building_snapshot_v1", { p_building_id: scope.buildingId }));
    if (!parsed.success) throw new NetworkCenterRepositoryError("Dữ liệu trạng thái camera chưa hợp lệ.", { code: "CAMERA_INVALID_DATA" });
    checkScope(scope, parsed.data.recorders);
    for (const recorder of parsed.data.recorders) {
      if (recorder.snapshot) {
        checkScope(scope, [recorder.snapshot]);
        if (recorder.snapshot.recorder_id !== recorder.id) {
          throw new NetworkCenterRepositoryError("Dữ liệu camera không khớp đầu ghi.", { code: "CAMERA_SCOPE_MISMATCH" });
        }
      }
    }
    return parsed.data;
  }

  async listEvents(scope: CameraScope, cursor?: CameraEventCursor) {
    const parsed = cameraEventsSchema.safeParse(await this.read("camera_building_events_v1", {
      p_building_id: scope.buildingId, p_limit: 50,
      p_before_observed_at: cursor?.observedAt ?? null, p_before_id: cursor?.id ?? null,
    }));
    if (!parsed.success || (parsed.data.hasMore && parsed.data.items.length === 0)) {
      throw new NetworkCenterRepositoryError("Dữ liệu lịch sử camera chưa hợp lệ.", { code: "CAMERA_INVALID_DATA" });
    }
    checkScope(scope, parsed.data.items);
    return parsed.data;
  }
}

export const supabaseCameraRepository = new SupabaseCameraRepository();

// ---------------------------------------------------------------------------
// Cảnh báo camera v2. Mã lỗi giữ nguyên trên NetworkCenterRepositoryError.code
// để UI phân biệt quyền (42501), xung đột (PT409) và dữ liệu nhập (22023).
// ---------------------------------------------------------------------------
function alertErrorMessage(code: string | undefined, serverMessage: string | undefined): string {
  switch (code) {
    case "42501": return "Bạn không có quyền thực hiện thao tác này với cảnh báo camera.";
    case "PT409": return "Cài đặt cảnh báo camera vừa được người khác thay đổi. Tải lại rồi lưu lại.";
    case "22023": {
      // Câu kiểm dữ liệu của RPC viết cho người dùng; quá dài thì dùng câu chung.
      const message = serverMessage?.trim();
      return message && message.length <= 200 ? message : "Giá trị nhập chưa hợp lệ.";
    }
    case "P0002": return "Sự cố này đã đóng.";
    case "PGRST301":
    case "PGRST302": return "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.";
    case "PGRST202":
    case "42883": return "Bộ cảnh báo camera chưa được triển khai trên hệ thống này.";
    default: return "Không thể xử lý cảnh báo camera. Vui lòng thử lại.";
  }
}

function checkAlertScope(scope: CameraScope, rows: Array<{ organization_id?: string; building_id?: string; organizationId?: string; buildingId?: string }>) {
  if (rows.some((row) => (row.organization_id ?? row.organizationId) !== scope.organizationId
    || (row.building_id ?? row.buildingId) !== scope.buildingId)) {
    throw new NetworkCenterRepositoryError("Dữ liệu camera không khớp tòa nhà đang chọn.", { code: "CAMERA_SCOPE_MISMATCH" });
  }
}

export class SupabaseCameraAlertRepository implements CameraAlertRepository {
  constructor(private readonly call: NetworkCenterRpcCall = rpc) {}

  private async run<T>(name: string, args: Record<string, unknown>, schema: ZodType<T>): Promise<T> {
    const { data, error } = await this.call(name, args);
    if (error) {
      throw new NetworkCenterRepositoryError(alertErrorMessage(error.code, error.message), { code: error.code, rpcName: name });
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new NetworkCenterRepositoryError("Dữ liệu cảnh báo camera chưa hợp lệ.", { code: "CAMERA_ALERT_INVALID_DATA", rpcName: name });
    }
    return parsed.data;
  }

  private ownView<T extends { organizationId: string }>(organizationId: string, view: T): T {
    if (view.organizationId !== organizationId) {
      throw new NetworkCenterRepositoryError("Dữ liệu cảnh báo camera không khớp công ty đang chọn.", { code: "CAMERA_SCOPE_MISMATCH" });
    }
    return view;
  }

  async getSettings(organizationId: string) {
    return this.ownView(organizationId, await this.run("camera_alert_get_settings_v1",
      { p_organization_id: organizationId }, cameraAlertSettingsViewSchema));
  }

  async saveSettings(organizationId: string, expectedVersion: number, patch: CameraAlertSettingsPatch) {
    return this.ownView(organizationId, await this.run("camera_alert_save_settings_v1",
      { p_organization_id: organizationId, p_expected_version: expectedVersion, p_patch: patch }, cameraAlertSettingsViewSchema));
  }

  listZaloGroups(organizationId: string, search?: string, limit = 50) {
    return this.run("camera_alert_list_zalo_groups_v1",
      { p_organization_id: organizationId, p_search: search?.trim() || null, p_limit: limit }, cameraAlertZaloGroupsSchema);
  }

  setChannelMute(input: CameraChannelMuteInput) {
    return this.run("camera_alert_set_channel_mute_v1", {
      p_recorder_id: input.recorderId, p_channel: input.channel, p_kind: input.kind,
      p_until: input.kind === "SNOOZE" ? input.untilAt ?? null : null, p_note: input.note?.trim() || null,
    }, cameraChannelMuteSchema);
  }

  clearChannelMute(recorderId: string, channel: number) {
    return this.run("camera_alert_clear_channel_mute_v1", { p_recorder_id: recorderId, p_channel: channel }, cameraChannelMuteClearSchema);
  }

  async listBuildingMutes(scope: CameraScope) {
    const data = await this.run("camera_building_channel_mutes_v1", { p_building_id: scope.buildingId }, cameraBuildingMutesSchema);
    checkAlertScope(scope, data.items);
    return data;
  }

  async listDeliveries(organizationId: string, query: CameraAlertDeliveryQuery = {}) {
    const data = await this.run("camera_alert_list_deliveries_v1", {
      p_organization_id: organizationId, p_status: query.status ?? null, p_limit: query.limit ?? 100,
      p_before: query.before?.createdAt ?? null, p_before_id: query.before?.id ?? null,
    }, cameraAlertDeliveriesSchema);
    if (data.hasMore && data.items.length === 0) {
      throw new NetworkCenterRepositoryError("Dữ liệu cảnh báo camera chưa hợp lệ.", { code: "CAMERA_ALERT_INVALID_DATA" });
    }
    return data;
  }

  sendTest(organizationId: string) {
    return this.run("camera_alert_send_test_v1", { p_organization_id: organizationId }, cameraAlertTestResultSchema);
  }

  async listIncidents(scope: CameraScope) {
    const data = await this.run("camera_building_incidents_v1", { p_building_id: scope.buildingId }, cameraIncidentsSchema);
    checkAlertScope(scope, data.items);
    return data;
  }

  acknowledgeIncident(incidentId: string) {
    return this.run("camera_alert_acknowledge_incident_v1", { p_incident_id: incidentId }, cameraIncidentAcknowledgementSchema);
  }
}

export const supabaseCameraAlertRepository = new SupabaseCameraAlertRepository();
