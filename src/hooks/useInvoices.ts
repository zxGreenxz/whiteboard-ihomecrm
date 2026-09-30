import {useRef} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadNumber,financialReadRows} from '@/lib/financialReadValidation';
import {runFinancialPending} from '@/lib/financialPendingAction';
import { voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { invoiceFailureMessage, invoiceLabel, invoiceLifecycleFeedback, confirmedInvoiceReceipt, InvoicePartialError } from '@/lib/invoiceFeedback';
// =============================================
// Invoice Module Hooks (Reimplemented)
// TanStack Query hooks for invoice CRUD, approval, statistics, and excess amounts.
// Uses new schema with billing_month (YYYY-MM) and building_id on invoices.
// =============================================

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { getSessionUser } from "@/lib/authSession";
import { readContractCreditBalance } from '@/lib/contractCreditBalance';
import { isCanonicalFallbackSignal } from '@/lib/canonicalFallback';
import { useToast } from '@/hooks/use-toast';
import type { PaginatedData } from '@/hooks/usePagination';
import type {
  InvoiceWithRelations,
  InvoiceFilters,
  InvoiceFormData,
  InvoiceFormItem,
  InvoiceStatus,
  InvoiceAdjustment,
} from '@/types/invoice';
import {
  getInvoiceEditMode,
  canCancelInvoice,
  roundInvoiceTotal,
  getInvoiceTitle,
  isFirstMonthInvoice,
} from '@/lib/invoiceUtils';
import { AMOUNT_SEARCH_TOLERANCE } from '@/lib/roomCodeSearch';
import { markLocalWrite } from '@/hooks/useRealtimeDataSync';
import { useOrganization } from '@/contexts/OrganizationContext';
import { withOrg, withOrgAll } from '@/lib/orgPayload';
import { todayISO } from '@/lib/collect';
import {
  buildCreditInvoiceCreateRpcArgs,
  capInvoiceCreditApplication,
  buildInvoiceCreditLifecycleRpcArgs,
  invokeCustomerCreditRpc,
  prepareCustomerCreditRequest,
  selectInvoiceCreateRpc,
} from '@/lib/customerCreditRpc';

// Re-export types for backward compatibility
export type { InvoiceWithRelations, InvoiceFilters } from '@/types/invoice';

export type { AdjustInvoiceInput } from '@/lib/invoiceAdjustmentRpc';
import { adjustInvoice, reviewInvoiceAdjustment, type AdjustInvoiceInput, type ReviewAdjustmentInput } from '@/lib/invoiceAdjustmentRpc';

// 15/09 (plan con B): 16 tiền tố cũ ở đây là lượt ĐÁNH THỨ NHẤT, rồi ~0,8s sau
// hub realtime nhận event `invoices` và đánh lượt THỨ HAI trên gần đúng tập ấy
// (descriptor src/hooks/realtime/finance.ts phủ invoices, invoices-legacy,
// invoice, invoice-statistics, invoice-totals-by-ids, first-invoice-details,
// invoice-rent-periods, unpaid-invoices, business-performance) rồi prefetch lại
// cả domain hoá đơn. Giữ lại ở đây đúng bốn TỔNG HỢP mà hub không khai — phần
// còn lại để hub lo, và markLocalWrite bên dưới ép lượt đó gộp về một.
//
// Hai tiền tố bị BỎ HẲN, có lý do chứ không phải cắt bừa:
//   - `financial-analysis`: không query nào dùng tiền tố này, nó chỉ tồn tại
//     trong các mảng invalidate. Cùng lớp "khoá trỏ hư không" đã đính chính ở
//     src/hooks/realtime/contracts.ts — invalidate khớp 0 query rồi im lặng.
//   - `finance-v2-routes`: cấu hình chuẩn mực kế toán của tổ chức; điều chỉnh
//     một hoá đơn không đụng tới nó.
const adjustmentAggregatePrefixes = [
  'excess-amount', 'invoice-rounding-report', 'invoice-payments-summary', 'collection-cycle',
];
export const useAdjustInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<InvoiceAdjustment, Error, AdjustInvoiceInput>({
    mutationFn: adjustInvoice,
    onSuccess: (adjustment, variables) => {
      // Theo ĐÚNG hoá đơn vừa sửa: màn đang mở phải đổi ngay, không đợi debounce
      // 800ms của hub. RPC luôn trả invoice_id; giữ input làm đường lùi.
      const invoiceId = adjustment?.invoice_id ?? variables.invoiceId;
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      void queryClient.invalidateQueries({ queryKey: ['invoice-history', invoiceId] });
      for (const prefix of adjustmentAggregatePrefixes) void queryClient.invalidateQueries({ queryKey: [prefix] });
      markLocalWrite(['invoices']);
      toast({ title: 'Đã lưu điều chỉnh', description: 'Đã cập nhật hóa đơn và lưu lịch sử phiên bản.' });
    },
  });
};
export const useReviewInvoiceAdjustment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<InvoiceAdjustment, Error, ReviewAdjustmentInput>({
    mutationFn: reviewInvoiceAdjustment,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice-history'] });
      toast({ title: 'Đã xác nhận kiểm tra' });
    },
  });
};

export interface UpdateInvoiceData {
  id: string;
  formData: InvoiceFormData;
}

// =============================================
// Shared select string for invoice queries
// =============================================

const INVOICE_LIST_SELECT = `
  *,
  contract:contracts!invoices_contract_id_fkey (
    id, contract_number, status, public_code, start_billing_date,
    contract_customers!contract_customers_contract_id_fkey (
      id, is_representative,
      customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
    )
  ),
  building:buildings!invoices_building_id_fkey (id, name, name_sort, default_account_id_tt, default_account_id_tk),
  room:rooms!invoices_room_id_fkey (id, name, name_sort),
  invoice_items (id, type, accounting_class, description, unit_price, quantity, coefficient, amount, service_id, previous_reading, current_reading, from_date, to_date, sort_order),
  payments (id, amount, payment_date, payment_method, notes, receipt_image_url, collection_id, reversed_at)
  ,invoice_adjustments (id, organization_id, invoice_id, revision, idempotency_key, reason, before_snapshot, after_snapshot, before_total, after_total, delta, adjusted_by, adjusted_at, review_status, checked_by, checked_at)
`;

// =============================================
// Pagination params
// =============================================

export interface InvoicePaginationParams {
  page?: number;
  pageSize?: number;
}

// =============================================
// useInvoices - Query invoices with pagination and filters
// Requirements: 10.2, 10.4, 10.5, 13.7
// =============================================

