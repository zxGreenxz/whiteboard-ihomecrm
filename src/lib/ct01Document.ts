import type { Customer } from '@/types/customer';
import type { Building } from '@/types/building';

export type CT01Customer = Pick<Customer, 'full_name' | 'date_of_birth' | 'gender' | 'id_number' | 'phone' | 'email'>;
export type CT01Building = Pick<Building, 'id' | 'name' | 'street_address' | 'ward' | 'district' | 'province'>;

export class CT01InputError extends Error {}

export function buildCT01Data(customer: CT01Customer, building: CT01Building, now = new Date()): Record<string, string> {
  const ward = building.ward.trim();
  if (!ward) throw new CT01InputError('Tòa nhà chưa có phường/xã. Vui lòng cập nhật tòa nhà trước khi tải CT01.');
  if (!building.street_address?.trim()) throw new CT01InputError('Tòa nhà chưa có địa chỉ chi tiết. Vui lòng cập nhật tòa nhà trước khi tải CT01.');
  const id = customer.id_number?.trim() ?? '';
  if (id && !/^\d{1,12}$/.test(id)) throw new CT01InputError('Số định danh của khách không phù hợp với 12 ô của mẫu CT01. Vui lòng kiểm tra hồ sơ khách.');
  const birth = customer.date_of_birth?.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(now);
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  const genderLabels: Record<string, string> = { MALE: 'Nam', FEMALE: 'Nữ', OTHER: 'Khác' };
  const data: Record<string, string> = {
    registration_authority: `Công an ${/^(phường|xã|thị trấn|đặc khu)\s/i.test(ward) ? ward : `phường ${ward}`}`,
    full_name: customer.full_name.trim(),
    date_of_birth: birth ? `${birth[3]}/${birth[2]}/${birth[1]}` : '',
    gender: genderLabels[customer.gender ?? ''] ?? customer.gender ?? '', phone: customer.phone ?? '', email: customer.email ?? '',
    household_head_name: customer.full_name.trim(),
    building_address: [building.street_address, ward, building.district, building.province].map(value => value?.trim()).filter(Boolean).join(', '),
    signature_date: `ngày ${datePart('day')} tháng ${datePart('month')} năm ${datePart('year')}`,
  };
  for (let index = 0; index < 12; index++) {
    data[`id_${index + 1}`] = id[index] ?? '';
    data[`head_id_${index + 1}`] = id[index] ?? '';
  }
  return data;
}

export async function renderCT01Document(customer: CT01Customer, building: CT01Building, now = new Date()): Promise<Blob> {
  const data = buildCT01Data(customer, building, now);
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

export async function downloadCT01Document(customer: CT01Customer, building: CT01Building): Promise<void> {
  const blob = await renderCT01Document(customer, building);
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
