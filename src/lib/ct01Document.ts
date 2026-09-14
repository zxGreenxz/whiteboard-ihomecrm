import type { Customer } from '@/types/customer';
import type { Building } from '@/types/building';
import type { BuildingLegalOwner } from './buildingLegalOwner';

export type CT01Customer = Pick<Customer, 'full_name' | 'date_of_birth' | 'gender' | 'id_number' | 'phone' | 'email'
  | 'id_issue_date' | 'id_issue_place' | 'detailed_address'>;
export type CT01Building = Pick<Building, 'id' | 'name' | 'street_address' | 'ward' | 'district' | 'province'>;
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

export function buildCT01Data(customer: CT01Customer, building: CT01Building, lease: CT01LeaseDetails, now = new Date()): Record<string, string> {
  const ward = building.ward.trim();
  if (!ward) throw new CT01InputError('Tòa nhà chưa có phường/xã. Vui lòng cập nhật tòa nhà trước khi tải CT01.');
  if (!building.street_address?.trim()) throw new CT01InputError('Tòa nhà chưa có địa chỉ chi tiết. Vui lòng cập nhật tòa nhà trước khi tải CT01.');
  const id = customer.id_number?.trim() ?? '';
  if (id && !/^\d{1,12}$/.test(id)) throw new CT01InputError('Số định danh của khách không phù hợp với 12 ô của mẫu CT01. Vui lòng kiểm tra hồ sơ khách.');
  if (lease.durationMonths !== 12 && lease.durationMonths !== 24) throw new CT01InputError('Vui lòng chọn thời hạn tạm trú 12 hoặc 24 tháng.');
  if (!lease.roomNumber.trim()) throw new CT01InputError('Hợp đồng đang ở chưa có số phòng. Vui lòng kiểm tra phòng trước khi tải.');
  if (!lease.owner.full_name.trim() || !lease.owner.id_number.trim()) {
    throw new CT01InputError('Tòa nhà chưa đủ họ tên và CCCD của người đứng tên chủ quyền. Vui lòng bổ sung trong chỉnh sửa tòa nhà.');
  }
  const birth = customer.date_of_birth?.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(now);
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  const genderLabels: Record<string, string> = { MALE: 'Nam', FEMALE: 'Nữ', OTHER: 'Khác' };
  const address = building.street_address.trim();
  const localityPrefix = /^(phường|xã|thị trấn|đặc khu)\s+\S/i;
  const locality = address.split(',').map(value => value.trim()).find(value => localityPrefix.test(value))
    ?? (localityPrefix.test(ward) ? ward : `phường ${ward}`);
  const endYear = Number(datePart('year')) + lease.durationMonths / 12;
  // Keep the Vietnamese calendar day, clamping 29 February in a non-leap year.
  const endDay = Math.min(Number(datePart('day')), new Date(Date.UTC(endYear, Number(datePart('month')), 0)).getUTCDate());
  const leaseEndDate = `${String(endDay).padStart(2, '0')}/${datePart('month')}/${endYear}`;
  const data: Record<string, string> = {
    registration_authority: `Công an ${/^(phường|xã|thị trấn|đặc khu)\s/i.test(ward) ? ward : `phường ${ward}`}`,
    full_name: customer.full_name.trim(),
    date_of_birth: birth ? `${birth[3]}/${birth[2]}/${birth[1]}` : '',
    gender: genderLabels[customer.gender ?? ''] ?? customer.gender ?? '', phone: customer.phone ?? '', email: customer.email ?? '',
    household_head_name: customer.full_name.trim(),
    building_address: address, building_locality: locality,
    registration_request: `Đăng ký tạm trú ${lease.durationMonths} tháng tại ${address}`,
    duration_months: String(lease.durationMonths), room_number: lease.roomNumber.trim(),
    owner_name: lease.owner.full_name.trim(), owner_birth_year: lease.owner.birth_year?.toString() ?? '',
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

export async function renderCT01Document(customer: CT01Customer, building: CT01Building, lease: CT01LeaseDetails, now = new Date()): Promise<Blob> {
  const data = buildCT01Data(customer, building, lease, now);
  const [{ default: Docxtemplater }, { default: PizZip }, response] = await Promise.all([
    import('docxtemplater'), import('pizzip'), fetch(`${import.meta.env.BASE_URL}templates/ct01.docx`),
  ]);
  if (!response.ok) throw new Error('Không tải được mẫu CT01. Vui lòng thử lại.');
  const document = new Docxtemplater(new PizZip(await response.arrayBuffer()), {
    paragraphLoop: true, linebreaks: true, nullGetter: () => '',
  });
  document.render(data);
  return document.getZip().generate({
    type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE',
  });
}

export async function downloadCT01Document(customer: CT01Customer, building: CT01Building, lease: CT01LeaseDetails, requestedAt = new Date()): Promise<void> {
  const blob = await renderCT01Document(customer, building, lease, requestedAt);
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  const safeName = Array.from(customer.full_name).filter(character => character.charCodeAt(0) >= 32)
    .join('').replace(/[<>:"/\\|?*]/g, '').trim();
  link.download = `CT01 - ${safeName || 'Khach hang'}.docx`;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  // Giữ URL cho trình duyệt kịp bắt đầu tải (đặc biệt trên thiết bị di động).
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
