function feedbackRecordName(value:unknown,fallback?:string):string {
 const row=value&&typeof value==='object'?value as {name?:unknown;id?:unknown}:null;
 return typeof row?.name==='string'&&row.name.trim()?row.name: fallback?.trim()||(typeof row?.id==='string'?row.id:'bản ghi');
}
import {useOrganization} from '@/contexts/OrganizationContext';
import {withOrg} from '@/lib/orgPayload';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { isUniqueViolation, normalizeVietnameseName } from '@/lib/clientRecordCreate';
import { settleLegacyPending } from '@/lib/legacyPendingExit';
import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { invalidateIeTypesCache } from "@/lib/ieTypesCache";
import { toast } from "sonner";
import { friendlyError } from "@/lib/friendlyError";

// --- Types ---

export interface IncomeExpenseType {
  id: string;
  user_id: string;
  name: string;
  type: "income" | "expense";
  category: string | null;
  description: string | null;
  is_default: boolean;
  // Cờ "đây có phải loại Tiền cọc" — bật → ảnh hưởng contracts.deposit_paid
  // và stats "Cọc đã thu". Set DB-side, FE chỉ đọc.
  is_deposit: boolean;
  // Cờ "hạng mục hạn chế": bật → chỉ người có quyền income_expenses.restricted_*
  // mới thấy hạng mục (picker) và các phiếu thuộc hạng mục này (bảng + tổng).
  // RLS enforce; FE thêm lọc picker theo restricted_create.
  is_restricted: boolean;
  // Cờ "hạng mục đặc biệt": bật → cho phép ẩn các dòng thuộc hạng mục này khỏi
  // danh sách báo cáo Phân bổ lợi nhuận (tuỳ chọn FE, KHÔNG đụng RLS/số tổng).
  hide_in_report: boolean;
  // NULL trên dữ liệu cũ chưa backfill; row mới do trigger trg_autofill_org gắn.
  organization_id: string | null;
  // Hạng mục chỉ hệ thống dùng: create_income_expense_v1 từ chối (0A000) rồi phiếu rơi im sang
  // đường compat luôn Chờ duyệt — ô chọn của người dùng phải loại ra. Query `select('*')` đã trả.
  system_only?: boolean;
  // Khoá phí cố định (tien_nha, dien, nuoc, …), duy nhất mỗi org từ 26/09/2026.
  fee_category?: string | null;
  // Danh mục chi chuẩn 03/10/2026 — xem src/lib/ieTypeCatalog.ts. Tuỳ chọn vì môi trường
  // chưa áp migration 20261003151606 thì `select('*')` chưa trả các cột này.
  archived_at?: string | null;
  merged_into_id?: string | null;
  keywords?: string[] | null;
  sort_order?: number | null;
  rule_key?: string | null;
  manual_hidden?: boolean | null;
  quick_entry_hidden?: boolean | null;
  internal_transfer?: boolean | null;
  created_at: string;
  updated_at: string;
}

/** Trường danh mục mà superadmin / chủ công ty sửa được (server chặn người khác). */
export interface IncomeExpenseTypeCatalogUpdates {
  keywords?: string[];
  sort_order?: number | null;
  quick_entry_hidden?: boolean;
  archived_at?: string | null;
  merged_into_id?: string | null;
}

// hermes-parity:begin w2d-ie-types — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
/**
 * Lọc hạng mục về đúng tổ chức của user TRƯỚC khi dedup theo tên.
 *
 * Án lệ 07/08/2026: RLS select trên income_expense_types chỉ check capability
 * toàn cục (can_access_org_entity không so organization_id) nên client thấy
 * hạng mục của MỌI org. Hai org seed cùng lúc đều có "Vệ Sinh Phòng"
 * (created_at giống hệt) → dedup bốc ngẫu nhiên id của org khác →
 * create_income_expense_v1 từ chối 42501 "Loại hạng mục 1 không thuộc tổ
 * chức hoặc sai chiều thu/chi", lỗi chập chờn theo thứ tự DB trả về.
 *
 * myOrgIds rỗng (rpc my_org_ids lỗi/chưa có) → không lọc để khỏi trắng
 * dropdown; dedup ưu tiên ownership vẫn chạy như cũ.
 */
