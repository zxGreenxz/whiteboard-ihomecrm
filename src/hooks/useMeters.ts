import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {confirmedRecordId,recordWriteMessage} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { nullIfNotFound } from "@/hooks/readErrors";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import { isDuplicateMeterCode } from "@/lib/meterFeedback";
import { friendlyError } from '@/lib/friendlyError';

class MeterServiceError extends Error {}
function meterMutationFailure(error: unknown, action: string) {
  if (isDuplicateMeterCode(error)) { toast.error('Mã công tơ đã tồn tại'); return; }
  if (error instanceof MeterServiceError) { toast.error(error.message); return; }
  if(error instanceof FinancialWorkflowError){toast.error(`Chưa ${action} được công tơ`,{description:recordWriteMessage(error,`${action} công tơ`)});return;}
  const feedback = friendlyError(error, `Chưa ${action} được công tơ`, { operation: `${action} công tơ` });
  toast.error(feedback.title, { description: feedback.description });
}

type Meter = Database["public"]["Tables"]["meters"]["Row"];
type MeterInsert = Database["public"]["Tables"]["meters"]["Insert"];
type MeterUpdate = Database["public"]["Tables"]["meters"]["Update"];
type MeterType = Database["public"]["Enums"]["meter_type"];

// ============================================================================
// Types
// ============================================================================

export type MeterWithRoom = Meter & {
  building: { id: string; name: string } | null;
  room: { id: string; name: string } | null;
};

export type MetersGroupedByRoom = Record<
  string,
  {
    room: { id: string; name: string } | null;
    building: { id: string; name: string } | null;
    meters: MeterWithRoom[];
  }
>;

// ============================================================================
// Pure helper functions (extracted for testability)
// ============================================================================

type FeeType = Database["public"]["Enums"]["fee_type"];

/**
 * Dấu hiệu nhận diện dịch vụ theo loại công tơ, theo thứ tự ưu tiên:
 * `fee_type` (cột phân loại đúng nghĩa, bắt buộc ở dialog tạo/sửa dịch vụ) →
 * `code` → `name` (chỉ để tương thích dữ liệu cũ).
 *
 * Khớp TÊN chính xác từng là đường duy nhất và đã gãy thật: dịch vụ "Điện" bị
 * xoá mềm 10/05/2026, từ đó MỌI lần thêm công tơ điện đều throw dù org vẫn có
 * dịch vụ điện dưới tên khác (audit 02/09/2026, C-07).
 */
const METER_TYPE_TO_SERVICE_MATCH: Record<
  string,
  { label: string; feeType?: FeeType; codes: string[]; names: string[] }
> = {
  ELECTRICITY: { label: "Tiền điện", feeType: "TIEN_DIEN", codes: ["ELEC", "DIEN"], names: ["Điện", "Tiền điện"] },
  WATER: { label: "Tiền nước", feeType: "TIEN_NUOC", codes: ["WATER", "NUOC"], names: ["Nước", "Tiền nước"] },
  GAS: { label: "Gas", codes: ["GAS"], names: ["Gas"] },
};

/** Pure function to group meters by room_id */
export function groupMetersByRoom(meters: MeterWithRoom[]): MetersGroupedByRoom {
  const grouped: MetersGroupedByRoom = {};
  for (const meter of meters) {
    const key = meter.room_id || "no-room";
    if (!grouped[key]) {
      grouped[key] = {
        room: meter.room,
        building: meter.building,
        meters: [],
      };
    }
    grouped[key].meters.push(meter);
  }
  return grouped;
}

/** Pure function to filter out soft-deleted meters (deleted_at IS NULL) */
export function filterActiveMeters<T extends { deleted_at: string | null }>(
  meters: T[]
): T[] {
  return meters.filter((meter) => meter.deleted_at === null);
}

