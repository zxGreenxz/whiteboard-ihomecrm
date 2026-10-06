// Một tệp Word gồm tờ khai CT01 + Hợp đồng cho thuê, mượn, ở nhờ của MỌI khách trong
// hợp đồng phòng, mỗi khách một bộ nối tiếp nhau — để quản lý in một lần cho cả phòng
// ký ngay lúc ký hợp đồng, thay vì mở từng khách tải CT01 riêng.
import { supabase } from '@/integrations/supabase/client';
import { loadBuildingLegalOwner } from './buildingLegalOwner';
import { mergeWordDocuments } from './docxMerge';
import {
  CT01InputError, assertCT01Lease, buildCT01Data, createCT01Renderer, wordBlob,
  type CT01Building, type CT01Customer, type CT01LeaseDetails,
} from './ct01Document';

export interface CT01RoomMember { customerId: string; isRepresentative: boolean; fallbackName?: string | null }

export interface CT01RoomBundleRequest {
  buildingId: string | null | undefined;
  roomNumber: string | null | undefined;
  members: readonly CT01RoomMember[];
  durationMonths: 12 | 24;
  requestedAt?: Date;
}

export interface CT01RoomBundle {
  /** null khi không khách nào đủ dữ liệu; `skipped` khi đó giải thích từng người. */
  blob: Blob | null;
  included: string[];
  skipped: Array<{ name: string; reason: string }>;
}

const CUSTOMER_COLUMNS = 'id, full_name, date_of_birth, gender, id_number, phone, email, id_issue_date, id_issue_place, detailed_address';

/** Người đại diện đứng đầu, những người còn lại giữ thứ tự trong hợp đồng; bỏ trùng. */
export function orderRoomMembers(members: readonly CT01RoomMember[]): CT01RoomMember[] {
  const seen = new Set<string>();
  return [...members].filter(member => member.customerId && !seen.has(member.customerId) && seen.add(member.customerId))
    .sort((left, right) => Number(right.isRepresentative) - Number(left.isRepresentative));
}

async function loadBuilding(buildingId: string): Promise<CT01Building> {
  const { data, error } = await supabase.from('buildings')
    .select('id, name, street_address, ward, district, province, organization_id')
    .eq('id', buildingId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw new CT01InputError('Không đọc được tòa nhà của hợp đồng. Kiểm tra tòa còn hoạt động và quyền xem tòa.');
  return data;
}

async function loadCustomers(ids: readonly string[]): Promise<Map<string, CT01Customer>> {
  const { data, error } = await supabase.from('customers').select(CUSTOMER_COLUMNS).in('id', [...ids]).is('deleted_at', null);
  if (error) throw error;
  return new Map((data ?? []).map(row => [row.id, row]));
}

export async function buildCT01RoomBundle(request: CT01RoomBundleRequest): Promise<CT01RoomBundle> {
  const requestedAt = request.requestedAt ?? new Date();
  const members = orderRoomMembers(request.members);
  if (members.length === 0) throw new CT01InputError('Hợp đồng chưa có khách nào để lập CT01.');
  if (!request.buildingId) throw new CT01InputError('Hợp đồng chưa gắn phòng/tòa nên chưa lập được CT01.');
  const [building, owner, customers] = await Promise.all([
    loadBuilding(request.buildingId), loadBuildingLegalOwner(request.buildingId), loadCustomers(members.map(member => member.customerId)),
  ]);
  if (!owner) throw new CT01InputError('Tòa nhà chưa có thông tin người đứng tên chủ quyền. Vui lòng bổ sung trong chỉnh sửa tòa nhà.');
  const lease: CT01LeaseDetails = { durationMonths: request.durationMonths, roomNumber: request.roomNumber ?? '', owner };
  // Lỗi của tòa/phòng/chủ quyền đúng cho cả phòng: báo một lần thay vì bỏ từng khách.
  assertCT01Lease(building, lease);

  const included: string[] = [];
  const skipped: CT01RoomBundle['skipped'] = [];
  const pages: Array<Record<string, string>> = [];
  for (const member of members) {
    const customer = customers.get(member.customerId);
    if (!customer) {
      skipped.push({ name: member.fallbackName?.trim() || 'Khách không tên', reason: 'Không đọc được hồ sơ khách (đã xoá hoặc không có quyền xem).' });
      continue;
    }
    try {
      pages.push(buildCT01Data(customer, building, lease, requestedAt));
      included.push(customer.full_name.trim());
    } catch (error) {
      if (!(error instanceof CT01InputError)) throw error;
      skipped.push({ name: customer.full_name.trim(), reason: error.message });
    }
  }
  if (pages.length === 0) return { blob: null, included, skipped };

  const render = await createCT01Renderer();
  const zips = pages.map(render);
  const documents = zips.map(zip => {
    const xml = zip.file('word/document.xml')?.asText();
    if (xml === undefined) throw new Error('Mẫu CT01 không có nội dung Word hợp lệ.');
    return xml;
  });
  // Mọi bản cùng mẫu nên styles/header/rId của bản đầu dùng chung được cho cả tệp.
  const base = zips[0];
  if (!base) throw new Error('Mẫu CT01 không có nội dung Word hợp lệ.');
  base.file('word/document.xml', mergeWordDocuments(documents));
  return { blob: wordBlob(base), included, skipped };
}
