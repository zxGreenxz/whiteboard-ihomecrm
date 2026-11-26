import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { BuildingServiceWithDetails } from "@/types/building";
import { friendlyError } from "@/lib/friendlyError";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import { readRecord, readString } from "@/lib/accountProfitReadModels";
import { FinancialWorkflowError, RepeatableWriteUnknownError } from "@/lib/financialWorkflowError";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrgAll } from "@/lib/orgPayload";

type RemovedServiceReceipt = Pick<Tables<"building_services">, "id" | "building_id" | "service_id">;
type SavedServiceReceipt = Pick<Tables<"building_services">, "id" | "building_id" | "service_id" | "is_active" | "unit_price_override">;
type ServiceInsert = Pick<TablesInsert<"building_services">, "building_id" | "service_id" | "is_active" | "unit_price_override">;
interface ServiceWriteReply { data: unknown; error: unknown }

function removedReceipt(value: unknown, buildingId: string): value is RemovedServiceReceipt {
  return readRecord(value) && readString(value.id) && value.building_id === buildingId && readString(value.service_id);
}
function savedReceipt(value: unknown, buildingId: string): value is SavedServiceReceipt {
  if (!readRecord(value)) return false;
  const active = value.is_active;
  const price = value.unit_price_override;
  return removedReceipt(value, buildingId) && typeof active === "boolean"
    && (price === null || (typeof price === "number" && Number.isFinite(price)));
}
function receivedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const rows: unknown[] = value;
  return [...new Set(rows.flatMap(row => readRecord(row) && readString(row.id) ? [row.id] : []))];
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

