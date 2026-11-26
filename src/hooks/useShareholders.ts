import { requireReadRows, requireReadRow, profitPersonRow, buildingShareRow, readString, readNullableString } from "@/lib/accountProfitReadModels";
import { persistentFinancialWorkflow } from "@/lib/persistentFinancialWorkflow";
import { requireProfitRows } from "@/lib/profitConfigurationReceipt";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { validateShareRows } from "@/lib/profitFeedback";
import { useRef } from "react";
import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError, workflowErrorMessage } from "@/lib/financialWorkflow";
import { notifyActionError } from "@/lib/actionFeedback";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { taoTaiKhoanQuanTri } from "@/lib/edgeFunctions";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";

// --- Types ---
export interface Shareholder {
  id: string;
  user_id: string;
  auth_user_id: string | null;
  name: string;
  note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BuildingShareholder {
  id: string;
  user_id: string;
  building_id: string;
  shareholder_id: string;
  percent: number;
}

export interface ShareholderFormValues {
  name: string;
  note?: string | null;
  is_active?: boolean;
  auth_user_id?: string | null;
}

// --- Queries ---

// Danh sách cổ đông (owner/admin thấy tất cả; cổ đông chỉ thấy mình qua RLS).
export const useShareholders = () => {
  return useQuery({
    queryKey: ["shareholders"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    queryFn: async () => {
      // hermes-parity:begin shareholder-profit — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const { data, error } = await (supabase
        .from("shareholders" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      // hermes-parity:end shareholder-profit
      if (error) {
        throw error;
      }
      return requireReadRows<Shareholder>(data, profitPersonRow);
    },
  });
};

// Cổ đông tương ứng tài khoản đang đăng nhập (null nếu user không phải cổ đông).
export const useMyShareholder = () => {
  return useQuery({
    queryKey: ["my-shareholder"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) return null;
      // hermes-parity:begin shareholder-profit
      const { data, error } = await (supabase
        .from("shareholders" as any)
        .select("*") as any)
        .eq("auth_user_id", auth.user.id)
        .is("deleted_at", null)
        .maybeSingle();
      // hermes-parity:end shareholder-profit
      // KHÔNG nuốt: null ở đây nghĩa "bạn không phải cổ đông" — nuốt lỗi là ẩn
      // sạch phần chia lợi nhuận của đúng người có phần.
      if (error) throw error;
      return data === null ? null : requireReadRow<Shareholder>(data, profitPersonRow);
    },
  });
};

// Tên các tòa caller có cổ phần / hưởng lương LN — qua RPC SECURITY DEFINER
// get_my_share_buildings (migration 20260701170000). Trang lợi nhuận dùng hook
// này để hiện TÊN TÒA vì cổ đông KHÔNG còn quyền đọc bảng buildings (tách quyền
// khỏi khu vận hành: can_access_building đã bỏ nhánh cổ đông).
export interface ShareBuilding {
  id: string;
  name: string | null;
}
export const useMyShareBuildings = () => {
  return useQuery({
    queryKey: ["my-share-buildings"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ShareBuilding[]> => {
      const { data, error } = await supabase.rpc("get_my_share_buildings");
      if (error) throw error;
      return requireReadRows<ShareBuilding>(data, row => readString(row.id) && readNullableString(row.name));
    },
  });
};

// Toàn bộ tỷ lệ % theo tòa (cho ma trận cấu hình).
export const useBuildingShareholders = () => {
  return useQuery({
    queryKey: ["building-shareholders"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("building_shareholders" as any)
        .select("*") as any);
      if (error) {
        throw error;
      }
      return requireReadRows<BuildingShareholder>(data, buildingShareRow);
    },
  });
};

// --- Mutations ---

export const useCreateShareholder = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  return useMutation({
    meta: { handlesFeedback: true },
    // Đợt 8 (cách D): production có chỉ mục duy nhất `shareholders(auth_user_id)` (toàn cục, đo 26/11/2026). Tra hồ sơ
    // còn hiệu lực của tài khoản TRƯỚC khi chèn: đã có (lần tạo trước mất phản hồi, hoặc người khác vừa tạo) ⇒ báo mã,
    // không chèn hồ sơ thứ hai. Tra hỏng hoặc chèn chưa rõ ⇒ báo, bấm lại thì tra lại; chỉ mục duy nhất chặn bản thứ hai.
    mutationFn: async (values: ShareholderFormValues) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw { code: 'PGRST301', message: 'Not authenticated' };
      const user = auth.user;
      const { repeatableWrite } = await import('@/lib/recordWriteOutcome');
      return repeatableWrite('tạo cổ đông', async () => {
        const account = values.auth_user_id ?? null;
        if (account) {
          const { data: existing, error: lookupError } = await supabase
            .from("shareholders")
            .select("id")
            .eq("auth_user_id", account)
            .is("deleted_at", null)
            .maybeSingle();
          if (lookupError) throw lookupError;
          if (existing !== null) {
            const existingId: unknown = existing?.id;
            if (typeof existingId !== 'string' || !existingId) throw new TypeError('Unconfirmed shareholder lookup');
            throw new FinancialAlreadyRecordedError(`Tài khoản này đã có hồ sơ cổ đông (mã ${existingId}), có thể từ lần lưu trước. Mở hồ sơ đó để sửa; không tạo thêm cổ đông.`, [existingId]);
          }
        }
        const { data, error } = await supabase
          .from("shareholders" as any)
          .insert(withOrg({
            user_id: user.id,
            name: values.name,
            note: values.note ?? null,
            is_active: values.is_active ?? true,
            auth_user_id: account,
          }, selectedOrganizationId))
          .select()
          .single();
        if (error) {
          throw error;
        }
        return requireAccountWriteReceipt(data, {}) as unknown as Shareholder;
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
    },
    // Hồ sơ đã có sẵn: tải lại danh sách để hồ sơ đó hiện ra mà sửa.
    onError: (error) => { if (error instanceof FinancialAlreadyRecordedError) qc.invalidateQueries({ queryKey: ["shareholders"] }); },
  });
};

export const useUpdateShareholder = () => {
  const qc = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    // Đợt 8 (cách A): đặt giá trị theo mã, chạy lại cho cùng kết quả: chưa rõ thì báo và cho lưu lại, không giữ dấu. Khớp
    // 0 dòng (RLS, hồ sơ đã mất) là chưa ghi gì: từ chối rõ.
    mutationFn: async (input: { id: string; values: ShareholderFormValues }) => {
      const patch: any = {
        name: input.values.name,
        note: input.values.note ?? null,
        is_active: input.values.is_active ?? true,
      };
      if (input.values.auth_user_id !== undefined) {
        patch.auth_user_id = input.values.auth_user_id;
      }
      const { repeatableWrite } = await import('@/lib/recordWriteOutcome');
      await repeatableWrite('lưu hồ sơ cổ đông', async () => {
        const { data, error } = await supabase
          .from("shareholders" as any)
          .update(patch)
          .eq("id", input.id)
          .select('*');
        if (error) throw error;
        if (Array.isArray(data) && data.length === 0) throw new FinancialWorkflowError('Chưa lưu hồ sơ cổ đông: không tìm thấy hồ sơ này, hoặc tài khoản không có quyền sửa. Tải lại danh sách cổ đông rồi thử lại.', 'failure', []);
        requireProfitRows(data, [{ ...patch, id: input.id }]);
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
    },
  });
};

export const useDeleteShareholder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("shareholders" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (error) {
        throw error;
      }
      const rows = requireProfitRows(data);
      if (!rows.length) return false;
      requireProfitRows(rows, [{id}]);
      return true;
    },
    onError: (error) => notifyActionError(error, "Chưa xóa cổ đông."),
    onSuccess: (changed) => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      if (changed) toast.success('Đã xoá cổ đông');
      else toast.info('Không có hồ sơ cổ đông nào được thay đổi.');
    },
  });
};

