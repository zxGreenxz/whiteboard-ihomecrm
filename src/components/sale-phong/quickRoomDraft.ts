import { saleRoomPatchSchema } from '@/lib/saleRoomOperations';
import { parseCurrencyAmount } from '@/lib/currencyAmountInput';

/**
 * Giá thuê/tháng ngoài khoảng này thường là gõ thiếu/thừa số 0. Chỉ cảnh báo, không chặn:
 * phòng cao cấp hoặc giá tượng trưng vẫn lưu được khi người sửa cố ý.
 */
export const QUICK_ROOM_PRICE_LOW = 500_000;
export const QUICK_ROOM_PRICE_HIGH = 100_000_000;

export interface QuickRoomValues {
  rentPrice: number | null;
  area: number | null;
  roomType: string | null;
  amenities: string[];
  saleNote: string | null;
  saleBonusNote: string | null;
  description?: string | null;
  images: string[];
}

export interface QuickRoomDraft {
  revision: string;
  original: QuickRoomValues;
  price: string;
  area: string;
  roomType: string;
  amenities: string;
  saleNote: string;
  saleBonusNote: string;
  description: string;
  images: string[];
  request?: { fingerprint: string; id: string; unknown?: boolean; conflict?: boolean; patch?: QuickRoomPatch };
}

export interface QuickRoomPatch {
  rent_price?: number;
  area?: number | null;
  room_type?: string | null;
  amenities?: string[];
  sale_note?: string | null;
  sale_bonus_note?: string | null;
  description?: string | null;
  images?: string[];
}

export function newQuickRoomDraft(values: QuickRoomValues, revision: string): QuickRoomDraft {
  return {
    revision,
    original: {
      rentPrice: values.rentPrice, area: values.area, roomType: values.roomType,
      saleNote: values.saleNote, saleBonusNote: values.saleBonusNote, description: values.description ?? null,
      amenities: [...values.amenities], images: [...values.images],
    },
    price: values.rentPrice == null ? '' : String(values.rentPrice),
    area: values.area == null ? '' : String(values.area),
    roomType: values.roomType ?? '',
    amenities: values.amenities.join('\n'),
    saleNote: values.saleNote ?? '',
    saleBonusNote: values.saleBonusNote ?? '',
    description: values.description ?? '',
    images: [...values.images],
  };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Ô nhập khác chữ ban đầu (kể cả chỉ đổi cách viết giá): giữ nguyên chữ người dùng đang gõ trên màn hình. */
export function quickRoomDraftTextChanged(draft: QuickRoomDraft): boolean {
  const original = newQuickRoomDraft(draft.original, draft.revision);
  return (['price', 'area', 'roomType', 'amenities', 'saleNote', 'saleBonusNote', 'description', 'images'] as const)
    .some(key => !same(draft[key], original[key]));
}

/**
 * Compare raw fields too: invalid numeric text is still an unsaved draft. Giá so theo giá trị đọc được:
 * chỉ đổi cách viết ("4250000" ⇄ "4.250.000") không phải bản nháp.
 */
export function quickRoomDraftDirty(draft: QuickRoomDraft): boolean {
  const original = newQuickRoomDraft(draft.original, draft.revision);
  const price = parseCurrencyAmount(draft.price).value;
  if (!same(draft.price, original.price) && (price == null || price !== draft.original.rentPrice)) return true;
  return (['area', 'roomType', 'amenities', 'saleNote', 'saleBonusNote', 'description', 'images'] as const)
    .some(key => !same(draft[key], original[key]));
}

export function quickRoomChanges(draft: QuickRoomDraft, permission: { edit: boolean; images: boolean }) {
  const patch: QuickRoomPatch = {};
  const errors: Record<string, string> = {};
  if (permission.edit) {
    const original = newQuickRoomDraft(draft.original, draft.revision);
    const changed = (field: keyof QuickRoomDraft) => !same(draft[field], original[field]);
    const price = draft.price.trim();
    // Nhận cả kiểu app tự hiển thị ("4.250.000", "4 250 000"); số lẻ, số âm, chữ vẫn bị giữ lại để sửa.
    const rentPrice = parseCurrencyAmount(price).value;
    const area = draft.area.trim().replace(',', '.');
    // So theo giá trị đọc được: gõ lại "4.250.000" cho giá 4250000 không phải là sửa giá.
    const priceChanged = changed('price') && (rentPrice == null || rentPrice !== draft.original.rentPrice);
    if (priceChanged && rentPrice == null) errors.price = 'Nhập giá nguyên không âm bằng đồng, ví dụ 4.250.000; không để trống.';
    else if (priceChanged && !saleRoomPatchSchema.safeParse({ rent_price: rentPrice }).success) errors.price = 'Giá niêm yết không vượt quá 9.999.999.999.999 đồng.';
    if (changed('area') && area && (!/^\d+(?:\.\d{1,2})?$/.test(area) || !Number.isFinite(Number(area)) || Number(area) > 1_000_000)) errors.area = 'Nhập diện tích từ 0 đến 1.000.000 m², tối đa 2 số thập phân.';
    if (changed('roomType') && draft.roomType.trim().length > 200) errors.roomType = 'Loại phòng tối đa 200 ký tự.';
    if (changed('saleNote') && draft.saleNote.trim().length > 2000) errors.saleNote = 'Thông tin công khai tối đa 2000 ký tự.';
    if (changed('saleBonusNote') && draft.saleBonusNote.trim().length > 2000) errors.saleBonusNote = 'Ghi chú nội bộ tối đa 2000 ký tự.';
    if (changed('description') && draft.description.trim().length > 2000) errors.description = 'Mô tả phòng tối đa 2000 ký tự.';
    const amenities = [...new Set(draft.amenities.split('\n').map(value => value.trim()).filter(Boolean))];
    if (changed('amenities') && (amenities.length > 50 || amenities.some(value => value.length > 200))) errors.amenities = 'Tối đa 50 nội thất, mỗi dòng không quá 200 ký tự.';
    const fields = {
      ...(priceChanged && rentPrice != null ? { rent_price: rentPrice } : {}),
      ...(changed('area') ? { area: area ? Number(area) : null } : {}),
      ...(changed('roomType') ? { room_type: draft.roomType.trim() || null } : {}),
      ...(changed('amenities') ? { amenities } : {}),
      ...(changed('saleNote') ? { sale_note: draft.saleNote.trim() || null } : {}),
      ...(changed('saleBonusNote') ? { sale_bonus_note: draft.saleBonusNote.trim() || null } : {}),
      ...(changed('description') ? { description: draft.description.trim() || null } : {}),
    };
    const before = {
      rent_price: draft.original.rentPrice,
      area: draft.original.area,
      room_type: draft.original.roomType,
      amenities: draft.original.amenities,
      sale_note: draft.original.saleNote,
      sale_bonus_note: draft.original.saleBonusNote,
      description: draft.original.description ?? null,
    };
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      if (!same(fields[key], before[key])) Object.assign(patch, { [key]: fields[key] });
    }
  }
  if (permission.images && !same(draft.images, draft.original.images)) {
    if (!saleRoomPatchSchema.safeParse({ images: draft.images }).success) errors.images = 'Tối đa 50 ảnh hợp lệ; ảnh phải được tải lên trước khi lưu.';
    patch.images = [...draft.images];
  }
  return { patch, errors };
}