// Keep the original workflow: delete all existing links, then insert the new set.
// Đợt 8 (luật 5): dịch vụ mặc định của tòa là thiết lập, không phải khoản tiền; «xoá rồi chèn lại» chạy lại cho đúng một bộ
// (khoá duy nhất building_id + service_id), không cộng dồn, nên không giữ dấu «chờ đối chiếu» nữa: rớt mạng ở bước nào
// cũng báo rõ và cho bấm lại. Chèn hỏng SAU khi đã gỡ danh sách cũ thì báo rõ là tòa có thể đang thiếu dịch vụ và cần lưu
// lại. Ghi nguyên tử trên máy chủ (không còn khoảng thiếu dịch vụ): đợt 10.
export const useUpsertBuildingServices = ({ silent = false }: { silent?: boolean } = {}) => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async ({ buildingId, services }: {
      buildingId: string;
      services: { service_id: string; is_active: boolean; unit_price_override: number | null }[];
    }) => {
      // Chỉ cần lúc lưu: không kéo thêm module vào gói tải trang.
      const { repeatableWrite } = await import("@/lib/recordWriteOutcome");
      const removedSteps = await repeatableWrite("gỡ danh sách dịch vụ cũ của tòa", async () => {
        // The legacy API casts and four-field payload match main; select adds only receipts.
        const { data: deleted, error: deleteError }: ServiceWriteReply = await (supabase
          .from("building_services" as any)
          .delete()
          .eq("building_id", buildingId)
          .select("id,building_id,service_id") as any);
        if (deleteError) throw deleteError;
        const received = receivedIds(deleted).map(id => ({ id, label: "Mã liên kết nhận sau bước gỡ, cần đối chiếu" }));
        if (!Array.isArray(deleted)) throw new FinancialWorkflowError(
          "Chưa xác nhận được kết quả gỡ dịch vụ cũ. Chưa gửi bước lưu danh sách mới.",
          "unknown", received, new TypeError("Unconfirmed building service deletion receipt"));
        const removed: unknown[] = deleted;
        if (!removed.every(row => removedReceipt(row, buildingId)) || new Set(removed.map(row => row.id)).size !== removed.length)
          throw new FinancialWorkflowError("Chưa xác nhận đúng các liên kết dịch vụ đã gỡ; chưa gửi danh sách mới.",
            "unknown", received, new TypeError("Mismatched building service deletion receipt"));
        return received.map(step => ({ id: step.id, label: "Đã gỡ liên kết dịch vụ cũ của tòa" }));
      }).catch((error: unknown) => {
        // Chưa rõ bước gỡ: dịch vụ cũ có thể đã gỡ. Nói rõ để người dùng biết tòa có thể đang thiếu dịch vụ mặc định.
        if (error instanceof RepeatableWriteUnknownError) throw new RepeatableWriteUnknownError("gỡ danh sách dịch vụ cũ của tòa", error.cause, error.completed, "Dịch vụ cũ có thể đã được gỡ nên tòa có thể đang thiếu dịch vụ mặc định. Bấm lại nút lưu: danh sách gỡ rồi ghi lại đúng danh sách đang chọn nên không nhân đôi.");
        throw error;
      });
      let savedIds: string[] = [];
      if (services.length > 0) {
        const rows: ServiceInsert[] = services.map(s => ({
          building_id: buildingId,
          service_id: s.service_id,
          is_active: s.is_active,
          unit_price_override: s.unit_price_override,
        }));
        try {
          savedIds = await repeatableWrite("lưu danh sách dịch vụ mới sau khi đã gỡ danh sách cũ của tòa", async () => {
            const { data: inserted, error: insertError }: ServiceWriteReply = await (supabase
              .from("building_services" as any)
              .insert(withOrgAll(rows, selectedOrganizationId))
              .select("id,building_id,service_id,is_active,unit_price_override") as any);
            if (insertError) throw insertError;
            const steps = [...removedSteps, ...receivedIds(inserted).map(id => ({ id, label: "Đã nhận mã liên kết dịch vụ mới; chưa xác nhận đủ danh sách" }))];
            if (!Array.isArray(inserted)) throw new FinancialWorkflowError(
              "Chưa xác nhận được danh sách dịch vụ mới đã lưu.",
              "unknown", steps, new TypeError("Unconfirmed building service insert receipt"));
            const saved: unknown[] = inserted;
            if (!saved.every(row => savedReceipt(row, buildingId)) || saved.length !== rows.length || new Set(saved.map(row => row.id)).size !== saved.length)
              throw new FinancialWorkflowError("Chưa xác nhận đủ và đúng các liên kết dịch vụ mới đã lưu.",
                "unknown", steps, new TypeError("Incomplete building service insert receipt"));
            const expected = [...rows];
            for (const row of saved) {
              const index = expected.findIndex(value => value.service_id === row.service_id && value.is_active === row.is_active && value.unit_price_override === row.unit_price_override);
              if (index < 0) throw new FinancialWorkflowError("Biên nhận dịch vụ mới chưa khớp danh sách đã gửi.",
                "unknown", steps, new TypeError("Mismatched building service insert values"));
              expected.splice(index, 1);
            }
            return saved.map(row => row.id);
          });
        } catch (error) {
          if (error instanceof RepeatableWriteUnknownError) throw new RepeatableWriteUnknownError("lưu danh sách dịch vụ mới sau khi đã gỡ danh sách cũ của tòa", error.cause, error.completed, "Danh sách dịch vụ cũ đã gỡ; tòa có thể đang thiếu dịch vụ mặc định cho tới khi lưu xong. Bấm lại nút lưu: danh sách gỡ rồi ghi lại đúng danh sách đang chọn nên không nhân đôi.");
          // Máy chủ từ chối rõ lệnh chèn sau khi danh sách cũ đã gỡ: báo đúng tình trạng, lưu lại là ghi đủ danh sách.
          const reason = friendlyError(error, "Chưa lưu danh sách dịch vụ mới", { operation: "lưu danh sách dịch vụ mới" });
          throw new FinancialWorkflowError(`Đã gỡ danh sách dịch vụ cũ của tòa (${removedSteps.length} dịch vụ) nhưng chưa lưu được danh sách mới. ${reason.description} Bấm lưu lại để ghi đủ dịch vụ; trong lúc này tòa có thể thiếu dịch vụ mặc định.`, "failure", [], error);
        }
      }
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
