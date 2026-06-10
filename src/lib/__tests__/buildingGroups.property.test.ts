import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  groupBuildingsByArea,
  groupSelectionState,
  toggleGroupSelection,
  toggleBuildingSelection,
  summarizeSelection,
  pruneSelection,
  UNGROUPED_LABEL,
  type BuildingLite,
  type AreaLite,
} from '../buildingGroups';

// =============================================
// Arbitraries
// =============================================

/**
 * Sinh bộ dữ liệu (areas, buildings) nhất quán cho mô hình N-N:
 * mỗi building thuộc 0..n khu (area_ids ⊆ areas, không trùng).
 */
const datasetArb = fc
  .record({
    areaCount: fc.integer({ min: 0, max: 5 }),
    buildingCount: fc.integer({ min: 0, max: 20 }),
  })
  .chain(({ areaCount, buildingCount }) => {
    const areas: AreaLite[] = Array.from({ length: areaCount }, (_, i) => ({
      id: `area-${i}`,
      name: `Khu ${i}`,
    }));
    const buildingArb =
      areaCount === 0
        ? fc.constant([] as number[])
        : fc.uniqueArray(fc.integer({ min: 0, max: areaCount - 1 }), {
            maxLength: areaCount,
          });
    return fc
      .array(buildingArb, { minLength: buildingCount, maxLength: buildingCount })
      .map((assignments) => {
        const buildings: BuildingLite[] = assignments.map((areaIdxs, i) => ({
          id: `b-${i}`,
          name: `Toà ${i}`,
          area_ids: areaIdxs.map((idx) => `area-${idx}`),
        }));
        return { areas, buildings };
      });
  });

/** Selection con tuỳ ý của danh sách building (không trùng lặp). */
const selectionOf = (buildings: BuildingLite[]) =>
  fc.uniqueArray(
    fc.integer({ min: 0, max: Math.max(0, buildings.length - 1) }),
    { maxLength: buildings.length },
  ).map((idxs) => (buildings.length === 0 ? [] : idxs.map((i) => buildings[i].id)));

// =============================================
// groupBuildingsByArea
// =============================================

describe('groupBuildingsByArea', () => {
  it('mỗi toà xuất hiện đúng 1 lần TRONG MỖI nhóm chứa nó; union = toàn bộ toà', () => {
    fc.assert(
      fc.property(datasetArb, ({ areas, buildings }) => {
        const groups = groupBuildingsByArea(buildings, areas);
        const areaIds = new Set(areas.map((a) => a.id));
        // union các nhóm = toàn bộ toà (không mất toà nào)
        const union = new Set(groups.flatMap((g) => g.buildings.map((b) => b.id)));
        expect([...union].sort()).toEqual(buildings.map((b) => b.id).sort());
        for (const g of groups) {
          // không trùng id TRONG một nhóm
          const ids = g.buildings.map((b) => b.id);
          expect(new Set(ids).size).toBe(ids.length);
          // toà nằm đúng nhóm
          for (const b of g.buildings) {
            const valid = (b.area_ids ?? []).filter((id) => areaIds.has(id));
            if (g.areaId === null) {
              expect(valid).toHaveLength(0);
            } else {
              expect(valid).toContain(g.areaId);
            }
          }
        }
        // toà thuộc k khu sống → xuất hiện đúng k lần (hoặc 1 lần ở Chưa phân khu)
        for (const b of buildings) {
          const valid = (b.area_ids ?? []).filter((id) => areaIds.has(id));
          const appearances = groups.filter((g) =>
            g.buildings.some((x) => x.id === b.id),
          ).length;
          expect(appearances).toBe(valid.length === 0 ? 1 : valid.length);
        }
      }),
    );
  });

  it('không có nhóm rỗng; nhóm "Chưa phân khu" luôn ở cuối nếu có', () => {
    fc.assert(
      fc.property(datasetArb, ({ areas, buildings }) => {
        const groups = groupBuildingsByArea(buildings, areas);
        for (const g of groups) expect(g.buildings.length).toBeGreaterThan(0);
        const ungroupedIdx = groups.findIndex((g) => g.areaId === null);
        if (ungroupedIdx !== -1) {
          expect(ungroupedIdx).toBe(groups.length - 1);
          expect(groups[ungroupedIdx].areaName).toBe(UNGROUPED_LABEL);
        }
      }),
    );
  });

  it('toà chỉ trỏ tới khu không tồn tại → vào nhóm Chưa phân khu', () => {
    const groups = groupBuildingsByArea(
      [{ id: 'b1', name: 'B1', area_ids: ['ghost'] }],
      [{ id: 'a1', name: 'Khu 1' }],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].areaId).toBeNull();
  });

  it('toà thuộc 2 khu xuất hiện trong cả 2 nhóm', () => {
    const areas: AreaLite[] = [
      { id: 'cu', name: 'Nhà cũ' },
      { id: 'thangbo', name: 'Thang bộ' },
    ];
    const buildings: BuildingLite[] = [
      { id: 'A', name: 'Toà A', area_ids: ['cu', 'thangbo'] },
      { id: 'B', name: 'Toà B', area_ids: ['cu'] },
    ];
    const groups = groupBuildingsByArea(buildings, areas);
    expect(groups.map((g) => g.areaId)).toEqual(['cu', 'thangbo']);
    expect(groups[0].buildings.map((b) => b.id)).toEqual(['A', 'B']);
    expect(groups[1].buildings.map((b) => b.id)).toEqual(['A']);
  });
});

