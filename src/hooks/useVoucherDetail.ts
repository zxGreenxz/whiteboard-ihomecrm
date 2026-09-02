// =============================================
// useVoucherWithBatch — chi tiết 1 phiếu thu/chi theo id + phiếu tổng (nếu phiếu
// nằm trong 1 đợt). Dùng cho trang /income-expense/voucher/:id (mở tab mới từ
// link "phiếu thu"): hiện chi tiết phiếu, và nếu thuộc đợt thì chia đôi khung
// kèm chi tiết phiếu tổng.
//
// Tự fetch + map giống useIncomeExpenses/useIncomeExpenseBatches (không tái dùng
// được vì 2 hook kia query theo bộ lọc danh sách, không theo 1 id).
// =============================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { jsonArray } from '@/lib/jsonValue';
import type {
  IncomeExpenseItem,
  IncomeExpenseWithRelations,
  IncomeExpenseBatchSummary,
} from '@/hooks/useIncomeExpenses';

const VOUCHER_SELECT = `
  *,
  building:buildings!income_expenses_building_id_fkey ( id, name ),
  room:rooms!income_expenses_room_id_fkey ( id, name ),
  tenant:tenants!income_expenses_tenant_id_fkey ( id, full_name ),
  account:accounts!income_expenses_account_id_fkey ( id, name )
`;

// Lấy items cho danh sách phiếu, group theo income_expense_id.
async function fetchItemsByVoucher(
  voucherIds: string[],
): Promise<Map<string, IncomeExpenseItem[]>> {
  const map = new Map<string, IncomeExpenseItem[]>();
  if (voucherIds.length === 0) return map;
  const { data } = await supabase
    .from('income_expense_items' as any)
    .select(
      `*, income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name, category, is_deposit )`,
    )
    .in('income_expense_id', voucherIds);
  for (const item of (data ?? []) as any[]) {
    const vId = item.income_expense_id;
    if (!map.has(vId)) map.set(vId, []);
    map.get(vId)!.push({
      id: item.id,
      income_expense_id: item.income_expense_id,
      income_expense_type_id: item.income_expense_type_id,
      type_name: item.income_expense_type?.name ?? '',
      category: item.income_expense_type?.category ?? null,
      is_deposit: !!item.income_expense_type?.is_deposit,
      description: item.description,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
      amount: Number(item.amount),
      start_date: item.start_date ?? null,
      end_date: item.end_date ?? null,
    });
  }
  return map;
}

