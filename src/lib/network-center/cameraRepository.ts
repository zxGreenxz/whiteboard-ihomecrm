import { supabase } from "@/integrations/supabase/client";
import {
  cameraBuildingSchema, cameraEventsSchema,
  type CameraEventCursor, type CameraRepository, type CameraScope,
} from "./cameraContracts";
import { NetworkCenterRepositoryError, type NetworkCenterRpcCall } from "./supabaseRepository";

const rpc: NetworkCenterRpcCall = (name, args) =>
  (supabase.rpc as unknown as NetworkCenterRpcCall)(name, args);

function checkScope(scope: CameraScope, rows: Array<{ organization_id: string; building_id: string }>) {
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