// Options factory dùng chung cho hook + prefetch (src/lib/prefetchPages.ts)
// để queryKey/queryFn chỉ có 1 nguồn — prefetch lệch key là vô dụng.
export const invoicesListQuery = (
  filters?: InvoiceFilters,
  pagination?: InvoicePaginationParams,
) => ({
    queryKey: ['invoices', filters, pagination] as const,
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5' hay bị GC trước khi bấm)
    queryFn: async (): Promise<PaginatedData<InvoiceWithRelations>> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Sort mặc định: KỲ mới nhất trước (toàn bộ HĐ tháng 7 → tháng 6 → ...),
      // trong cùng kỳ xếp như mục Thu của Phân bổ LN: tòa A→Z → phòng
      // (MB→G→L→số, so tự nhiên). name_sort = generated column mirror của
      // src/lib/roomSort.ts (migration 20260702100000). Phải order server-side
      // vì phân trang server-side (mỗi trang chỉ fetch 20 dòng).
      // Method drill-down starts from a SECURITY INVOKER table-valued RPC.
      // PostgREST can still apply all filters/count/range to SETOF invoices,
      // while the EXISTS stays server-side and cannot hit the 1000-row cap.
      const invoiceSource = filters?.payment_method
        ? supabase.rpc('invoice_payment_method_drilldown', {
            p_payment_method: filters.payment_method,
          })
        : supabase.from('invoices');

      let query = (invoiceSource
        .select(INVOICE_LIST_SELECT, { count: 'exact' }) as any)
        .is('deleted_at', null)
        .order('billing_month', { ascending: false })
        .order('building(name_sort)', { ascending: true, nullsFirst: false })
        .order('room(name_sort)', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters?.building_ids?.length) {
        query = query.in('building_id', filters.building_ids);
      } else if (filters?.building_id) {
        query = query.eq('building_id', filters.building_id);
      }
      if (filters?.room_ids?.length) {
        query = query.in('room_id', filters.room_ids);
      } else if (filters?.room_id) {
        query = query.eq('room_id', filters.room_id);
      }
      if (filters?.contract_id) {
        query = query.eq('contract_id', filters.contract_id);
      }
      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.payment_status === 'paid') {
        query = query.eq('status', 'PAID');
      } else if (filters?.payment_status === 'partial') {
        query = query.eq('status', 'PARTIAL_PAID');
      } else if (filters?.payment_status === 'unpaid') {
        // Chưa thu đồng nào → loại cả PAID lẫn PARTIAL_PAID.
        query = query.not('status', 'in', '(PAID,PARTIAL_PAID)');
      }
      // Vòng đời HĐ — mặc định 'active': ẩn các HĐ đã huỷ. Đặt SAU các filter
      // status/payment_status để không bị override khi user chọn cụ thể.
      const viewStatus = filters?.view_status ?? 'active';
      if (viewStatus === 'active' && !filters?.status) {
        query = query.neq('status', 'CANCELLED');
      } else if (viewStatus === 'cancelled') {
        query = query.eq('status', 'CANCELLED');
      }
      if (filters?.billing_month) {
        query = query.eq('billing_month', filters.billing_month);
      }
      if (filters?.date_range?.start) {
        query = query.gte('issue_date', filters.date_range.start);
      }
      if (filters?.date_range?.end) {
        query = query.lte('issue_date', filters.date_range.end);
      }

      // Lọc theo số tiền (±tolerance) — suy từ ô tìm kiếm khi người dùng gõ số.
      if (filters?.amount_target != null) {
        query = query
          .gte('total_amount', filters.amount_target - AMOUNT_SEARCH_TOLERANCE)
          .lte('total_amount', filters.amount_target + AMOUNT_SEARCH_TOLERANCE);
      }

      // Tìm theo text: số HĐ (invoice_number) HOẶC tên khách. Tên khách nằm ở
      // bảng join (contract → contract_customers → customers) nên resolve trước
      // customer_id khớp tên → contract_id rồi OR vào điều kiện.
      if (filters?.search?.trim()) {
        const q = filters.search.trim().replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim();
        if (q) {
          const { data: custRows } = await supabase
            .from('customers')
            .select('id')
            .ilike('full_name', `%${q}%`)
            .limit(200);
          const custIds = ((custRows || []) as any[]).map((c) => c.id);
          let contractIds: string[] = [];
          if (custIds.length > 0) {
            const { data: ccRows } = await supabase
              .from('contract_customers')
              .select('contract_id')
              .in('customer_id', custIds);
            contractIds = Array.from(
              new Set(((ccRows || []) as any[]).map((r) => r.contract_id).filter(Boolean))
            );
          }
          const ors = [`invoice_number.ilike.%${q}%`];
          if (contractIds.length > 0) {
            ors.push(`contract_id.in.(${contractIds.join(',')})`);
          }
          query = query.or(ors.join(','));
        }
      }

      if (filters?.adjustment_review_status) {
        query = query.eq('adjustment_review_status', filters.adjustment_review_status === 'pending' ? 'PENDING' : 'CHECKED');
      }

      // Apply pagination
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        // KHÔNG nuốt lỗi: throw để React Query vào isError + retry. Trước đây
        // return {data:[]} khiến trang hiện "Chưa có hoá đơn" GIẢ khi RLS/timeout/5xx.
        console.error('useInvoices error:', error);
        throw error;
      }

      const invoiceRows = financialReadRows(data as InvoiceWithRelations[] | null).map((invoice) => ({
        ...invoice,
        payments: (invoice.payments ?? []).filter(
          (payment) => !(payment as typeof payment & { reversed_at?: string | null }).reversed_at,
        ),
      }));

      if (invoiceRows.length > 0) {
        const { data: methodRows, error: methodError } = await supabase.rpc(
          'invoice_active_payment_methods',
          { p_invoice_ids: invoiceRows.map((invoice) => invoice.id) },
        );
        if (!methodError) {
          const methodsByInvoice = new Map<string, string[]>();
          for (const row of (methodRows ?? []) as Array<{
            invoice_id: string;
            payment_methods: string[] | null;
          }>) {
            methodsByInvoice.set(row.invoice_id, row.payment_methods ?? []);
          }
          return {
            data: invoiceRows.map((invoice) => ({
              ...invoice,
              active_payment_methods: methodsByInvoice.get(invoice.id) ?? [],
            })) as InvoiceWithRelations[],
            count: count || 0,
          };
        }
        // Highlight enrichment is non-critical; keep the paginated invoice list
        // available and fall back to its active embedded payment rows.
        console.error('invoice_active_payment_methods error:', methodError);
      }

      return { data: invoiceRows as InvoiceWithRelations[], count: count || 0 };
    },
  });

export const useInvoices = (
  filters?: InvoiceFilters,
  pagination?: InvoicePaginationParams,
) => {
  return useQuery({
    ...invoicesListQuery(filters, pagination),
    // Giữ trang cũ khi đổi filter/search/trang để bảng không nhảy về "Đang tải".
    placeholderData: keepPreviousData,
  });
};

// Legacy hook for backwards compatibility (returns array directly)
export const useInvoicesLegacy = (filters?: {
  status?: string;
  contract_id?: string;
}) => {
  return useQuery({
    queryKey: ['invoices-legacy', filters],
    queryFn: async (): Promise<InvoiceWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      let query = (supabase
        .from('invoices')
        .select(INVOICE_LIST_SELECT) as any)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.contract_id && filters.contract_id !== 'create') {
        query = query.eq('contract_id', filters.contract_id);
      }

      const { data, error } = await query;
      if (error) {
        console.error('useInvoicesLegacy error:', error);
        throw error;
      }
      return financialReadRows(data as InvoiceWithRelations[] | null);
    },
  });
};

// =============================================
// useInvoice - Query single invoice with relations
// Requirements: 1.12, 3.1
// =============================================

export const useInvoice = (invoiceId?: string) => {
  return useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async (): Promise<InvoiceWithRelations | null> => {
      if (!invoiceId) return null;

      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await (supabase
        .from('invoices')
        .select(INVOICE_LIST_SELECT) as any)
        .eq('id', invoiceId)
        .is('deleted_at', null)
        .single();

      if (error) throw error;
      if(!data || data.id!==invoiceId)throw new TypeError('Chưa đọc được hóa đơn cần xem.');
      return {...data,total_amount:financialReadNumber(data.total_amount),paid_amount:financialReadNumber(data.paid_amount)} as InvoiceWithRelations;
    },
    enabled: !!invoiceId,
  });
};

// =============================================
// useInvoiceTotalsByIds — lấy GỌN tổng/đã trả/còn lại của nhiều hoá đơn theo id.
// Dùng cho báo cáo gộp khoản thu theo hoá đơn (note thiếu/thừa so với HĐ) —
// chỉ cần vài cột số, không kéo cả quan hệ như useInvoice.
// =============================================

export interface InvoiceTotalLite {
  id: string;
  total_amount: number;
  paid_amount: number;
  remaining_amount: number;
  // Tên hoá đơn KHÔNG kèm phòng/toà (getInvoiceTitle trên bản ghi thiếu quan hệ
  // room/building) — cột Thu bên BC Lợi Nhuận hiện đúng tên như trang /invoices
  // nhưng gọn (phòng đã có cột riêng). Vd "TIỀN PHÒNG THÁNG ĐẦU TIÊN - 05/2026".
  displayTitle: string;
}