/** Pure function to filter meters by building_id and/or meter_type */
export function filterMeters(
  meters: MeterWithRoom[],
  filters: { building_id?: string | null; meter_type?: string | null }
): MeterWithRoom[] {
  return meters.filter((meter) => {
    if (filters.building_id && meter.building_id !== filters.building_id) {
      return false;
    }
    if (filters.meter_type && meter.meter_type !== filters.meter_type) {
      return false;
    }
    return true;
  });
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Resolve service_id from meter_type by querying the services table.
 * Thử lần lượt fee_type → code → name trong các dịch vụ ĐANG HOẠT ĐỘNG (ưu tiên
 * is_default). `maybeSingle()` thay `single()` vì 0 hay nhiều dòng đều không
 * phải lỗi ở bước dò. Không tìm thấy thì toast chỉ đúng chỗ phải tạo dịch vụ.
 */
async function resolveServiceId(meterType: string | null | undefined): Promise<string> {
  const match = meterType ? METER_TYPE_TO_SERVICE_MATCH[meterType] : undefined;
  if (!match) {
    throw new MeterServiceError('Không tìm thấy dịch vụ tương ứng với loại công tơ. Kiểm tra loại công tơ đã chọn.');
  }

  const activeServices = () =>
    supabase
      .from("services")
      .select("id")
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .limit(1);

  const feeType = match.feeType;
  const attempts: Array<() => ReturnType<typeof activeServices>> = [];
  if (feeType) attempts.push(() => activeServices().eq("fee_type", feeType));
  attempts.push(() => activeServices().in("code", match.codes));
  attempts.push(() => activeServices().in("name", match.names));

  for (const attempt of attempts) {
    const { data, error } = await attempt().maybeSingle();
    if (error) {
      throw error;
    }
    if (data?.id) return data.id;
  }

  throw new MeterServiceError(`Chưa có dịch vụ "${match.label}" đang hoạt động — vào Cài đặt ▸ Dịch vụ tạo trước khi thêm công tơ.`);
}

// ============================================================================
// Query hooks
// ============================================================================

/** Query danh sách công tơ, filter deleted_at IS NULL, hỗ trợ filter theo roomId và meterType */
export const useMeters = (roomId?: string, meterType?: MeterType) => {
  return useQuery({
    queryKey: ["meters", roomId, meterType],
    queryFn: async () => {
      // PHÂN TRANG: không truyền roomId thì đây là truy vấn org-wide; một toà
      // nhiều phòng × điện/nước/gas vượt 1000 dòng rất dễ, và PostgREST cắt im.
      // `created_at` không duy nhất → phải có tiebreaker `id` thì ranh giới
      // trang mới không sót/trùng.
      const rows = await fetchAllRows((from, to) => {
        let query = supabase
          .from("meters")
          .select("*")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

        if (roomId) {
          query = query.eq("room_id", roomId);
        }
        if (meterType) {
          query = query.eq("meter_type", meterType);
        }

        return query.range(from, to);
      }, { label: "meters" });

      if (rows === null) {
        // fetchAllRows tra null = loi query (da console.error). Nem de vao isError,
        // khong bien loi thanh danh sach rong (Contract 14, plan C).
        throw new Error('useMeters: khong tai duoc du lieu');
      }

      return rows;
    },
  });
};

/** Query single meter by ID */
export const useMeter = (id: string) => {
  return useQuery({
    queryKey: ["meters", "detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meters")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) return nullIfNotFound(error, "useMeter");

      return data;
    },
    enabled: !!id,
  });
};

/** Query từ view meters_with_latest_reading */
export const useMetersWithLatestReading = () => {
  return useQuery({
    queryKey: ["meters-with-latest-reading"],
    queryFn: async () => {
      // View KHÔNG có filter nào: đây là toàn bộ công tơ của org. Không phân
      // trang thì màn công tơ mất dòng từ số 1001 trở đi, im lặng.
      const rows = await fetchAllRows((from, to) =>
        supabase
          .from("meters_with_latest_reading" as any)
          .select("*")
          .order("id", { ascending: true })
          .range(from, to),
        { label: "meters-with-latest-reading" },
      );

      if (rows === null) {
        // fetchAllRows tra null = loi query (da console.error). Nem de vao isError,
        // khong bien loi thanh danh sach rong (Contract 14, plan C).
        throw new Error('useMetersWithLatestReading: khong tai duoc du lieu');
      }

      return rows;
    },
  });
};

