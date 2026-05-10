import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  IncomeExpenseFormValues,
  ExcelImportRow,
  IncomeExpenseBatchFormValues,
} from "@/lib/incomeExpenseValidation";

// --- Types ---

export interface IncomeExpenseFilters {
  area_id?: string | null;
  building_id?: string | null;
  room_id?: string | null;
  account_id?: string | null;
  cash_book_id?: string | null;
  type?: "INCOME" | "EXPENSE" | null;
  start_date?: string | null;
  end_date?: string | null;
  approval_status?: "UNAPPROVED" | "APPROVED" | "CANCELLED" | null;
}


export interface IncomeExpenseItem {
  id: string;
  income_expense_id: string;
  income_expense_type_id: string;
  type_name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  amount: number;
  start_date: string | null;
  end_date: string | null;
}


export interface IncomeExpenseWithRelations {
  id: string;
  user_id: string;
  code: string;
  type: "INCOME" | "EXPENSE";
  name: string;
  building_id: string;
  building_name: string;
  room_id: string | null;
  room_name: string | null;
  bed_id: string | null;
  bed_name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  voucher_date: string;
  total_amount: number;
  approval_status: "UNAPPROVED" | "APPROVED" | "CANCELLED";
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  payer_name: string | null;
  account_id: string | null;
  account_name: string | null;
  contract_id: string | null;
  attachments: string[];
  business_result_accounting: boolean;
  receive_bank_name: string | null;
  receive_bank_account: string | null;
  creator_name: string | null;
  repeat_cycle: 'NONE' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR' | null;
  repeat_infinity: boolean;
  repeat_count: number;
  repeat_remaining: number;
  repeat_next_date: string | null;
  repeat_parent_id: string | null;
  items: IncomeExpenseItem[];
  created_at: string;
  updated_at: string;
}

// --- Query Hooks ---