export const useInvoiceTotalsByIds = (ids: string[]) => {
  // Dedupe + sort để queryKey ổn định (không refetch oan khi thứ tự đổi).
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['invoice-totals-by-ids', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, InvoiceTotalLite>> => {
      const map = new Map<string, InvoiceTotalLite>();
      // Chunk để tránh URL .in() quá dài (PostgREST 400 khi danh sách id lớn).
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('invoices')
          .select(
            `id, total_amount, paid_amount, remaining_amount,
             kind, billing_month, notes, issue_date,
             contract:contracts!invoices_contract_id_fkey (start_billing_date),
             invoice_items (type, from_date)`,
          )
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const row of financialReadRows(data as any[] | null)) {
          map.set(row.id, {
            id: row.id,
            total_amount: financialReadNumber(row.total_amount),
            paid_amount: financialReadNumber(row.paid_amount),
            remaining_amount: financialReadNumber(row.remaining_amount),
            // Không select room/building → title tự rớt phần "<phòng>/<toà>".
            displayTitle: getInvoiceTitle(row),
          });
        }
      }
      return map;
    },
  });
};

// =============================================
// useFirstInvoiceDetails — chi tiết "hoá đơn tháng đầu" (HĐ tự sinh khi ký HĐ).
// Cho mỗi invoice id, NẾU nó là hoá đơn tháng đầu của hợp đồng — nhận diện theo:
//   • kỳ tiền phòng (item RENT) bắt đầu ĐÚNG contracts.start_billing_date, HOẶC
//   • notes tự động chứa "… tháng đầu" (fallback cho HĐ thiếu start_billing_date)
// thì trả về:
//   • kỳ tiền phòng (from→to của item RENT)
//   • đã thu / tổng của hoá đơn (paid_amount / total_amount)
//   • cọc đã đóng / tổng cọc (contracts.deposit_paid / total_deposit)
// Dùng cho trang Phân bổ lợi nhuận + dialog "Các lần thanh toán".
// Invoice KHÔNG phải tháng đầu sẽ không có trong map.
// =============================================

export interface FirstInvoiceDetail {
  invoiceId: string;
  contractId: string | null;
  rentFrom: string | null;
  rentTo: string | null;
  // Tiền phòng + dịch vụ = total hoá đơn TRỪ phần cọc gộp trong hoá đơn (item
  // OTHER "Tiền cọc" — thiết kế hiện hành GỘP cọc còn thiếu vào HĐ tháng đầu).
  // Quy ước PHÒNG-TRƯỚC (khớp allocateDepositPortion): tiền thu phủ phần
  // phòng/DV trước, cọc sau cùng.
  rentServicePaid: number;
  rentServiceTotal: number;
  invoicePaid: number;
  invoiceTotal: number;
  depositPaid: number;
  depositTotal: number;
  // Phần cọc nằm NGAY TRONG hoá đơn này (item OTHER "Tiền cọc"); 0 với HĐ mới.
  depositInInvoice: number;
}

// Item cọc bị nhồi vào hoá đơn (HĐ cũ): luôn là type OTHER mô tả "Tiền cọc".
function depositAmountInInvoice(items: any[]): number {
  return (items ?? []).reduce((sum, it) => {
    if (it?.type !== 'OTHER') return sum;
    const raw = String(it?.description ?? '').toLowerCase();
    const norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const isCoc = raw.includes('cọc') || raw.includes('cược') || norm.includes('coc');
    return isCoc ? sum + financialReadNumber(it.amount) : sum;
  }, 0);
}

export const useFirstInvoiceDetails = (ids: string[]) => {
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['first-invoice-details', sortedIds],
    meta:{errorDisplay:"inline",label:"chi tiết hoá đơn đầu"},
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, FirstInvoiceDetail>> => {
      const map = new Map<string, FirstInvoiceDetail>();
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('invoices')
          .select(
            `id, total_amount, paid_amount, notes,
             contract:contracts!invoices_contract_id_fkey (id, start_billing_date, total_deposit, deposit_paid),
             invoice_items (type, description, from_date, to_date, amount)`,
          )
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const inv of financialReadRows(data as any[] | null)) {
          const items = financialReadRows(inv.invoice_items as any[] | null);
          // Item RENT có from_date sớm nhất là dòng tiền phòng tháng đầu.
          const rent =
            items
              .filter((it) => it.type === 'RENT' && it.from_date)
              .sort((a, b) =>
                String(a.from_date).localeCompare(String(b.from_date)),
              )[0] ??
            items.find((it) => it.type === 'RENT') ??
            null;
          const contract = inv.contract ?? null;
          // Nhận diện dùng CHUNG với tên hoá đơn "TIỀN PHÒNG THÁNG ĐẦU TIÊN"
          // (isFirstMonthInvoice): notes "tháng đầu"/"đầu tiên" HOẶC kỳ RENT
          // bắt đầu đúng contracts.start_billing_date.
          if (!isFirstMonthInvoice(inv)) continue;
          const invoiceTotal = financialReadNumber(inv.total_amount);
          const invoicePaid = financialReadNumber(inv.paid_amount);
          // Bỏ phần cọc gộp trong HĐ → còn tiền phòng + dịch vụ (đã trừ giảm
          // trừ). Quy ước PHÒNG-TRƯỚC: tiền thu phủ phần phòng/dịch vụ TRƯỚC,
          // cọc sau — KHỚP với phân bổ hạng mục lúc thu (allocateDepositPortion).
          const depositInInvoice = depositAmountInInvoice(items);
          const rentServiceTotal = Math.max(0, invoiceTotal - depositInInvoice);
          const rentServicePaid = Math.max(0, Math.min(invoicePaid, rentServiceTotal));
          map.set(inv.id, {
            invoiceId: inv.id,
            contractId: contract?.id ?? null,
            rentFrom: rent?.from_date ?? null,
            rentTo: rent?.to_date ?? null,
            rentServicePaid,
            rentServiceTotal,
            invoicePaid,
            invoiceTotal,
            depositPaid: contract ? financialReadNumber(contract.deposit_paid) : 0,
            depositTotal: contract ? financialReadNumber(contract.total_deposit) : 0,
            depositInInvoice,
          });
        }
      }
      return map;
    },
  });
};

// =============================================
// useInvoiceRentPeriods — kỳ tiền phòng (from→to) của hạng mục RENT bị PRORATE
// (hoá đơn KHÔNG đủ ngày: khách vào/rời giữa tháng). Hệ chỉ set from_date/to_date
// cho item khi prorate → có dòng RENT kèm from_date+to_date ⇒ hoá đơn không đủ
// ngày. Dùng tô màu + ghi chú kỳ ở cột Thu (Phân bổ lợi nhuận) cho MỌI hoá đơn
// (không chỉ HĐ tháng đầu như useFirstInvoiceDetails).
// =============================================

export interface InvoiceRentPeriod {
  invoiceId: string;
  rentFrom: string;
  rentTo: string;
}

export const useInvoiceRentPeriods = (ids: string[]) => {
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['invoice-rent-periods', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, InvoiceRentPeriod>> => {
      const map = new Map<string, InvoiceRentPeriod>();
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('invoices')
          .select('id, billing_month, invoice_items (type, from_date, to_date)')
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const inv of financialReadRows<any>(data)) {
          const rent = financialReadRows<any>(inv.invoice_items)
            .filter((it) => it.type === 'RENT' && it.from_date && it.to_date)
            .sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)))[0];
          if (!rent) continue;
          // Chỉ tính "không đủ ngày" khi kỳ tiền phòng KHÔNG phủ trọn tháng hoá đơn
          // (loại trường hợp HĐ đủ tháng vẫn lỡ set from/to = 1→cuối tháng).
          const bm: string | null = inv.billing_month ?? null;
          let partial = true;
          if (bm && /^\d{4}-\d{2}$/.test(bm)) {
            const [y, m] = bm.split('-').map(Number);
            const monthStart = `${bm}-01`;
            const lastDay = new Date(y, m, 0).getDate();
            const monthEnd = `${bm}-${String(lastDay).padStart(2, '0')}`;
            const from = String(rent.from_date).slice(0, 10);
            const to = String(rent.to_date).slice(0, 10);
            partial = from > monthStart || to < monthEnd;
          }
          if (partial) {
            map.set(inv.id, {
              invoiceId: inv.id,
              rentFrom: rent.from_date,
              rentTo: rent.to_date,
            });
          }
        }
      }
      return map;
    },
  });
};