// =============================================
// toggle group / building
// =============================================

describe('toggleGroupSelection', () => {
  it('từ none/all: toggle 2 lần trả về selection ban đầu; từ some: toggle 2 lần → none (semantics checkbox 3 trạng thái)', () => {
    fc.assert(
      fc.property(
        datasetArb.chain(({ areas, buildings }) =>
          fc.tuple(
            fc.constant({ areas, buildings }),
            selectionOf(buildings),
          ),
        ),
        ([{ areas, buildings }, selection]) => {
          const groups = groupBuildingsByArea(buildings, areas);
          for (const g of groups) {
            const ids = g.buildings.map((b) => b.id);
            const before = groupSelectionState(selection, ids);
            const once = toggleGroupSelection(selection, ids);
            const twice = toggleGroupSelection(once, ids);
            if (before === 'some') {
              // some → all → none: phần chọn dở trong nhóm bị bỏ — chủ ý.
              expect(groupSelectionState(twice, ids)).toBe('none');
            } else {
              expect(new Set(twice)).toEqual(new Set(selection));
            }
          }
        },
      ),
    );
  });

  it('sau toggle, trạng thái nhóm là all hoặc none (không bao giờ some)', () => {
    fc.assert(
      fc.property(
        datasetArb.chain(({ areas, buildings }) =>
          fc.tuple(fc.constant({ areas, buildings }), selectionOf(buildings)),
        ),
        ([{ areas, buildings }, selection]) => {
          const groups = groupBuildingsByArea(buildings, areas);
          for (const g of groups) {
            const ids = g.buildings.map((b) => b.id);
            const next = toggleGroupSelection(selection, ids);
            expect(groupSelectionState(next, ids)).not.toBe('some');
            // không đụng toà ngoài nhóm
            const outside = (sel: readonly string[]) =>
              sel.filter((id) => !ids.includes(id)).sort();
            expect(outside(next)).toEqual(outside(selection));
          }
        },
      ),
    );
  });

  it('nhóm chồng lấn: bỏ chọn Khu A kéo toà chung ra khỏi selection → Khu B thành "some"', () => {
    const areas: AreaLite[] = [
      { id: 'a', name: 'Khu A' },
      { id: 'b', name: 'Khu B' },
    ];
    const buildings: BuildingLite[] = [
      { id: 'shared', name: 'Toà chung', area_ids: ['a', 'b'] },
      { id: 'onlyA', name: 'Toà A1', area_ids: ['a'] },
      { id: 'onlyB', name: 'Toà B1', area_ids: ['b'] },
    ];
    const groups = groupBuildingsByArea(buildings, areas);
    const idsA = groups[0].buildings.map((b) => b.id); // shared + onlyA
    const idsB = groups[1].buildings.map((b) => b.id); // shared + onlyB
    // chọn hết cả 2 khu rồi bỏ Khu A
    const all = ['shared', 'onlyA', 'onlyB'];
    const afterToggleA = toggleGroupSelection(all, idsA);
    expect(afterToggleA.sort()).toEqual(['onlyB']);
    expect(groupSelectionState(afterToggleA, idsB)).toBe('some');
  });
});

