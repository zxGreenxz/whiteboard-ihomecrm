// Bộ lọc nhà của bảng "LN được chia Nhà × Tháng": chỉ đổi cột được bày, không đổi số gốc. Dữ liệu giả.
import { describe, expect, it } from 'vitest';
import {
  BUILDING_FILTER_MAX_PRESETS, BUILDING_FILTER_NAME_MAX, activeBuildingFilter, applyBuildingFilter, buildingFilterDraftError,
  buildingFilterSettingKey, buildingFilterStorageKey, parseBuildingFilterState, parseBuildingFilterValue, removeBuildingFilter,
  sameBuildingFilterState, upsertBuildingFilter,
  type BuildingFilterState,
} from '../buildingFilters';
import type { BuildingColumn, MatrixRow } from '../selfView';

const columns: BuildingColumn[] = [{ key: 'a', name: 'Nhà A' }, { key: 'b', name: 'Nhà B' }, { key: 'c', name: 'Nhà C' }];
const rows: MatrixRow[] = [
  { period: '2026-05-01', month: 5, excluded: false, cells: [100, 200, null], total: 300 },
  { period: '2026-06-01', month: 6, excluded: true, cells: [null, -50, 70], total: 20 },
  { period: '2026-07-01', month: 7, excluded: false, cells: [null, 40, null], total: 40 },
];

