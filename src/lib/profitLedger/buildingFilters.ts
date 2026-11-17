// Bộ lọc nhà cho bảng "LN được chia Nhà × Tháng" của màn cổ đông tự xem (chủ yêu cầu 16/11/2026).
// Chỉ là cách BÀY cột, không đổi số liệu nào của sổ tổng. Lưu THEO TÀI KHOẢN trên máy chủ (bảng
// public.settings, khoá `buildingFilterSettingKey`) để theo người dùng sang trình duyệt / máy khác và cả
// cửa sổ ẩn danh (chủ yêu cầu 17/11/2026); bản trên trình duyệt (`buildingFilterStorageKey`) chỉ là bộ đệm.

import type { BuildingColumn, MatrixRow } from './selfView';

export interface BuildingFilterPreset {
  id: string;
  name: string;
  /** Khoá cột nhà (BuildingColumn.key) được hiện. */
  keys: string[];
}

export interface BuildingFilterState {
  presets: BuildingFilterPreset[];
  /** null = "Tất cả". */
  activeId: string | null;
}

export const BUILDING_FILTER_NAME_MAX = 40;
export const BUILDING_FILTER_MAX_PRESETS = 20;

export function emptyBuildingFilterState(): BuildingFilterState {
  return { presets: [], activeId: null };
}

/** Khoá bộ đệm trên trình duyệt (localStorage) — mở màn ngay, dùng tạm khi máy chủ chưa đọc / ghi được. */
export function buildingFilterStorageKey(organizationId: string, shareholderId: string): string {
  return `ihome:ln-nha-thang:bo-loc:v1:${organizationId}:${shareholderId}`;
}

/**
 * Khoá dòng `public.settings` (duy nhất theo user_id + key): mỗi TÀI KHOẢN một bản, tách theo công ty + cổ
 * đông (một người có thể thuộc nhiều công ty).
 */
export function buildingFilterSettingKey(organizationId: string, shareholderId: string): string {
  return `ln_nha_thang_bo_loc:v1:${organizationId}:${shareholderId}`;
}

/** Giá trị jsonb đọc từ máy chủ ⇒ trạng thái đã làm sạch (cùng luật với bản trên trình duyệt). */
export function parseBuildingFilterValue(value: unknown): BuildingFilterState {
  if (value === null || value === undefined) return emptyBuildingFilterState();
  return parseBuildingFilterState(JSON.stringify(value));
}

export function sameBuildingFilterState(a: BuildingFilterState, b: BuildingFilterState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Đọc chuỗi đã lưu; hỏng / lạ định dạng ⇒ trạng thái rỗng (không ném lỗi làm trắng màn). */
export function parseBuildingFilterState(raw: string | null): BuildingFilterState {
  if (!raw) return emptyBuildingFilterState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyBuildingFilterState();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.presets)) return emptyBuildingFilterState();
  const presets: BuildingFilterPreset[] = [];
  const seen = new Set<string>();
  for (const item of parsed.presets) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.keys)) continue;
    const name = item.name.trim().slice(0, BUILDING_FILTER_NAME_MAX);
    const keys = [...new Set(item.keys.filter((k): k is string => typeof k === 'string' && k !== ''))];
    if (!item.id || seen.has(item.id) || !name || keys.length === 0) continue;
    seen.add(item.id);
    presets.push({ id: item.id, name, keys });
    if (presets.length === BUILDING_FILTER_MAX_PRESETS) break;
  }
  const activeId = typeof parsed.activeId === 'string' && seen.has(parsed.activeId) ? parsed.activeId : null;
  return { presets, activeId };
}

/** Lỗi của hộp tạo / sửa bộ lọc; null = hợp lệ. */
export function buildingFilterDraftError(
  draft: { name: string; keys: readonly string[] },
  presets: readonly BuildingFilterPreset[],
  editingId: string | null,
): string | null {
  const name = draft.name.trim();
  if (!name) return 'Nhập tên bộ lọc';
  if (name.length > BUILDING_FILTER_NAME_MAX) return `Tên bộ lọc tối đa ${BUILDING_FILTER_NAME_MAX} ký tự`;
  const lower = name.toLocaleLowerCase('vi');
  if (presets.some((p) => p.id !== editingId && p.name.toLocaleLowerCase('vi') === lower)) return 'Đã có bộ lọc trùng tên';
  if (draft.keys.length === 0) return 'Chọn ít nhất một nhà';
  if (editingId === null && presets.length >= BUILDING_FILTER_MAX_PRESETS) return `Tối đa ${BUILDING_FILTER_MAX_PRESETS} bộ lọc`;
  return null;
}

/** Thêm mới hoặc ghi đè theo id, rồi chọn luôn bộ lọc đó. */
export function upsertBuildingFilter(state: BuildingFilterState, preset: BuildingFilterPreset): BuildingFilterState {
  const clean: BuildingFilterPreset = { id: preset.id, name: preset.name.trim(), keys: [...new Set(preset.keys)] };
  const exists = state.presets.some((p) => p.id === clean.id);
  return {
    presets: exists ? state.presets.map((p) => (p.id === clean.id ? clean : p)) : [...state.presets, clean],
    activeId: clean.id,
  };
}

export function removeBuildingFilter(state: BuildingFilterState, id: string): BuildingFilterState {
  return {
    presets: state.presets.filter((p) => p.id !== id),
    activeId: state.activeId === id ? null : state.activeId,
  };
}

export function activeBuildingFilter(state: BuildingFilterState): BuildingFilterPreset | null {
  return state.presets.find((p) => p.id === state.activeId) ?? null;
}

/**
 * Áp bộ lọc lên ma trận Nhà × Tháng. `keys` null = không lọc (trả nguyên, "Tổng chia" là tổng cả tháng).
 * Có lọc: chỉ giữ cột được chọn, cột tổng = tổng các nhà ĐANG HIỆN, bỏ tháng không còn ô nào có số.
 */
export function applyBuildingFilter(
  columns: readonly BuildingColumn[],
  rows: readonly MatrixRow[],
  keys: readonly string[] | null,
): { columns: BuildingColumn[]; rows: MatrixRow[] } {
  if (keys === null) return { columns: [...columns], rows: [...rows] };
  const wanted = new Set(keys);
  const indexes = columns.map((c, i) => (wanted.has(c.key) ? i : -1)).filter((i) => i >= 0);
  const shownColumns = indexes.map((i) => columns[i]).filter((c): c is BuildingColumn => c !== undefined);
  const shownRows: MatrixRow[] = [];
  for (const row of rows) {
    const cells = indexes.map((i) => row.cells[i] ?? null);
    if (cells.every((v) => v === null)) continue;
    shownRows.push({ ...row, cells, total: cells.reduce<number>((sum, v) => sum + (v ?? 0), 0) });
  }
  return { columns: shownColumns, rows: shownRows };
}
