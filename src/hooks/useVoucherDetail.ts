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

  // 3. Đợt + các phiếu con
  const { data: bRow, error: batchError } = await supabase
    .from('income_expense_batches')
    .select('*')
    .eq('id', batchId)
    .is('deleted_at', null)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!bRow) return { voucher, batch: null };

  const links = await fetchAllRows<{income_expense_id:string}>((from,to)=>supabase.from("income_expense_batch_items").select("income_expense_id").eq("batch_id",batchId).order("income_expense_id").range(from,to),{label:"voucher-batch-links"});
  if (!links) throw new Error("Không tải được liên kết phiếu tổng.");
  const siblingIds = links.map(link=>link.income_expense_id);
  if (!voucher.organization_id) throw new Error("Phiếu thiếu tổ chức.");
  const childVouchers = await hydrateIncomeExpenseSupplements(await hydrateReservationCreators(await hydrateIncomeExpenseDetailRelations(await loadIncomeExpenseDetails(voucher.organization_id,siblingIds))));
  childVouchers.sort((a,b)=>a.code.localeCompare(b.code,"vi",{numeric:true}));

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
}
