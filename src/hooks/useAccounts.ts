import {useRef} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {financialReadNumber} from '@/lib/financialReadValidation';
import { notifyActionError } from "@/lib/actionFeedback";
import { jsonProp } from "@/lib/jsonValue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { rpcNullable } from "@/lib/rpcNullable";
import { toast } from "sonner";

// --- Types ---

export interface Account {
  id: string;
  organization_id?: string;
  user_id: string;
  code: string;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  bank_account_holder: string | null;
  branch: string | null;
  description: string | null;
  is_default: boolean;
  // Tòa nhà mặc định để tự chọn sổ quỹ này trong dialog Tạo phiếu nhanh.
  quick_default_building_id: string | null;
  initial_amount: number;
  initial_date: string;        // YYYY-MM-DD
  lock_date: string | null;    // YYYY-MM-DD
  /** Sổ ảo/kỹ thuật (CỌC giữ hộ, Cấn trừ nội bộ, Làm tròn, Thối...) — chỉ chứa
   *  bút toán, không có két tiền thật. Thống kê TIỀN THẬT phải lọc false. */
  is_virtual?: boolean;
  created_at: string;
  updated_at: string;
}

export interface AccountWithBalance extends Account {
  /** Tồn quỹ. `null` = KHÔNG ĐỌC ĐƯỢC, không phải 0 đ — xem `balance_visible`. */
  current_amount: number | null;
  /**
   * Server có cho người đang đăng nhập xem tồn quỹ của sổ này không
   * (`list_cashbook_visibility_v2.balance_visible`, bám đúng predicate RLS của
   * `income_expense_posting_lines`). Không đọc được quyền thì query báo lỗi.
   */
  balance_visible: boolean;
  owner_name?: string | null;  // full_name của user phụ trách (JS-merged từ profiles)
}

export interface AccountFormValues {
  name: string;
  description?: string | null;
  initial_amount: number;
  initial_date: string;
  is_default?: boolean;
  /** Tòa nhà mặc định khi tạo phiếu nhanh (null = không gán). */
  quick_default_building_id?: string | null;
  /** ID của user phụ trách (= accounts.user_id). Chỉ admin mới được đổi.
   *  Khi undefined → giữ nguyên (update) hoặc auto = auth.uid() (create). */
  user_id?: string;
}

// --- Query: select-list (dùng trong filter & form thu chi) ---
// opts.enabled: cho caller hoãn fetch tới khi thực sự cần (vd CollectDrawer
// chỉ tải sổ quỹ khi mở sheet thu tiền). Mặc định true — 20+ call site cũ giữ nguyên.
// Chủ/super-admin THẤY cả sổ sandbox demo qua RLS (code DEMO%) — lọc khỏi
// dropdown + trang Sổ quỹ của tenant thật; tài khoản demo đăng nhập vẫn thấy
// sổ của mình (không áp filter).
const isDemoSession = async (): Promise<boolean> => {
  const u = await getSessionUser();
  return !!u?.email?.startsWith("demo.");
};

