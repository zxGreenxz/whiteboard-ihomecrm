import { z } from 'zod';
import type { FilterKey, ZaloProfile } from '@/components/chat-zalo/types';

/**
 * Danh sách hội thoại Chat Zalo đọc qua MỘT hàm database dùng chung:
 * `public.zalo_conversation_list_v1` (migration 20261018051900). Web, Hermes và báo cáo gọi cùng
 * công thức: RLS của người gọi, lọc tài khoản/nhãn/thẻ, ẩn hội thoại chưa có tin khi không tìm,
 * tìm chữ thường trong tên/SĐT/nhãn phụ/tên phòng, ghim trước rồi tin mới nhất, phân trang và tổng.
 *
 * File này chỉ dựng tham số và kiểm hình dạng câu trả lời — không chứa công thức lọc nào.
 */

/** Khoá nhỏ của profile mà danh sách hiển thị; member maps lớn đi useZaloGroupMembers. */
export const PROFILE_FIELDS = ['kind', 'room', 'roomSub', 'price', 'contractCode', 'contractTerm', 'contractStatus', 'debt', 'issue', 'stage', 'source', 'company', 'phone', 'rooms', 'stats', 'isGroup', 'members', 'desc', 'staff', 'tags'] as const satisfies readonly (keyof ZaloProfile)[];

/** Cột của một dòng hội thoại mà hàm trả (cùng tập projection PostgREST cũ, trừ profile). */
export const CONV_FIELDS = ['id', 'account_id', 'peer_zalo_uid', 'label_ids', 'peer_name', 'initials', 'peer_avatar_url', 'tone', 'last_message_at', 'sub_label', 'sub_tone', 'last_message_text', 'unread_count', 'list_tag', 'is_online', 'header_tag', 'header_sub', 'peer_phone', 'is_pinned', 'is_muted', 'marked_unread', 'thread_type', 'customer_id', 'lead_id', 'contract_id', 'room_id', 'is_sale_partner'] as const;

/** Tham số RPC; chưa có trong generated types tới khi sinh lại types sau khi áp production. */
export interface ZaloConversationListArgs {
  p_organization_id: string;
  p_filter?: FilterKey;
  p_search?: string;
  p_account_ids?: string[];
  p_label_account_id?: string;
  p_label_id?: number;
  p_building_ids?: string[];
  p_limit?: number;
  p_offset: number;
}

export interface ZaloConversationListRequest {
  organizationId: string;
  /** Thẻ lọc của cột danh sách; bỏ trống = danh sách nền (mọi hội thoại, kể cả danh bạ chưa có tin). */
  filter?: FilterKey | null;
  search?: string;
  /** Tài khoản đang chọn; bỏ trống = không lọc tài khoản. */
  selectedAccountIds?: readonly string[] | null;
  /** Mọi tài khoản của công ty: chọn đủ cả thì không lọc tài khoản. */
  accountIds?: readonly string[];
  /** Khoá nhãn `${accountId}:${labelId}` (zaloLabelKey); bỏ trống = không lọc nhãn. */
  label?: string | null;
  limit?: number;
  offset?: number;
}

export function zaloConversationListArgs(request: ZaloConversationListRequest): ZaloConversationListArgs {
  const selected = request.selectedAccountIds ? new Set(request.selectedAccountIds) : null;
  const allSelected = !selected || (request.accountIds ?? []).every(id => selected.has(id));
  // Khoá nhãn hỏng thì gửi nguyên phần số: hàm từ chối (22023) thay vì bỏ lọc trong im lặng.
  const separator = request.label ? request.label.lastIndexOf(':') : -1;
  return {
    p_organization_id: request.organizationId,
    p_filter: request.filter ?? undefined,
    p_search: request.search?.trim() || undefined,
    p_account_ids: allSelected ? undefined : [...selected],
    p_label_account_id: request.label ? request.label.slice(0, separator) : undefined,
    p_label_id: request.label ? Number(request.label.slice(separator + 1)) : undefined,
    p_limit: request.limit,
    p_offset: request.offset ?? 0,
  };
}

const count = z.number().int().nonnegative().safe();
const rowSchema = z.object({
  id: z.string().uuid(),
  peer_name: z.string(),
  profile: z.record(z.string(), z.unknown()),
}).passthrough();
const listSchema = z.object({ total: count, rows: z.array(rowSchema) });

export interface ZaloConversationListResult {
  /** Dòng cùng hình dạng projection PostgREST cũ (`profile_<khoá>`) để mapConv đọc như trước. */
  rows: Record<string, unknown>[];
  total: number;
}

/** Kiểm câu trả lời trước khi đưa vào danh sách; lệch là lỗi, không phải danh sách rỗng. */
export function parseZaloConversationList(value: unknown, args: ZaloConversationListArgs): ZaloConversationListResult {
  const parsed = listSchema.parse(value);
  const ids = parsed.rows.map(row => row.id);
  if (
    parsed.rows.length > parsed.total
    || (args.p_limit !== undefined && parsed.rows.length > args.p_limit)
    || new Set(ids).size !== ids.length
    || parsed.rows.some(row => CONV_FIELDS.some(field => !(field in row))
      || Object.keys(row.profile).some(key => !(PROFILE_FIELDS as readonly string[]).includes(key)))
  ) {
    throw new TypeError('Danh sách hội thoại Zalo trả về không nhất quán.');
  }
  const rows = parsed.rows.map(({ profile, ...row }) => ({
    ...row,
    ...Object.fromEntries(Object.entries(profile).map(([key, value]) => [`profile_${key}`, value])),
  }));
  return { rows, total: parsed.total };
}
