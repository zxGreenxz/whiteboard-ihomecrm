import type PizZip from 'pizzip';
import type { Customer } from '@/types/customer';
import type { Building } from '@/types/building';
import type { BuildingLegalOwner } from './buildingLegalOwner';
import { normalizeProvinceName, titleCaseVi } from './tamTruPayload';

export type CT01Customer = Pick<Customer, 'full_name' | 'date_of_birth' | 'gender' | 'id_number' | 'phone' | 'email'
  | 'id_issue_date' | 'id_issue_place' | 'detailed_address'>;
export type CT01Building = Pick<Building, 'id' | 'name' | 'street_address' | 'ward' | 'district' | 'province'>
  // organization_id để ghi sổ hồ sơ tạm trú đúng công ty; tuỳ chọn vì mẫu CT01 không cần.
  & { organization_id?: string | null };
export interface CT01LeaseDetails {
  durationMonths: 12 | 24;
  roomNumber: string;
  owner: BuildingLegalOwner;
}

export class CT01InputError extends Error {}

function formatDate(value: string | null): string {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : '';
}

/** Phần kiểm chung của cả phòng (tòa, số phòng, chủ quyền, thời hạn) — lỗi ở đây đúng cho mọi khách. */
export function assertCT01Lease(building: CT01Building, lease: CT01LeaseDetails): void {
  if (!building.ward.trim()) throw new CT01InputError('Tòa nhà chưa có phường/xã. Vui lòng cập nhật tòa nhà trước khi tải CT01.');
  if (!building.street_address?.trim()) throw new CT01InputError('Tòa nhà chưa có địa chỉ chi tiết. Vui lòng cập nhật tòa nhà trước khi tải CT01.');
  if (lease.durationMonths !== 12 && lease.durationMonths !== 24) throw new CT01InputError('Vui lòng chọn thời hạn tạm trú 12 hoặc 24 tháng.');
  if (!lease.roomNumber.trim()) throw new CT01InputError('Hợp đồng đang ở chưa có số phòng. Vui lòng kiểm tra phòng trước khi tải.');
  if (!lease.owner.full_name.trim() || !lease.owner.id_number.trim()) {
    throw new CT01InputError('Tòa nhà chưa đủ họ tên và CCCD của người đứng tên chủ quyền. Vui lòng bổ sung trong chỉnh sửa tòa nhà.');
  }
}

export function buildCT01Data(customer: CT01Customer, building: CT01Building, lease: CT01LeaseDetails, now = new Date()): Record<string, string> {
  assertCT01Lease(building, lease);
  const ward = building.ward.trim();
  const id = customer.id_number?.trim() ?? '';
  if (id && !/^\d{1,12}$/.test(id)) throw new CT01InputError('Số định danh của khách không phù hợp với 12 ô của mẫu CT01. Vui lòng kiểm tra hồ sơ khách.');
  const birth = customer.date_of_birth?.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(now);
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  const genderLabels: Record<string, string> = { MALE: 'Nam', FEMALE: 'Nữ', OTHER: 'Khác' };
  // assertCT01Lease đã chặn địa chỉ trống; `?? ''` chỉ để TypeScript biết điều đó.
  const address = (building.street_address ?? '').trim();
  const localityPrefix = /^(phường|xã|thị trấn|đặc khu)\s+\S/i;
  const addressParts = address.split(',').map(value => value.trim());
  const localityIndex = addressParts.findIndex(value => localityPrefix.test(value));
  const fallbackLocality = localityPrefix.test(ward) ? ward : `phường ${ward}`;
  const locality = (localityIndex >= 0 ? addressParts[localityIndex] : undefined) ?? fallbackLocality;
  const registrationLocality = localityIndex >= 0 ? addressParts.slice(localityIndex).join(', ') : fallbackLocality;
  const endYear = Number(datePart('year')) + lease.durationMonths / 12;
  // Keep the Vietnamese calendar day, clamping 29 February in a non-leap year.
  const endDay = Math.min(Number(datePart('day')), new Date(Date.UTC(endYear, Number(datePart('month')), 0)).getUTCDate());
  const leaseEndDate = `${String(endDay).padStart(2, '0')}/${datePart('month')}/${endYear}`;
  const data: Record<string, string> = {
    registration_authority: `Công an ${registrationLocality}`,
    full_name: customer.full_name.trim(),
    date_of_birth: birth ? `${birth[3]}/${birth[2]}/${birth[1]}` : '',
    gender: genderLabels[customer.gender ?? ''] ?? customer.gender ?? '', phone: customer.phone ?? '', email: customer.email ?? '',
    household_head_name: customer.full_name.trim(),
    building_address: address, building_locality: locality,
    registration_request: `Đăng ký tạm trú ${lease.durationMonths} tháng tại ${address}`,
    duration_months: String(lease.durationMonths), room_number: lease.roomNumber.trim(),
    // Tòa thường lưu tên chủ quyền in hoa toàn bộ; in cùng kiểu với tên khách (hoa chữ đầu).
    owner_name: titleCaseVi(lease.owner.full_name), owner_birth_year: lease.owner.birth_year?.toString() ?? '',
    owner_id_number: lease.owner.id_number.trim(), owner_id_issue_date: formatDate(lease.owner.id_issue_date),
    owner_id_issue_place: lease.owner.id_issue_place.trim(), owner_permanent_address: lease.owner.permanent_address.trim(),
    customer_birth_year: birth?.[1] ?? '', customer_id_number: id,
    customer_id_issue_date: formatDate(customer.id_issue_date), customer_id_issue_place: customer.id_issue_place ?? '',
    customer_permanent_address: customer.detailed_address ?? '',
    download_date: `${datePart('day')}/${datePart('month')}/${datePart('year')}`, lease_end_date: leaseEndDate,
    signature_day: datePart('day'), signature_month: datePart('month'), signature_year: datePart('year'),
    signature_date: `ngày ${datePart('day')} tháng ${datePart('month')} năm ${datePart('year')}`,
  };
  for (let index = 0; index < 12; index++) {
    data[`id_${index + 1}`] = id[index] ?? '';
    data[`head_id_${index + 1}`] = id[index] ?? '';
  }
  return data;
}