export const useAccounts = (opts?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ["accounts"],
    enabled: opts?.enabled ?? true,
    queryFn: async () => {
      let query = (supabase
        .from("accounts" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (!(await isDemoSession())) {
        query = query.not("code", "ilike", "DEMO%");
      }
      const { data, error } = await query;

      if (error) {
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách sổ quỹ. Tải lại trước khi ghi nhận khoản cọc.');
      return data as Account[];
    },
  });
};

/**
 * Sổ nào người đang đăng nhập được xem TỒN QUỸ.
 *
 * Lỗi kiểm tra quyền được truyền ra query; không hiển thị số dư như đã xác minh.
 */
const readBalanceVisibility = async (): Promise<Map<string, boolean>> => {
  const { data, error } = await supabase.rpc("list_cashbook_visibility_v2");
  if (error) {
    throw error;
  }
  if (!Array.isArray(data) || data.some(row => !row || typeof row !== "object" || typeof row.cashbook_id !== "string" || typeof row.balance_visible !== "boolean")) throw new Error("Chưa kiểm tra được quyền xem số dư sổ quỹ");
  const rows = data as { cashbook_id: string; balance_visible: boolean }[];
  return new Map(rows.map((r) => [r.cashbook_id, r.balance_visible === true]));
};

// --- Query: list with balance (cho trang Cashbooks) ---
export const useAccountsWithBalance = (params?: {
  searchQuery?: string;
  page?: number;
  pageSize?: number;
}) => {
  const page = params?.page ?? 1;
  const pageSize = params?.pageSize ?? 10;
  const searchQuery = params?.searchQuery?.trim() ?? "";

  return useQuery({
    meta: {feedback:"inline"},
    queryKey: ["accounts-with-balance", page, pageSize, searchQuery],
    queryFn: async (): Promise<{
      data: AccountWithBalance[];
      totalCount: number;
    }> => {
      let query = supabase
        .from("accounts_with_balance" as any)
        .select("*", { count: "exact" });
      if (!(await isDemoSession())) {
        query = (query as any).not("code", "ilike", "DEMO%");
      }

      if (searchQuery) {
        // search trên name + code
        query = query.or(
          `name.ilike.%${searchQuery}%,code.ilike.%${searchQuery}%`
        );
      }

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;

      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, to);

      if (error) {
        throw error;
      }

      if (!Array.isArray(data) || typeof count !== 'number' || !Number.isSafeInteger(count) || count<0) throw new Error('Invalid cashbook list response');
      const rows = data as any[];

      // JS-merge owner profile (full_name) cho cột "Phụ trách".
      const userIds = Array.from(
        new Set(rows.map((r) => r.user_id).filter(Boolean))
      ) as string[];
      const ownerById = new Map<string, { full_name: string | null }>();
      if (userIds.length > 0) {
        const { data: profiles, error: profilesError } = await (supabase
          .from("profiles")
          .select("id, full_name" as any) as any)
          .in("id", userIds);
        if (profilesError) throw profilesError;
        if(!Array.isArray(profiles))throw new TypeError('Chưa đọc được người phụ trách sổ quỹ.');
        for (const p of (profiles as any[])) {
          ownerById.set(p.id, { full_name: p.full_name ?? null });
        }
      }

      // H3.4 — `accounts_with_balance` là view security_invoker, nên cột
      // current_amount của nó được tính DƯỚI QUYỀN NGƯỜI ĐỌC:
      //   current_amount = initial_amount + COALESCE(SUM(posting_lines…), 0)
      // RLS `finance_v2_posting_lines_select_custodian` chỉ mở posting lines
      // cho CUSTODIAN của chính sổ đó. Ai không phải CUSTODIAN đọc ra 0 dòng
      // ⇒ SUM = NULL ⇒ COALESCE = 0 ⇒ tồn quỹ hiện ra ĐÚNG BẰNG số dư đầu kỳ.
      // Đó là một con số SAI trông như số thật — cộng được vào tổng, in được
      // ra báo cáo. Hỏi server sổ nào thật sự đọc được rồi để TRỐNG phần còn
      // lại; `null` không cộng nhầm vào đâu được, `0` thì có.
      const visibleById = await readBalanceVisibility();

      const mapped: AccountWithBalance[] = rows.map((r) => {
        const visible = visibleById.get(r.id) === true;
        if (r.initial_amount == null || !Number.isFinite(Number(r.initial_amount)) || (visible && (r.current_amount == null || !Number.isFinite(Number(r.current_amount))))) throw new Error("Invalid cashbook balance values");
        return {
          ...r,
          initial_amount: financialReadNumber(r.initial_amount),
          current_amount: visible ? financialReadNumber(r.current_amount) : null,
          balance_visible: visible,
          owner_name: ownerById.get(r.user_id)?.full_name ?? null,
        };
      });

      return { data: mapped, totalCount: count };
    },
  });
};

// --- Mutations ---

export const useCreateAccount = (options?: {silent?: boolean}) => {
  const qc = useQueryClient();
  const workflow=useRef(persistentFinancialWorkflow('cashbook-create',{scope:'actor'}));
  return useMutation({
    meta:{handlesFeedback:!!options?.silent},
    mutationFn: async (values: AccountFormValues) => workflow.current.run('new','tạo sổ quỹ',async progress => {
      const authData = { user: await getSessionUser() };
      if (!authData.user) throw new Error("User not authenticated");

      // Canonical create_cashbook_v1 (parity: description/is_default/owner giữ
      // nguyên). KHÔNG còn fallback ghi thẳng bảng: Đợt 0 đã REVOKE
      // INSERT/UPDATE/DELETE trên `accounts` khỏi authenticated
      // (20260730102000_money_tables_revoke_dml.sql) vì đó là đường cho phép
      // client tự xoá lock_date và sửa initial_amount — tức tự đổi số dư sổ
      // quỹ mà không sinh một phiếu hay posting nào.
      const canonical = await supabase.rpc("create_cashbook_v1", {
        p_name: values.name,
        p_initial_amount: values.initial_amount,
        p_initial_date: values.initial_date,
        p_bank_name: rpcNullable<string>(null),
        p_account_number: rpcNullable<string>(null),
        p_quick_default_building_id: rpcNullable(values.quick_default_building_id ?? null),
        p_idempotency_key: progress.requestKey,
        p_description: values.description ?? undefined,
        p_is_default: values.is_default ?? false,
        p_owner_user_id: values.user_id || undefined,
      });
      if (!canonical.error) {
        const id = jsonProp(canonical.data, "cashbook_id");
        if (typeof id !== "string" || !id) throw new TypeError("Unconfirmed created cashbook");
        return {id};
      }
      throw canonical.error;
    }),
    onError: (error:unknown) => { if (!options?.silent) notifyActionError(error, "Chưa tạo sổ quỹ."); },
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (!options?.silent) toast.success(`Đã tạo sổ quỹ ${input.name}.`);
    },
  });
};