/** Cảnh báo (không chặn lưu) khi giá đọc được là 0 đ hoặc lệch hẳn mức thuê phòng thường gặp. */
export function quickRoomPriceWarning(price: string): string | null {
  const value = parseCurrencyAmount(price).value;
  if (value == null) return null;
  if (value === 0) return 'Giá 0 đ sẽ hiện đúng như vậy cho sale và khách. Kiểm tra lại nếu không cố ý.';
  if (value < QUICK_ROOM_PRICE_LOW) return 'Giá dưới 500.000 đ/tháng — kiểm tra có thiếu số 0 không. Vẫn lưu được nếu đúng.';
  if (value > QUICK_ROOM_PRICE_HIGH) return 'Giá trên 100.000.000 đ/tháng — kiểm tra có thừa số 0 không. Vẫn lưu được nếu đúng.';
  return null;
}

/** Persist only well-shaped drafts from this actor/org session, never trust stored JSON. */
export function readQuickRoomDrafts(key: string): Record<string, QuickRoomDraft> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, candidate]) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const draft = candidate as Partial<QuickRoomDraft>;
      return typeof draft.revision === 'string' && !!draft.original &&
        ['price', 'area', 'roomType', 'amenities', 'saleNote', 'saleBonusNote', 'description'].every(field => typeof draft[field as keyof QuickRoomDraft] === 'string') &&
        Array.isArray(draft.images) && draft.images.every(item => typeof item === 'string') &&
        Array.isArray(draft.original.images) && draft.original.images.every(item => typeof item === 'string') &&
        Array.isArray(draft.original.amenities) && draft.original.amenities.every(item => typeof item === 'string') &&
        [draft.original.rentPrice, draft.original.area].every(item => item === null || (typeof item === 'number' && Number.isFinite(item))) &&
        [draft.original.roomType, draft.original.saleNote, draft.original.saleBonusNote].every(item => item === null || typeof item === 'string') &&
        (!draft.request || (typeof draft.request.id === 'string' && typeof draft.request.fingerprint === 'string'));
    })) as Record<string, QuickRoomDraft>;
  } catch {
    // Optional local cache can be unavailable or malformed; never trust it or block reading fresh rooms.
  }
  return {};
}

/**
 * Tìm theo từng từ, không cần đúng thứ tự: "111PVC · 101" (chép từ nhãn phòng) và "101 111pvc"
 * đều ra phòng đó. Dấu phân cách hiển thị ("·", "-", ngoặc, dấu phẩy) chỉ là khoảng trắng.
 */
export function roomSearchMatches(haystack: string, query: string): boolean {
  const needles = roomSearchWords(query);
  if (!needles.length) return true;
  const text = roomSearchWords(haystack).join(' ');
  return needles.every(needle => text.includes(needle));
}

/** Các từ tìm kiếm sau khi bỏ dấu và dấu phân cách hiển thị; mảng rỗng = ô tìm không có chữ. */
export function roomSearchWords(value: string): string[] {
  return roomSearchKey(value).split(/[\s·•,;:()[\]/\\|–—-]+/u).filter(Boolean);
}

export function roomSearchKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi-VN').trim();
}