// =============================================
// useContractDepositVouchers — phiếu thu CỌC RIÊNG của hợp đồng (ngoài hoá đơn).
// = income_expenses INCOME đã duyệt, có item is_deposit, gắn contract_id. Đây là
// phần cọc đóng bằng phiếu thu riêng — TÁCH khỏi phần cọc nhồi trong hoá đơn
// (depositInInvoice) để popup hiển thị rạch ròi, không nhầm với tiền thu HĐ.
// =============================================

export interface ContractDepositVoucher {
  id: string;
  code: string | null;
  totalAmount: number;
  voucherDate: string | null;
  // Ai tạo phiếu + thu vào sổ quỹ nào (account) — để biết nguồn cọc bổ sung.
  creatorName: string | null;
  accountName: string | null;
  // Ảnh chứng từ của phiếu (income_expenses.attachments) — hiện thumbnail.
  images: string[];
}

export const useContractDepositVouchers = (contractId?: string | null) => {
  return useQuery({
    queryKey: ['contract-deposit-vouchers', contractId],
    meta:{errorDisplay:"inline",label:"phiếu cọc hợp đồng"},
    enabled: !!contractId,
    queryFn: async (): Promise<ContractDepositVoucher[]> => {
      if (!contractId) return [];
      const { data, error } = await supabase
        .from('income_expenses')
        .select(
          `id, code, total_amount, voucher_date, creator_name, attachments,
           account:accounts!income_expenses_account_id_fkey ( name ),
           income_expense_items!inner ( id, amount, income_expense_types!inner ( is_deposit ) )`,
        )
        .eq('contract_id', contractId)
        .eq('type', 'INCOME')
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        // CHỈ phiếu cọc ĐỘC LẬP (ngoài hoá đơn): invoice_id IS NULL — vd cọc giữ
        // chỗ thu trước khi ký, hoặc phiếu cọc tạo tay. Phiếu cọc TÁCH TỪ hoá đơn
        // tháng đầu (A2, có invoice_id) thuộc "trong HĐ" → KHÔNG liệt kê ở đây.
        .is('invoice_id', null)
        .eq('income_expense_items.income_expense_types.is_deposit', true)
        .order('voucher_date', { ascending: true });
      if (error) throw error;
      // Dedupe theo id (phòng khi 1 phiếu có >1 item cọc → !inner nhân dòng).
      const map = new Map<string, ContractDepositVoucher>();
      for (const v of financialReadRows(data as any[] | null)) {
        if (map.has(v.id)) continue;
        // Số CỌC = Σ item cọc (embed đã lọc is_deposit) — phiếu trộn không đếm
        // thừa phần không-cọc.
        const depositSum = financialReadRows(v.income_expense_items as any[] | null).reduce<number>(
          (s: number, it: any) => s + financialReadNumber(it.amount),
          0,
        );
        map.set(v.id, {
          id: v.id,
          code: v.code ?? null,
          totalAmount: depositSum,
          voucherDate: v.voucher_date ?? null,
          creatorName: v.creator_name ?? null,
          accountName: v.account?.name ?? null,
          images: Array.isArray(v.attachments)
            ? v.attachments.filter((x: unknown): x is string => typeof x === 'string')
            : [],
        });
      }
      return Array.from(map.values());
    },
  });
};

// =============================================
// useCreateInvoice - Create invoice + invoice_items, status = APPROVED (mặc định đã duyệt)
// =============================================

export const useCreateInvoice = (options: {silent?:boolean} = {}) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    meta:{handlesFeedback:!!options.silent},
    mutationFn: async (formData: InvoiceFormData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { items, ...invoiceFields } = formData;

      // Calculate totals from items
      const subtotal = items.reduce(
        (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
        0,
      );
      const creditApplication = capInvoiceCreditApplication({
        subtotal,
        previousDebt: invoiceFields.previous_debt || 0,
        requestedDiscount: invoiceFields.discount_amount || 0,
        requestedCredit: invoiceFields.applied_credit ?? 0,
      });
      const discountAmount = creditApplication.discountAmount;
      const appliedCredit = creditApplication.appliedCredit;

      // total = tạm tính − giảm trừ (mình nợ khách) + nợ cũ (khách nợ mình)
      // Làm tròn phần lẻ: <900đ → tròn xuống, ≥900đ → tròn lên bội số 1000
      const total_amount = roundInvoiceTotal(
        subtotal
        - discountAmount
        + (invoiceFields.previous_debt || 0),
      );

      const request = prepareCustomerCreditRequest('invoice-create');
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const creatorName: string =
        (typeof meta.full_name === 'string' && meta.full_name)
        || (typeof meta.name === 'string' && meta.name)
        || user.email
        || 'Người dùng';
      const canonicalBaseArgs = {
        p_contract_id: invoiceFields.contract_id,
        p_building_id: invoiceFields.building_id,
        p_room_id: invoiceFields.room_id ?? null,
        p_billing_month: invoiceFields.billing_month,
        p_issue_date: invoiceFields.issue_date,
        p_due_date: invoiceFields.due_date,
        p_kind: 'MONTHLY',
        p_subtotal: subtotal,
        p_discount_amount: discountAmount,
        p_total_amount: total_amount,
        p_previous_debt: invoiceFields.previous_debt || 0,
        p_items: items.map((item) => ({
          service_id: item.service_id || null,
          type: item.type,
          accounting_class: item.accounting_class,
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          coefficient: item.coefficient,
          amount: item.unit_price * item.quantity * item.coefficient,
          previous_reading: item.previous_reading ?? null,
          current_reading: item.current_reading ?? null,
          from_date: item.from_date || null,
          to_date: item.to_date || null,
          sort_order: item.sort_order,
        })),
        p_prepaid_amount: invoiceFields.prepaid_amount || 0,
        p_discount_notes: invoiceFields.discount_notes || null,
        p_electricity_prev_overridden: !!invoiceFields.electricity_prev_overridden,
        p_previous_debt_sources: (invoiceFields.previous_debt_sources ?? []) as unknown as Json,
        p_template_id: invoiceFields.template_id || null,
        p_notes: invoiceFields.notes || null,
        p_creator_name: creatorName,
      };
      const rpcName = selectInvoiceCreateRpc(appliedCredit);
      const canonicalArgs = appliedCredit > 0
        ? buildCreditInvoiceCreateRpcArgs(canonicalBaseArgs, appliedCredit, request)
        : {
            ...canonicalBaseArgs,
            p_idempotency_key: request.idempotencyKey,
            p_applied_credit: 0,
          };

      // Credit invoices have one atomic path and fail closed on every RPC error.
      // Non-credit invoices retain the existing controlled legacy fallback.
      // Generated types intentionally lag until the migration is applied.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // canonicalArgs dựng theo nhánh (có/không applied credit) nên chỉ suy được
      // Record<string, unknown>. Cast riêng THAM SỐ — tên RPC vẫn do compiler kiểm.
      const canonical = await supabase.rpc(
        rpcName,
        canonicalArgs as never,
      );
      if (!canonical.error) return confirmedInvoiceReceipt(canonical.data);
      if (appliedCredit > 0) throw canonical.error;
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      // Generate invoice number
      const { generateInvoiceNumber } = await import('@/lib/invoiceUtils');
      const invoice_number = await generateInvoiceNumber(user.id);

      // Insert invoice
      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .insert(withOrg({
          user_id: user.id,
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,
          invoice_number,
          billing_month: invoiceFields.billing_month,
          issue_date: invoiceFields.issue_date,
          due_date: invoiceFields.due_date,
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
          subtotal,
          discount_amount: invoiceFields.discount_amount || 0,
          discount_notes: invoiceFields.discount_notes || null,
          electricity_prev_overridden: !!invoiceFields.electricity_prev_overridden,
          total_amount,
          prepaid_amount: invoiceFields.prepaid_amount || 0,
          paid_amount: 0,
          previous_debt: invoiceFields.previous_debt || 0,
          previous_debt_sources: invoiceFields.previous_debt_sources ?? [],
          notes: invoiceFields.notes || null,
          template_id: invoiceFields.template_id || null,
          creator_name: creatorName,
        } as any, selectedOrganizationId))
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Insert invoice items
      if (items.length > 0) {
        const invoiceItems = items.map((item) => ({
          invoice_id: invoice.id,
          service_id: item.service_id || null,
          type: item.type as any,
          accounting_class: item.accounting_class,
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          coefficient: item.coefficient,
          amount: item.unit_price * item.quantity * item.coefficient,
          previous_reading: item.previous_reading ?? null,
          current_reading: item.current_reading ?? null,
          from_date: item.from_date || null,
          to_date: item.to_date || null,
          sort_order: item.sort_order,
        }));

        const { error: itemsError } = await supabase
          .from('invoice_items')
          .insert(withOrgAll(invoiceItems, selectedOrganizationId) as any);

        if (itemsError) throw new InvoicePartialError(`Đã tạo hoá đơn ${invoice.invoice_number || invoice.id} nhưng chưa lưu đủ hạng mục. Mở hoá đơn để đối chiếu; không tạo lại toàn bộ.`,invoice.id,itemsError);
      }

      return invoice;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      if(options.silent) return;
      toast({
        title: `Đã tạo ${invoiceLabel(result)}`,
        description: 'Mở hoá đơn để xem trạng thái duyệt và số tiền phải thu.',
      });
    },
    onError: (error: Error) => {
      if(options.silent) return;
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi tạo hoá đơn',
        description: invoiceFailureMessage(error, "tạo hoá đơn"),
      });
    },
  });
};