export interface CT01HuyDetails {
  roomNumber: string;
  owner: BuildingLegalOwner;
  /** yyyy-mm-dd ngày chấm dứt (hệ thống quyết); null thì lấy ngày tải (now). */
  endDate: string | null;
}

/** Chỗ trống để viết tay khi hồ sơ chưa có dữ liệu. */
const HANDWRITE_BLANK = '……………';
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const parts = value.match(DATE_ONLY);
  if (!parts) return false;
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** Kiểm chung của giấy hủy tạm trú (không có thời hạn như đăng ký). */
export function assertCT01HuyInput(building: CT01Building, details: CT01HuyDetails): void {
  if (!building.street_address?.trim()) throw new CT01InputError('Tòa nhà chưa có địa chỉ chi tiết. Vui lòng cập nhật tòa nhà trước khi tải giấy hủy tạm trú.');
  if (!details.roomNumber.trim()) throw new CT01InputError('Hợp đồng chưa có số phòng. Vui lòng kiểm tra phòng trước khi tải giấy hủy tạm trú.');
  if (!details.owner.full_name.trim() || !details.owner.id_number.trim()) {
    throw new CT01InputError('Tòa nhà chưa đủ họ tên và CCCD của người đứng tên chủ quyền. Vui lòng bổ sung trong chỉnh sửa tòa nhà trước khi tải giấy hủy tạm trú.');
  }
  // Chỉ nhận ngày thuần: một mốc giờ UTC cắt lấy ngày có thể lệch một ngày so với giờ Việt Nam.
  if (details.endDate !== null && !isCalendarDate(details.endDate)) {
    throw new CT01InputError('Ngày chấm dứt hợp đồng không hợp lệ nên không lập được biên bản thanh lý. Vui lòng kiểm tra hợp đồng.');
  }
}

/**
 * Dữ liệu mẫu templates/ct01-huy.docx: tờ khai CT01 hủy tạm trú + biên bản thanh lý hợp đồng thuê nhà.
 * Dùng lại buildCT01Data cho phần CT01; thời hạn 12 tháng chỉ để qua kiểm của hàm đó — mẫu hủy
 * không in duration_months/lease_end_date/download_date.
 */
