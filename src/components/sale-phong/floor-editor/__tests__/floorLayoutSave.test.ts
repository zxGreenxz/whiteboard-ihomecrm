import { describe, expect, it } from 'vitest';
import type { FloorLayoutsMap, StoredFloorLayout } from '@/pages/phong-trong/floorLayoutShared';
import {
  FloorLayoutSaveError, editedFloors, sameLayout, saveEditedFloors, type FloorLayoutIo, type FloorLayoutSnapshot,
} from '../floorLayoutSave';

const layout = (x: number, extra: Partial<StoredFloorLayout> = {}): StoredFloorLayout => ({
  canvasW: 600, canvasH: 400, corridor: { x: 0, y: 180, w: 600, h: 40 }, fixtures: [],
  rooms: { 'room-1': { x, y: 10, w: 150, h: 118 } }, ...extra,
});

/** Máy chủ giả: giữ một dòng `buildings`, ghi có điều kiện `updated_at` như PostgREST + trigger. */
function server(initial: FloorLayoutsMap, options: { denyWrites?: boolean } = {}) {
  let row: FloorLayoutSnapshot = { floorLayouts: structuredClone(initial), updatedAt: 't1' };
  let clock = 1;
  const writes: FloorLayoutsMap[] = [];
  const beforeWrite: Array<() => void> = [];
  const bump = (floorLayouts: FloorLayoutsMap) => { clock += 1; row = { floorLayouts: structuredClone(floorLayouts), updatedAt: `t${clock}` }; };
  const io: FloorLayoutIo = {
    async read() { return structuredClone(row); },
    async writeIfUnchanged(_id, floorLayouts, expected) {
      beforeWrite.shift()?.();
      if (options.denyWrites || row.updatedAt !== expected) return null;
      writes.push(structuredClone(floorLayouts));
      bump(floorLayouts);
      return structuredClone(row);
    },
  };
  return { io, writes, current: () => row, otherUserSaves: (floorLayouts: FloorLayoutsMap) => bump(floorLayouts), beforeWrite };
}

describe('sameLayout / editedFloors', () => {
  it('so JSON không phụ thuộc thứ tự khoá như jsonb trả về', () => {
    expect(sameLayout({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameLayout({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameLayout(undefined, null)).toBe(true);
  });

  it('chỉ tính tầng đã chạm mà khác mốc; tầng hoàn tác về như cũ không còn là chưa lưu', () => {
    const base = { 5: layout(10), 4: layout(20) };
    const draft = { 5: layout(10), 4: layout(99), 3: layout(1) };
    expect(editedFloors(base, draft, ['5', '4', '4'])).toEqual(['4']);
    // Tầng tự xếp tạm (chưa có trên máy chủ) chỉ thành "đã sửa" khi người dùng chạm vào.
    expect(editedFloors(base, draft, ['3'])).toEqual(['3']);
    expect(editedFloors(base, draft, [])).toEqual([]);
  });
});

describe('saveEditedFloors', () => {
  it('chỉ gửi tầng đã sửa, giữ nguyên tầng chỉ mở xem và tầng người khác vừa lưu', async () => {
    const opened = { 5: layout(10), 4: layout(20) };
    const db = server(opened);
    db.otherUserSaves({ ...opened, 4: layout(77) }); // người khác lưu tầng 4 sau lúc mình mở
    // Bản trên màn hình còn tầng 4 cũ và tầng 3 tự xếp tạm (chưa ai lưu).
    const draft = { 5: layout(55), 4: layout(20), 3: layout(1) };
    const saved = await saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft, floors: ['5'] });
    expect(db.writes).toEqual([{ 5: layout(55), 4: layout(77) }]);
    expect(saved.floorLayouts).toEqual({ 5: layout(55), 4: layout(77) });
    expect(saved.floorLayouts[3]).toBeUndefined();
  });

  it('người khác đã lưu đúng tầng mình sửa: báo «đã có người sửa», không ghi gì', async () => {
    const opened = { 5: layout(10) };
    const db = server(opened);
    db.otherUserSaves({ 5: layout(30) });
    const attempt = saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft: { 5: layout(55) }, floors: ['5'] });
    await expect(attempt).rejects.toMatchObject({ kind: 'conflict', floors: ['5'] });
    await expect(attempt).rejects.toThrow(/Đã có người sửa sơ đồ tầng 5/);
    expect(db.writes).toEqual([]);
    expect(db.current().floorLayouts).toEqual({ 5: layout(30) });
  });

  it('người khác lưu đúng tầng đó CHEN GIỮA lúc đọc và lúc ghi: điều kiện updated_at chặn, đọc lại rồi báo', async () => {
    const opened = { 5: layout(10) };
    const db = server(opened);
    db.beforeWrite.push(() => db.otherUserSaves({ 5: layout(30) }));
    await expect(saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft: { 5: layout(55) }, floors: ['5'] }))
      .rejects.toMatchObject({ kind: 'conflict' });
    expect(db.writes).toEqual([]);
    expect(db.current().floorLayouts).toEqual({ 5: layout(30) });
  });

  it('người khác sửa tầng khác chen giữa: thử lại và gộp, không mất việc của ai', async () => {
    const opened = { 5: layout(10), 4: layout(20) };
    const db = server(opened);
    db.beforeWrite.push(() => db.otherUserSaves({ ...opened, 4: layout(44) }));
    const saved = await saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft: { ...opened, 5: layout(55) }, floors: ['5'] });
    expect(saved.floorLayouts).toEqual({ 5: layout(55), 4: layout(44) });
    expect(db.writes).toHaveLength(1);
  });

  it('lần lưu trước mất phản hồi nhưng đã ghi: bản máy chủ trùng bản của mình thì không coi là xung đột', async () => {
    const opened = { 5: layout(10) };
    const db = server(opened);
    db.otherUserSaves({ 5: layout(55) }); // chính lần lưu trước đã vào máy chủ
    await expect(saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft: { 5: layout(55) }, floors: ['5'] }))
      .resolves.toMatchObject({ floorLayouts: { 5: layout(55) } });
  });

  it('0 dòng mà updated_at không đổi là bị chính sách quyền từ chối, không báo nhầm xung đột', async () => {
    const opened = { 5: layout(10) };
    const db = server(opened, { denyWrites: true });
    const attempt = saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft: { 5: layout(55) }, floors: ['5'] });
    await expect(attempt).rejects.toBeInstanceOf(FloorLayoutSaveError);
    await expect(attempt).rejects.toMatchObject({ kind: 'denied' });
  });

  it('toà bị ghi liên tục quá 3 lần thì dừng, báo thử lại, không lặp vô hạn', async () => {
    const opened = { 5: layout(10), 4: layout(20) };
    const db = server(opened);
    for (let i = 0; i < 5; i += 1) db.beforeWrite.push(() => db.otherUserSaves({ ...db.current().floorLayouts, 4: layout(40 + i) }));
    await expect(saveEditedFloors(db.io, { buildingId: 'b1', base: opened, draft: { ...opened, 5: layout(55) }, floors: ['5'] }))
      .rejects.toMatchObject({ kind: 'busy' });
    expect(db.writes).toEqual([]);
  });
});