// =============================================
// useUpdateInvoice - Update invoice (check canEditInvoice first)
// Requirements: 3.1, 3.2
// =============================================

export const useUpdateInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async ({ id, formData }: UpdateInvoiceData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch current invoice to check status
      const { data: current, error: fetchError } = await supabase
        .from('invoices')
        .select('status, paid_amount, deleted_at, adjustment_revision')
        .eq('id', id)
        .single();

      if (fetchError) throw fetchError;
      if (getInvoiceEditMode({ ...current, status: current.status as InvoiceStatus }) !== 'draft') {
        throw new Error('Không thể chỉnh sửa hoá đơn ở trạng thái này');
      }

      const { items, ...invoiceFields } = formData;

      // Recalculate totals
      const subtotal = items.reduce(
        (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
        0,
      );
      // total = tạm tính − giảm trừ + nợ cũ
      // Làm tròn phần lẻ: <900đ → tròn xuống, ≥900đ → tròn lên bội số 1000
      const total_amount = roundInvoiceTotal(
        subtotal
        - (invoiceFields.discount_amount || 0)
        + (invoiceFields.previous_debt || 0),
      );

      // Canonical update_invoice_v1: guard server (DRAFT|APPROVED, paid=0) + replace
      // items atomic; fallback legacy khi chưa deploy/coexistence.
      const canonical = await supabase.rpc('update_invoice_v1', {
        p_invoice_id: id,
        p_contract_id: invoiceFields.contract_id,
        p_building_id: invoiceFields.building_id,
        p_room_id: invoiceFields.room_id ?? null,
        p_billing_month: invoiceFields.billing_month,
        p_issue_date: invoiceFields.issue_date,
        p_due_date: invoiceFields.due_date,
        p_subtotal: subtotal,
        p_discount_amount: invoiceFields.discount_amount || 0,
        p_total_amount: total_amount,
        p_previous_debt: invoiceFields.previous_debt || 0,
        p_items: items.map((item) => ({
          service_id: item.service_id || null,
          type: item.type,
          accounting_class: item.accounting_class,
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          coefficient: item.coefficient,
          amount: item.unit_price * item.quantity * item.coefficient,
          previous_reading: item.previous_reading ?? null,
          current_reading: item.current_reading ?? null,
          from_date: item.from_date || null,
          to_date: item.to_date || null,
          sort_order: item.sort_order,
        })),
        p_prepaid_amount: invoiceFields.prepaid_amount || 0,
        p_discount_notes: invoiceFields.discount_notes || undefined,
        p_electricity_prev_overridden: !!invoiceFields.electricity_prev_overridden,
        p_previous_debt_sources: (invoiceFields.previous_debt_sources ?? []) as unknown as Json,
        p_template_id: invoiceFields.template_id || undefined,
        p_notes: invoiceFields.notes || undefined,
      });
      if (!canonical.error) return confirmedInvoiceReceipt(canonical.data);
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      // Update invoice
      const { data: invoice, error: updateError } = await supabase
        .from('invoices')
        .update({
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,
          billing_month: invoiceFields.billing_month,
          issue_date: invoiceFields.issue_date,
          due_date: invoiceFields.due_date,
          subtotal,
          discount_amount: invoiceFields.discount_amount || 0,
          discount_notes: invoiceFields.discount_notes || null,
          electricity_prev_overridden: !!invoiceFields.electricity_prev_overridden,
          total_amount,
          prepaid_amount: invoiceFields.prepaid_amount || 0,
          previous_debt: invoiceFields.previous_debt || 0,
          previous_debt_sources: invoiceFields.previous_debt_sources ?? [],
          notes: invoiceFields.notes || null,
          template_id: invoiceFields.template_id || null,
        } as any)
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Delete old items and insert new ones
      const { error: deleteItemsError } = await supabase
        .from('invoice_items')
        .delete()
        .eq('invoice_id', id);

      if (deleteItemsError) throw new InvoicePartialError(`Đã cập nhật thông tin hoá đơn nhưng chưa thay hạng mục. Mở hoá đơn để đối chiếu trước khi lưu tiếp.`,id,deleteItemsError);

      if (items.length > 0) {
        const invoiceItems = items.map((item) => ({
          invoice_id: id,
          service_id: item.service_id || null,
          type: item.type as any,
          accounting_class: item.accounting_class,
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          coefficient: item.coefficient,
          amount: item.unit_price * item.quantity * item.coefficient,
          previous_reading: item.previous_reading ?? null,
          current_reading: item.current_reading ?? null,
          from_date: item.from_date || null,
          to_date: item.to_date || null,
          sort_order: item.sort_order,
        }));

        const { error: insertItemsError } = await supabase
          .from('invoice_items')
          .insert(withOrgAll(invoiceItems, selectedOrganizationId) as any);

        if (insertItemsError) throw new InvoicePartialError(`Đã cập nhật thông tin hoá đơn và gỡ hạng mục cũ nhưng chưa lưu hạng mục mới. Mở hoá đơn để đối chiếu; giữ bản nháp đang nhập.`,id,insertItemsError);
      }

      return invoice;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });

      toast({
        title: `Đã lưu ${invoiceLabel(result)}`,
        description: 'Hoá đơn đã được cập nhật.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi cập nhật hoá đơn',
        description: invoiceFailureMessage(error, "sửa hoá đơn"),
      });
    },
  });
};

