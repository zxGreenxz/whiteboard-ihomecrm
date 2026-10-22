import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";

import {
  devicesResultSchema,
  deviceSchema,
  linkSchema,
  linksResultSchema,
  logsResultSchema,
  tenantsResultSchema,
  unlinkResultSchema,
  type DoorAction,
  type DoorDevice,
  type DoorDeviceKind,
  type DoorKeyLink,
  type DoorLogsPage,
  type DoorTenant,
  type DoorUnlockType,
} from "./dto";
import { DoorAccessError, rpcFailure } from "./errors";

export interface DoorRpcResult {
  data: unknown;
  error: { code?: string | null; message?: string | null; details?: string | null } | null;
}

export type DoorRpcCall = (name: string, args?: Record<string, unknown>) => PromiseLike<DoorRpcResult>;

/**
 * PHÉP ÉP KIỂU DUY NHẤT của tầng này.
 *
 * Các RPC `door_access_*` chưa có trong `src/integrations/supabase/types.ts` (migration viết
 * song song, types sinh lại sau khi áp). Ép một lần ở đây; mọi kết quả đi qua zod ở `call`.
 * Gọi qua arrow (không `.bind`) để tsc không dựng lại cả chồng overload của `rpc` — cùng lý do
 * với src/lib/network-center/supabaseRepository.ts.
 *
 * Chỗ gọi viết `transport.rpc("door_access_…", …)` với TÊN VIẾT THẲNG để check-rpc-surface,
 * check-rpc-arg-names và check-rpc-name-literal vẫn thấy từng RPC.
 */
const supabaseRpc: DoorRpcCall = (name, args) => (supabase.rpc as unknown as DoorRpcCall)(name, args);

export interface DoorRpcTransport {
  rpc: DoorRpcCall;
}

export interface SaveDeviceInput {
  tuyaDeviceId: string;
  buildingId: string;
  displayName: string;
  deviceKind: DoorDeviceKind;
  tuyaCategory: string | null;
  tuyaProductName: string | null;
  channelId: number;
  passwordLength: number;
}

export interface LinkKeyInput {
  deviceId: string;
  unlockType: DoorUnlockType;
  unlockSn: number;
  tuyaUserId: string | null;
  deviceUserName: string | null;
  customerId: string | null;
  label: string | null;
}

/**
 * Mốc trang kế của nhật ký: (created_at, id) của DÒNG CUỐI trang trước — khoá ghép, vì nhiều dòng
 * có thể trùng created_at (chỉ mốc thời gian thì bỏ sót dòng; hợp đồng đổi 21/10).
 */
export interface ActionLogCursor {
  before: string;
  beforeId: string;
}

export interface ActionLogQuery {
  deviceId: string | null;
  actions?: readonly DoorAction[] | null;
  limit?: number;
  cursor?: ActionLogCursor | null;
}

/** Mốc trang kế từ một trang nhật ký; hết trang (hoặc trang rỗng) ⇒ undefined. */
export function nextActionLogCursor(page: DoorLogsPage): ActionLogCursor | undefined {
  if (!page.has_more || page.logs.length === 0) return undefined;
  const last = page.logs[page.logs.length - 1];
  return last ? { before: last.created_at, beforeId: last.id } : undefined;
}

export const ACTION_LOG_PAGE_SIZE = 50;

async function call<T>(
  request: () => PromiseLike<DoorRpcResult>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  context: { operation: string; mutation: boolean },
): Promise<T> {
  let response: DoorRpcResult;
  try {
    response = await request();
  } catch {
    // supabase.rpc không ném (nó trả {error}); nhánh này chỉ cho transport tự viết.
    throw rpcFailure({ code: null, message: "network error" }, context);
  }
  if (response.error) throw rpcFailure(response.error, context);
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) {
    throw context.mutation
      ? new DoorAccessError(
          "invalid_result",
          `Chưa xác nhận được kết quả ${context.operation}. Tải lại trước khi thử lại.`,
          { outcomeUnknown: true },
        )
      : new DoorAccessError("invalid_result", `Máy chủ trả dữ liệu chưa hợp lệ khi ${context.operation}. Thử lại sau.`);
  }
  return parsed.data;
}

