import type { FloorLayoutsMap, StoredFloorLayout } from '@/pages/phong-trong/floorLayoutShared';

/**
 * Lưu sơ đồ toà theo TẦNG ĐÃ SỬA (lỗi 8 + S11 audit Sale phòng 24/11/2026).
 *
 * `buildings.floor_layouts` là một cột JSON chung cho mọi tầng và PostgREST không vá được một khoá
 * JSON nếu không viết thêm SQL. Nên lần lưu: đọc bản mới nhất trên máy chủ, chỉ thay các tầng người
 * dùng đã sửa, rồi ghi có điều kiện `updated_at` còn đúng bản vừa đọc (trigger `set_buildings_updated_at`
 * đổi cột này ở mọi lần UPDATE). Hệ quả:
 *  - tầng chỉ mở xem (kể cả tầng mới được tự xếp tạm) không bị ghi đè bằng bản cũ;
 *  - người khác đã lưu ĐÚNG tầng mình sửa sau lúc mình mở ⇒ báo «đã có người sửa», không ghi;
 *  - người khác lưu tầng khác hoặc sửa thông tin khác của toà ⇒ gộp, không mất việc của ai.
 */

export type FloorLayoutSaveErrorKind = 'conflict' | 'denied' | 'busy';

export class FloorLayoutSaveError extends Error {
  constructor(message: string, readonly kind: FloorLayoutSaveErrorKind, readonly floors: string[] = []) {
    super(message);
    this.name = 'FloorLayoutSaveError';
  }
}

export interface FloorLayoutSnapshot {
  floorLayouts: FloorLayoutsMap;
  updatedAt: string;
}

export interface FloorLayoutIo {
  read(buildingId: string): Promise<FloorLayoutSnapshot>;
  /** Ghi khi `updated_at` vẫn là `expectedUpdatedAt`; không có dòng nào được ghi thì trả null. */
  writeIfUnchanged(buildingId: string, floorLayouts: FloorLayoutsMap, expectedUpdatedAt: string): Promise<FloorLayoutSnapshot | null>;
}

export interface SaveEditedFloorsInput {
  buildingId: string;
  /** Bản máy chủ lúc mở toà (hoặc lúc lưu xong lần trước) — mốc để biết người khác có sửa không. */
  base: FloorLayoutsMap;
  /** Bản trên màn hình. Chỉ các tầng trong `floors` được gửi đi. */
  draft: FloorLayoutsMap;
  floors: readonly string[];
}

/** So hai giá trị JSON không phụ thuộc thứ tự khoá (jsonb trả khoá theo thứ tự riêng của nó). */
export function sameLayout(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Tầng người dùng đã sửa mà hiện khác bản máy chủ lúc mở (bỏ các tầng đã hoàn tác về như cũ). */
export function editedFloors(base: FloorLayoutsMap, draft: FloorLayoutsMap, touched: Iterable<string>): string[] {
  return [...new Set(touched)].filter(floor => draft[floor] !== undefined && !sameLayout(draft[floor], base[floor])).sort(compareFloorKeys);
}

export function floorLabel(floors: readonly string[]): string {
  return floors.map(floor => `tầng ${floor}`).join(', ');
}

/** Hỏi trước khi bỏ tầng chưa lưu; dùng chung cho đổi toà, tải bản mới nhất (đổi tab hỏi ở trang cha). */
export function confirmDiscardFloorPlan(floors: readonly string[], next: string): boolean {
  return !floors.length || window.confirm(`Sơ đồ còn thay đổi chưa lưu ở ${floorLabel(floors)}. Bỏ các thay đổi này và ${next}?`);
}

function compareFloorKeys(a: string, b: string): number {
  return Number(b) - Number(a) || (a < b ? -1 : a > b ? 1 : 0);
}

const MAX_ATTEMPTS = 3;

/** Chạy một lần lưu. Lỗi đọc/ghi của máy chủ được ném nguyên vẹn để nơi gọi phân loại. */
export async function saveEditedFloors(io: FloorLayoutIo, input: SaveEditedFloorsInput): Promise<FloorLayoutSnapshot> {
  const floors = [...new Set(input.floors)];
  let latest = await io.read(input.buildingId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Bản máy chủ trùng bản của chính mình (lần lưu trước mất phản hồi nhưng đã ghi) không phải người khác sửa.
    const taken = floors.filter(floor => !sameLayout(latest.floorLayouts[floor], input.base[floor])
      && !sameLayout(latest.floorLayouts[floor], input.draft[floor])).sort(compareFloorKeys);
    if (taken.length) {
      throw new FloorLayoutSaveError(
        `Đã có người sửa sơ đồ ${floorLabel(taken)} sau lúc bạn mở toà này. Chưa lưu gì; bản bạn đang sửa vẫn giữ trên màn hình. `
        + 'Bấm «Tải bản mới nhất» để xem bản của họ rồi sửa lại.',
        'conflict', taken);
    }
    const merged: FloorLayoutsMap = { ...latest.floorLayouts };
    for (const floor of floors) {
      const layout: StoredFloorLayout | undefined = input.draft[floor];
      if (layout) merged[floor] = layout;
    }
    const written = await io.writeIfUnchanged(input.buildingId, merged, latest.updatedAt);
    if (written) return written;
    const again = await io.read(input.buildingId);
    // Không ai ghi chen mà vẫn 0 dòng: chính sách quyền của bảng từ chối (không phải xung đột phiên bản).
    if (again.updatedAt === latest.updatedAt) {
      throw new FloorLayoutSaveError(
        'Máy chủ không ghi sơ đồ: tài khoản này chưa được sửa toà nhà này. Bản đang sửa vẫn giữ trên màn hình; nhờ quản lý cấp quyền rồi lưu lại.',
        'denied');
    }
    latest = again;
  }
  throw new FloorLayoutSaveError(
    'Toà nhà đang được cập nhật liên tục nên chưa lưu được sơ đồ. Bản đang sửa vẫn giữ; bấm Lưu lại sau ít giây.',
    'busy');
}
