import { z } from 'zod';
import type { Database } from '@/integrations/supabase/types';
import type { Customer, CustomerFilters, CustomerStats } from '@/types/customer';

/**
 * Màn Khách hàng đọc qua MỘT hàm database dùng chung: `public.customer_list_v1`
 * (migration 20261017115708). Web, Hermes và báo cáo gọi cùng công thức: RLS của người
 * gọi, lọc trạng thái/thẻ loại, tìm không dấu (customer_search_patterns_v1 = bản SQL của
 * customerSearchFilter), lọc toà/phòng theo lưu trú, sắp created_at desc, phân trang, tổng
 * và khối thống kê.
 *
 * File này chỉ dựng tham số và kiểm hình dạng câu trả lời — không chứa công thức nào.
 */
export type CustomerListArgs = Database['public']['Functions']['customer_list_v1']['Args'];

export interface CustomerListRequest {
  organizationId: string;
  filters?: CustomerFilters;
  /** Trang 1-based như usePagination. Bỏ trống ⇒ toàn bộ danh sách (picker hợp đồng). */
  pagination?: { page: number; pageSize: number };
  /** Kèm toà/phòng hiện tại (current_building_*) cho kiểm phạm vi nút Sửa/Xoá. */
  includeLocation: boolean;
  /** Chỉ lấy khối thống kê: không tải dòng nào. */
  statsOnly?: boolean;
}

export function customerListArgs(request: CustomerListRequest): CustomerListArgs {
  const filters = request.filters ?? {};
  const { page, pageSize } = request.pagination ?? { page: 0, pageSize: 0 };
  const wantsPage = !request.statsOnly && page > 0 && pageSize > 0;
  const kind = filters.statFilter && filters.statFilter !== 'ALL' && !request.statsOnly ? filters.statFilter : undefined;
  return {
    p_organization_id: request.organizationId,
    p_status: filters.status || undefined,
    p_kind: kind,
    p_search: filters.search?.trim() || undefined,
    p_building_ids: filters.building_id ? [filters.building_id] : undefined,
    p_room_id: filters.room_id || undefined,
    p_limit: request.statsOnly ? 0 : wantsPage ? pageSize : undefined,
    p_offset: wantsPage ? (page - 1) * pageSize : 0,
    p_include_location: request.statsOnly ? false : request.includeLocation,
  };
}

const count = z.number().int().nonnegative().safe();
const statsSchema = z.object({ total: count, individual: count, organization: count, foreign: count });
const rowSchema = z.object({ id: z.string().uuid(), created_at: z.string().min(1) }).passthrough();
const listSchema = z.object({ total: count, stats: statsSchema, rows: z.array(rowSchema) });

export interface CustomerListResult {
  rows: Customer[];
  total: number;
  stats: CustomerStats;
}

/** Kiểm câu trả lời trước khi đưa vào bảng; lệch là lỗi, không phải danh sách rỗng. */
export function parseCustomerList(value: unknown, args: CustomerListArgs): CustomerListResult {
  const parsed = listSchema.parse(value);
  const ids = parsed.rows.map(row => row.id);
  if (
    parsed.rows.length > parsed.total
    || (args.p_limit !== undefined && args.p_limit !== null && parsed.rows.length > args.p_limit)
    || parsed.total > parsed.stats.total
    || new Set(ids).size !== ids.length
    || parsed.rows.some(row => args.p_include_location !== false && !('current_building_id' in row))
  ) {
    throw new TypeError('Danh sách khách hàng trả về không nhất quán.');
  }
  const { total, individual, organization, foreign } = parsed.stats;
  return { rows: parsed.rows as unknown as Customer[], total: parsed.total, stats: { total, individual, organization, foreign } };
}