export function createDoorAccessRepository(transport: DoorRpcTransport = { rpc: supabaseRpc }) {
  return {
    async listDevices(organizationId: string, includeInactive = false): Promise<DoorDevice[]> {
      const result = await call(
        () => transport.rpc("door_access_devices_v1", {
          p_organization_id: organizationId,
          p_include_inactive: includeInactive,
        }),
        devicesResultSchema,
        { operation: "tải danh sách máy cửa", mutation: false },
      );
      return result.devices;
    },

    /**
     * Gắn máy MỚI / tìm máy trên SmartLife: máy chủ đòi quyền Quản lý máy ở MỌI tòa. Hỏi đúng hàm máy chủ dùng để
     * chặn — không suy từ get_my_permissions_v2 (khoá có chiều BUILDING luôn trả org_wide=false kể cả với chủ).
     */
    async canManageOrganization(organizationId: string): Promise<boolean> {
      return call(
        () => transport.rpc("door_access_can_manage_org_v1", { p_organization_id: organizationId }),
        z.boolean(),
        { operation: "kiểm quyền gắn máy mới", mutation: false },
      );
    },

    async listKeyLinks(organizationId: string, deviceId: string): Promise<DoorKeyLink[]> {
      const result = await call(
        () => transport.rpc("door_access_key_links_v1", {
          p_organization_id: organizationId,
          p_device_id: deviceId,
        }),
        linksResultSchema,
        { operation: "tải danh sách vân tay đã gắn", mutation: false },
      );
      return result.links;
    },

    async listBuildingTenants(organizationId: string, deviceId: string): Promise<DoorTenant[]> {
      const result = await call(
        () => transport.rpc("door_access_building_tenants_v1", {
          p_organization_id: organizationId,
          p_device_id: deviceId,
        }),
        tenantsResultSchema,
        { operation: "tải danh sách khách đang thuê", mutation: false },
      );
      return result.tenants;
    },

    async listActionLogs(organizationId: string, query: ActionLogQuery): Promise<DoorLogsPage> {
      return call(
        () => transport.rpc("door_access_action_logs_v1", {
          p_organization_id: organizationId,
          p_device_id: query.deviceId,
          p_actions: query.actions && query.actions.length > 0 ? [...query.actions] : null,
          p_limit: query.limit ?? ACTION_LOG_PAGE_SIZE,
          // Gửi CẢ HAI hoặc không gửi gì: mốc thời gian thiếu id thì máy chủ bỏ sót dòng trùng giờ.
          p_before: query.cursor?.before ?? null,
          p_before_id: query.cursor?.beforeId ?? null,
        }),
        logsResultSchema,
        { operation: "tải nhật ký thao tác", mutation: false },
      );
    },

    async saveDevice(organizationId: string, input: SaveDeviceInput): Promise<DoorDevice> {
      return call(
        () => transport.rpc("door_access_save_device_v1", {
          p_organization_id: organizationId,
          p_tuya_device_id: input.tuyaDeviceId,
          p_building_id: input.buildingId,
          p_display_name: input.displayName,
          p_device_kind: input.deviceKind,
          p_tuya_category: input.tuyaCategory,
          p_tuya_product_name: input.tuyaProductName,
          p_channel_id: input.channelId,
          p_password_length: input.passwordLength,
        }),
        deviceSchema,
        { operation: "lưu máy cửa", mutation: true },
      );
    },

    async disableDevice(organizationId: string, deviceId: string): Promise<DoorDevice> {
      return call(
        () => transport.rpc("door_access_disable_device_v1", {
          p_organization_id: organizationId,
          p_device_id: deviceId,
        }),
        deviceSchema,
        { operation: "tắt máy khỏi CRM", mutation: true },
      );
    },

    async linkKey(organizationId: string, input: LinkKeyInput): Promise<DoorKeyLink> {
      return call(
        () => transport.rpc("door_access_link_key_v1", {
          p_organization_id: organizationId,
          p_device_id: input.deviceId,
          p_unlock_type: input.unlockType,
          p_unlock_sn: input.unlockSn,
          p_tuya_user_id: input.tuyaUserId,
          p_device_user_name: input.deviceUserName,
          p_customer_id: input.customerId,
          p_label: input.label,
        }),
        linkSchema,
        { operation: "gắn số trên máy", mutation: true },
      );
    },

    async unlinkKey(organizationId: string, linkId: string): Promise<{ id: string }> {
      const result = await call(
        () => transport.rpc("door_access_unlink_key_v1", {
          p_organization_id: organizationId,
          p_link_id: linkId,
        }),
        unlinkResultSchema,
        { operation: "bỏ gắn", mutation: true },
      );
      return { id: result.id };
    },
  };
}

export type DoorAccessRepository = ReturnType<typeof createDoorAccessRepository>;

export const doorAccessRepository: DoorAccessRepository = createDoorAccessRepository();