export function selectIeTypeRowsForOrgs(
  rows: IncomeExpenseType[],
  currentUserId: string | null,
  myOrgIds: string[],
): IncomeExpenseType[] {
  const scoped = myOrgIds.length
    ? rows.filter(
        (r) => r.organization_id == null || myOrgIds.includes(r.organization_id),
      )
    : rows;

  const ownershipRank = (r: IncomeExpenseType) =>
    currentUserId && r.user_id === currentUserId ? 0 : 1;
  const sorted = [...scoped].sort((a, b) => {
    const diff = ownershipRank(a) - ownershipRank(b);
    if (diff !== 0) return diff;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });

  const seen = new Map<string, IncomeExpenseType>();
  for (const row of sorted) {
    const key = `${row.type}::${row.name.trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, row);
  }

  return Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "vi", { sensitivity: "base" })
  );
}
// hermes-parity:end w2d-ie-types

// my_org_ids() là SECURITY DEFINER đã grant authenticated (xem useMyOrgIds ở
// useNotificationSettings.ts).
//
// Lỗi thì THROW, không trả []. Trước đây trả [] để "khỏi trắng dropdown", nhưng
// [] ở đây nghĩa là "không biết org nào" và selectIeTypeRowsForOrgs bỏ lọc —
// tức một lỗi RPC nhất thời mở đúng cánh cửa mà án lệ 07/08/2026 đóng lại: hạng
// mục của org khác lọt vào picker rồi create_income_expense_v1 từ chối 42501.
// Fail-closed: thà màn hình báo lỗi còn hơn đưa lựa chọn của công ty khác.
async function fetchMyOrgIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc("my_org_ids");
  if (error) {
    console.error("useIncomeExpenseTypes my_org_ids error:", error);
    throw error;
  }
  if (!Array.isArray(data)) throw new Error('Chưa xác nhận được tổ chức của bạn. Tải lại hạng mục thu chi trước khi chọn.');
  return (data as string[]).filter(Boolean);
}

// --- Query Hooks ---

// Loại thu chi gần như không đổi trong phiên → staleTime dài để các component
// remount (form/dialog/filter) không refetch lại, đỡ request trên instance nhỏ.
const IE_TYPES_STALE_TIME = 5 * 60_000;

export const useIncomeExpenseTypes = (
  filterType?: "income" | "expense",
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    staleTime: IE_TYPES_STALE_TIME,
    queryKey: ["income-expense-types", filterType],
    queryFn: async (): Promise<IncomeExpenseType[]> => {
      // hermes-parity:begin w2d-ie-types
      // DB canonical theo (organization, type, normalized name). Giữ dedup
      // client-side trong giai đoạn rollout để phiên đang mở trước migration
      // không nháy dòng trùng; đây không còn là nguồn bảo đảm tính duy nhất.
      const [user, myOrgIds] = await Promise.all([
        getSessionUser(),
        fetchMyOrgIds(),
      ]);
      const currentUserId = user?.id ?? null;

      let query = supabase
        .from("income_expense_types" as any)
        .select("*")
        .order("name", { ascending: true });

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTypes error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách loại thu chi. Tải lại trước khi chọn.');
      const rows = data as unknown as IncomeExpenseType[];
      return selectIeTypeRowsForOrgs(rows, currentUserId, myOrgIds);
      // hermes-parity:end w2d-ie-types
    },
  });
};

/**
 * Distinct, non-null categories cho user hiện tại (lọc theo type nếu truyền).
 * Dùng cho combobox gom nhóm trong form Thêm/Sửa loại thu chi.
 */
export const useIncomeExpenseTypeCategories = (
  filterType?: "income" | "expense"
) => {
  return useQuery({
    staleTime: IE_TYPES_STALE_TIME,
    queryKey: ["income-expense-type-categories", filterType],
    queryFn: async (): Promise<string[]> => {
      // Categories cũng dùng chung — không filter theo user_id (xem hook
      // useIncomeExpenseTypes phía trên), nhưng phải lọc org vì RLS đang cho
      // thấy cross-org (cùng án lệ 07/08/2026 ở selectIeTypeRowsForOrgs).
      const myOrgIds = await fetchMyOrgIds();
      let query = supabase
        .from("income_expense_types" as any)
        .select("category, organization_id")
        .not("category", "is", null);

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;
      if (error) {
        console.error("useIncomeExpenseTypeCategories error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được nhóm loại thu chi. Tải lại trước khi chọn.');
      const set = new Set<string>();
      for (const row of data as unknown as Array<{
        category: string | null;
        organization_id: string | null;
      }>) {
        if (
          myOrgIds.length &&
          row.organization_id != null &&
          !myOrgIds.includes(row.organization_id)
        ) {
          continue;
        }
        const c = (row.category ?? "").trim();
        if (c) set.add(c);
      }
      return Array.from(set).sort((a, b) =>
        a.localeCompare(b, "vi", { sensitivity: "base" })
      );
    },
  });
};

/**
 * Các hạng mục được đánh dấu "đặc biệt" (hide_in_report=true). DB canonical bảo
 * đảm một ID cho mỗi tên trong tổ chức; báo cáo vẫn khớp thêm theo tên để tương
 * thích cache/phiên cũ trong giai đoạn rollout.
 */
export const useHiddenInReportTypes = () => {
  return useQuery({
    staleTime: IE_TYPES_STALE_TIME,
    queryKey: ["ie-types-hidden-in-report"],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .select("id, name")
        .eq("hide_in_report", true);
      if (error) {
        console.error("useHiddenInReportTypes error:", error);
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được loại thu chi trong báo cáo. Tải lại trước khi xem.');
      return (data as any[]).map((r) => ({ id: r.id, name: r.name ?? "" }));
    },
  });
};

/**
 * Loại thu chi trùng ràng buộc duy nhất `income_expense_types_org_side_normalized_name_uq` của production:
 * (công ty, chiều thu/chi, `normalize_income_expense_type_name(name)` = bỏ dấu, chữ thường, đ→d, gộp khoảng trắng).
 * `missing`: đọc được nhưng không thấy (RLS ẩn hạng mục hạn chế của người khác cũng là không thấy); `unreadable`: đọc hỏng.
 */
async function findIncomeExpenseTypeByName(organizationId: string, side: 'income' | 'expense', name: string): Promise<{ state: 'found'; row: IncomeExpenseType } | { state: 'missing' } | { state: 'unreadable' }> {
  try {
    const { data, error } = await supabase.from('income_expense_types').select('*').eq('organization_id', organizationId);
    if (error || !Array.isArray(data)) return { state: 'unreadable' };
    const wanted = normalizeVietnameseName(name);
    const row = (data as unknown as IncomeExpenseType[]).find(item => String(item.type ?? '').trim().toLowerCase() === side && normalizeVietnameseName(item.name) === wanted);
    return row ? { state: 'found', row } : { state: 'missing' };
  } catch {
    /* Lỗi mạng khi tra: không kết luận được. */
    return { state: 'unreadable' };
  }
}

// Tên loại (công ty, chiều, tên chuẩn hoá) có lần tạo chưa rõ kết quả trong tab này: lần bấm sau gặp trùng tên thì đó là
// loại của chính lần gửi trước, trả lại loại đó. Không phải lần gửi lại thì trùng tên là lỗi của người dùng như cũ.
const unconfirmedTypeNames = new Set<string>();
const typeNameKey = (organizationId: string, side: string, name: string) => `${organizationId}|${side}|${normalizeVietnameseName(name)}`;

/**
 * Loại đã có này trả lại cho nơi gọi được không: không lưu trữ, không gộp, không chỉ hệ thống, không ẩn khỏi ô chọn; hạn
 * chế chỉ khi chính người dùng đang tạo một loại hạn chế.
 */
const usableType = (row: IncomeExpenseType, wantRestricted: boolean) => !row.archived_at && !row.merged_into_id && !row.system_only && !row.manual_hidden && (!row.is_restricted || wantRestricted);

// --- Mutation Hooks ---

export const useCreateIncomeExpenseType = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      type: "income" | "expense";
      category?: string | null;
      description?: string | null;
      is_default?: boolean;
      is_restricted?: boolean;
      hide_in_report?: boolean;
    } & IncomeExpenseTypeCatalogUpdates) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // Trigger strict yêu cầu tổ chức được chọn trong payload; không suy từ toà.
      const payload = withOrg({
          user_id: user.id,
          name: input.name,
          type: input.type,
          category: input.category ?? null,
          description: input.description ?? null,
          is_default: input.is_default ?? false,
          is_restricted: input.is_restricted ?? false,
          hide_in_report: input.hide_in_report ?? false,
          // Cột danh mục chỉ gửi khi có giá trị — môi trường chưa áp migration
          // danh mục chuẩn sẽ từ chối cột lạ.
          ...(input.keywords && input.keywords.length ? { keywords: input.keywords } : {}),
          ...(input.sort_order != null ? { sort_order: input.sort_order } : {}),
          ...(input.quick_entry_hidden ? { quick_entry_hidden: true } : {}),
        },selectedOrganizationId);
      // Đợt 4: không còn khoá chung. Dấu khoá chung của bản trước chỉ được gỡ: tên loại là duy nhất trong công ty
      // nên mọi lần tạo sau đều tự đối chiếu được theo tên, không cần tra gì thêm cho dấu cũ.
      await settleLegacyPending({ namespace: 'income-expense-type-create', businessKey: 'create' }, async () => true);
      let response: { data: unknown; error: unknown };
      try {
        response = await supabase.from("income_expense_types" as any).insert(payload).select().single();
      } catch (thrown) {
        response = { data: null, error: thrown };
      }
      const { data, error } = response;
      const created = data as { id?: unknown; name?: unknown } | null;
      const nameKey = typeNameKey(payload.organization_id, input.type, input.name);
      if (!error && typeof created?.id === 'string' && created.id && created.name === input.name) {
        unconfirmedTypeNames.delete(nameKey);
        return data as IncomeExpenseType;
      }
      const nameTaken = isUniqueViolation(error) && /normalized_name/.test(String((error as { message?: unknown }).message ?? ''));
      // Máy chủ từ chối rõ vì lý do khác (quyền, cột lạ…): lỗi thật, không có gì để đối chiếu.
      if (error && !nameTaken && !hasUnconfirmedResponse(error)) throw error;
      // Trùng tên, hoặc chưa rõ kết quả: tra đúng loại theo ràng buộc duy nhất (công ty, chiều, tên chuẩn hoá).
      const found = await findIncomeExpenseTypeByName(payload.organization_id, input.type, input.name);
      if (found.state === 'found') {
        const existing = found.row;
        const retry = unconfirmedTypeNames.has(nameKey);
        unconfirmedTypeNames.delete(nameKey);
        // Trùng tên mà không phải lần gửi lại: người dùng tạo trùng một loại đã có. Báo như trước (giữ nguyên form và
        // thiết lập đang nhập), kèm mã loại đó.
        if (nameTaken && !retry) {
          throw new FinancialWorkflowError(`Loại thu chi «${existing.name}» đã có trong công ty (mã ${existing.id}). Chọn loại đó trong danh sách hoặc đặt tên khác.`, 'failure', []);
        }
        if (!usableType(existing, !!input.is_restricted)) {
          throw new FinancialWorkflowError(`Tên «${existing.name}» trùng với một loại thu chi đã lưu trữ, đã gộp, chỉ hệ thống dùng, đang ẩn hoặc hạn chế (mã ${existing.id}). Khôi phục hoặc chọn loại đó ở Cài đặt › Loại thu chi nếu được phép, hoặc đặt tên khác.`, 'failure', []);
        }
        // Lần gửi trước (hoặc chính lần gửi mất phản hồi này) đã tạo loại đó: trả lại nó, không tạo thêm.
        return nameTaken ? { ...existing, existed: true } : existing;
      }
      if (nameTaken) {
        unconfirmedTypeNames.delete(nameKey);
        throw new FinancialWorkflowError(found.state === 'missing'
          ? 'Tên loại thu chi này đã có trong công ty nhưng bạn không xem được (có thể là hạng mục hạn chế). Đặt tên khác, hoặc nhờ chủ công ty kiểm tra.'
          : 'Tên loại thu chi này đã có trong công ty; chưa đọc lại được loại đó. Tải lại danh sách loại thu chi rồi chọn hoặc đặt tên khác.', 'failure', []);
      }
      unconfirmedTypeNames.add(nameKey);
      throw new FinancialWorkflowError('Chưa xác nhận được kết quả tạo loại thu chi. Giữ nguyên thông tin rồi bấm lưu lại: tên loại là duy nhất trong công ty nên không tạo trùng.', 'unknown', [], error);
    },
    onSuccess: (data) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      if ((data as { existed?: boolean } | null)?.existed) {
        toast.success(`Loại thu chi ${feedbackRecordName(data)} đã được tạo ở lần gửi trước; dùng loại này, không tạo thêm.`);
        return;
      }
      toast.success(`Đã tạo loại thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({queryKey:['income-expense-types']});
      queryClient.invalidateQueries({queryKey:['income-expense-type-categories']});
      if (error instanceof FinancialWorkflowError) { toast.error('Chưa tạo được loại thu chi', {description:recordWriteMessage(error, 'tạo loại thu chi')}); return; }
      const feedback = friendlyError(error, "Chưa tạo được loại thu chi", { operation: "tạo loại thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error creating income expense type:", error);
    },
  });
};