function mapVoucherRow(
  v: any,
  itemsByVoucher: Map<string, IncomeExpenseItem[]>,
): IncomeExpenseWithRelations {
  return {
    id: v.id,
    user_id: v.user_id,
    organization_id: v.organization_id ?? null,
    posting_mode: v.posting_mode ?? null,
    posting_status: v.posting_status ?? null,
    review_state: v.review_state ?? null,
    approval_version: Number(v.approval_version ?? 1),
    posting_version: Number(v.posting_version ?? 1),
    code: v.code,
    type: v.type,
    name: v.name,
    building_id: v.building_id,
    building_name: v.building?.name ?? '',
    room_id: v.room_id,
    room_name: v.room?.name ?? null,
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
    account_is_virtual: v.account?.is_virtual ?? null,
    system_source: v.system_source ?? null,
    commission_kind:
      v.commission_kind === 'broker' || v.commission_kind === 'sale'
        ? v.commission_kind
        : null,
    shareholder_id: v.shareholder_id ?? null,
    contract_id: v.contract_id ?? null,
    invoice_id: v.invoice_id ?? null,
    attachments: v.attachments ?? [],
    business_result_accounting: v.business_result_accounting ?? null,
    counts_in_business_result: v.counts_in_business_result ?? true,
    kqkd_amount: Number(v.kqkd_amount ?? v.total_amount) || 0,
    receive_bank_name: v.receive_bank_name ?? null,
    receive_bank_account: v.receive_bank_account ?? null,
    creator_name: v.creator_name ?? null,
    repeat_cycle: v.repeat_cycle ?? 'NONE',
    repeat_infinity: !!v.repeat_infinity,
    repeat_count: Number(v.repeat_count ?? 0),
    repeat_remaining: Number(v.repeat_remaining ?? 0),
    repeat_next_date: v.repeat_next_date ?? null,
    repeat_parent_id: v.repeat_parent_id ?? null,
    verified_at: v.verified_at ?? null,
    verified_by: v.verified_by ?? null,
    verified_by_name: v.verified_by_name ?? null,
    verified_note: v.verified_note ?? null,
    items: itemsByVoucher.get(v.id) ?? [],
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

export interface VoucherWithBatch {
  voucher: IncomeExpenseWithRelations | null;
  batch: IncomeExpenseBatchSummary | null;
}

export const useVoucherWithBatch = (voucherId?: string) => {
  return useQuery({
    queryKey: ['voucher-with-batch', voucherId],
    enabled: !!voucherId,
    queryFn: async (): Promise<VoucherWithBatch> => {
      if (!voucherId) return { voucher: null, batch: null };

      // 1. Phiếu chính
      const { data: vRow, error } = await supabase
        .from('income_expenses')
        .select(VOUCHER_SELECT)
        .eq('id', voucherId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      if (!vRow) return { voucher: null, batch: null };

      const mainItems = await fetchItemsByVoucher([voucherId]);
      const voucher = mapVoucherRow(vRow, mainItems);

      // 2. Phiếu này có thuộc đợt (phiếu tổng) nào không?
      const { data: link } = await supabase
        .from('income_expense_batch_items')
        .select('batch_id')
        .eq('income_expense_id', voucherId)
        .maybeSingle();
      const batchId: string | null = link?.batch_id ?? null;
      if (!batchId) return { voucher, batch: null };

      // 3. Đợt + các phiếu con
      const { data: bRow } = await supabase
        .from('income_expense_batches')
        .select('*')
        .eq('id', batchId)
        .is('deleted_at', null)
        .maybeSingle();
      if (!bRow) return { voucher, batch: null };

      const { data: links } = await supabase
        .from('income_expense_batch_items')
        .select('income_expense_id')
        .eq('batch_id', batchId);
      const siblingIds = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (siblingIds.length === 0) return { voucher, batch: null };

      const { data: siblingRows } = await supabase
        .from('income_expenses')
        .select(VOUCHER_SELECT)
        .in('id', siblingIds)
        .is('deleted_at', null);
      const siblingItems = await fetchItemsByVoucher(siblingIds);
      const childVouchers = ((siblingRows ?? []) as any[])
        .map((r) => mapVoucherRow(r, siblingItems))
        // Giữ thứ tự ổn định: theo mã phiếu.
        .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '', 'vi', { numeric: true }));

      if (childVouchers.length === 0) return { voucher, batch: null };

      const total = childVouchers.reduce(
        (s, v) => s + (v.approval_status === 'CANCELLED' ? 0 : v.total_amount),
        0,
      );
      const buildings = Array.from(
        new Set(childVouchers.map((v) => v.building_name).filter(Boolean)),
      );
      const first = childVouchers[0];

      const batch: IncomeExpenseBatchSummary = {
        id: bRow.id,
        user_id: bRow.user_id,
        name: bRow.name,
        // Cột `type` trong DB là text tự do; kiểu ở FE là union hai giá trị. Ép
        // thẳng sẽ nuốt mọi giá trị lạ (viết hoa khác, chuỗi rỗng, giá trị mới
        // thêm ở migration sau) và đẩy nó vào UI như thể hợp lệ. Kiểm tại đây và
        // ngã về EXPENSE — phiếu chi là mặc định AN TOÀN: hiển thị nhầm một
        // khoản thu thành chi thì người dùng thấy ngay, còn ngược lại thì một
        // khoản chi lạ trông như tiền vào.
        type: bRow.type === "INCOME" ? "INCOME" : "EXPENSE",
        payer_name: bRow.payer_name,
        // `attachments` là cột jsonb ⇒ kiểu sinh ra là Json, không phải string[].
        // Lọc lấy đúng phần tử chuỗi thay vì khẳng định suông: một phần tử rác
        // trong mảng sẽ thành `undefined` ở chỗ render và vỡ ở nơi khác.
        attachments: jsonArray({ a: bRow.attachments }, "a").filter(
          (x): x is string => typeof x === "string",
        ),
        notes: bRow.notes,
        created_at: bRow.created_at,
        voucher_date: first.voucher_date,
        account_id: first.account_id,
        account_name: first.account_name,
        business_result_accounting: first.business_result_accounting,
        creator_name: first.creator_name,
        vouchers: childVouchers,
        voucher_count: childVouchers.length,
        total_amount: total,
        building_names: buildings,
        has_approved: childVouchers.some((v) => v.approval_status === 'APPROVED'),
        all_cancelled: childVouchers.every((v) => v.approval_status === 'CANCELLED'),
      };

      return { voucher, batch };
    },
  });
};