// =============================================
// useBulkCancelInvoices - Huỷ nhiều hoá đơn (gôm từ bulk soft-delete, 09/2026)
// Không còn RPC bulk phía DB: loop cancel_invoice_with_credit_v1 từng hoá đơn
// (mỗi cái một idempotency key). Mất tính atomic của bulk nhưng mỗi lượt huỷ
// vốn độc lập; hoá đơn không đủ điều kiện bị BỎ QUA và báo trong toast tổng.
// =============================================

export const useBulkCancelInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();

  return useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      if (invoiceIds.length === 0) return { done: 0, skipped: 0, failed: 0, completedIds: [] as string[], failures: [] as {id:string;message:string;outcomeUnknown:boolean}[] };

      // RPC cancel KHÔNG guard status/paid ở DB → lọc trước bằng canCancelInvoice.
      const { data: rows, error: fetchError } = await supabase
        .from('invoices')
        .select('id, organization_id, status, paid_amount, deleted_at')
        .in('id', invoiceIds);
      if (fetchError) throw fetchError;

      const eligible = financialReadRows(rows).filter((row) =>
        canCancelInvoice({
          status: row.status as InvoiceStatus,
          paid_amount: row.paid_amount,
          deleted_at: row.deleted_at,
        }),
      );

      const completedIds:string[]=[];
      const failures:{id:string;message:string;outcomeUnknown:boolean}[]=[];
      let done = 0;
      let failed = 0;
      for (const row of eligible) {
        try {
          if(invoiceLifecycleUnknown.has(row.id)) throw new TypeError("Chưa đối chiếu trạng thái hoá đơn của lần thao tác trước.");
          await runFinancialPending({
            namespace:'invoice-cancel',userId:user.id,
            organizationId:row.organization_id ?? selectedOrganizationId ?? '',businessKey:row.id,
          },async progress=>{
            const result=await invokeCustomerCreditRpc(
              (fn,args)=>supabase.rpc(fn,args),'cancel_invoice_with_credit_v1',
              buildInvoiceCreditLifecycleRpcArgs(row.id,prepareCustomerCreditRequest('invoice-cancel',progress.requestKey)),
            );
            const receipt=confirmedInvoiceReceipt(await readInvoiceLifecycleReceipt(result,row.id));
            if(receipt.id!==row.id || receipt.status!=='CANCELLED') throw new TypeError('Chưa xác nhận được hoá đơn đã hủy sau thao tác.');
            progress.recordCompleted([row.id]);
          });
          done += 1; completedIds.push(row.id);
        } catch (error) {
          if(voucherOutcomeUnknown(error)) invoiceLifecycleUnknown.add(row.id);
          failures.push({id:row.id,message:invoiceFailureMessage(error,"hủy hóa đơn"),outcomeUnknown:voucherOutcomeUnknown(error)});
          failed += 1;
        }
      }
      return { done, skipped: invoiceIds.length - eligible.length, failed, completedIds, failures };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      const { done, skipped, failed } = result ?? { done: 0, skipped: 0, failed: 0 };
      const extras = [
        skipped > 0 ? `${skipped} hoá đơn không đủ điều kiện (đã thu tiền/đã huỷ) bị bỏ qua` : '',
        failed > 0 ? `${failed} hoá đơn lỗi khi huỷ` : '',
      ].filter(Boolean).join('; ');
      toast({
        variant: failed > 0 ? 'destructive' : undefined,
        title: done>0 ? `Đã huỷ ${done} hoá đơn` : "Chưa có hóa đơn nào được hủy",
        description: extras
          ? `${extras}.`
          : 'Các hoá đơn đã chuyển vào mục "Đã huỷ" và có thể phục hồi.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi huỷ hoá đơn',
        description: invoiceFailureMessage(error, "huỷ các hoá đơn"),
      });
    },
  });
};

// =============================================
// useApproveInvoice - DRAFT → APPROVED
// Requirements: 4.1, 4.2
// =============================================

const invoiceLifecycleUnknown = new Set<string>();
async function readInvoiceLifecycleReceipt(value:unknown,invoiceId:string):Promise<unknown> {
  const receipt=value && typeof value==='object'?value as Record<string,unknown>:{};
  const row=receipt.invoice && typeof receipt.invoice==='object'?receipt.invoice as Record<string,unknown>:receipt;
  const knownStates=['DRAFT','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED'];
  if(row.id===invoiceId && typeof row.status==='string' && knownStates.includes(row.status)) return value;
  const {data,error}=await supabase.from('invoices').select('id, invoice_number, status').eq('id',invoiceId).single();
  if(error || !data || data.id!==invoiceId || !knownStates.includes(data.status)) throw new TypeError('Chưa đọc được trạng thái hoá đơn sau thao tác.');
  return {invoice:data,noop:receipt.noop};
}

async function confirmSingleInvoiceLifecycle(value:unknown,invoiceId:string,expectedStates:string[],completed:{id:string;label:string}[]):Promise<unknown> {
  const result=await readInvoiceLifecycleReceipt(value,invoiceId);
  const receipt=confirmedInvoiceReceipt(result);
  if(receipt.id!==invoiceId || !expectedStates.includes(String(receipt.status)))throw new TypeError('Chưa xác nhận được trạng thái hoá đơn sau thao tác.');
  completed.push({id:receipt.id,label:`Đã nhận trạng thái của ${invoiceLabel(receipt)}`});
  return result;
}

export const useApproveInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('invoice-approve'));

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      return workflow.current.run(invoiceId,'duyệt hoá đơn',async progress=>{
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Canonical approve_invoice_v1 (server-side state-guard + permission
      // parity RLS); fallback legacy update khi writer chưa deploy/không quyền.
      const canonical = await supabase.rpc('approve_invoice_v1', {
        p_invoice_id: invoiceId,
      });
      if (!canonical.error) return confirmSingleInvoiceLifecycle(canonical.data,invoiceId,['APPROVED'],progress.completed);
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
        } as any)
        .eq('id', invoiceId)
        .eq('status', 'DRAFT' as any)
        .select()
        .single();

      if (error) throw error;
      return confirmSingleInvoiceLifecycle(data,invoiceId,['APPROVED'],progress.completed);
    },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast(invoiceLifecycleFeedback(result,"duyệt"));
    },
    onError: (error: Error, invoiceId: string) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi duyệt hoá đơn',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"duyệt hoá đơn") : invoiceFailureMessage(error,"duyệt hoá đơn"),
      });
    },
  });
};

// =============================================
// useUnapproveInvoice - APPROVED → DRAFT
// Requirements: 4.5
// =============================================

export const useUnapproveInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('invoice-unapprove'));

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      return workflow.current.run(invoiceId,'bỏ duyệt hoá đơn',async progress=>{
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const canonical = await supabase.rpc('unapprove_invoice_v1', {
        p_invoice_id: invoiceId,
      });
      if (!canonical.error) return confirmSingleInvoiceLifecycle(canonical.data,invoiceId,['DRAFT'],progress.completed);
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'DRAFT' as any,
          approved_at: null,
          approved_by: null,
        } as any)
        .eq('id', invoiceId)
        .eq('status', 'APPROVED' as any)
        .select()
        .single();

      if (error) throw error;
      return confirmSingleInvoiceLifecycle(data,invoiceId,['DRAFT'],progress.completed);
    },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast(invoiceLifecycleFeedback(result,"bỏ duyệt"));
    },
    onError: (error: Error, invoiceId: string) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi bỏ duyệt hoá đơn',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"bỏ duyệt hoá đơn") : invoiceFailureMessage(error,"bỏ duyệt hoá đơn"),
      });
    },
  });
};

// =============================================
// useBulkApproveInvoices - Bulk approve DRAFT → APPROVED
// Requirements: 4.3
// =============================================

