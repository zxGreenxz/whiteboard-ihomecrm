/**
 * Module THUẦN (chỉ phụ thuộc sampleData) chia sẻ giữa:
 *  - editor sơ đồ tọa độ (src/components/sale-phong/floor-editor)
 *  - adapter trang công khai (supabaseData.ts)
 * Giữ pure (không import React/CSS) để không kéo code editor vào bundle public.
 */
import { layoutFloor, type Box, type Fixture, type FloorPlan, type Room } from "./sampleData";

/** Shape lưu trong buildings.floor_layouts["<floor>"]. rooms = map keyed by room id. */
export interface StoredFloorLayout {
  canvasW: number;
  canvasH: number;
  corridor: Box;
  fixtures: Fixture[];
  rooms: Record<string, Box>;
}
export type FloorLayoutsMap = Record<string, StoredFloorLayout>;

/** Sinh layout tự động (layoutFloor) rồi chuyển sang StoredFloorLayout để làm seed cho editor. */
export function seedFromAuto(floor: number, rooms: Room[]): StoredFloorLayout {
  const fp = layoutFloor(floor, rooms);
  const roomsMap: Record<string, Box> = {};
  for (const r of fp.rooms) roomsMap[r.id] = { x: r.x, y: r.y, w: r.w, h: r.h };
  return { canvasW: fp.canvasW, canvasH: fp.canvasH, corridor: fp.corridor, fixtures: fp.fixtures, rooms: roomsMap };
}

/**
 * Ghép layout đã lưu lên danh sách phòng thật → FloorPlan để render.
 * - Phòng có toạ độ trong sl.rooms → dùng toạ độ đó.
 * - Phòng CHƯA đặt (thêm sau khi lưu / đổi tầng) → tự sinh layoutFloor, đẩy xuống
 *   dưới khối đã lưu (offset theo canvasH) để không đè & luôn hiển thị.
 * - Khoá phòng mồ côi (đã xoá) tự bị bỏ qua (lặp theo rooms, tra map).
 */
export function applyStoredLayout(floor: number, rooms: Room[], sl: StoredFloorLayout): FloorPlan {
  const placed: Room[] = [];
  const unplaced: Room[] = [];
  for (const r of rooms) {
    const box = sl.rooms?.[r.id];
    if (box) placed.push({ ...r, x: box.x, y: box.y, w: box.w, h: box.h });
    else unplaced.push(r);
  }

  let canvasW = sl.canvasW;
  let canvasH = sl.canvasH;
  let extra: Room[] = [];
  if (unplaced.length) {
    const auto = layoutFloor(floor, unplaced);
    extra = auto.rooms.map((r) => ({ ...r, y: r.y + sl.canvasH }));
    canvasW = Math.max(canvasW, auto.canvasW);
    canvasH = sl.canvasH + auto.canvasH;
  }

  return {
    floor,
    rooms: [...placed, ...extra],
    fixtures: sl.fixtures ?? [],
    corridor: sl.corridor,
    canvasW,
    canvasH,
  };
}
