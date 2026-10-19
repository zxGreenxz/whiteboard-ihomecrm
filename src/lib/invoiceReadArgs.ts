// Ánh xạ bộ lọc màn Hoá đơn → tham số hai hàm SQL dùng chung (migration
// 20261017115809_invoice_read_shared_v1): invoice_list_v1 và invoice_statistics_v3.
// Công thức lọc/sắp xếp/phân trang/quyền nằm ở SQL; file này CHỈ đổi tên trường và
// giữ đúng cách web cũ chọn giữa các trường trùng nghĩa (building_ids vs building_id…).
import { financialReadNumber, financialReadRows } from '@/lib/financialReadValidation';
import type { InvoiceFilters, InvoiceStatus, InvoiceWithRelations } from '@/types/invoice';
import type { PaginatedData } from '@/hooks/usePagination';

/** PostgREST cũ cắt mỗi lần đọc ở 1000 dòng; hàm SQL giữ cùng trần. */
const INVOICE_LIST_MAX_ROWS = 1000;

interface InvoiceListPagination {
  page?: number;
  pageSize?: number;
}

/** Cùng trường với InvoiceStatisticsFilters của useInvoices (thẻ thống kê). */
interface InvoiceStatisticsArgsInput {
  building_id?: string;
  building_ids?: string[];
  room_id?: string;
  status?: InvoiceStatus;
  start_date?: string;
  end_date?: string;
  billing_month?: string;
  payment_status?: 'paid' | 'unpaid' | 'partial';
}

// Tham số vắng để undefined (supabase-js bỏ khỏi body ⇒ hàm dùng DEFAULT NULL), khớp kiểu
// sinh tự động `p_x?: T` của tham số có DEFAULT.
export function invoiceListRpcArgs(filters: InvoiceFilters = {}, pagination?: InvoiceListPagination) {
  // Web cũ: building_ids (nếu có) THẮNG building_id; room_ids THẮNG room_id.
  const buildingIds = filters.building_ids?.length
    ? filters.building_ids
    : filters.building_id ? [filters.building_id] : undefined;
  const roomIds = filters.room_ids?.length ? filters.room_ids : filters.room_id ? [filters.room_id] : undefined;
  const paged = Boolean(pagination?.page && pagination?.pageSize);
  const page = pagination?.page ?? 1;
  const pageSize = pagination?.pageSize ?? INVOICE_LIST_MAX_ROWS;
  return {
    p_billing_month: filters.billing_month || undefined,
    p_view_status: filters.view_status ?? 'active',
    p_status: filters.status || undefined,
    p_payment_status: filters.payment_status,
    p_filter_building_ids: buildingIds,
    p_room_ids: roomIds,
    p_contract_id: filters.contract_id || undefined,
    p_issue_date_from: filters.date_range?.start || undefined,
    p_issue_date_to: filters.date_range?.end || undefined,
    p_amount_target: filters.amount_target ?? undefined,
    p_search: filters.search,
    p_adjustment_review_status: filters.adjustment_review_status,
    p_payment_method: filters.payment_method,
    p_limit: paged ? pageSize : INVOICE_LIST_MAX_ROWS,
    p_offset: paged ? (page - 1) * pageSize : 0,
  };
}

export function invoiceStatisticsRpcArgs(filters: InvoiceStatisticsArgsInput = {}) {
  // get_invoice_statistics_v2 áp CẢ p_building_id lẫn p_building_ids (AND) — giữ đúng giao đó.
  let buildingIds: string[] | undefined = filters.building_ids?.length ? filters.building_ids : undefined;
  if (filters.building_id) {
    buildingIds = buildingIds ? buildingIds.filter((id) => id === filters.building_id) : [filters.building_id];
  }
  return {
    p_billing_month: filters.billing_month,
    p_status: filters.status,
    p_payment_status: filters.payment_status,
    p_filter_building_ids: buildingIds,
    p_room_ids: filters.room_id ? [filters.room_id] : undefined,
    p_issue_date_from: filters.start_date,
    p_issue_date_to: filters.end_date,
  };
}

/** {total_count, rows} của invoice_list_v1; thiếu/hỏng thì ném, không thành "0 hoá đơn". */
export function readInvoiceListPayload(data: unknown): PaginatedData<InvoiceWithRelations> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Chưa đọc được đầy đủ danh sách tài chính.');
  }
  const payload = data as { total_count?: unknown; rows?: InvoiceWithRelations[] | null };
  return { data: financialReadRows(payload.rows), count: financialReadNumber(payload.total_count) };
}