export const useBulkApproveInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      if (invoiceIds.length === 0) return;

      // Canonical trả về SỐ LƯỢNG đã duyệt; legacy trả mảng row → chuẩn hoá
      // cả hai thành mảng-tương-đương qua count ở onSuccess (xem dưới).
      const canonical = await supabase.rpc('bulk_approve_invoices_v1', {
        p_invoice_ids: invoiceIds,
      });
      if (!canonical.error) {
        if(typeof canonical.data!=="number" || !Number.isInteger(canonical.data) || canonical.data<0) throw new TypeError("Chưa xác nhận được số hoá đơn đã duyệt.");
        return {count:canonical.data};
      }
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
        } as any)
        .in('id', invoiceIds)
        .eq('status', 'DRAFT' as any)
        .select();

      if (error) throw error;
      return { count: data?.length ?? 0 };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      const count = data?.count ?? 0;
      toast({
        title: count > 0 ? 'Đã duyệt các hoá đơn' : 'Không có hoá đơn mới được duyệt',
        description: `Đã duyệt ${count} hoá đơn. Xem trạng thái từng hoá đơn trong danh sách.`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi duyệt hoá đơn',
        description: invoiceFailureMessage(error, "duyệt các hoá đơn"),
      });
    },
  });
};

// =============================================
// useInvoiceStatistics - Query RPC get_invoice_statistics
// Requirements: 10.1
// =============================================

export interface InvoiceStatisticsFilters {
  building_id?: string;
  /** Lọc nhiều toà — RPC nhận p_building_ids (migration 20260610100000). */
  building_ids?: string[];
  room_id?: string;
  status?: InvoiceStatus;
  start_date?: string;
  end_date?: string;
  billing_month?: string;
  payment_status?: 'paid' | 'unpaid' | 'partial';
}

export interface InvoiceStatistics {
  total_amount: number;
  total_paid: number;
  total_remaining: number;
  total_refunded: number;
  total_count: number;
  rent_amount: number;
  electric_amount: number;
  water_amount: number;
  pdv_amount: number;
  total_collected: number;
  payment_tm: number;
  payment_tk: number;
  payment_tt: number;
  /** Cấn trừ — payments method='CT' do thanh lý tự sinh (cấn cọc/đối trừ công
   *  nợ), KHÔNG phải tiền mặt. Tách riêng để TM không bị phồng. */
  payment_ct: number;
  change_amount: number;
  /** Cọc đã thu — tổng IE INCOME APPROVED có item is_deposit, filter theo
   *  area/building/room/billing_month tương tự các stat khác. Tách riêng để
   *  không trộn vào TM/TK/TT vì cọc không phải thanh toán hoá đơn. */
  deposit_collected: number;
}

export const invoiceStatisticsQuery = (filters?: InvoiceStatisticsFilters) => ({
    queryKey: ['invoice-statistics', filters] as const,
    meta:{errorDisplay:'inline',label:'thống kê hoá đơn'},
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5')
    queryFn: async (): Promise<InvoiceStatistics> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // RBAC v2: không truyền p_user_id; quyền xác định qua can_access_building().
      // Nhờ vậy super_admin thấy đủ data của các building trong scope (kể cả invoice
      // do staff khác tạo), khắc phục lỗi "lệch owner" của bản v1.
      const { data, error } = await supabase.rpc('get_invoice_statistics_v2', {
        p_building_id: filters?.building_id ?? undefined,
        p_room_id: filters?.room_id ?? undefined,
        p_status: filters?.status ?? undefined,
        p_start_date: filters?.start_date ?? undefined,
        p_end_date: filters?.end_date ?? undefined,
        p_billing_month: filters?.billing_month ?? undefined,
        p_payment_status: filters?.payment_status ?? undefined,
        p_building_ids: filters?.building_ids?.length ? filters.building_ids : undefined,
      });

      if (error) throw error;

      // Kết quả RPC về dưới dạng Json; ép một lần ở đây thay vì cast cả
      // supabase.rpc — như vậy tên RPC và tham số vẫn được compiler kiểm.
      const result = (Array.isArray(data) ? data[0] : data) as unknown as
        Record<string, number | null | undefined>;
      return {
        total_amount: financialReadNumber(result?.total_amount),
        total_paid: financialReadNumber(result?.total_paid),
        total_remaining: financialReadNumber(result?.total_remaining),
        total_refunded: financialReadNumber(result?.total_refunded),
        total_count: financialReadNumber(result?.total_count),
        rent_amount: financialReadNumber(result?.rent_amount),
        electric_amount: financialReadNumber(result?.electric_amount),
        water_amount: financialReadNumber(result?.water_amount),
        pdv_amount: financialReadNumber(result?.pdv_amount),
        total_collected: financialReadNumber(result?.total_collected),
        payment_tm: financialReadNumber(result?.payment_tm),
        payment_tk: financialReadNumber(result?.payment_tk),
        payment_tt: financialReadNumber(result?.payment_tt),
        payment_ct: financialReadNumber(result?.payment_ct),
        change_amount: financialReadNumber(result?.change_amount),
        deposit_collected: financialReadNumber(result?.deposit_collected),
      };
    },
  });

export const useInvoiceStatistics = (filters?: InvoiceStatisticsFilters) => {
  return useQuery(invoiceStatisticsQuery(filters));
};

// =============================================
// useCheckOverdueInvoices - Auto-update overdue invoices on page load
// Requirements: 7.7, 11.10
// Checks invoices with status APPROVED (chưa thu đồng nào) where due_date < today
// and updates their status to OVERDUE. PARTIAL_PAID KHÔNG bị đụng (H1.5, 15/09/2026).
// =============================================

export const useCheckOverdueInvoices = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<number> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Canonical sweep server-side (phạm vi toà được phép), trả số lượng.
      const canonical = await supabase.rpc('mark_overdue_invoices_v1');
      if (!canonical.error) return (canonical.data as number) ?? 0;
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const today = todayISO();

      // Fallback (khi RPC canonical chưa có): CÙNG LUẬT với mark_overdue_invoices_v1
      // sau 15/09/2026 — chỉ hoá đơn APPROVED chưa thu đồng nào. PARTIAL_PAID
      // giữ nguyên: recompute_invoice_for_id ưu tiên PARTIAL_PAID trước OVERDUE,
      // đánh ở đây là hai writer nói hai luật và trạng thái lật qua lật lại.
      const { data: overdueInvoices, error: fetchError } = await supabase
        .from('invoices')
        .select('id')
        .is('deleted_at', null)
        .eq('status', 'APPROVED' as any)
        .eq('paid_amount', 0)
        .lt('due_date', today);

      if (fetchError) throw fetchError;
      if (!overdueInvoices || overdueInvoices.length === 0) return 0;

      const overdueIds = overdueInvoices.map((inv) => inv.id);

      // Batch update all overdue invoices
      const { error: updateError } = await supabase
        .from('invoices')
        .update({ status: 'OVERDUE' as any } as any)
        .in('id', overdueIds)
        ;

      if (updateError) throw updateError;

      return overdueIds.length;
    },
    onSuccess: (count) => {
      if (count > 0) {
        // Invalidate invoice queries so the list refreshes with updated statuses
        queryClient.invalidateQueries({ queryKey: ['invoices'] });
        queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
        queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      }
    },
    onError: (error: Error) => {
      // Silently log - this is a background check, don't disrupt the user
      console.error('Failed to check overdue invoices:', error.message);
    },
  });
};

// =============================================
// useExcessAmount - Read the canonical lot-backed customer credit balance
// Requirements: 8.2
// =============================================

export const useExcessAmount = (contractId?: string) => {
  return useQuery({
    queryKey: ['excess-amount', contractId],
    queryFn: async (): Promise<number> => {
      if (!contractId) return 0;

      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Generated types intentionally lag until the migration is applied.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc(
        'get_customer_credit_balance_v1',
        { p_contract_id: contractId },
      );

      if (error) throw error;
      return readContractCreditBalance(data);
    },
    enabled: !!contractId,
  });
};


// =============================================
// Legacy hooks kept for backward compatibility
// These are used by existing components that haven't been migrated yet
// =============================================

