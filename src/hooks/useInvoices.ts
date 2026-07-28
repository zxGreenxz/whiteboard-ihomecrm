// =============================================
// Invoice Module Hooks (Reimplemented)
// TanStack Query hooks for invoice CRUD, approval, statistics, and excess amounts.
// Uses new schema with billing_month (YYYY-MM) and building_id on invoices.
// =============================================

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { isCanonicalFallbackSignal } from '@/lib/canonicalFallback';
import { useToast } from '@/hooks/use-toast';
import type { PaginatedData } from '@/hooks/usePagination';
import type {
  InvoiceWithRelations,
  InvoiceFilters,
  InvoiceFormData,
  InvoiceFormItem,
  InvoiceStatus,
} from '@/types/invoice';
import {
  canEditInvoice,
  canDeleteInvoice,
  roundInvoiceTotal,
  getInvoiceTitle,
  isFirstMonthInvoice,
} from '@/lib/invoiceUtils';
import { AMOUNT_SEARCH_TOLERANCE } from '@/lib/roomCodeSearch';
import {
  buildBulkInvoiceCreditLifecycleRpcArgs,
  buildCreditInvoiceCreateRpcArgs,
  capInvoiceCreditApplication,
  buildInvoiceCreditLifecycleRpcArgs,
  invokeCustomerCreditRpc,
  prepareCustomerCreditRequest,
  selectInvoiceCreateRpc,
} from '@/lib/customerCreditRpc';