export const useIncomeExpenses = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string
) => {
  return useQuery({
    queryKey: [
      "income-expenses",
      "list",
      filters.area_id,
      filters.building_id,
      filters.room_id,
      filters.account_id,
      filters.type,
      filters.start_date,
      filters.end_date,
      filters.approval_status,
      pagination.page,
      pagination.pageSize,
      searchQuery,
    ],
    queryFn: async (): Promise<{
      data: IncomeExpenseWithRelations[];
      totalCount: number;
    }> => {
      const hasSearch = searchQuery && searchQuery.trim().length > 0;

      // Build the main query with joins
      let query = supabase
        .from("income_expenses" as any)
        .select(
          `
          *,
          building:buildings!income_expenses_building_id_fkey ( id, name ),
          room:rooms!income_expenses_room_id_fkey ( id, name ),
          bed:beds!income_expenses_bed_id_fkey ( id, name ),
          tenant:tenants!income_expenses_tenant_id_fkey ( id, full_name ),
          account:accounts!income_expenses_account_id_fkey ( id, name )
        `,
          { count: "exact" }
        )
        .is("deleted_at", null);

      // Apply filters
      // For area_id, we need to get building IDs belonging to the area first
      if (filters.area_id) {
        const { data: areaBuildings } = await supabase
          .from("buildings" as any)
          .select("id")
          .eq("area_id", filters.area_id)
          .is("deleted_at", null);
        const areaBuildingIds = (areaBuildings || []).map((b: any) => b.id);
        if (areaBuildingIds.length > 0) {
          query = query.in("building_id", areaBuildingIds);
        } else {
          // No buildings in this area, return empty
          return { data: [], totalCount: 0 };
        }
      }
      if (filters.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters.room_id) {
        query = query.eq("room_id", filters.room_id);
      }
      if (filters.account_id) {
        query = query.eq("account_id", filters.account_id);
      }
      if (filters.type) {
        query = query.eq("type", filters.type);
      }
      if (filters.start_date) {
        query = query.gte("voucher_date", filters.start_date);
      }
      if (filters.end_date) {
        query = query.lte("voucher_date", filters.end_date);
      }
      if (filters.approval_status) {
        query = query.eq("approval_status", filters.approval_status);
      }

      // When searching, we need to fetch all filtered records and search client-side
      // because tenant_name comes from a joined table and can't be searched server-side.
      // When not searching, use server-side pagination for efficiency.
      if (!hasSearch) {
        const from = (pagination.page - 1) * pagination.pageSize;
        const to = from + pagination.pageSize - 1;
        query = query.range(from, to);
      }

      // Order by voucher_date desc
      query = query.order("voucher_date", { ascending: false });

      const { data: vouchers, error, count } = await query;

      if (error) {
        console.error("useIncomeExpenses error:", error);
        return { data: [], totalCount: 0 };
      }

      if (!vouchers || vouchers.length === 0) {
        return { data: [], totalCount: count || 0 };
      }

      // Fetch items for all vouchers in one query
      const voucherIds = (vouchers as any[]).map((v: any) => v.id);
      const { data: allItems, error: itemsError } = await supabase
        .from("income_expense_items" as any)
        .select(
          `
          *,
          income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name )
        `
        )
        .in("income_expense_id", voucherIds);

      if (itemsError) {
        console.error("useIncomeExpenses items error:", itemsError);
      }

      // Group items by income_expense_id
      const itemsByVoucherId = new Map<string, IncomeExpenseItem[]>();
      if (allItems) {
        for (const item of allItems as any[]) {
          const vId = item.income_expense_id;
          if (!itemsByVoucherId.has(vId)) {
            itemsByVoucherId.set(vId, []);
          }
          itemsByVoucherId.get(vId)!.push({
            id: item.id,
            income_expense_id: item.income_expense_id,
            income_expense_type_id: item.income_expense_type_id,
            type_name: item.income_expense_type?.name ?? "",
            description: item.description,
            quantity: item.quantity,
            unit_price: Number(item.unit_price),
            amount: Number(item.amount),
            start_date: item.start_date ?? null,
            end_date: item.end_date ?? null,
          });
        }
      }

      // Map vouchers to IncomeExpenseWithRelations
      const mapped: IncomeExpenseWithRelations[] = (vouchers as any[]).map(
        (v: any) => ({
          id: v.id,
          user_id: v.user_id,
          code: v.code,
          type: v.type,
          name: v.name,
          building_id: v.building_id,
          building_name: v.building?.name ?? "",
          room_id: v.room_id,
          room_name: v.room?.name ?? null,
          bed_id: v.bed_id,
          bed_name: v.bed?.name ?? null,
          tenant_id: v.tenant_id,
          tenant_name: v.tenant?.full_name ?? null,
          voucher_date: v.voucher_date,
          total_amount: Number(v.total_amount),
          approval_status: v.approval_status,
          approved_by: v.approved_by,
          approved_at: v.approved_at,
          notes: v.notes,
          payer_name: v.payer_name ?? null,
          account_id: v.account_id ?? null,
          account_name: v.account?.name ?? null,
          contract_id: v.contract_id ?? null,
          attachments: v.attachments ?? [],
          business_result_accounting: v.business_result_accounting ?? false,
          receive_bank_name: v.receive_bank_name ?? null,
          receive_bank_account: v.receive_bank_account ?? null,
          creator_name: v.creator_name ?? null,
          repeat_cycle: v.repeat_cycle ?? 'NONE',
          repeat_infinity: !!v.repeat_infinity,
          repeat_count: Number(v.repeat_count ?? 0),
          repeat_remaining: Number(v.repeat_remaining ?? 0),
          repeat_next_date: v.repeat_next_date ?? null,
          repeat_parent_id: v.repeat_parent_id ?? null,
          items: itemsByVoucherId.get(v.id) ?? [],
          created_at: v.created_at,
          updated_at: v.updated_at,
        })
      );

      // Apply client-side search (ilike on name, code, tenant_name)
      if (hasSearch) {
        const search = searchQuery!.trim().toLowerCase();
        const filtered = mapped.filter(
          (v) =>
            v.name.toLowerCase().includes(search) ||
            v.code.toLowerCase().includes(search) ||
            (v.tenant_name && v.tenant_name.toLowerCase().includes(search))
        );

        // Client-side pagination after search
        const totalCount = filtered.length;
        const from = (pagination.page - 1) * pagination.pageSize;
        const paginated = filtered.slice(from, from + pagination.pageSize);

        return {
          data: paginated,
          totalCount,
        };
      }

      return {
        data: mapped,
        totalCount: count || 0,
      };
    },
  });
};