export interface RecordPaymentData {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  notes?: string;
  receipt_image_url?: string;
}

// useRecordPayment (legacy, non-atomic insert-rồi-read-modify-write) ĐÃ GỠ ở
// Sprint 5b: dead code (không nơi nào gọi), anti-pattern §8.1. Dùng
// useInvoicePayments::useRecordPaymentRPC (RPC record_invoice_payment_v3 atomic).

// =============================================
// Legacy: Meter reading hooks (kept for backward compatibility)
// These will be moved to useInvoicePayments.ts in task 9.3
// =============================================

export interface MeterReadingData {
  contract_id: string;
  service_id: string;
  meter_type: string;
  reading_date: string;
  current_reading: number;
  previous_reading: number;
  notes?: string;
}

export const useRecordMeterReading = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (data: MeterReadingData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data: reading, error } = await supabase
        .from('meter_readings')
        .insert(withOrgAll([{
          user_id: user.id,
          contract_id: data.contract_id,
          service_id: data.service_id,
          meter_type: data.meter_type as any,
          reading_date: data.reading_date,
          previous_reading: data.previous_reading,
          current_reading: data.current_reading,
          notes: data.notes,
        }], selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      return reading;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter_readings'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Chỉ số công tơ đã được ghi nhận thành công',
        description: 'Chỉ số công tơ đã được ghi nhận.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận chỉ số',
        description: invoiceFailureMessage(error, "ghi chỉ số công tơ"),
      });
    },
  });
};

export const useMeterReadings = (contractId?: string) => {
  return useQuery({
    queryKey: ['meter_readings', contractId],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('meter_readings')
        .select(`
          *,
          contract:contracts!meter_readings_contract_id_fkey (
            id,
            contract_number,
            tenant:tenants!contracts_tenant_id_fkey (full_name)
          ),
          service:services!meter_readings_service_id_fkey (
            id, name, unit
          )
        `)
        .order('reading_date', { ascending: false });

      if (contractId) {
        query = query.eq('contract_id', contractId);
      }

      const { data, error } = await query;
      if (error) {
        console.error('useMeterReadings error:', error);
        throw error;
      }
      return data || [];
    },
    enabled: !!contractId || contractId === undefined,
  });
};

export interface BulkMeterReadingData {
  contract_id: string;
  service_id: string;
  meter_type: 'ELECTRIC' | 'WATER' | 'GAS' | 'OTHER';
  reading_date: string;
  previous_reading: number;
  current_reading: number;
  notes?: string;
}

export const useBulkCreateMeterReadings = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (readings: BulkMeterReadingData[]) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const readingsToInsert = readings.map((reading) => ({
        user_id: user.id,
        contract_id: reading.contract_id,
        service_id: reading.service_id,
        meter_type: reading.meter_type as any,
        reading_date: reading.reading_date,
        previous_reading: reading.previous_reading,
        current_reading: reading.current_reading,
        notes: reading.notes,
      }));

      const { data, error } = await supabase
        .from('meter_readings')
        .insert(withOrgAll(readingsToInsert, selectedOrganizationId))
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['meter_readings'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Chỉ số công tơ đã được ghi nhận thành công',
        description: `Đã ghi nhận ${data.length} chỉ số công tơ.`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận chỉ số',
        description: invoiceFailureMessage(error, "ghi các chỉ số công tơ"),
      });
    },
  });
};

// =============================================
// Legacy: useCancelInvoice (kept for backward compatibility)
// =============================================

// =============================================
// useRestoreInvoice - CANCELLED → APPROVED
// Khôi phục lại HĐ đã huỷ. RPC restore_invoice_with_credit_v1 chỉ đòi quyền
// invoices.edit trên toà (không đòi super admin) và tự apply lại credit; FE
// render nút cho ai có quyền huỷ — để user tự sửa tay lỡ bấm huỷ nhầm.
// =============================================

export const useRestoreInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('invoice-restore'));

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      return workflow.current.run(invoiceId,'khôi phục hoá đơn',async progress=>{
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const result=await invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // Ranh giới abstraction: invoker cố ý nhận Record<string, unknown> để
        // test inject được fake rpc, nên chữ ký không khớp overload đã typed của
        // supabase.rpc. Cast GOM một chỗ ở đây, không rải ra từng call site.
        (fn, args) => supabase.rpc(fn, args),
        'restore_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-restore',progress.requestKey),
        ),
      );
      return confirmSingleInvoiceLifecycle(result,invoiceId,['APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE'],progress.completed);
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast(invoiceLifecycleFeedback(result,"khôi phục"));
    },
    onError: (error: Error, invoiceId: string) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi phục hồi hoá đơn',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"khôi phục hoá đơn") : invoiceFailureMessage(error,"khôi phục hoá đơn"),
      });
    },
  });
};

/**
 * Super admin huỷ hoá đơn sau khi mọi payment đã được hoàn tác. Credit đã áp
 * được unwind bằng bút toán đối ứng; không hard-delete payment hay ledger.
 */
export const useForceCancelInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('invoice-force-cancel'));

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      return workflow.current.run(invoiceId,'huỷ hoá đơn',async progress=>{
      const result=await invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // Ranh giới abstraction: invoker cố ý nhận Record<string, unknown> để
        // test inject được fake rpc, nên chữ ký không khớp overload đã typed của
        // supabase.rpc. Cast GOM một chỗ ở đây, không rải ra từng call site.
        (fn, args) => supabase.rpc(fn, args),
        'super_admin_force_cancel_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-force-cancel',progress.requestKey),
        ),
      );
      return confirmSingleInvoiceLifecycle(result,invoiceId,['CANCELLED'],progress.completed);
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast(invoiceLifecycleFeedback(result,"huỷ"));
    },
    onError: (error: Error, invoiceId: string) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi huỷ hoá đơn',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"huỷ hoá đơn") : invoiceFailureMessage(error,"huỷ hoá đơn"),
      });
    },
  });
};

export const useCancelInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('invoice-cancel'));

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      return workflow.current.run(invoiceId,'huỷ hoá đơn',async progress=>{
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Từ 15/09/2026 luật "DRAFT|APPROVED và chưa thu đồng nào" đã nằm trong
      // chính RPC (migration `hoa_don_guard_huy_no_keo_subtotal_ngay`), nên lần
      // đọc này chỉ còn để đổi lỗi SQL thành một câu tiếng Việt. Giữ lại: bỏ đi
      // thì người dùng nhận nguyên văn thông báo của Postgres.
      const { data: current, error: fetchError } = await supabase
        .from('invoices')
        .select('status, paid_amount, deleted_at')
        .eq('id', invoiceId)
        .single();

      if (fetchError) throw fetchError;
      if (!canCancelInvoice({
        status: current.status as InvoiceStatus,
        paid_amount: current.paid_amount,
        deleted_at: current.deleted_at,
      })) {
        throw new FinancialWorkflowError('Không thể huỷ hoá đơn ở trạng thái này (đã thu tiền hoặc đã huỷ)','failure',[]);
      }

      const result=await invokeCustomerCreditRpc(
        // Ranh giới abstraction: invoker cố ý nhận Record<string, unknown> để
        // test inject được fake rpc, nên chữ ký không khớp overload đã typed của
        // supabase.rpc. Cast GOM một chỗ ở đây, không rải ra từng call site.
        (fn, args) => supabase.rpc(fn, args),
        'cancel_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-cancel',progress.requestKey),
        ),
      );
      return confirmSingleInvoiceLifecycle(result,invoiceId,['CANCELLED'],progress.completed);
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast(invoiceLifecycleFeedback(result,"huỷ"));
    },
    onError: (error: Error, invoiceId: string) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi huỷ hoá đơn',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"huỷ hoá đơn") : invoiceFailureMessage(error,"huỷ hoá đơn"),
      });
    },
  });
};