// Re-export types for backward compatibility
export type { InvoiceWithRelations, InvoiceFilters } from '@/types/invoice';

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
  room:rooms!invoices_room_id_fkey (id, name, name_sort),  invoice_items (id, type, description, unit_price, quantity, coefficient, amount, service_id, previous_reading, current_reading, from_date, to_date, sort_order),
  payments (id, amount, payment_date, payment_method, notes, receipt_image_url, collection_id, reversed_at)
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
        ? (supabase as any).rpc('invoice_payment_method_drilldown', {
            p_payment_method: filters.payment_method,
          })
        : (supabase as any).from('invoices');

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
          const { data: custRows } = await (supabase as any)
            .from('customers')
            .select('id')
            .ilike('full_name', `%${q}%`)
            .limit(200);
          const custIds = ((custRows || []) as any[]).map((c) => c.id);
          let contractIds: string[] = [];
          if (custIds.length > 0) {
            const { data: ccRows } = await (supabase as any)
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

      const invoiceRows = ((data || []) as InvoiceWithRelations[]).map((invoice) => ({
        ...invoice,
        payments: (invoice.payments ?? []).filter(
          (payment) => !(payment as typeof payment & { reversed_at?: string | null }).reversed_at,
        ),
      }));

      if (invoiceRows.length > 0) {
        const { data: methodRows, error: methodError } = await (supabase as any).rpc(
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
        return [];
      }
      return (data || []) as InvoiceWithRelations[];
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
      return data as InvoiceWithRelations;
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
        const { data, error } = await (supabase as any)
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
        for (const row of (data ?? []) as any[]) {
          map.set(row.id, {
            id: row.id,
            total_amount: Number(row.total_amount) || 0,
            paid_amount: Number(row.paid_amount) || 0,
            remaining_amount: Number(row.remaining_amount) || 0,
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
    return isCoc ? sum + (Number(it.amount) || 0) : sum;
  }, 0);
}

export const useFirstInvoiceDetails = (ids: string[]) => {
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['first-invoice-details', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, FirstInvoiceDetail>> => {
      const map = new Map<string, FirstInvoiceDetail>();
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await (supabase as any)
          .from('invoices')
          .select(
            `id, total_amount, paid_amount, notes,
             contract:contracts!invoices_contract_id_fkey (id, start_billing_date, total_deposit, deposit_paid),
             invoice_items (type, description, from_date, to_date, amount)`,
          )
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const inv of (data ?? []) as any[]) {
          const items = (inv.invoice_items ?? []) as any[];
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
          const invoiceTotal = Number(inv.total_amount) || 0;
          const invoicePaid = Number(inv.paid_amount) || 0;
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
            depositPaid: Number(contract?.deposit_paid) || 0,
            depositTotal: Number(contract?.total_deposit) || 0,
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
        const { data, error } = await (supabase as any)
          .from('invoices')
          .select('id, billing_month, invoice_items (type, from_date, to_date)')
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const inv of (data ?? []) as any[]) {
          const rent = ((inv.invoice_items ?? []) as any[])
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
    enabled: !!contractId,
    queryFn: async (): Promise<ContractDepositVoucher[]> => {
      if (!contractId) return [];
      const { data, error } = await (supabase as any)
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
      for (const v of (data ?? []) as any[]) {
        if (map.has(v.id)) continue;
        // Số CỌC = Σ item cọc (embed đã lọc is_deposit) — phiếu trộn không đếm
        // thừa phần không-cọc.
        const depositSum = ((v.income_expense_items ?? []) as any[]).reduce(
          (s: number, it: any) => s + (Number(it.amount) || 0),
          0,
        );
        map.set(v.id, {
          id: v.id,
          code: v.code ?? null,
          totalAmount: depositSum || Number(v.total_amount) || 0,
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

export const useCreateInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
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
        p_previous_debt_sources: invoiceFields.previous_debt_sources ?? [],
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
      const canonical = await (supabase.rpc as any)(rpcName, canonicalArgs);
      if (!canonical.error) return canonical.data;
      if (appliedCredit > 0) throw canonical.error;
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      // Generate invoice number
      const { generateInvoiceNumber } = await import('@/lib/invoiceUtils');
      const invoice_number = await generateInvoiceNumber(user.id);

      // Insert invoice
      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .insert({
          user_id: user.id,
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,          invoice_number,
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
        } as any)
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Insert invoice items
      if (items.length > 0) {
        const invoiceItems = items.map((item) => ({
          invoice_id: invoice.id,
          service_id: item.service_id || null,
          type: item.type as any,
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
          .insert(invoiceItems as any);

        if (itemsError) throw itemsError;
      }

      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Dữ liệu đã được TẠO thành công',
        description: 'Hoá đơn mới đã được duyệt và sẵn sàng ghi nhận thanh toán.',
      });
    },
    onError: (error: Error) => {
      const msg = error.message || '';
      const friendly = msg.includes('idx_invoices_unique_contract_billing')
        ? 'Hợp đồng này đã có hoá đơn cho kỳ thanh toán đã chọn. Hệ thống chỉ cho phép 1 hoá đơn / hợp đồng / kỳ.'
        : msg;
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi tạo hoá đơn',
        description: friendly,
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

  return useMutation({
    mutationFn: async ({ id, formData }: UpdateInvoiceData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch current invoice to check status
      const { data: current, error: fetchError } = await supabase
        .from('invoices')
        .select('status, paid_amount')
        .eq('id', id)
        .single();

      if (fetchError) throw fetchError;
      if (!canEditInvoice({ status: current.status as InvoiceStatus, paid_amount: current.paid_amount })) {
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
      const canonical = await (supabase.rpc as any)('update_invoice_v1', {
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
        p_previous_debt_sources: invoiceFields.previous_debt_sources ?? [],
        p_template_id: invoiceFields.template_id || null,
        p_notes: invoiceFields.notes || null,
      });
      if (!canonical.error) return canonical.data;
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      // Update invoice
      const { data: invoice, error: updateError } = await supabase
        .from('invoices')
        .update({
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,          billing_month: invoiceFields.billing_month,
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

      if (deleteItemsError) throw deleteItemsError;

      if (items.length > 0) {
        const invoiceItems = items.map((item) => ({
          invoice_id: id,
          service_id: item.service_id || null,
          type: item.type as any,
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
          .insert(invoiceItems as any);

        if (insertItemsError) throw insertItemsError;
      }

      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });

      toast({
        title: 'Dữ liệu đã được CẬP NHẬT thành công',
        description: 'Hoá đơn đã được cập nhật.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi cập nhật hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useDeleteInvoice - Soft-delete single invoice
// Requirements: 3.4, 3.5
// =============================================

export const useDeleteInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch current invoice to check status
      const { data: current, error: fetchError } = await supabase
        .from('invoices')
        .select('status, paid_amount')
        .eq('id', invoiceId)
        .single();

      if (fetchError) throw fetchError;
      if (!canDeleteInvoice({ status: current.status as InvoiceStatus, paid_amount: current.paid_amount })) {
        throw new Error('Không thể xoá hoá đơn ở trạng thái này');
      }

      return invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fn, args) => (supabase.rpc as any)(fn, args),
        'soft_delete_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-delete'),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });

      toast({
        title: 'Dữ liệu đã được XOÁ thành công',
        description: 'Hoá đơn đã được xoá.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xoá hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useBulkDeleteInvoices - Soft-delete multiple invoices
// Requirements: 3.5
// =============================================

export const useBulkDeleteInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      if (invoiceIds.length === 0) return;

      return invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fn, args) => (supabase.rpc as any)(fn, args),
        'bulk_soft_delete_invoices_with_credit_v1',
        buildBulkInvoiceCreditLifecycleRpcArgs(
          invoiceIds,
          prepareCustomerCreditRequest('invoice-bulk-delete'),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Dữ liệu đã được XOÁ thành công',
        description: 'Các hoá đơn đã chọn đã được xoá.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xoá hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useApproveInvoice - DRAFT → APPROVED
// Requirements: 4.1, 4.2
// =============================================

export const useApproveInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Canonical approve_invoice_v1 (server-side state-guard + permission
      // parity RLS); fallback legacy update khi writer chưa deploy/không quyền.
      const canonical = await (supabase.rpc as any)('approve_invoice_v1', {
        p_invoice_id: invoiceId,
      });
      if (!canonical.error) return canonical.data;
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
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Hoá đơn đã được duyệt thành công',
        description: 'Hoá đơn đã chuyển sang trạng thái Đã duyệt.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi duyệt hoá đơn',
        description: error.message,
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

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const canonical = await (supabase.rpc as any)('unapprove_invoice_v1', {
        p_invoice_id: invoiceId,
      });
      if (!canonical.error) return canonical.data;
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
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Đã bỏ duyệt hoá đơn',
        description: 'Hoá đơn đã chuyển về trạng thái Nháp.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi bỏ duyệt hoá đơn',
        description: error.message,
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
      const canonical = await (supabase.rpc as any)('bulk_approve_invoices_v1', {
        p_invoice_ids: invoiceIds,
      });
      if (!canonical.error) return { count: canonical.data as number };
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
        title: 'Duyệt hàng loạt thành công',
        description: `Đã duyệt ${count} hoá đơn.`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi duyệt hoá đơn',
        description: error.message,
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
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5')
    queryFn: async (): Promise<InvoiceStatistics> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // RBAC v2: không truyền p_user_id; quyền xác định qua can_access_building().
      // Nhờ vậy super_admin thấy đủ data của các building trong scope (kể cả invoice
      // do staff khác tạo), khắc phục lỗi "lệch owner" của bản v1.
      const { data, error } = await (supabase.rpc as any)('get_invoice_statistics_v2', {
        p_building_id: filters?.building_id ?? null,
        p_room_id: filters?.room_id ?? null,
        p_status: filters?.status ?? null,
        p_start_date: filters?.start_date ?? null,
        p_end_date: filters?.end_date ?? null,
        p_billing_month: filters?.billing_month ?? null,
        p_payment_status: filters?.payment_status ?? null,
        p_building_ids: filters?.building_ids?.length ? filters.building_ids : null,
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      return {
        total_amount: Number(result?.total_amount ?? 0),
        total_paid: Number(result?.total_paid ?? 0),
        total_remaining: Number(result?.total_remaining ?? 0),
        total_refunded: Number(result?.total_refunded ?? 0),
        total_count: Number(result?.total_count ?? 0),
        rent_amount: Number(result?.rent_amount ?? 0),
        electric_amount: Number(result?.electric_amount ?? 0),
        water_amount: Number(result?.water_amount ?? 0),
        pdv_amount: Number(result?.pdv_amount ?? 0),
        total_collected: Number(result?.total_collected ?? 0),
        payment_tm: Number(result?.payment_tm ?? 0),
        payment_tk: Number(result?.payment_tk ?? 0),
        payment_tt: Number(result?.payment_tt ?? 0),
        payment_ct: Number(result?.payment_ct ?? 0),
        change_amount: Number(result?.change_amount ?? 0),
        deposit_collected: Number(result?.deposit_collected ?? 0),
      };
    },
  });

export const useInvoiceStatistics = (filters?: InvoiceStatisticsFilters) => {
  return useQuery(invoiceStatisticsQuery(filters));
};

// =============================================
// useCheckOverdueInvoices - Auto-update overdue invoices on page load
// Requirements: 7.7, 11.10
// Checks invoices with status APPROVED or PARTIAL_PAID where due_date < today
// and updates their status to OVERDUE.
// =============================================

export const useCheckOverdueInvoices = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<number> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Canonical sweep server-side (phạm vi toà được phép), trả số lượng.
      const canonical = await (supabase.rpc as any)('mark_overdue_invoices_v1', {});
      if (!canonical.error) return (canonical.data as number) ?? 0;
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const today = new Date().toISOString().split('T')[0];

      // Find all invoices that should be marked as OVERDUE:
      // status IN ('APPROVED', 'PARTIAL_PAID'), due_date < today, not deleted
      const { data: overdueInvoices, error: fetchError } = await supabase
        .from('invoices')
        .select('id')
        .is('deleted_at', null)
        .in('status', ['APPROVED', 'PARTIAL_PAID'] as any)
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
      const { data, error } = await (supabase.rpc as any)(
        'get_customer_credit_balance_v1',
        { p_contract_id: contractId },
      );

      if (error) throw error;
      return Number(data) || 0;
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

  return useMutation({
    mutationFn: async (data: MeterReadingData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data: reading, error } = await supabase
        .from('meter_readings')
        .insert([{
          user_id: user.id,
          contract_id: data.contract_id,
          service_id: data.service_id,
          meter_type: data.meter_type as any,
          reading_date: data.reading_date,
          previous_reading: data.previous_reading,
          current_reading: data.current_reading,
          notes: data.notes,
        }])
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
        description: error.message,
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
        return [];
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
        .insert(readingsToInsert)
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
        description: error.message,
      });
    },
  });
};

// =============================================
// Legacy: useCancelInvoice (kept for backward compatibility)
// =============================================

// =============================================
// useRestoreInvoice - CANCELLED → APPROVED (super admin)
// Khôi phục lại HĐ đã huỷ. RLS đã có policy super_admin bypass nên client
// chỉ cần update; FE chịu trách nhiệm chỉ render nút này cho super admin.
// =============================================

export const useRestoreInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      return invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fn, args) => (supabase.rpc as any)(fn, args),
        'restore_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-restore'),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Đã phục hồi hoá đơn',
        description: 'Hoá đơn đã chuyển về trạng thái Đã duyệt.',
      });
    },
    onError: (error: Error) => {
      const msg = error.message || '';
      const friendly = msg.includes('idx_invoices_unique_contract_billing')
        ? 'Đã có hoá đơn khác cho hợp đồng + kỳ thanh toán này. Hãy huỷ hoá đơn đó trước khi phục hồi.'
        : msg;
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi phục hồi hoá đơn',
        description: friendly,
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

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      return invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fn, args) => (supabase.rpc as any)(fn, args),
        'super_admin_force_cancel_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-force-cancel'),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Đã xoá hoá đơn',
        description: 'Hoá đơn đã được huỷ sau khi kiểm tra payment và hoàn tác credit an toàn.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xoá hoá đơn',
        description: error.message,
      });
    },
  });
};

export const useCancelInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      return invokeCustomerCreditRpc(
        // Generated types intentionally lag until the migration is applied.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fn, args) => (supabase.rpc as any)(fn, args),
        'cancel_invoice_with_credit_v1',
        buildInvoiceCreditLifecycleRpcArgs(
          invoiceId,
          prepareCustomerCreditRequest('invoice-cancel'),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Hoá đơn đã được huỷ',
        description: 'Hoá đơn đã chuyển sang trạng thái Đã huỷ.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi huỷ hoá đơn',
        description: error.message,
      });
    },
  });
};