export const useIncomeExpenseStats = (filters: IncomeExpenseFilters) => {
  return useQuery({
    queryKey: [
      "income-expenses",
      "stats",
      filters.area_id,
      filters.building_id,
      filters.room_id,
      filters.account_id,
      filters.type,
      filters.start_date,
      filters.end_date,
      filters.approval_status,
    ],
    queryFn: async (): Promise<{
      totalIncome: number;
      totalExpense: number;
      difference: number;
    }> => {
      let query = supabase
        .from("income_expenses" as any)
        .select("type, total_amount")
        .is("deleted_at", null);

      // Apply same filters as useIncomeExpenses
      // For area_id, get building IDs belonging to the area first
      if (filters.area_id) {
        const { data: areaBuildings } = await supabase
          .from("buildings" as any)
          .select("id")
          .eq("area_id", filters.area_id)
          .is("deleted_at", null);
        const areaBuildingIds = (areaBuildings || []).map((b: any) => b.id);
        if (areaBuildingIds.length > 0) {
          query = query.in("building_id", areaBuildingIds);
        } else {
          return { totalIncome: 0, totalExpense: 0, difference: 0 };
        }
      }
      if (filters.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters.room_id) {
        query = query.eq("room_id", filters.room_id);
      }
      if (filters.account_id) {
        query = query.eq("account_id", filters.account_id);
      }
      if (filters.type) {
        query = query.eq("type", filters.type);
      }
      if (filters.start_date) {
        query = query.gte("voucher_date", filters.start_date);
      }
      if (filters.end_date) {
        query = query.lte("voucher_date", filters.end_date);
      }
      if (filters.approval_status) {
        query = query.eq("approval_status", filters.approval_status);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseStats error:", error);
        return {
          totalIncome: 0,
          totalExpense: 0,
          difference: 0,
        };
      }

      const rows = (data || []) as any[];
      let totalIncome = 0;
      let totalExpense = 0;

      for (const row of rows) {
        const amount = Number(row.total_amount) || 0;
        if (row.type === "INCOME") {
          totalIncome += amount;
        } else if (row.type === "EXPENSE") {
          totalExpense += amount;
        }
      }

      return {
        totalIncome,
        totalExpense,
        difference: totalIncome - totalExpense,
      };
    },
  });
};


// --- Mutation Input Types ---

export interface CreateIncomeExpenseInput extends IncomeExpenseFormValues {}

export interface UpdateIncomeExpenseInput {
  id: string;
  data: IncomeExpenseFormValues;
}

export interface ImportIncomeExpenseRow extends ExcelImportRow {
  building_id: string;
  income_expense_type_id: string;
}

// --- Mutation Hooks ---

// Tạo phiếu thu/chi mới (phiếu + items)
export const useCreateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateIncomeExpenseInput) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1. Insert the voucher
      const { data: voucher, error: voucherError } = await supabase
        .from("income_expenses" as any)
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: input.type,
          name: input.name,
          building_id: input.building_id,
          room_id: input.room_id ?? null,
          tenant_id: input.tenant_id ?? null,
          payer_name: input.payer_name ?? null,
          account_id: input.account_id ?? null,
          attachments: input.attachments ?? [],
          business_result_accounting: input.business_result_accounting ?? false,
          repeat_cycle: input.repeat_cycle ?? "NONE",
          repeat_infinity: !!input.repeat_infinity,
          repeat_count: input.repeat_count ?? 0,
          repeat_remaining: input.repeat_infinity
            ? 0
            : Number(input.repeat_count ?? 0),
          repeat_next_date:
            input.repeat_cycle && input.repeat_cycle !== "NONE"
              ? input.voucher_date
              : null,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();

      if (voucherError) {
        toast.error(voucherError.message || "Không thể tạo phiếu thu/chi");
        throw voucherError;
      }

      // 2. Insert items
      const itemsToInsert = input.items.map((item) => ({
        income_expense_id: (voucher as any).id,
        income_expense_type_id: item.income_expense_type_id,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("income_expense_items" as any)
        .insert(itemsToInsert);

      if (itemsError) {
        toast.error(itemsError.message || "Không thể tạo hạng mục");
        throw itemsError;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating income expense:", error);
    },
  });
};