describe('toggleBuildingSelection', () => {
  it('toggle 2 lần = ban đầu; selection không bao giờ trùng phần tử', () => {
    fc.assert(
      fc.property(
        datasetArb.chain(({ buildings }) =>
          fc.tuple(fc.constant(buildings), selectionOf(buildings)),
        ),
        ([buildings, selection]) => {
          if (buildings.length === 0) return;
          const id = buildings[0].id;
          const once = toggleBuildingSelection(selection, id);
          expect(new Set(toggleBuildingSelection(once, id))).toEqual(
            new Set(selection),
          );
          expect(new Set(once).size).toBe(once.length);
        },
      ),
    );
  });
});

// =============================================
// summarizeSelection
// =============================================

describe('summarizeSelection', () => {
  it('rỗng → chuỗi rỗng; 1 toà → tên toà; trọn đúng 1 khu (không kéo trọn khu khác) → "Tên khu (N toà)"', () => {
    fc.assert(
      fc.property(datasetArb, ({ areas, buildings }) => {
        const groups = groupBuildingsByArea(buildings, areas);
        expect(summarizeSelection([], groups)).toBe('');
        if (buildings.length > 0) {
          expect(summarizeSelection([buildings[0].id], groups)).toBe(
            buildings[0].name,
          );
        }
        for (const g of groups) {
          if (g.buildings.length < 2) continue;
          const selection = g.buildings.map((b) => b.id);
          const sel = new Set(selection);
          // Nhóm chồng lấn: nếu selection này cũng vô tình trọn khu khác
          // thì nhãn theo greedy có thể khác — chỉ assert khi g là khu trọn duy nhất.
          const otherFull = groups.some(
            (g2) =>
              g2 !== g &&
              g2.buildings.length > 0 &&
              g2.buildings.every((b) => sel.has(b.id)),
          );
          if (otherFull) continue;
          const label = summarizeSelection(selection, groups);
          expect(label).toBe(`${g.areaName} (${g.buildings.length} toà)`);
        }
      }),
    );
  });

  it('không khớp khu trọn nào (≥2 toà) → "N toà"', () => {
    const areas: AreaLite[] = [{ id: 'a', name: 'Khu A' }];
    const buildings: BuildingLite[] = [
      { id: 'b1', name: 'B1', area_ids: ['a'] },
      { id: 'b2', name: 'B2', area_ids: ['a'] },
      { id: 'b3', name: 'B3', area_ids: ['a'] },
    ];
    const groups = groupBuildingsByArea(buildings, areas);
    expect(summarizeSelection(['b1', 'b2'], groups)).toBe('2 toà');
  });

  it('greedy: khu con bị khu trước cover trọn thì không liệt kê lặp', () => {
    const areas: AreaLite[] = [
      { id: 'big', name: 'Khu lớn' },
      { id: 'sub', name: 'Khu con' },
    ];
    const buildings: BuildingLite[] = [
      { id: 'x', name: 'X', area_ids: ['big', 'sub'] },
      { id: 'y', name: 'Y', area_ids: ['big', 'sub'] },
      { id: 'z', name: 'Z', area_ids: ['big'] },
    ];
    const groups = groupBuildingsByArea(buildings, areas);
    // chọn cả 3 → trọn "Khu lớn"; "Khu con" (x,y) đã được cover trọn → bỏ qua
    expect(summarizeSelection(['x', 'y', 'z'], groups)).toBe('Khu lớn (3 toà)');
    // chọn x,y → "Khu lớn" thiếu z nên không trọn; chỉ "Khu con" trọn
    expect(summarizeSelection(['x', 'y'], groups)).toBe('Khu con (2 toà)');
  });
});

// =============================================
// pruneSelection
// =============================================

describe('pruneSelection', () => {
  it('kết quả luôn ⊆ danh sách toà hiện có và ⊆ selection gốc; toà thuộc 2 khu chỉ tính 1 lần', () => {
    fc.assert(
      fc.property(
        datasetArb,
        fc.array(fc.string(), { maxLength: 10 }),
        ({ buildings }, extraIds) => {
          const selection = [...buildings.slice(0, 2).map((b) => b.id), ...extraIds];
          const pruned = pruneSelection(selection, buildings);
          const valid = new Set(buildings.map((b) => b.id));
          for (const id of pruned) {
            expect(valid.has(id)).toBe(true);
            expect(selection.includes(id)).toBe(true);
          }
        },
      ),
    );
  });

  it('toà thuộc 2 khu vẫn chỉ là 1 id trong selection', () => {
    const buildings: BuildingLite[] = [
      { id: 'A', name: 'Toà A', area_ids: ['k1', 'k2'] },
    ];
    expect(pruneSelection(['A', 'ghost'], buildings)).toEqual(['A']);
  });
});
