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

/** Sinh bộ dữ liệu (areas, buildings) nhất quán: building.area_id ∈ areas hoặc null. */
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
    const buildingArb = fc.tuple(
      fc.integer({ min: -1, max: areaCount - 1 }), // -1 = không thuộc khu
    );
    return fc
      .array(buildingArb, { minLength: buildingCount, maxLength: buildingCount })
      .map((assignments) => {
        const buildings: BuildingLite[] = assignments.map(([areaIdx], i) => ({
          id: `b-${i}`,
          name: `Toà ${i}`,
          area_id: areaIdx >= 0 ? `area-${areaIdx}` : null,
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
  it('mọi toà xuất hiện đúng 1 lần trong đúng nhóm của nó', () => {
    fc.assert(
      fc.property(datasetArb, ({ areas, buildings }) => {
        const groups = groupBuildingsByArea(buildings, areas);
        const seen = groups.flatMap((g) => g.buildings.map((b) => b.id));
        // không mất toà, không trùng toà
        expect(seen.sort()).toEqual(buildings.map((b) => b.id).sort());
        // toà nằm đúng nhóm
        for (const g of groups) {
          for (const b of g.buildings) {
            if (g.areaId === null) {
              expect(b.area_id ?? null).toBeNull();
            } else {
              expect(b.area_id).toBe(g.areaId);
            }
          }
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

  it('toà trỏ tới khu không tồn tại → vào nhóm Chưa phân khu', () => {
    const groups = groupBuildingsByArea(
      [{ id: 'b1', name: 'B1', area_id: 'ghost' }],
      [{ id: 'a1', name: 'Khu 1' }],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].areaId).toBeNull();
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
});

describe('toggleBuildingSelection', () => {
  it('toggle 2 lần = ban đầu; selection không bao giờ trùng phần tử', () => {
    fc.assert(
      fc.property(
        datasetArb.chain(({ buildings, areas }) =>
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
  it('rỗng → chuỗi rỗng; 1 toà → tên toà; trọn 1 khu → "Tên khu (N toà)"', () => {
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
          const label = summarizeSelection(
            g.buildings.map((b) => b.id),
            groups,
          );
          expect(label).toBe(`${g.areaName} (${g.buildings.length} toà)`);
        }
      }),
    );
  });

  it('không khớp khu trọn nào (≥2 toà) → "N toà"', () => {
    const areas: AreaLite[] = [{ id: 'a', name: 'Khu A' }];
    const buildings: BuildingLite[] = [
      { id: 'b1', name: 'B1', area_id: 'a' },
      { id: 'b2', name: 'B2', area_id: 'a' },
      { id: 'b3', name: 'B3', area_id: 'a' },
    ];
    const groups = groupBuildingsByArea(buildings, areas);
    expect(summarizeSelection(['b1', 'b2'], groups)).toBe('2 toà');
  });
});

// =============================================
// pruneSelection
// =============================================

describe('pruneSelection', () => {
  it('kết quả luôn ⊆ danh sách toà hiện có và ⊆ selection gốc', () => {
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
});