// Cập nhật phiếu thu/chi (chỉ khi UNAPPROVED)
export const useUpdateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateIncomeExpenseInput) => {
      const { id, data } = input;

      // 1. Update the voucher (only if UNAPPROVED)
      const { data: voucher, error: voucherError } = await supabase
        .from("income_expenses" as any)
        .update({
          type: data.type,
          name: data.name,
          building_id: data.building_id,
          room_id: data.room_id ?? null,
          tenant_id: data.tenant_id ?? null,
          payer_name: data.payer_name ?? null,
          account_id: data.account_id ?? null,
          attachments: data.attachments ?? [],
          business_result_accounting: data.business_result_accounting ?? false,
          voucher_date: data.voucher_date,
        })
        .eq("id", id)
        .select()
        .single();

      if (voucherError) {
        toast.error(voucherError.message || "Không thể cập nhật phiếu thu/chi");
        throw voucherError;
      }

      // 2. Delete existing items
      const { error: deleteError } = await supabase
        .from("income_expense_items" as any)
        .delete()
        .eq("income_expense_id", id);

      if (deleteError) {
        toast.error(deleteError.message || "Không thể xoá hạng mục cũ");
        throw deleteError;
      }

      // 3. Re-insert new items
      const itemsToInsert = data.items.map((item) => ({
        income_expense_id: id,
        income_expense_type_id: item.income_expense_type_id,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("income_expense_items" as any)
        .insert(itemsToInsert);

      if (itemsError) {
        toast.error(itemsError.message || "Không thể tạo hạng mục mới");
        throw itemsError;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating income expense:", error);
    },
  });
};

// Huỷ phiếu thu/chi: KHÔNG xoá, chỉ đổi trạng thái sang CANCELLED.
// Phiếu đã huỷ không được tính vào Tồn quỹ của tài khoản.
export const useCancelIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("income_expenses" as any)
        .update({ approval_status: "CANCELLED" })
        .eq("id", id);

      if (error) {
        toast.error(error.message || "Không thể huỷ phiếu thu/chi");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Phiếu đã được HUỶ");
    },
    onError: (error) => {
      console.error("Error cancelling income expense:", error);
    },
  });
};

// Import phiếu thu/chi hàng loạt từ Excel
export const useImportIncomeExpenses = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      rows: ImportIncomeExpenseRow[]
    ): Promise<{
      successCount: number;
      failedCount: number;
      errors: Array<{ row: number; message: string }>;
    }> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      let successCount = 0;
      let failedCount = 0;
      const errors: Array<{ row: number; message: string }> = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // 1. Create the voucher
          const { data: voucher, error: voucherError } = await supabase
            .from("income_expenses" as any)
            .insert({
              user_id: user.id,
              type: row.type,
              name: row.name,
              building_id: row.building_id,
              voucher_date: row.voucher_date,
            })
            .select()
            .single();

          if (voucherError) {
            failedCount++;
            errors.push({ row: i + 1, message: voucherError.message });
            continue;
          }

          // 2. Create the item
          const { error: itemError } = await supabase
            .from("income_expense_items" as any)
            .insert({
              income_expense_id: (voucher as any).id,
              income_expense_type_id: row.income_expense_type_id,
              description: row.item_name,
              quantity: 1,
              unit_price: row.amount,
            });

          if (itemError) {
            failedCount++;
            errors.push({ row: i + 1, message: itemError.message });
            continue;
          }

          successCount++;
        } catch (err: any) {
          failedCount++;
          errors.push({ row: i + 1, message: err.message || "Lỗi không xác định" });
        }
      }

      return { successCount, failedCount, errors };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      if (result.successCount > 0) {
        toast.success("Dữ liệu đã được TẠO thành công");
      }
      if (result.failedCount > 0 && result.successCount === 0) {
        toast.error(`Tất cả ${result.failedCount} phiếu đều lỗi`);
      }
    },
    onError: (error) => {
      console.error("Error importing income expenses:", error);
      toast.error("Không thể nhập dữ liệu từ Excel");
    },
  });
};

