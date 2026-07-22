import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { isCanonicalFallbackSignal } from "@/lib/canonicalFallback";

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
  current_amount: number;      // tồn quỹ
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
        toast.error("Không thể tải danh sách sổ quỹ");
        throw error;
      }

      return (data || []) as Account[];
    },
  });
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
        console.error("useAccountsWithBalance error", error);
        toast.error("Không thể tải danh sách sổ quỹ");
        return { data: [], totalCount: 0 };
      }

      const rows = (data || []) as any[];

      // JS-merge owner profile (full_name) cho cột "Phụ trách".
      const userIds = Array.from(
        new Set(rows.map((r) => r.user_id).filter(Boolean))
      ) as string[];
      const ownerById = new Map<string, { full_name: string | null }>();
      if (userIds.length > 0) {
        const { data: profiles } = await (supabase
          .from("profiles")
          .select("id, full_name" as any) as any)
          .in("id", userIds);
        for (const p of ((profiles as any[]) || [])) {
          ownerById.set(p.id, { full_name: p.full_name ?? null });
        }
      }

      const mapped: AccountWithBalance[] = rows.map((r) => ({
        ...r,
        initial_amount: Number(r.initial_amount) || 0,
        current_amount: Number(r.current_amount) || 0,
        owner_name: ownerById.get(r.user_id)?.full_name ?? null,
      }));

      return { data: mapped, totalCount: count ?? 0 };
    },
  });
};

// --- Mutations ---

export const useCreateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: AccountFormValues) => {
      const authData = { user: await getSessionUser() };
      if (!authData.user) throw new Error("User not authenticated");

      const payload: any = {
        user_id: values.user_id || authData.user.id,
        name: values.name,
        description: values.description ?? null,
        initial_amount: values.initial_amount,
        initial_date: values.initial_date,
        is_default: values.is_default ?? false,
        quick_default_building_id: values.quick_default_building_id ?? null,
      };

      // Canonical create_cashbook_v1 (parity: description/is_default/owner giữ
      // nguyên); fallback legacy insert khi writer chưa bật cho org (server route).
      const canonical = await (supabase.rpc as any)("create_cashbook_v1", {
        p_name: values.name,
        p_initial_amount: values.initial_amount,
        p_initial_date: values.initial_date,
        p_bank_name: null,
        p_account_number: null,
        p_quick_default_building_id: values.quick_default_building_id ?? null,
        p_idempotency_key: crypto.randomUUID(),
        p_description: values.description ?? null,
        p_is_default: values.is_default ?? false,
        p_owner_user_id: values.user_id || null,
      });
      if (!canonical.error) return canonical.data;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể tạo sổ quỹ");
        throw canonical.error;
      }

      const { data, error } = await supabase
        .from("accounts" as any)
        .insert(payload)
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể tạo sổ quỹ");
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Thông tin đã được cập nhật lưu trữ thành công");
    },
  });
};

export const useUpdateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; values: AccountFormValues }) => {
      const patch: any = {
        name: input.values.name,
        description: input.values.description ?? null,
        initial_amount: input.values.initial_amount,
        initial_date: input.values.initial_date,
        quick_default_building_id: input.values.quick_default_building_id ?? null,
      };
      // Chỉ gán user_id khi form thực sự đẩy lên (admin đổi người phụ trách).
      // Non-admin không gửi field này → giữ nguyên user_id cũ.
      if (input.values.user_id) patch.user_id = input.values.user_id;
      // Chỉ đổi is_default khi form thực sự gửi (form sổ quỹ hiện chưa có ô này)
      // → tránh sửa sổ làm mất cờ "sổ thu mặc định" đã set cho auto-pick TM.
      if (input.values.is_default !== undefined) patch.is_default = input.values.is_default;

      // Canonical update_cashbook_metadata_v1; fallback legacy update khi chưa bật.
      const canonical = await (supabase.rpc as any)("update_cashbook_metadata_v1", {
        p_cashbook_id: input.id,
        p_name: input.values.name,
        p_description: input.values.description ?? null,
        p_initial_amount: input.values.initial_amount,
        p_initial_date: input.values.initial_date,
        p_quick_default_building_id: input.values.quick_default_building_id ?? null,
        p_is_default: input.values.is_default !== undefined ? input.values.is_default : null,
        p_owner_user_id: input.values.user_id || null,
      });
      if (!canonical.error) return;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể cập nhật sổ quỹ");
        throw canonical.error;
      }

      const { data, error } = await supabase
        .from("accounts" as any)
        .update(patch)
        .eq("id", input.id)
        .select("id");

      if (error) {
        toast.error(error.message || "Không thể cập nhật sổ quỹ");
        throw error;
      }
      if (!data || data.length === 0) {
        const msg = "Bạn không có quyền chỉnh sửa sổ quỹ này";
        toast.error(msg);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Thông tin đã được cập nhật lưu trữ thành công");
    },
  });
};

export const useDeleteAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Canonical archive_cashbook_v1 (từ chối nếu còn phiếu); fallback legacy.
      const canonical = await (supabase.rpc as any)("archive_cashbook_v1", { p_cashbook_id: id });
      if (!canonical.error) return;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể xoá sổ quỹ");
        throw canonical.error;
      }

      const { data, error } = await supabase
        .from("accounts" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");

      if (error) {
        toast.error(error.message || "Không thể xoá sổ quỹ");
        throw error;
      }
      if (!data || data.length === 0) {
        const msg = "Bạn không có quyền xoá sổ quỹ này";
        toast.error(msg);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
  });
};

export const useLockAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; lock_date: string }) => {
      // Canonical lock_cashbook_period_v1 (monotonic guard); fallback legacy.
      const canonical = await (supabase.rpc as any)("lock_cashbook_period_v1", {
        p_cashbook_id: input.id, p_lock_date: input.lock_date, p_unlock: false,
      });
      if (!canonical.error) return;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể khoá sổ");
        throw canonical.error;
      }

      const { data, error } = await supabase
        .from("accounts" as any)
        .update({ lock_date: input.lock_date })
        .eq("id", input.id)
        .select("id");
      if (error) {
        toast.error(error.message || "Không thể khoá sổ");
        throw error;
      }
      if (!data || data.length === 0) {
        const msg = "Bạn không có quyền khoá sổ quỹ này";
        toast.error(msg);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã khoá sổ thành công");
    },
  });
};

export const useUnlockAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Canonical unlock qua lock_cashbook_period_v1(unlock=true); fallback legacy.
      const canonical = await (supabase.rpc as any)("lock_cashbook_period_v1", {
        p_cashbook_id: id, p_lock_date: null, p_unlock: true,
      });
      if (!canonical.error) return;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể mở khoá sổ");
        throw canonical.error;
      }

      const { data, error } = await supabase
        .from("accounts" as any)
        .update({ lock_date: null })
        .eq("id", id)
        .select("id");
      if (error) {
        toast.error(error.message || "Không thể mở khoá sổ");
        throw error;
      }
      if (!data || data.length === 0) {
        const msg = "Bạn không có quyền mở khoá sổ quỹ này";
        toast.error(msg);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã mở khoá sổ thành công");
    },
  });
};
