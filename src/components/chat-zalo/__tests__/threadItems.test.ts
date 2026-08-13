import { describe, it, expect } from 'vitest';
import { buildThreadItems, normalizeVn } from '../threadItems';
import type { ZaloMessage } from '../types';

const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 7, 13, 3, min, sec)).toISOString();
const msg = (p: Partial<ZaloMessage>): ZaloMessage => ({ dir: 'in', text: 'x', ...p });

describe('buildThreadItems', () => {
  it('chèn divider ngày khi đổi ngày', () => {
    const items = buildThreadItems([
      msg({ id: '1', createdAt: '2026-08-12T03:00:00Z' }),
      msg({ id: '2', createdAt: '2026-08-13T03:00:00Z' }),
    ]);
    const days = items.filter((i) => i.kind === 'day');
    expect(days.length).toBe(2);
    expect(items[0].kind).toBe('day');
  });

  it('gom ≥2 ảnh liên tiếp cùng chiều trong 60s thành album', () => {
    const items = buildThreadItems([
      msg({ id: 'a', type: 'image', createdAt: at(0, 0) }),
      msg({ id: 'b', type: 'image', createdAt: at(0, 20) }),
      msg({ id: 'c', type: 'image', createdAt: at(0, 40) }),
      msg({ id: 'd', text: 'text sau album', createdAt: at(1) }),
    ]);
    const albums = items.filter((i) => i.kind === 'album');
    expect(albums.length).toBe(1);
    expect((albums[0] as { items: unknown[] }).items.length).toBe(3);
  });

  it('KHÔNG gom ảnh khác chiều hoặc cách nhau quá 60s', () => {
    const items = buildThreadItems([
      msg({ id: 'a', type: 'image', dir: 'in', createdAt: at(0) }),
      msg({ id: 'b', type: 'image', dir: 'out', createdAt: at(0, 10) }),
      msg({ id: 'c', type: 'image', dir: 'out', createdAt: at(5) }),
    ]);
    expect(items.filter((i) => i.kind === 'album').length).toBe(0);
    expect(items.filter((i) => i.kind === 'msg').length).toBe(3);
  });

  it('divider chưa đọc đặt trước N tin in cuối', () => {
    const items = buildThreadItems([
      msg({ id: '1', dir: 'out', createdAt: at(0) }),
      msg({ id: '2', dir: 'in', createdAt: at(1) }),
      msg({ id: '3', dir: 'in', createdAt: at(2) }),
    ], 2);
    const idx = items.findIndex((i) => i.kind === 'unread');
    expect(idx).toBeGreaterThan(-1);
    const after = items.slice(idx + 1).filter((i) => i.kind === 'msg');
    expect(after.length).toBe(2);
  });

  it('gom nhóm: tin liên tiếp cùng chiều ≤5 phút → grouped, tin cuối lượt lastOfGroup', () => {
    const items = buildThreadItems([
      msg({ id: '1', dir: 'out', createdAt: at(0) }),
      msg({ id: '2', dir: 'out', createdAt: at(1) }),
      msg({ id: '3', dir: 'in', createdAt: at(2) }),
    ]);
    const msgs = items.filter((i) => i.kind === 'msg') as Extract<ReturnType<typeof buildThreadItems>[number], { kind: 'msg' }>[];
    expect(msgs[0].grouped).toBe(false);
    expect(msgs[0].lastOfGroup).toBe(false);
    expect(msgs[1].grouped).toBe(true);
    expect(msgs[1].lastOfGroup).toBe(true);
    expect(msgs[2].grouped).toBe(false);
  });
});

describe('normalizeVn', () => {
  it('bỏ dấu tiếng Việt', () => {
    expect(normalizeVn('Phòng Trọ Đẹp')).toBe('phong tro dep');
    expect(normalizeVn('điện nước')).toBe('dien nuoc');
  });
});
