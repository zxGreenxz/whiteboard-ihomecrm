// =============================================
// useVoucherWithBatch — chi tiết 1 phiếu thu/chi theo id + phiếu tổng (nếu phiếu
// nằm trong 1 đợt). Dùng cho trang /income-expense/voucher/:id (mở tab mới từ
// link "phiếu thu"): hiện chi tiết phiếu, và nếu thuộc đợt thì chia đôi khung
// kèm chi tiết phiếu tổng.
//
// Tự fetch + map giống useIncomeExpenses/useIncomeExpenseBatches (không tái dùng
// được vì 2 hook kia query theo bộ lọc danh sách, không theo 1 id).
// =============================================

import { loadIncomeExpenseDetail, loadIncomeExpenseDetails, hydrateIncomeExpenseDetailRelations, withDetailReadDeadline } from "@/hooks/income-expenses/detailRead";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { jsonArray } from '@/lib/jsonValue';
import { hydrateReservationCreators } from '@/hooks/income-expenses/reservationCreators';
import { hydrateIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import type {
  IncomeExpenseWithRelations,
  IncomeExpenseBatchSummary,
} from '@/hooks/useIncomeExpenses';

export interface VoucherWithBatch {
  voucher: IncomeExpenseWithRelations | null;
  batch: IncomeExpenseBatchSummary | null;
}

export const useVoucherWithBatch = (voucherId?: string) => {
  return useQuery({
    queryKey: ['voucher-with-batch', voucherId],
    enabled: !!voucherId,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
    // Đọc kẹt ⇒ lỗi + Thử lại sau 20 giây như phiếu lẻ (chủ chốt 30/09/2026), không quay mãi.
    queryFn: () => withDetailReadDeadline(loadVoucherWithBatch(voucherId)),
    // Màn đợt và trang phiếu riêng tự hiện lỗi + Thử lại; toast chung chỉ che nút.
    meta: { silent: true },
  });
};

async function loadVoucherWithBatch(voucherId: string | undefined): Promise<VoucherWithBatch> {
  if (!voucherId) return { voucher: null, batch: null };

  const voucher = await loadIncomeExpenseDetail(voucherId);
  if (!voucher) return { voucher: null, batch: null };

  // 2. Phiếu này có thuộc đợt (phiếu tổng) nào không?
  const { data: link, error: linkError } = await supabase
    .from('income_expense_batch_items')
    .select('batch_id')
    .eq('income_expense_id', voucherId)
    .maybeSingle();
  if (linkError) throw linkError;
  const batchId: string | null = link?.batch_id ?? null;
  if (!batchId) return { voucher, batch: null };

  if (!voucher.organization_id) throw new Error("Phiếu thiếu tổ chức.");
  const batch = await loadIncomeExpenseBatch(batchId, voucher.organization_id);
  if (batch && !batch.voucher_ids?.includes(voucher.id)) throw new Error("Phiếu vừa chuyển khỏi đợt. Vui lòng tải lại.");
  return { voucher, batch };
}

/** Read the complete, unfiltered membership through the existing organization RLS. */
async function readIncomeExpenseBatch(batchId: string, organizationId: string) {
  if (!organizationId) throw new Error("Chưa xác định công ty của phiếu tổng.");
  const { data: bRow, error: batchError } = await supabase
    .from('income_expense_batches')
    .select('*')
    .eq('id', batchId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!bRow) return null;
  if (bRow.organization_id !== organizationId || (bRow.type !== 'EXPENSE' && bRow.type !== 'INCOME')) throw new Error("Thông tin phiếu tổng không hợp lệ.");

  const links = await fetchAllRows<{income_expense_id:string}>((from,to)=>supabase.from("income_expense_batch_items").select("income_expense_id").eq("batch_id",batchId).order("income_expense_id").range(from,to),{label:"voucher-batch-links"});
  if (!links) throw new Error("Không tải được liên kết phiếu tổng.");
  const siblingIds = links.map(link=>link.income_expense_id);
  if (new Set(siblingIds).size !== siblingIds.length) throw new Error("Danh sách phiếu con bị trùng. Vui lòng tải lại.");
  return { row: bRow, voucher_ids: siblingIds };
}

export async function readIncomeExpenseBatchMembership(batchId: string, organizationId: string) {
  const data = await readIncomeExpenseBatch(batchId, organizationId);
  return data ? { id: data.row.id, organization_id: data.row.organization_id, type: data.row.type, voucher_ids: data.voucher_ids } : null;
}

export async function loadIncomeExpenseBatch(batchId: string, organizationId: string): Promise<IncomeExpenseBatchSummary | null> {
  const data = await readIncomeExpenseBatch(batchId, organizationId);
  if (!data || !data.voucher_ids.length) return null;
  const { row: bRow, voucher_ids: siblingIds } = data;
  const childVouchers = await hydrateIncomeExpenseSupplements(await hydrateReservationCreators(await hydrateIncomeExpenseDetailRelations(await loadIncomeExpenseDetails(organizationId,siblingIds))));
  childVouchers.sort((a,b)=>a.code.localeCompare(b.code,"vi",{numeric:true}));

  if (childVouchers.length !== siblingIds.length) throw new Error("Chưa tải đủ toàn bộ phiếu trong đợt.");

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
    organization_id: bRow.organization_id,
    voucher_ids: siblingIds,
    user_id: bRow.user_id,
    name: bRow.name,
    // readIncomeExpenseBatch đã từ chối các giá trị ngoài hai loại hợp lệ.
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

  return batch;
}