/** Query công tơ nhóm theo phòng */
export const useMetersGroupedByRoom = (
  buildingId?: string,
  meterType?: MeterType
) => {
  return useQuery({
    queryKey: ["meters", "grouped", buildingId, meterType],
    queryFn: async () => {
      // Cùng lý do với useMeters: nhóm theo phòng mà thiếu dòng thì cả phòng
      // biến mất khỏi màn hình chứ không chỉ thiếu một công tơ.
      const rows = await fetchAllRows((from, to) => {
        let query = supabase
          .from("meters")
          .select("*, building:buildings(id, name), room:rooms(id, name)")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

        if (buildingId) {
          query = query.eq("building_id", buildingId);
        }
        if (meterType) {
          query = query.eq("meter_type", meterType);
        }

        return query.range(from, to);
      }, { label: "meters-grouped" });

      if (rows === null) {
        // fetchAllRows tra null = loi query (da console.error). Nem de vao isError;
        // tra object rong o day = "phong nao cung khong co cong to" (Contract 14, plan C).
        throw new Error('useMetersGroupedByRoom: khong tai duoc du lieu');
      }

      const meters = rows as unknown as MeterWithRoom[];
      return groupMetersByRoom(meters);
    },
  });
};

/** Gọi RPC get_meters_without_readings, trả về UnrecordedMeter[] */
export const useUnrecordedMeters = (params: {
  buildingId?: string;
  roomId?: string;
  meterType?: MeterType;
  month: string;
}) => {
  const { buildingId, roomId, meterType, month } = params;

  return useQuery({
    queryKey: ["unrecorded-meters", buildingId, roomId, meterType, month],
    queryFn: async () => {
      // RBAC v2: bỏ p_user_id; quyền xác định qua can_access_building.
      const { data, error } = await supabase.rpc(
        "get_meters_without_readings_v2",
        {
          // 3 tham số lọc đều `DEFAULT NULL` ở server ⇒ vắng mặt = NULL. Dùng
          // `undefined` để khớp kiểu `p_x?: T` của tham số CÓ DEFAULT.
          p_building_id: buildingId ?? undefined,
          p_room_id: roomId ?? undefined,
          p_meter_type: meterType ?? undefined,
          p_month: month,
        }
      );

      if (error) {
        console.error("[useUnrecordedMeters] RPC error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách công tơ chưa chốt. Tải lại để kiểm tra.');
      return data;
    },
    enabled: !!month,
  });
};

// ============================================================================
// Mutation hooks
// ============================================================================

/** Mutation INSERT vào meters với user_id = auth.uid() */
export const useCreateMeter = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  const guard=persistentFinancialWorkflow('meter-create');
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (meter: Omit<MeterInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // Auto-resolve service_id from meter_type
      const serviceId = await resolveServiceId(meter.meter_type);

      return guard.run('create','tạo công tơ',async()=>{
      const { data, error } = await supabase
        .from("meters")
        .insert(withOrg({ ...meter, user_id: user.id, service_id: serviceId }, selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(data,'tạo công tơ');
      return data;
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (meter) => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      queryClient.invalidateQueries({ queryKey: ["meters-with-latest-reading"] });
      queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
      toast.success(`Đã tạo công tơ ${meter.code}`);
    },
    onError: (error) => {
      console.error("Error creating meter:", error);
      queryClient.invalidateQueries({ queryKey: ['meters'] });
      meterMutationFailure(error, 'tạo');
    },
  });
};

/** Mutation UPDATE meters */
export const useUpdateMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: MeterUpdate }) => {
      // Auto-resolve service_id when meter_type is being updated
      let resolvedUpdates = { ...updates };
      if (updates.meter_type) {
        const serviceId = await resolveServiceId(updates.meter_type);
        resolvedUpdates.service_id = serviceId;
      }

      const { data, error } = await supabase
        .from("meters")
        .update(resolvedUpdates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(data,'cập nhật công tơ',id);
      return data;
    },
    onSuccess: (meter) => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      queryClient.invalidateQueries({ queryKey: ["meters-with-latest-reading"] });
      queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
      toast.success(`Đã cập nhật công tơ ${meter.code}`);
    },
    onError: (error) => {
      console.error("Error updating meter:", error);
      queryClient.invalidateQueries({ queryKey: ['meters'] });
      meterMutationFailure(error, 'cập nhật');
    },
  });
};

/** Mutation soft-delete (UPDATE deleted_at = NOW()) */
export const useDeleteMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("meters")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select('id')
        .single();

      if (error) throw error;
      confirmedRecordId(data,'xóa công tơ',id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      queryClient.invalidateQueries({ queryKey: ["meters-with-latest-reading"] });
      queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
      toast.success("Đã xóa công tơ");
    },
    onError: (error) => {
      console.error("Error deleting meter:", error);
      queryClient.invalidateQueries({ queryKey: ['meters'] });
      meterMutationFailure(error, 'xóa');
    },
  });
};