describe('applyBuildingFilter', () => {
  it('không lọc ⇒ trả nguyên cột, dòng và tổng cả tháng', () => {
    expect(applyBuildingFilter(columns, rows, null)).toEqual({ columns, rows });
  });

  it('có lọc ⇒ chỉ cột được chọn (theo thứ tự cột gốc), tổng = tổng nhà đang hiện, giữ cờ "đã trả đủ"', () => {
    const shown = applyBuildingFilter(columns, rows, ['c', 'a']);
    expect(shown.columns.map((c) => c.key)).toEqual(['a', 'c']);
    expect(shown.rows).toEqual([
      { period: '2026-05-01', month: 5, excluded: false, cells: [100, null], total: 100 },
      { period: '2026-06-01', month: 6, excluded: true, cells: [null, 70], total: 70 },
    ]);
  });

  it('tháng không còn ô nào có số bị bỏ; số âm vẫn cộng đúng dấu; khoá lạ ⇒ rỗng', () => {
    expect(applyBuildingFilter(columns, rows, ['b']).rows.map((r) => [r.month, r.total])).toEqual([[5, 200], [6, -50], [7, 40]]);
    expect(applyBuildingFilter(columns, rows, ['a']).rows.map((r) => r.month)).toEqual([5]);
    expect(applyBuildingFilter(columns, rows, ['khong-co'])).toEqual({ columns: [], rows: [] });
  });

  it('không sửa mảng gốc', () => {
    const before = JSON.stringify(rows);
    applyBuildingFilter(columns, rows, ['a']);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('lưu / đọc bộ lọc', () => {
  const state: BuildingFilterState = { presets: [{ id: 'p1', name: 'Cụm 1', keys: ['a', 'b'] }], activeId: 'p1' };

  it('khoá lưu tách theo công ty và cổ đông', () => {
    expect(buildingFilterStorageKey('org-a', 'sh-1')).not.toBe(buildingFilterStorageKey('org-b', 'sh-1'));
    expect(buildingFilterStorageKey('org-a', 'sh-1')).not.toBe(buildingFilterStorageKey('org-a', 'sh-2'));
  });

  it('khoá trên tài khoản (public.settings) tách theo công ty và cổ đông, khác khoá bộ đệm trình duyệt', () => {
    expect(buildingFilterSettingKey('org-a', 'sh-1')).toBe('ln_nha_thang_bo_loc:v1:org-a:sh-1');
    expect(buildingFilterSettingKey('org-a', 'sh-1')).not.toBe(buildingFilterSettingKey('org-b', 'sh-1'));
    expect(buildingFilterSettingKey('org-a', 'sh-1')).not.toBe(buildingFilterSettingKey('org-a', 'sh-2'));
    expect(buildingFilterSettingKey('org-a', 'sh-1')).not.toBe(buildingFilterStorageKey('org-a', 'sh-1'));
  });

  it('giá trị jsonb từ tài khoản đọc cùng luật làm sạch; rỗng / lạ ⇒ trạng thái rỗng', () => {
    expect(parseBuildingFilterValue(state)).toEqual(state);
    expect(parseBuildingFilterValue(null)).toEqual({ presets: [], activeId: null });
    expect(parseBuildingFilterValue(undefined)).toEqual({ presets: [], activeId: null });
    expect(parseBuildingFilterValue('chuỗi lạ')).toEqual({ presets: [], activeId: null });
    expect(parseBuildingFilterValue({ presets: [{ id: 'p1', name: '  ', keys: ['a'] }], activeId: 'p1' })).toEqual({ presets: [], activeId: null });
  });

  it('so hai trạng thái theo nội dung', () => {
    expect(sameBuildingFilterState(state, JSON.parse(JSON.stringify(state)) as BuildingFilterState)).toBe(true);
    expect(sameBuildingFilterState(state, { ...state, activeId: null })).toBe(false);
  });

  it('đọc lại đúng thứ đã lưu', () => {
    expect(parseBuildingFilterState(JSON.stringify(state))).toEqual(state);
  });

  it.each([null, '', 'không phải json', '[]', '{"presets":"x"}', '42'])('dữ liệu hỏng %j ⇒ rỗng, không ném lỗi', (raw) => {
    expect(parseBuildingFilterState(raw)).toEqual({ presets: [], activeId: null });
  });

  it('bỏ mục hỏng, trùng id, thiếu tên, không có nhà; activeId lạ ⇒ "Tất cả"', () => {
    const raw = JSON.stringify({
      activeId: 'ma',
      presets: [
        { id: 'p1', name: '  Cụm 1  ', keys: ['a', 'a', 7, ''] },
        { id: 'p1', name: 'Trùng id', keys: ['b'] },
        { id: 'p2', name: '   ', keys: ['b'] },
        { id: 'p3', name: 'Không nhà', keys: [] },
        'rác',
      ],
    });
    expect(parseBuildingFilterState(raw)).toEqual({ presets: [{ id: 'p1', name: 'Cụm 1', keys: ['a'] }], activeId: null });
  });

  it('thêm mới chọn luôn bộ lọc đó; ghi đè theo id giữ vị trí; xoá bộ đang chọn ⇒ về "Tất cả"', () => {
    const added = upsertBuildingFilter(state, { id: 'p2', name: ' Cụm 2 ', keys: ['c', 'c'] });
    expect(added).toEqual({ presets: [state.presets[0], { id: 'p2', name: 'Cụm 2', keys: ['c'] }], activeId: 'p2' });
    const edited = upsertBuildingFilter(added, { id: 'p1', name: 'Cụm 1 mới', keys: ['a'] });
    expect(edited.presets.map((p) => p.name)).toEqual(['Cụm 1 mới', 'Cụm 2']);
    expect(activeBuildingFilter(edited)?.id).toBe('p1');
    expect(removeBuildingFilter(edited, 'p1')).toEqual({ presets: [{ id: 'p2', name: 'Cụm 2', keys: ['c'] }], activeId: null });
    expect(removeBuildingFilter(edited, 'p2').activeId).toBe('p1');
  });
});

describe('buildingFilterDraftError', () => {
  const presets = [{ id: 'p1', name: 'Cụm 1', keys: ['a'] }];

  it('thiếu tên, tên quá dài, trùng tên (không phân biệt hoa thường), chưa chọn nhà', () => {
    expect(buildingFilterDraftError({ name: '  ', keys: ['a'] }, presets, null)).toBe('Nhập tên bộ lọc');
    expect(buildingFilterDraftError({ name: 'x'.repeat(BUILDING_FILTER_NAME_MAX + 1), keys: ['a'] }, presets, null)).toMatch(/tối đa/);
    expect(buildingFilterDraftError({ name: 'cụm 1', keys: ['a'] }, presets, null)).toBe('Đã có bộ lọc trùng tên');
    expect(buildingFilterDraftError({ name: 'Cụm 2', keys: [] }, presets, null)).toBe('Chọn ít nhất một nhà');
  });

  it('sửa chính nó thì không tính là trùng tên; hợp lệ ⇒ null', () => {
    expect(buildingFilterDraftError({ name: 'Cụm 1', keys: ['a', 'b'] }, presets, 'p1')).toBeNull();
    expect(buildingFilterDraftError({ name: 'Cụm 2', keys: ['b'] }, presets, null)).toBeNull();
  });

  it('đủ số bộ lọc tối đa thì không tạo thêm, nhưng vẫn sửa được', () => {
    const full = Array.from({ length: BUILDING_FILTER_MAX_PRESETS }, (_, i) => ({ id: `p${i}`, name: `Bộ ${i}`, keys: ['a'] }));
    expect(buildingFilterDraftError({ name: 'Thêm nữa', keys: ['a'] }, full, null)).toMatch(/Tối đa/);
    expect(buildingFilterDraftError({ name: 'Bộ 0 mới', keys: ['a'] }, full, 'p0')).toBeNull();
  });
});