// =============================================
// PHIẾU THU/CHI TỔNG (BATCH)
// =============================================

export interface IncomeExpenseBatchSummary {
  id: string;
  user_id: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  payer_name: string | null;
  attachments: string[];
  notes: string | null;
  created_at: string;
  // Aggregated từ phiếu con (đều giống nhau giữa các phiếu trong batch):
  voucher_date: string | null;
  account_id: string | null;
  account_name: string | null;
  business_result_accounting: boolean;
  creator_name: string | null;
  // Tổng hợp:
  vouchers: IncomeExpenseWithRelations[];
  voucher_count: number;
  total_amount: number;
  building_names: string[];
  has_approved: boolean;
  all_cancelled: boolean;
}

// Tạo phiếu tổng = INSERT 1 batch + N phiếu con + N junction + N items.
export const useCreateIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: IncomeExpenseBatchFormValues) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1. INSERT batch metadata
      const { data: batch, error: batchError } = await supabase
        .from("income_expense_batches" as any)
        .insert({
          user_id: user.id,
          name: input.shared_name,
          type: input.type,
          payer_name: input.payer_name ?? null,
          attachments: input.attachments ?? [],
          notes: input.notes ?? null,
        })
        .select()
        .single();

      if (batchError || !batch) {
        toast.error(batchError?.message || "Không thể tạo phiếu tổng");
        throw batchError;
      }

      // 2. INSERT N phiếu con (denormalize metadata chung).
      //    Insert TỪNG phiếu để giữ thứ tự rõ ràng (tương ứng với items input).
      //    Nếu lỗi ở giữa: rollback bằng cách xoá batch (CASCADE xoá junction và batch_items).
      const childVouchers: any[] = [];
      try {
        for (const item of input.items) {
          const { data: voucher, error: voucherError } = await supabase
            .from("income_expenses" as any)
            .insert({
              user_id: user.id,
              creator_name: creatorName,
              type: input.type,
              name: `${input.shared_name} - ${item.type_name ?? ""}`.trim(),
              building_id: item.building_id,
              room_id: item.room_id ?? null,
              account_id: input.account_id,
              payer_name: input.payer_name ?? null,
              attachments: input.attachments ?? [],
              business_result_accounting: input.business_result_accounting ?? false,
              voucher_date: input.voucher_date,
              repeat_cycle: "NONE",
              repeat_infinity: false,
              repeat_count: 0,
              repeat_remaining: 0,
            })
            .select()
            .single();

          if (voucherError || !voucher) {
            throw voucherError ?? new Error("Không thể tạo phiếu con");
          }
          childVouchers.push(voucher);
        }

        // 3. INSERT items (1 item / phiếu vì mỗi hạng mục = 1 phiếu)
        const itemRows = input.items.map((item, idx) => ({
          income_expense_id: childVouchers[idx].id,
          income_expense_type_id: item.income_expense_type_id,
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        }));
        const { error: itemsError } = await supabase
          .from("income_expense_items" as any)
          .insert(itemRows);
        if (itemsError) throw itemsError;

        // 4. INSERT junction rows
        const linkRows = childVouchers.map((v) => ({
          batch_id: (batch as any).id,
          income_expense_id: v.id,
        }));
        const { error: linkError } = await supabase
          .from("income_expense_batch_items" as any)
          .insert(linkRows);
        if (linkError) throw linkError;
      } catch (err: any) {
        // Best-effort rollback: xoá batch (CASCADE xoá junction);
        // Phiếu con đã insert sẽ thành phiếu lẻ standalone — soft-delete chúng.
        if (childVouchers.length > 0) {
          const ids = childVouchers.map((v) => v.id);
          await supabase
            .from("income_expenses" as any)
            .update({ deleted_at: new Date().toISOString() })
            .in("id", ids);
        }
        await supabase
          .from("income_expense_batches" as any)
          .delete()
          .eq("id", (batch as any).id);
        toast.error(err?.message || "Không thể tạo phiếu tổng");
        throw err;
      }

      return { batch, voucherCount: childVouchers.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(`Đã tạo ${result.voucherCount} phiếu trong 1 đợt`);
    },
    onError: (error) => {
      console.error("Error creating income expense batch:", error);
    },
  });
};