export function buildCT01HuyData(customer: CT01Customer, building: CT01Building, details: CT01HuyDetails, now = new Date()): Record<string, string> {
  assertCT01HuyInput(building, details);
  const data = buildCT01Data(customer, building, { durationMonths: 12, roomNumber: details.roomNumber, owner: details.owner }, now);
  const orBlank = (value: string | null | undefined) => value?.trim() || HANDWRITE_BLANK;
  const end = details.endDate?.match(DATE_ONLY);
  const province = building.province?.trim();
  return {
    ...data,
    registration_request: `Hủy tạm trú tại ${data.building_address}`,
    tl_city: province ? normalizeProvinceName(province) : HANDWRITE_BLANK,
    // Ngày thanh lý do hệ thống quyết, không bao giờ để trống: thiếu ngày chấm dứt thì lấy ngày tải.
    tl_end_date: end ? `ngày ${end[3]} tháng ${end[2]} năm ${end[1]}` : data.signature_date ?? '',
    tl_owner_birth_year: orBlank(data.owner_birth_year),
    tl_owner_id_issue_date: orBlank(data.owner_id_issue_date),
    tl_owner_id_issue_place: orBlank(data.owner_id_issue_place),
    tl_owner_permanent_address: orBlank(data.owner_permanent_address),
    tl_customer_birth: orBlank(data.date_of_birth),
    // Trong mẫu hủy, customer_id_number chỉ in ở biên bản (CT01 dùng id_1…id_12).
    customer_id_number: orBlank(data.customer_id_number),
    tl_customer_id_issue_date: orBlank(data.customer_id_issue_date),
    tl_customer_id_issue_place: orBlank(data.customer_id_issue_place),
    tl_customer_permanent_address: orBlank(data.customer_permanent_address),
  };
}

async function createTemplateRenderer(fileName: string, missingMessage: string): Promise<(data: Record<string, string>) => PizZip> {
  const [{ default: Docxtemplater }, { default: PizZipClass }, response] = await Promise.all([
    import('docxtemplater'), import('pizzip'), fetch(`${import.meta.env.BASE_URL}templates/${fileName}`),
  ]);
  if (!response.ok) throw new Error(missingMessage);
  const template = await response.arrayBuffer();
  return data => {
    const document = new Docxtemplater(new PizZipClass(template), {
      paragraphLoop: true, linebreaks: true, nullGetter: () => '',
    });
    document.render(data);
    return document.getZip();
  };
}

/** Tải mẫu một lần, trả hàm điền dữ liệu; mỗi lần gọi dựng một bản Word riêng từ cùng byte mẫu. */
export async function createCT01Renderer(): Promise<(data: Record<string, string>) => PizZip> {
  return createTemplateRenderer('ct01.docx', 'Không tải được mẫu CT01. Vui lòng thử lại.');
}

export function wordBlob(zip: PizZip): Blob {
  return zip.generate({
    type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE',
  });
}

export async function renderCT01Document(customer: CT01Customer, building: CT01Building, lease: CT01LeaseDetails, now = new Date()): Promise<Blob> {
  const data = buildCT01Data(customer, building, lease, now);
  const render = await createCT01Renderer();
  return wordBlob(render(data));
}

/** Bỏ ký tự điều khiển và ký tự Windows cấm trong tên tệp. */
function safeFileName(raw: string): string {
  return Array.from(raw).filter(character => character.charCodeAt(0) >= 32)
    .join('').replace(/[<>:"/\\|?*]/g, '').trim();
}

export function downloadWordBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  // Giữ URL cho trình duyệt kịp bắt đầu tải (đặc biệt trên thiết bị di động).
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadCT01Document(customer: CT01Customer, building: CT01Building, lease: CT01LeaseDetails, requestedAt = new Date()): Promise<void> {
  const blob = await renderCT01Document(customer, building, lease, requestedAt);
  downloadWordBlob(blob, `CT01 - ${safeFileName(customer.full_name) || 'Khach hang'}.docx`);
}

export async function renderCT01HuyDocument(customer: CT01Customer, building: CT01Building, details: CT01HuyDetails, now = new Date()): Promise<Blob> {
  const data = buildCT01HuyData(customer, building, details, now);
  const render = await createTemplateRenderer('ct01-huy.docx', 'Không tải được mẫu CT01 hủy tạm trú. Vui lòng thử lại.');
  return wordBlob(render(data));
}

export async function downloadCT01HuyDocument(customer: CT01Customer, building: CT01Building, details: CT01HuyDetails, requestedAt = new Date()): Promise<void> {
  const blob = await renderCT01HuyDocument(customer, building, details, requestedAt);
  downloadWordBlob(blob, `CT01 huy tam tru - ${safeFileName(customer.full_name) || 'Khach hang'}.docx`);
}
