import { saleRoomPatchSchema } from '@/lib/saleRoomOperations';

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

/** Compare raw fields too: invalid numeric text is still an unsaved draft. */
export function quickRoomDraftDirty(draft: QuickRoomDraft): boolean {
  const original = newQuickRoomDraft(draft.original, draft.revision);
  return (['price', 'area', 'roomType', 'amenities', 'saleNote', 'saleBonusNote', 'description', 'images'] as const)
    .some(key => !same(draft[key], original[key]));
}

export function quickRoomChanges(draft: QuickRoomDraft, permission: { edit: boolean; images: boolean }) {
  const patch: QuickRoomPatch = {};
  const errors: Record<string, string> = {};
  if (permission.edit) {
    const original = newQuickRoomDraft(draft.original, draft.revision);
    const changed = (field: keyof QuickRoomDraft) => !same(draft[field], original[field]);
    const price = draft.price.trim();
    const area = draft.area.trim().replace(',', '.');
    const priceChanged = changed('price');
    if (priceChanged && (!/^\d+$/.test(price) || !Number.isSafeInteger(Number(price)))) errors.price = 'Nhập giá nguyên không âm bằng đồng; không để trống.';
    else if (priceChanged && !saleRoomPatchSchema.safeParse({ rent_price: Number(price) }).success) errors.price = 'Giá niêm yết không vượt quá 9.999.999.999.999 đồng.';
    if (changed('area') && area && (!/^\d+(?:\.\d{1,2})?$/.test(area) || !Number.isFinite(Number(area)) || Number(area) > 1_000_000)) errors.area = 'Nhập diện tích từ 0 đến 1.000.000 m², tối đa 2 số thập phân.';
    if (changed('roomType') && draft.roomType.trim().length > 200) errors.roomType = 'Loại phòng tối đa 200 ký tự.';
    if (changed('saleNote') && draft.saleNote.trim().length > 2000) errors.saleNote = 'Thông tin công khai tối đa 2000 ký tự.';
    if (changed('saleBonusNote') && draft.saleBonusNote.trim().length > 2000) errors.saleBonusNote = 'Ghi chú nội bộ tối đa 2000 ký tự.';
    if (changed('description') && draft.description.trim().length > 2000) errors.description = 'Mô tả phòng tối đa 2000 ký tự.';
    const amenities = [...new Set(draft.amenities.split('\n').map(value => value.trim()).filter(Boolean))];
    if (changed('amenities') && (amenities.length > 50 || amenities.some(value => value.length > 200))) errors.amenities = 'Tối đa 50 nội thất, mỗi dòng không quá 200 ký tự.';
    const fields = {
      ...(priceChanged ? { rent_price: Number(price) } : {}),
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

export function roomSearchKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi-VN').trim();
}