// Danh sách phiếu tổng (group by batch_id)
export const useIncomeExpenseBatches = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string
) => {
  return useQuery({
    queryKey: [
      "income-expense-batches",
      "list",
      filters.area_id,
      filters.building_id,
      filters.account_id,
      filters.type,
      filters.start_date,
      filters.end_date,
      filters.approval_status,
      pagination.page,
      pagination.pageSize,
      searchQuery,
    ],
    queryFn: async (): Promise<{
      data: IncomeExpenseBatchSummary[];
      totalCount: number;
    }> => {
      // Lấy area → buildings nếu cần (dùng cho filter)
      let areaBuildingIds: string[] | null = null;
      if (filters.area_id) {
        const { data: areaBuildings } = await supabase
          .from("buildings" as any)
          .select("id")
          .eq("area_id", filters.area_id)
          .is("deleted_at", null);
        areaBuildingIds = (areaBuildings || []).map((b: any) => b.id);
        if (areaBuildingIds.length === 0) {
          return { data: [], totalCount: 0 };
        }
      }

      // 1. Lấy batches (kèm filter type nếu có)
      let batchQuery = supabase
        .from("income_expense_batches" as any)
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (filters.type) batchQuery = batchQuery.eq("type", filters.type);

      const { data: batches, error: batchError } = await batchQuery;
      if (batchError) {
        console.error("useIncomeExpenseBatches batch error:", batchError);
        return { data: [], totalCount: 0 };
      }
      if (!batches || batches.length === 0) {
        return { data: [], totalCount: 0 };
      }

      const batchIds = (batches as any[]).map((b: any) => b.id);

      // 2. Lấy junction rows
      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items" as any)
        .select("batch_id, income_expense_id")
        .in("batch_id", batchIds);
      if (linkError) {
        console.error("useIncomeExpenseBatches link error:", linkError);
        return { data: [], totalCount: 0 };
      }

      const voucherIds = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (voucherIds.length === 0) {
        // Có batch nhưng không có voucher con → không hiển thị
        return { data: [], totalCount: 0 };
      }

      // 3. Lấy phiếu con (kèm joins) + filter
      let voucherQuery = supabase
        .from("income_expenses" as any)
        .select(
          `
          *,
          building:buildings!income_expenses_building_id_fkey ( id, name ),
          room:rooms!income_expenses_room_id_fkey ( id, name ),
          tenant:tenants!income_expenses_tenant_id_fkey ( id, full_name ),
          account:accounts!income_expenses_account_id_fkey ( id, name )
        `
        )
        .is("deleted_at", null)
        .in("id", voucherIds);

      if (areaBuildingIds) voucherQuery = voucherQuery.in("building_id", areaBuildingIds);
      if (filters.building_id) voucherQuery = voucherQuery.eq("building_id", filters.building_id);
      if (filters.account_id) voucherQuery = voucherQuery.eq("account_id", filters.account_id);
      if (filters.start_date) voucherQuery = voucherQuery.gte("voucher_date", filters.start_date);
      if (filters.end_date) voucherQuery = voucherQuery.lte("voucher_date", filters.end_date);

      const { data: vouchers, error: voucherError } = await voucherQuery;
      if (voucherError) {
        console.error("useIncomeExpenseBatches voucher error:", voucherError);
        return { data: [], totalCount: 0 };
      }

      // 4. Lấy items của tất cả phiếu con
      const fetchedVoucherIds = ((vouchers ?? []) as any[]).map((v) => v.id);
      const { data: allItems } = await supabase
        .from("income_expense_items" as any)
        .select(
          `
          *,
          income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name )
        `
        )
        .in("income_expense_id", fetchedVoucherIds.length > 0 ? fetchedVoucherIds : ["__empty__"]);

      const itemsByVoucherId = new Map<string, IncomeExpenseItem[]>();
      for (const item of (allItems ?? []) as any[]) {
        const vId = item.income_expense_id;
        if (!itemsByVoucherId.has(vId)) itemsByVoucherId.set(vId, []);
        itemsByVoucherId.get(vId)!.push({
          id: item.id,
          income_expense_id: item.income_expense_id,
          income_expense_type_id: item.income_expense_type_id,
          type_name: item.income_expense_type?.name ?? "",
          description: item.description,
          quantity: item.quantity,
          unit_price: Number(item.unit_price),
          amount: Number(item.amount),
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        });
      }

      // 5. Map vouchers → IncomeExpenseWithRelations
      const voucherMap = new Map<string, IncomeExpenseWithRelations>();
      for (const v of (vouchers ?? []) as any[]) {
        voucherMap.set(v.id, {
          id: v.id,
          user_id: v.user_id,
          code: v.code,
          type: v.type,
          name: v.name,
          building_id: v.building_id,
          building_name: v.building?.name ?? "",
          room_id: v.room_id,
          room_name: v.room?.name ?? null,
          bed_id: v.bed_id,
          bed_name: v.bed?.name ?? null,
          tenant_id: v.tenant_id,
          tenant_name: v.tenant?.full_name ?? null,
          voucher_date: v.voucher_date,
          total_amount: Number(v.total_amount),
          approval_status: v.approval_status,
          approved_by: v.approved_by,
          approved_at: v.approved_at,
          notes: v.notes,
          payer_name: v.payer_name ?? null,
          account_id: v.account_id ?? null,
          account_name: v.account?.name ?? null,
          contract_id: v.contract_id ?? null,
          attachments: v.attachments ?? [],
          business_result_accounting: v.business_result_accounting ?? false,
          receive_bank_name: v.receive_bank_name ?? null,
          receive_bank_account: v.receive_bank_account ?? null,
          creator_name: v.creator_name ?? null,
          repeat_cycle: v.repeat_cycle ?? "NONE",
          repeat_infinity: !!v.repeat_infinity,
          repeat_count: Number(v.repeat_count ?? 0),
          repeat_remaining: Number(v.repeat_remaining ?? 0),
          repeat_next_date: v.repeat_next_date ?? null,
          repeat_parent_id: v.repeat_parent_id ?? null,
          items: itemsByVoucherId.get(v.id) ?? [],
          created_at: v.created_at,
          updated_at: v.updated_at,
        });
      }

      // 6. Group voucherIds theo batch
      const voucherIdsByBatch = new Map<string, string[]>();
      for (const link of (links ?? []) as any[]) {
        if (!voucherIdsByBatch.has(link.batch_id)) {
          voucherIdsByBatch.set(link.batch_id, []);
        }
        voucherIdsByBatch.get(link.batch_id)!.push(link.income_expense_id);
      }

      // 7. Build BatchSummary[] từ batches + vouchers
      const summaries: IncomeExpenseBatchSummary[] = [];
      for (const b of batches as any[]) {
        const vIds = voucherIdsByBatch.get(b.id) ?? [];
        const childVouchers = vIds
          .map((id) => voucherMap.get(id))
          .filter((v): v is IncomeExpenseWithRelations => !!v);

        if (childVouchers.length === 0) continue; // batch không có voucher hợp lệ sau filter → bỏ

        const total = childVouchers.reduce(
          (sum, v) => sum + (v.approval_status === "CANCELLED" ? 0 : v.total_amount),
          0
        );
        const buildings = Array.from(
          new Set(childVouchers.map((v) => v.building_name).filter(Boolean))
        );
        const allCancelled = childVouchers.every(
          (v) => v.approval_status === "CANCELLED"
        );
        const hasApproved = childVouchers.some(
          (v) => v.approval_status === "APPROVED"
        );

        const first = childVouchers[0];

        // Apply approval_status filter ở mức batch
        if (filters.approval_status === "APPROVED" && !hasApproved) continue;
        if (filters.approval_status === "CANCELLED" && !allCancelled) continue;

        summaries.push({
          id: b.id,
          user_id: b.user_id,
          name: b.name,
          type: b.type,
          payer_name: b.payer_name,
          attachments: b.attachments ?? [],
          notes: b.notes,
          created_at: b.created_at,
          voucher_date: first.voucher_date,
          account_id: first.account_id,
          account_name: first.account_name,
          business_result_accounting: first.business_result_accounting,
          creator_name: first.creator_name,
          vouchers: childVouchers,
          voucher_count: childVouchers.length,
          total_amount: total,
          building_names: buildings,
          has_approved: hasApproved,
          all_cancelled: allCancelled,
        });
      }

      // 8. Search client-side trên name + payer_name
      let filtered = summaries;
      if (searchQuery && searchQuery.trim().length > 0) {
        const q = searchQuery.trim().toLowerCase();
        filtered = summaries.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.payer_name && s.payer_name.toLowerCase().includes(q))
        );
      }

      // 9. Pagination
      const totalCount = filtered.length;
      const from = (pagination.page - 1) * pagination.pageSize;
      const paginated = filtered.slice(from, from + pagination.pageSize);

      return { data: paginated, totalCount };
    },
  });
};

