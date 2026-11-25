import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { CT01Declaration, CT01FormData } from "@/types/customer";
import { recordWriteMessage } from "@/lib/recordWriteOutcome";
import { FinancialAlreadyRecordedError, FinancialWorkflowError } from "@/lib/financialWorkflowError";
import { hasUnconfirmedResponse } from "@/lib/operationOutcome";
import { legacyWindow, settleLegacyPending } from "@/lib/legacyPendingExit";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";

// =============================================
// useCT01Declarations - Query declarations for a customer
// Requirements: 6.5
// =============================================

export const useCT01Declarations = (customerId: string) => {
  return useQuery({
    queryKey: ["ct01-declarations", customerId],
    queryFn: async (): Promise<CT01Declaration[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await (supabase
        .from("ct01_declarations") as any)
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useCT01Declarations error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error("Chưa tải được tờ khai CT01.");
      return data as CT01Declaration[];
    },
    enabled: !!customerId,
  });
};

// =============================================
// useCreateCT01Declaration - Insert mutation
// Requirements: 6.5
// =============================================

// Đợt 7 (luật 5, cách D): tờ khai CT01 không phải tiền nên không giữ dấu «chờ đối chiếu». Mỗi lần lưu mang mã tờ khai do
// trình duyệt sinh (bảng nhận `id` từ trình duyệt, trigger không ghi đè; production 26/11/2026). Mã của lần gửi chưa rõ kết
// quả được nhớ theo (người dùng, khách) trong tab này để lần lưu sau gửi lại ĐÚNG mã đó: khoá chính chặn tờ khai thứ hai và
// đọc đúng mã cho biết lần trước đã ghi hay chưa. Tải lại trang là quên; không gì bị khoá.
const unconfirmedCt01 = new Map<string, string>();
/** Test / đổi tài khoản: quên các mã đang chờ xác nhận. */
export const forgetUnconfirmedCt01 = () => unconfirmedCt01.clear();
const isUniqueViolation = (error: unknown) => !!error && typeof error === "object" && String((error as { code?: unknown }).code ?? "") === "23505";

async function readCt01ById(id: string): Promise<{ state: "found"; row: CT01Declaration } | { state: "missing" } | { state: "unreadable" }> {
  try {
    const { data, error } = await (supabase.from("ct01_declarations") as any).select("*").eq("id", id).maybeSingle();
    if (error) return { state: "unreadable" };
    if (!data) return { state: "missing" };
    return data.id === id ? { state: "found", row: data as CT01Declaration } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

export const useCreateCT01Declaration = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async ({
      customerId,
      data: formData,
    }: {
      customerId: string;
      data: CT01FormData;
    }) => {
      const user = await getSessionUser();
      if (!user) throw { code: "PGRST301", message: "Not authenticated" };
      // Dấu bản trước của khách này (khoá chung theo khách, phạm vi người dùng): đọc một lần, tra tờ khai quanh giờ kẹt.
      // Thấy thì chỉ báo «có thể đã lưu» kèm mã, mới nhất trước, rồi gỡ dấu; lần lưu sau tạo bình thường.
      const legacy = await settleLegacyPending({ namespace: "ct01-declaration-create", businessKey: customerId }, async pending => {
        const window = legacyWindow(pending);
        const { data, error } = await (supabase.from("ct01_declarations") as any).select("id,created_at")
          .eq("customer_id", customerId).eq("user_id", user.id).gte("created_at", window.from).lte("created_at", window.to)
          .order("created_at", { ascending: false }).limit(5);
        if (error || !Array.isArray(data)) throw error ?? new TypeError("unreadable");
        return (data as { id: string }[]).map(row => row.id);
      }, { organizationId: "actor-scope" });
      if (legacy?.verdict.length) {
        throw new FinancialAlreadyRecordedError(`Có thể tờ khai CT01 của khách này đã được lưu ở lần gửi trước (mã ${legacy.verdict.join(", ")}). Mở danh sách tờ khai để kiểm tra; bấm lưu lại nếu vẫn muốn tạo thêm.`, legacy.verdict);
      }

      const memoryKey = `${user.id}|${selectedOrganizationId ?? ""}|${customerId}`;
      const reused = unconfirmedCt01.get(memoryKey);
      const id = reused ?? crypto.randomUUID();
      unconfirmedCt01.set(memoryKey, id);
      let response: { data: unknown; error: unknown };
      try {
        response = await (supabase
          .from("ct01_declarations") as any)
          .insert(withOrg({
            ...formData,
            id,
            user_id: user.id,
            customer_id: customerId,
          }, selectedOrganizationId))
          .select()
          .single();
      } catch (error) {
        response = { data: null, error };
      }
      const { data, error } = response;
      const receipt = data && typeof data === "object" ? (data as { id?: unknown }).id : undefined;
      if (!error && typeof receipt === "string" && receipt) {
        unconfirmedCt01.delete(memoryKey);
        return data as CT01Declaration;
      }
      const duplicate = isUniqueViolation(error);
      if (error && !duplicate && !hasUnconfirmedResponse(error)) {
        // Máy chủ từ chối rõ. Mã của một lần gửi trước còn chưa rõ thì giữ: lời từ chối lần này không nói gì về lần đó.
        if (!reused) unconfirmedCt01.delete(memoryKey);
        throw error;
      }
      // Không có dòng trả về, lỗi mạng hoặc trùng mã: đọc đúng mã mới biết lần gửi đã ghi chưa.
      const read = await readCt01ById(id);
      if (read.state === "found") {
        unconfirmedCt01.delete(memoryKey);
        return read.row;
      }
      if (duplicate && read.state === "missing") {
        unconfirmedCt01.delete(memoryKey);
        throw new FinancialAlreadyRecordedError(`Tờ khai CT01 mã ${id} đã có trên máy chủ (lần gửi trước đã ghi) nhưng bạn không xem được. Nhờ quản lý kiểm tra.`, [id]);
      }
      throw new FinancialWorkflowError("Chưa xác nhận được kết quả lưu tờ khai CT01. Giữ nguyên thông tin rồi bấm lưu lại: máy gửi lại đúng mã tờ khai này nên không tạo trùng.", "unknown", [{ id, label: "Mã tờ khai đang chờ xác nhận" }], error);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["ct01-declarations", variables.customerId],
      });
      toast.success("Đã lưu tờ khai CT01");
    },
    onError: (error: unknown) => {
      toast.error(recordWriteMessage(error, "lưu tờ khai CT01"));
      console.error("Error creating CT01 declaration:", error);
    },
  });
};
