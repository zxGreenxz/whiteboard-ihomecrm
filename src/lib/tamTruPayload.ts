// Gói dữ liệu điền form Đăng ký tạm trú trên Cổng DVC Bộ Công an. Thuần, không I/O.
// Cổng dùng đơn vị hành chính MỚI (tỉnh → phường, không có quận) nên phường lấy từ
// địa chỉ chi tiết của toà (cùng luật với buildCT01Data), không dùng cột ward cũ.
import type { DossierKind } from './residenceDossierFiles';

export interface TamTruAttachment { kind: DossierKind; fileName: string; contentType: string; url: string }

export interface TamTruPayload {
  version: 1;
  createdAt: string;
  customerId: string;
  buildingName: string;
  roomNumber: string;
  receive: { provinceName: string; wardName: string };
  person: { fullName: string; dob: string; genderCode: '2' | '3' | '4'; idNumber: string; phone: string; email: string };
  address: string;
  household: { relationshipCode: 'CH01' };
  tempResidentTo: string;
  attachments: TamTruAttachment[];
}

export class TamTruInputError extends Error {}

export interface TamTruCustomerInput {
  id: string; full_name: string; date_of_birth: string | null; gender: string | null;
  id_number: string | null; phone: string | null; email: string | null;
}
export interface TamTruBuildingInput { name: string; street_address: string | null; province: string }

const CENTRAL_CITIES = ['hồ chí minh', 'hà nội', 'đà nẵng', 'hải phòng', 'cần thơ', 'huế'];
const LOCALITY = /^(phường|xã|thị trấn|đặc khu)\s+\S/i;
const KIND_ORDER: DossierKind[] = ['CT01', 'LEASE', 'OWNERSHIP'];

function stripProvincePrefix(raw: string): string {
  return raw.trim().replace(/^(thành phố|tp\.?|tỉnh)\s+/i, '').trim();
}

function titleCaseVi(s: string): string {
  return s.split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toLocaleUpperCase('vi') + w.slice(1).toLocaleLowerCase('vi')).join(' ');
}

/** "Hồ Chí Minh" / "TP Hồ Chí Minh" → "Thành phố Hồ Chí Minh"; "Đồng Nai" → "Tỉnh Đồng Nai". */
export function normalizeProvinceName(raw: string): string {
  const core = titleCaseVi(stripProvincePrefix(raw));
  return CENTRAL_CITIES.includes(core.toLocaleLowerCase('vi')) ? `Thành phố ${core}` : `Tỉnh ${core}`;
}

/** Tách phần phường/xã mới khỏi địa chỉ chi tiết; address = các phần đứng trước phường. */
export function splitBuildingAddress(streetAddress: string): { address: string; wardName: string | null } {
  const parts = streetAddress.split(',').map(p => p.trim()).filter(Boolean);
  const idx = parts.findIndex(p => LOCALITY.test(p));
  if (idx < 0) return { address: parts.join(', '), wardName: null };
  return { address: parts.slice(0, idx).join(', '), wardName: parts[idx] };
}

/** Mã giới tính của cổng: 2 Nam, 3 Nữ, 4 Khác. CRM đang lưu lẫn "Nam" và "MALE". */
export function genderCode(raw: string | null | undefined): '2' | '3' | '4' | null {
  const v = (raw ?? '').trim().toLocaleLowerCase('vi');
  if (v === 'nam' || v === 'male') return '2';
  if (v === 'nữ' || v === 'female') return '3';
  if (v === 'khác' || v === 'other') return '4';
  return null;
}

