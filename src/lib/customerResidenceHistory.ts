import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { sameContractCustomers, type ContractRelationSnapshot } from './contractRelationReconcile';
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
});
const accommodation = z.object({
  contract_id: uuid,
  building_id: uuid.nullable(),
  room_id: uuid.nullable(),
  building_name: z.string().nullable(),
  room_name: z.string().nullable()
});
const summary = z.object({
  customer_id: uuid,
  state: z.enum(['CURRENT', 'DEPARTED', 'NONE', 'UNKNOWN']),
  current_accommodations: z.array(accommodation),
  departure_date: date.nullable(),
  departure_kind: z.string().min(1).nullable().default(null),
  incomplete: z.boolean(),
  last_contract_end: z.object({ contract_id: uuid, date }).nullable().default(null)
});
const event = z.object({
  id: z.number().int().positive().safe(),
  organization_id: uuid,
  customer_id: uuid,
  contract_id: uuid,
  building_id: uuid.nullable(),
  room_id: uuid.nullable(),
  building_name: z.string().nullable(),
  room_name: z.string().nullable(),
  contract_number: z.string().nullable(),
  kind: z.string().min(1),
  effective_date: date.nullable(),
  recorded_at: z.string().datetime({ offset: true }),
  reason: z.string().nullable(),
  actor_id: uuid.nullable(),
  actor_name: z.string().nullable(),
  incomplete: z.boolean()
});
const contractContext = z.object({
  contract_id: uuid,
  contract_number: z.string().nullable(),
  status: z.string().min(1),
  building_id: uuid.nullable(),
  room_id: uuid.nullable(),
  building_name: z.string().nullable(),
  room_name: z.string().nullable(),
  signed_date: date.nullable(),
  start_date: date.nullable(),
  end_date: date.nullable(),
  actual_end_date: date.nullable(),
  room_segments: z.array(z.object({
    room_id: uuid,
    room_name: z.string().nullable(),
    building_name: z.string().nullable(),
    from_date: date.nullable(),
    to_date: date.nullable(),
    source_path: z.string(),
    trusted: z.boolean(),
    diagnostic: z.string().nullable()
  }))
});
const history = z.object({
  events: z.array(event),
  next_before_id: z.number().int().positive().safe().nullable(),
  contract_contexts: z.array(contractContext).default([])
});
export type CustomerResidenceSummary = z.infer<typeof summary>;
export type CustomerResidenceEvent = z.infer<typeof event>;
export type CustomerResidencePage = z.infer<typeof history>;
export type CustomerResidenceContractContext = z.infer<typeof contractContext>;
export function parseResidenceSummaries(value: unknown, ids: readonly string[]): CustomerResidenceSummary[] {
  const rows = z.array(summary).parse(value);
  const expected = new Set(ids);
  if (rows.length !== expected.size || new Set(rows.map(row => row.customer_id)).size !== expected.size || rows.some(row => !expected.has(row.customer_id) || (row.state === 'CURRENT') !== (row.current_accommodations.length > 0) || (['CURRENT', 'NONE', 'UNKNOWN'].includes(row.state) && row.departure_date !== null) || (row.last_contract_end !== null && (row.state !== 'DEPARTED' || row.departure_date !== null))))
    throw new TypeError('Chưa nhận được đầy đủ tóm tắt lưu trú.');
  return rows;
}
export function parseResidenceHistory(value: unknown, org: string, customer: string): CustomerResidencePage {
  const page = history.parse(value);
  if (page.events.some((row, i) => {
    const previous = page.events[i - 1];
    return row.organization_id !== org || row.customer_id !== customer || (previous !== undefined && row.id >= previous.id);
  }) || (page.next_before_id !== null && page.next_before_id !== page.events.at(-1)?.id)
    || new Set(page.contract_contexts.map(context => context.contract_id)).size !== page.contract_contexts.length)
    throw new TypeError('Trang lịch sử lưu trú không hợp lệ.');
  return page;
}
export const residenceDate = (value: string | null) => value ? value.split('-').reverse().join('/') : 'Chưa rõ ngày';
export function residenceSummaryLabel(value: CustomerResidenceSummary): string {
  if (value.state === 'CURRENT')
    return value.current_accommodations.map(room => [room.building_name, room.room_name ? `Phòng ${room.room_name}` : 'Phòng chưa rõ'].filter(Boolean).join(' · ')).join('; ');
  if (value.state === 'DEPARTED') {
    if (value.last_contract_end)
      return `Kết thúc HĐ · ${residenceDate(value.last_contract_end.date)}`;
    if (value.departure_kind === 'CONTRACT_DELETED')
      return 'Hợp đồng đã xóa';
    if (value.departure_date) {
      const labels: Record<string, string> = {
        MEMBER_REMOVED: 'Gỡ khỏi HĐ', TENANT_TRANSFER_OUT: 'Nhượng HĐ', TERMINATED: 'Kết thúc HĐ',
        EARLY_RETURN: 'Đã rời', ON_TIME_RETURN: 'Đã rời', NATURAL_EXPIRY: 'Đã rời', FORFEIT: 'Bỏ cọc HĐ'
      };
      const label = value.departure_kind ? labels[value.departure_kind] : undefined;
      if (label) return `${label} · ${residenceDate(value.departure_date)}`;
    }
    return 'Không còn HĐ đang ở';
  }
  return value.state === 'NONE' ? 'Chưa liên kết hợp đồng' : 'Chưa đủ quyền xác định lưu trú';
}
export const residenceEventLabels: Record<string, string> = {
  OBSERVED: 'Liên kết hợp đồng từ dữ liệu cũ',
  CHECKED_IN: 'Ghi nhận ký HĐ / nhận phòng',
  CONTRACT_ACTIVATED: 'Kích hoạt hợp đồng',
  MEMBER_ADDED: 'Được thêm vào hợp đồng',
  MEMBER_REMOVED: 'Được gỡ khỏi hợp đồng',
  TENANT_TRANSFER_OUT: 'Nhượng hợp đồng',
  TENANT_TRANSFER_IN: 'Nhận nhượng hợp đồng',
  ROOM_CHANGED: 'Chuyển phòng',
  RENEWED: 'Gia hạn',
  TERMINATED: 'Kết thúc hợp đồng',
  EARLY_RETURN: 'Trả phòng sớm',
  ON_TIME_RETURN: 'Trả phòng hết hạn',
  NATURAL_EXPIRY: 'Trả phòng hết hạn',
  FORFEIT: 'Bỏ cọc',
  CONTRACT_DELETED: 'Xóa hợp đồng'
};
// RPC arguments are checked against the generated Supabase schema. JSON replies
// still pass through the runtime domain validators below.
async function rpcData(request: PromiseLike<{ data: unknown; error: unknown }>) {
  const result = await request;
  if (result.error) throw result.error;
  return result.data;
}
export async function readResidenceSummaries(org: string, ids: readonly string[]) {
  if (!org)
    throw new Error('Chưa chọn tổ chức.');
  if (!ids.length)
    return [];
  const result: CustomerResidenceSummary[] = [];
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    result.push(...parseResidenceSummaries(await rpcData(supabase.rpc('get_customer_residence_summaries_v1', { p_organization_id: org, p_customer_ids: chunk })), chunk));
  }
  return result;
}
export async function readResidenceHistory(org: string, customer: string, before: number | null = null) {
  const page = parseResidenceHistory(await rpcData(supabase.rpc('get_customer_residence_history_v1', {
    p_organization_id: org,
    p_customer_id: customer,
    p_before_id: before ?? undefined,
    p_limit: 50
  })), org, customer);
  if (before !== null && page.events.some(row => row.id >= before))
    throw new TypeError('Lịch sử không tiến sang trang kế tiếp.');
  return page;
}
export async function reconcileResidenceMembers(org: string, contract: string, expected: ContractRelationSnapshot['customers'], desired: ContractRelationSnapshot['customers']) {
  const data = await rpcData(supabase.rpc('reconcile_contract_customers_v1', {
    p_organization_id: org,
    p_contract_id: contract,
    p_expected: expected,
    p_customers: desired
  }));
  const parsed = z.array(z.object({ customer_id: z.string().min(1), is_representative: z.boolean(), notes: z.string().nullable() })).parse(data);
  const rows = parsed.map(row => {
    if (typeof row.customer_id !== 'string' || typeof row.is_representative !== 'boolean' || (row.notes !== null && typeof row.notes !== 'string'))
      throw new TypeError('Biên nhận khách hàng không đầy đủ.');
    return { customer_id: row.customer_id, is_representative: row.is_representative, notes: row.notes };
  });
  if (!sameContractCustomers(rows, desired))
    throw new TypeError('Chưa xác nhận được đầy đủ khách hàng của hợp đồng.');
  return rows;
}
export async function readResidenceLocationIds(org: string, building?: string, room?: string, includeHistory = false) {
  const ids: string[] = [];
  let after: string | null = null;
  for (; ;) {
    const page = z.array(uuid).parse(await rpcData(supabase.rpc('get_customer_residence_location_ids_v1', {
      p_organization_id: org,
      p_building_id: building,
      p_room_id: room,
      p_include_history: includeHistory,
      p_after_id: after ?? undefined,
      p_limit: 500
    })));
    if (page.some((id, i) => {
      const previous = page[i - 1] ?? after;
      return previous !== null && id <= previous;
    }))
      throw new TypeError('Trang lọc lưu trú không hợp lệ.');
    ids.push(...page);
    if (page.length < 500)
      return ids;
    after = page.at(-1)!;
  }
}