// Upsert 1 ô tỷ lệ (building × shareholder).
export const useUpsertBuildingShare = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  return useMutation({
    mutationFn: async (input: { building_id: string; shareholder_id: string; percent: number }) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");
      const { data, error } = await supabase
        .from("building_shareholders" as any)
        .upsert(
          withOrg({
            user_id: auth.user.id,
            building_id: input.building_id,
            shareholder_id: input.shareholder_id,
            percent: input.percent,
          }, selectedOrganizationId),
          { onConflict: "building_id,shareholder_id" }
        ).select('*');
      if (error) throw error;
      return requireProfitRows(data, [{...input, user_id: auth.user.id}]);
    },
    onError: (error) => notifyActionError(error, "Chưa lưu tỷ lệ cổ đông."),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["building-shareholders"] });
    },
  });
};

// Đồng bộ toàn bộ tỷ lệ tòa cho 1 cổ đông = danh sách rows truyền vào
// (xoá tòa không còn, upsert tòa mới/đổi %).
//
// Đợt 8 (cách A, đặt cả bộ; sát tiền vì là tỷ lệ chia lợi nhuận): mỗi lượt đọc lại tỷ lệ hiện có, xoá đúng các dòng ở tòa
// bỏ đi rồi upsert theo chỉ mục duy nhất `building_shareholders(building_id, shareholder_id)` (production 26/11/2026) với
// tỷ lệ tuyệt đối. Chạy lại cùng danh sách cho cùng một bộ tỷ lệ: không có dòng thứ hai, không cộng dồn; một lệnh cũ tới
// trễ chỉ ghi đúng giá trị đó (xoá dòng của tòa bỏ đi, hoặc đặt cùng tỷ lệ). Không giữ dấu «chờ đối chiếu»: chưa rõ thì báo
// và cho lưu lại. Chưa nguyên tử (hai lệnh riêng): đã xoá mà upsert bị từ chối thì báo rõ để lưu lại (hàm máy chủ: đợt 10).
export const useSyncShareholderBuildings = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { shareholder_id: string; rows: Array<{ building_id: string; percent: number }> }) => {
      if (Object.keys(validateShareRows(input.rows)).length) throw new FinancialWorkflowError('Kiểm tra từng tòa và tỷ lệ cổ đông trước khi lưu.', 'failure', []);
      const user = await getSessionUser();
      if (!user) throw { code: 'PGRST301', message: 'Not authenticated' };
      const { repeatableWrite, settleZeroRowDelete } = await import('@/lib/recordWriteOutcome');
      let removedCount = 0;
      try {
        await repeatableWrite('lưu tỷ lệ cổ đông', async () => {
          const { data: existing, error: existingError } = await supabase.from('building_shareholders' as any).select('id, building_id').eq('shareholder_id', input.shareholder_id);
          if (existingError) throw existingError;
          const existingRows = requireProfitRows(existing);
          if (existingRows.some(row => typeof row.building_id !== 'string' || !row.building_id)) throw new TypeError('Unconfirmed existing building shares');
          const keep = new Set(input.rows.map(row => row.building_id));
          const removed = existingRows.filter(row => !keep.has(row.building_id as string)).map(row => row.id as string);
          if (removed.length) {
            const { data, error } = await supabase.from('building_shareholders' as any).delete().in('id', removed).select('id');
            if (error) throw error;
            const deleted = requireProfitRows(data).map(row => row.id as string);
            if (deleted.some(id => !removed.includes(id))) throw new TypeError('Unconfirmed building share delete');
            removedCount += deleted.length;
            // Khớp thiếu dòng: dòng đó đã bị xoá ở nơi khác (đúng đích) hoặc RLS không cho xoá (từ chối rõ). Đọc lại đúng các dòng đó.
            const missing = removed.filter(id => !deleted.includes(id));
            if (missing.length) await settleZeroRowDelete('xoá tỷ lệ ở tòa bỏ đi', () => supabase.from('building_shareholders').select('id').in('id', missing));
          }
          if (input.rows.length) {
            const payload = input.rows.map(row => ({ ...row, user_id: user.id, shareholder_id: input.shareholder_id }));
            const { data, error } = await supabase.from('building_shareholders' as any).upsert(withOrgAll(payload, selectedOrganizationId), {onConflict:'building_id,shareholder_id'}).select('*');
            if (error) throw error;
            requireProfitRows(data, payload);
          }
        });
      } catch (error) {
        // Đã xoá tỷ lệ ở tòa bỏ đi mà bước sau bị từ chối rõ: cấu hình đang dở, nói đúng điều đó.
        if (removedCount && !(error instanceof RepeatableWriteUnknownError)) throw new FinancialWorkflowError(`Đã xoá tỷ lệ ở ${removedCount} tòa bỏ đi nhưng chưa lưu xong tỷ lệ mới: ${workflowErrorMessage(error, 'lưu tỷ lệ tòa nhà')} Bấm Lưu lại để ghi lại đúng bộ tỷ lệ này.`, 'failure', [], error);
        throw error;
      }
      // Khoá của dấu bản trước: mã cổ đông, công ty đang chọn.
      const id = input.shareholder_id;
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'shareholder-sync', businessKey: id }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần lưu sau gỡ lại. */ }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['building-shareholders'] }); },
  });
};