function vnParts(now: Date): { day: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { day: get('day'), month: get('month'), year: get('year') };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Hạn tạm trú = hôm nay (giờ Việt Nam) + 12/24 tháng, kẹp 29/02 sang 28/02. */
export function tempResidentTo(now: Date, months: 12 | 24): string {
  const { day, month, year } = vnParts(now);
  const endYear = year + months / 12;
  const lastDay = new Date(Date.UTC(endYear, month, 0)).getUTCDate();
  return `${pad(Math.min(day, lastDay))}/${pad(month)}/${endYear}`;
}

function dobOf(value: string | null | undefined): string | null {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** dd/mm/yyyy có thật và còn ở tương lai so với hôm nay (giờ Việt Nam). */
export function ngayHanHopLe(value: string | null | undefined, now: Date = new Date()): value is string {
  const m = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false;
  const t = vnParts(now);
  return d.getTime() > Date.UTC(t.year, t.month - 1, t.day);
}

export function buildTamTruPayload(input: {
  customer: TamTruCustomerInput;
  building: TamTruBuildingInput;
  roomNumber: string;
  durationMonths: 12 | 24;
  /** Hạn ghi trên hợp đồng ở nhờ (đọc từ ảnh). Có thì dùng thay cho hôm nay + 12/24 tháng. */
  tempResidentTo?: string | null;
  attachments: TamTruAttachment[];
  now?: Date;
}): TamTruPayload {
  const { customer, building, attachments } = input;
  const now = input.now ?? new Date();
  const fullName = customer.full_name.trim();
  if (!fullName) throw new TamTruInputError('Khách chưa có họ tên.');
  const dob = dobOf(customer.date_of_birth);
  if (!dob) throw new TamTruInputError('Khách chưa có ngày sinh. Vui lòng cập nhật hồ sơ khách.');
  const gender = genderCode(customer.gender);
  if (!gender) throw new TamTruInputError('Khách chưa có giới tính. Vui lòng cập nhật hồ sơ khách.');
  const idNumber = (customer.id_number ?? '').trim();
  if (!/^\d{12}$/.test(idNumber)) throw new TamTruInputError('Số CCCD của khách phải đủ 12 số. Vui lòng kiểm tra hồ sơ khách.');
  if (!building.street_address?.trim()) throw new TamTruInputError('Toà nhà chưa có địa chỉ chi tiết. Vui lòng cập nhật toà nhà.');
  const { address, wardName } = splitBuildingAddress(building.street_address);
  if (!wardName) {
    throw new TamTruInputError('Địa chỉ chi tiết của toà chưa có phường/xã mới (ví dụ "…, Phường Hạnh Thông, …"). Vui lòng cập nhật toà nhà.');
  }
  if (!address) throw new TamTruInputError('Địa chỉ chi tiết của toà thiếu số nhà, đường phố trước phần phường.');
  const has = (k: DossierKind) => attachments.some(a => a.kind === k);
  if (!has('CT01')) throw new TamTruInputError('Chưa có ảnh tờ khai CT01 đã ký của khách.');
  if (!has('LEASE')) throw new TamTruInputError('Chưa có ảnh hợp đồng thuê đã ký của khách.');
  if (!has('OWNERSHIP')) throw new TamTruInputError('Toà nhà chưa có ảnh giấy tờ chứng minh chỗ ở hợp pháp. Bổ sung trong chỉnh sửa toà nhà.');
  return {
    version: 1,
    createdAt: now.toISOString(),
    customerId: customer.id,
    buildingName: building.name,
    roomNumber: input.roomNumber,
    receive: { provinceName: normalizeProvinceName(building.province), wardName },
    person: {
      fullName, dob, genderCode: gender, idNumber,
      phone: (customer.phone ?? '').trim(), email: (customer.email ?? '').trim(),
    },
    address,
    household: { relationshipCode: 'CH01' },
    // Hạn trên hợp đồng là nguồn đúng: tờ khai CT01 và hợp đồng đều ghi theo ngày
    // chủ tải giấy về in, còn hôm nay là ngày bấm nút — hai mốc đã từng lệch nhau.
    tempResidentTo: ngayHanHopLe(input.tempResidentTo, now) ? input.tempResidentTo : tempResidentTo(now, input.durationMonths),
    attachments: [...attachments].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
  };
}
