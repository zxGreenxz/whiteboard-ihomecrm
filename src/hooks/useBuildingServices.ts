import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { BuildingServiceWithDetails } from "@/types/building";
import { friendlyError } from "@/lib/friendlyError";
import type { Tables } from "@/integrations/supabase/types";
import { readRecord, readString } from "@/lib/accountProfitReadModels";
import { FinancialWorkflowError, RepeatableWriteUnknownError } from "@/lib/financialWorkflowError";

type ServiceLinkReceipt = Pick<Tables<"building_services">, "id" | "building_id" | "service_id">;
type SavedServiceReceipt = Pick<Tables<"building_services">, "id" | "building_id" | "service_id" | "is_active" | "unit_price_override">;

function linkReceipt(value: unknown, buildingId: string): value is ServiceLinkReceipt {
  return readRecord(value) && readString(value.id) && value.building_id === buildingId && readString(value.service_id);
}
function savedReceipt(value: unknown, buildingId: string): value is SavedServiceReceipt {
  if (!readRecord(value)) return false;
  const active = value.is_active;
  const price = value.unit_price_override;
  return linkReceipt(value, buildingId) && typeof active === "boolean"
    && (price === null || (typeof price === "number" && Number.isFinite(price)));
}
type BuildingServiceTarget = Pick<SavedServiceReceipt, "service_id" | "is_active" | "unit_price_override">;
type ReplaceBuildingServicesRpc = (name: "replace_building_services_v1", args: { p_building_id: string; p_services: BuildingServiceTarget[] }) =>
  PromiseLike<{ data: unknown; error: unknown }>;
/**
 * Biên nhận của replace_building_services_v1 phải khớp ĐÚNG bộ đã gửi: đúng số dòng, mã dòng là chuỗi không trùng, đúng mã
 * toà, đa tập (dịch vụ, bật/tắt, giá riêng) khớp từng dòng đã gửi. Lệch hay sai dạng ⇒ chưa rõ (không bao giờ là đã lưu).
 */
function confirmedServices(value: unknown, buildingId: string, sent: readonly BuildingServiceTarget[]): string[] {
  const mismatch = () => new FinancialWorkflowError("Biên nhận dịch vụ mặc định của tòa chưa khớp danh sách đã gửi.", "unknown", [], new TypeError("Mismatched building services receipt"));
  if (!Array.isArray(value)) throw mismatch();
  const rows: unknown[] = value;
  if (rows.length !== sent.length || !rows.every(row => savedReceipt(row, buildingId))) throw mismatch();
  const saved = rows as SavedServiceReceipt[];
  if (new Set(saved.map(row => row.id)).size !== saved.length) throw mismatch();
  const expected = [...sent];
  for (const row of saved) {
    const index = expected.findIndex(value => value.service_id === row.service_id && value.is_active === row.is_active && value.unit_price_override === row.unit_price_override);
    if (index < 0) throw mismatch();
    expected.splice(index, 1);
  }
  return saved.map(row => row.id);
}
/** Lời từ chối do chính hàm máy chủ viết (tiếng Việt, không lộ SQL): giữ nguyên câu đó cho màn hình. */
function serverWorded(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return typeof message === "string" && code === "42501" && message.startsWith("Chưa ") ? new FinancialWorkflowError(message, "failure", [], error) : error;
}

// Fetch building services with service details for a building
export const useBuildingServices = (buildingId: string) => {
  return useQuery({
    queryKey: ["building-services", buildingId],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("building_services" as any)
        .select(`
          id,
          building_id,
          service_id,
          is_active,
          unit_price_override,
          created_at,
          updated_at,
          service:services(id, name, unit_price, unit, type, pricing_type)
        `)
        .eq("building_id", buildingId) as any);

      if (error) {
        console.error("useBuildingServices error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được dịch vụ mặc định của tòa. Tải lại trước khi lập hợp đồng.');
      return data as BuildingServiceWithDetails[];
    },
    enabled: !!buildingId,
  });
};

// Đợt 8 (luật 5): dịch vụ mặc định của tòa là thiết lập, không phải khoản tiền; ghi lặp lại được nên không giữ dấu «chờ đối
// chiếu»: rớt mạng báo rõ và cho bấm lại. Đợt 10b: «xoá rồi chèn lại» đi MỘT hàm máy chủ (replace_building_services_v1,
// SECURITY INVOKER: RLS và trigger như ghi thẳng) thay cả bộ trong một giao dịch: hoặc chưa ghi gì, hoặc đã ghi đủ, không còn
// lúc tòa thiếu dịch vụ. Không gửi organization_id: trigger suy công ty từ tòa.
const BUILDING_SERVICES_OPERATION = "lưu dịch vụ mặc định của tòa";
const BUILDING_SERVICES_ADVICE = "Máy chủ thay cả danh sách dịch vụ của tòa trong một lần: lần trước hoặc chưa ghi gì, hoặc đã ghi đủ, tòa không ở trạng thái dở. Bấm lại nút lưu để ghi đúng danh sách đang chọn; không nhân đôi dịch vụ.";
export const useUpsertBuildingServices = ({ silent = false }: { silent?: boolean } = {}) => {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async ({ buildingId, services }: {
      buildingId: string;
      services: { service_id: string; is_active: boolean; unit_price_override: number | null }[];
    }) => {
      // Chỉ cần lúc lưu: không kéo thêm module vào gói tải trang.
      const { repeatableWrite } = await import("@/lib/recordWriteOutcome");
      const sent: BuildingServiceTarget[] = services.map(s => ({ service_id: s.service_id, is_active: s.is_active, unit_price_override: s.unit_price_override }));
      const savedIds = await repeatableWrite(BUILDING_SERVICES_OPERATION, async () => {
        const client = supabase as unknown as { rpc: ReplaceBuildingServicesRpc };
        const { data, error } = await client.rpc("replace_building_services_v1", { p_building_id: buildingId, p_services: sent });
        if (error) throw serverWorded(error);
        return confirmedServices(data, buildingId, sent);
      }).catch((error: unknown) => {
        if (error instanceof RepeatableWriteUnknownError) throw new RepeatableWriteUnknownError(BUILDING_SERVICES_OPERATION, error.cause, error.completed, BUILDING_SERVICES_ADVICE);
        throw error;
      });
      try { const { forgetLegacyPending } = await import("@/lib/legacyPendingExit"); await forgetLegacyPending({ businessKey: buildingId, namespace: "building-services-replace" }, { organizationId: "actor-scope" }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần lưu sau gỡ lại. */ }
      return savedIds;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["building-services", variables.buildingId] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
    },
    onError: (error, variables) => {
      if (error instanceof FinancialWorkflowError) {
        queryClient.invalidateQueries({ queryKey: ["building-services", variables.buildingId] });
        queryClient.invalidateQueries({ queryKey: ["buildings"] });
      }
      const feedback = friendlyError(error, "Chưa cập nhật được dịch vụ tòa nhà", { operation: "cập nhật dịch vụ tòa nhà" });
      if (!silent) toast.error(feedback.title, { description: feedback.description });
      console.error("Error upserting building services:", error);
    },
  });
};