export const useDeleteBuildingShare = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { building_id: string; shareholder_id: string }) => {
      const { data, error } = await supabase.from('building_shareholders' as any).delete().eq('building_id', input.building_id).eq('shareholder_id', input.shareholder_id).select('id, building_id, shareholder_id');
      if (error) throw error;
      const rows = requireProfitRows(data);
      if (!rows.length) return false;
      requireProfitRows(rows, [input]);
      return true;
    },
    onError: (error) => notifyActionError(error, "Chưa xóa tỷ lệ cổ đông."),
    onSuccess: (changed) => {
      qc.invalidateQueries({ queryKey: ["building-shareholders"] });
      if (!changed) toast.info('Không có tỷ lệ cổ đông nào được xóa.');
    },
  });
};

// Tạo tài khoản đăng nhập cho cổ đông (edge admin-create-user) + gán auth_user_id.
export const useCreateShareholderLogin = () => {
  const qc = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('shareholder-account-link'));
  return useMutation({
    mutationFn: async (input: {
      shareholder_id: string;
      email: string;
      password: string;
      full_name?: string;
    }) => workflow.current.run(input.shareholder_id, "tạo và gán tài khoản cổ đông", async (progress) => {
      // Qua wrapper — xem `src/lib/edgeFunctions.ts`. Trước đây chỗ này và
      // `useAdminUsers` gọi CÙNG một Edge Function với hai thân yêu cầu khác nhau
      // và hai cách đọc phản hồi khác nhau, cả hai đều qua `as any`. Giờ hình dạng
      // chỉ khai một lần.
      const { id: newUserId } = await taoTaiKhoanQuanTri(
        (fn, options) => supabase.functions.invoke(fn, options),
        {
          email: input.email,
          password: input.password,
          full_name: input.full_name ?? "",
        },
      );

      progress.completed.push({id:newUserId,label:"Đã tạo tài khoản đăng nhập"});
      progress.stage = "gán tài khoản cho cổ đông";
      const { data: linked, error: upErr } = await supabase
        .from("shareholders" as any)
        .update({ auth_user_id: newUserId })
        .eq("id", input.shareholder_id).select("id");
      if (upErr) throw upErr;
      requireProfitRows(linked, [{id: input.shareholder_id}]);
      return { userId: newUserId };
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("Đã tạo tài khoản đăng nhập cho cổ đông");
    },
    onError: (error) => toast.error(workflowErrorMessage(error,"tạo tài khoản cổ đông"), {description:error instanceof FinancialWorkflowError ? error.completed.map(step=>`${step.label}: ${step.id}`).join("; ") : undefined}),
  });
};