export const useUpdateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: {
        name?: string;
        type?: "income" | "expense";
        category?: string | null;
        description?: string | null;
        is_default?: boolean;
        is_restricted?: boolean;
        hide_in_report?: boolean;
      } & IncomeExpenseTypeCatalogUpdates;
    }) => {
      return persistentFinancialWorkflow('income-expense-type-update').run(id, 'cập nhật loại thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(data, 'cập nhật loại thu chi', id);
      return data;
      });
    },
    onSuccess: (data) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success(`Đã cập nhật loại thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({queryKey:['income-expense-types']});
      queryClient.invalidateQueries({queryKey:['income-expense-type-categories']});
      if (error instanceof FinancialWorkflowError) { toast.error('Chưa cập nhật được loại thu chi', {description:recordWriteMessage(error, 'cập nhật loại thu chi')}); return; }
      const feedback = friendlyError(error, "Chưa cập nhật được loại thu chi", { operation: "cập nhật loại thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error updating income expense type:", error);
    },
  });
};

export const useDeleteIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Check if type is being used by income_expense_items
      const { data: usageCheck, error: usageError } = await supabase
        .from("income_expense_items" as any)
        .select("id")
        .eq("income_expense_type_id", id)
        .limit(1);

      if (usageError) {
        console.error("Error checking type usage:", usageError);
        throw usageError;
      }

      if (!Array.isArray(usageCheck)) throw new Error('Chưa kiểm tra được phiếu đang dùng loại thu chi. Tải lại trước khi xóa.');
      if (usageCheck.length > 0) {
        throw new Error(
          "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi"
        );
      }

      return persistentFinancialWorkflow('income-expense-type-delete').run(id, 'xoá loại thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .delete()
        .eq("id", id)
        .select('id,name')
        .single();

      if (error) {
        throw error;
      }
      confirmedRecordId(data, 'xoá loại thu chi', id);
      return data;
      });
    },
    onSuccess: (data) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success(`Đã xóa loại thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({queryKey:['income-expense-types']});
      queryClient.invalidateQueries({queryKey:['income-expense-type-categories']});
      if (error instanceof FinancialWorkflowError) { toast.error('Chưa xóa được loại thu chi', {description:recordWriteMessage(error, 'xóa loại thu chi')}); return; }
      const feedback = friendlyError(error, "Chưa xóa được loại thu chi", { operation: "xóa loại thu chi", rules: [{ message: "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi", description: "Loại thu chi đang được dùng trong phiếu thu/chi. Kiểm tra phiếu liên quan trước khi xóa." }] });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error deleting income expense type:", error);
    },
  });
};