// Huỷ tất cả phiếu con của 1 batch (1 click)
export const useCancelIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (batchId: string) => {
      // 1. Lấy danh sách voucher_id thuộc batch
      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items" as any)
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        toast.error(linkError.message || "Không thể đọc danh sách phiếu trong đợt");
        throw linkError;
      }
      const ids = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      // 2. UPDATE chuyển CANCELLED (chỉ với phiếu đang APPROVED)
      const { data, error } = await supabase
        .from("income_expenses" as any)
        .update({ approval_status: "CANCELLED" })
        .in("id", ids)
        .eq("approval_status", "APPROVED")
        .select("id");
      if (error) {
        toast.error(error.message || "Không thể huỷ phiếu trong đợt");
        throw error;
      }
      return { count: (data ?? []).length };
    },
    onSuccess: ({ count }) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(
        count === 0
          ? "Không còn phiếu nào trong đợt cần huỷ"
          : `Đã huỷ ${count} phiếu trong đợt`
      );
    },
    onError: (error) => {
      console.error("Error cancelling income expense batch:", error);
    },
  });
};

// (Workflow Duyệt/Bỏ duyệt đã bị loại bỏ — phiếu mặc định APPROVED khi tạo,
//  Huỷ thì set CANCELLED qua useCancelIncomeExpense.)

// Sinh các phiếu lặp lại tới hôm nay (RPC).
export const useGenerateRecurringVouchers = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");
      const { data, error } = await (supabase.rpc as any)(
        "generate_recurring_vouchers",
        { p_user_id: user.id }
      );
      if (error) {
        toast.error(error.message || "Không thể sinh phiếu lặp lại");
        throw error;
      }
      return (data ?? []) as Array<{ parent_id: string; child_id: string; voucher_date: string }>;
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(
        rows.length === 0
          ? "Không có phiếu lặp lại đến hạn"
          : `Đã sinh ${rows.length} phiếu lặp lại`
      );
    },
  });
};