export const useUpdateAccount = (options?: {silent?: boolean}) => {
  const qc = useQueryClient();
  const workflow=useRef(persistentFinancialWorkflow('cashbook-lifecycle',{scope:'actor'}));
  return useMutation({
    meta:{handlesFeedback:!!options?.silent},
    mutationFn: async (input: { id: string; values: AccountFormValues }) => workflow.current.run(input.id,'lưu thay đổi sổ quỹ',async () => {
      // Canonical update_cashbook_metadata_v1 — RPC lo phần "chỉ đổi user_id /
      // is_default khi form thực sự gửi". Không còn fallback ghi thẳng bảng
      // (xem ghi chú ở useCreateAccount).
      const canonical = await supabase.rpc("update_cashbook_metadata_v1", {
        p_cashbook_id: input.id,
        p_name: input.values.name,
        p_description: rpcNullable(input.values.description ?? null),
        p_initial_amount: input.values.initial_amount,
        p_initial_date: input.values.initial_date,
        p_quick_default_building_id: rpcNullable(input.values.quick_default_building_id ?? null),
        p_is_default: rpcNullable(input.values.is_default !== undefined ? input.values.is_default : null),
        p_owner_user_id: rpcNullable(input.values.user_id || null),
      });
      if (!canonical.error) {
        if (jsonProp(canonical.data, 'cashbook_id') !== input.id) throw new TypeError('Unconfirmed cashbook update');
        return;
      }
      throw canonical.error;
    }),
    onError: (error:unknown) => { if (!options?.silent) notifyActionError(error, "Chưa lưu thay đổi sổ quỹ."); },
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (!options?.silent) toast.success(`Đã lưu thay đổi sổ quỹ ${input.values.name}.`);
    },
  });
};

export const useDeleteAccount = () => {
  const qc = useQueryClient();
  const workflow=useRef(persistentFinancialWorkflow('cashbook-lifecycle',{scope:'actor'}));
  return useMutation({
    mutationFn: async (id: string) => workflow.current.run(id,'xóa sổ quỹ',async () => {
      // Canonical archive_cashbook_v1 (từ chối nếu còn phiếu). Không còn
      // fallback ghi thẳng bảng (xem ghi chú ở useCreateAccount).
      const canonical = await supabase.rpc("archive_cashbook_v1", { p_cashbook_id: id });
      if (!canonical.error) {
        if (jsonProp(canonical.data, 'cashbook_id') !== id || jsonProp(canonical.data, 'archived') !== true) throw new TypeError('Unconfirmed cashbook archive');
        return;
      }
      throw canonical.error;
    }),
    onError: (error:unknown) => notifyActionError(error, "Chưa xóa sổ quỹ."),
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã xóa sổ quỹ.");
    },
  });
};

// ĐỢT 6 — ĐÃ XOÁ useLockAccount / useUnlockAccount.
//
// Khoá sổ không còn là một nút bấm một mình: nó là kết quả của nghi thức chốt &
// bàn giao hai bên (propose_cashbook_closing_v1 → confirm_cashbook_closing_v1,
// xem src/hooks/useCashbookClosing.ts), và ngày khoá hiệu lực đọc từ
// app_private.cashbook_closures chứ không từ accounts.lock_date.
//
// useUnlockAccount thì đã CHẾT từ Đợt 3: lock_cashbook_period_v1(p_unlock=>true)
// LUÔN ném [CASHBOOK_CLOSED] theo quyết định #7 của chủ ("không ai mở"). Giữ một
// nút gọi nó lại là hứa với người dùng một đường thoát không tồn tại.
