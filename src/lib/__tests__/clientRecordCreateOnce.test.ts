// Đợt 9: `createRecordOnce` — tạo bản ghi thiết lập bằng mã do trình duyệt sinh, nhớ mã theo tab theo `matchKeys`.
// Ba kịch bản của plan (lệnh không tới máy chủ; tới nhưng mất phản hồi; trùng với bản ghi khác) cộng hàng rào: mã đã có mà
// không đọc thấy, đọc lại hỏng, lần trước ghi với thông tin khác.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Mode = 'ok' | 'drop-before' | 'drop-after';
const io = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  ids: [] as string[],
  modes: [] as string[],
  readFails: 0,
  /** Chỉ mục duy nhất khác khoá chính: cột → tên chỉ mục. */
  unique: null as null | { column: string; name: string },
  hidden: new Set<string>(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      let payload: Record<string, unknown> | undefined;
      let wantedId: unknown;
      const query = {
        insert: (value: Record<string, unknown>) => { payload = value; return query; },
        select: () => query,
        eq: (_column: string, value: unknown) => { wantedId = value; return query; },
        single: async () => {
          io.ids.push(String(payload?.id));
          const mode = (io.modes.shift() ?? 'ok') as Mode;
          if (mode === 'drop-before') throw new TypeError('Failed to fetch');
          if (io.rows.some(row => row.id === payload?.id)) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
          if (io.unique && io.rows.some(row => row[io.unique!.column] === payload?.[io.unique!.column])) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${io.unique.name}"` } };
          }
          io.rows.push(payload!);
          if (mode === 'drop-after') throw new TypeError('Failed to fetch');
          return { data: payload, error: null };
        },
        maybeSingle: async () => {
          if (io.readFails > 0) { io.readFails--; throw new TypeError('Failed to fetch'); }
          const row = io.rows.find(item => item.id === wantedId && !io.hidden.has(String(item.id)));
          return { data: row ?? null, error: null };
        },
      };
      return query;
    },
  },
}));

import { createRecordOnce, forgetUnconfirmedCreates, otherUniqueConstraint } from '../clientRecordCreate';
import { FinancialAlreadyRecordedError, FinancialWorkflowError } from '../financialWorkflowError';

const asset = (name: string, note = '') => ({
  table: 'assets' as const, userId: 'u1', organizationId: 'o1', matchKeys: [`n:${name.toLowerCase()}`],
  payload: { name, notes: note, organization_id: 'o1' },
  operation: 'tạo tài sản', sameAs: (row: Record<string, unknown>) => row.name === name && row.notes === note,
  describe: (row: Record<string, unknown>) => `Tài sản ${String(row.name)}`,
});

beforeEach(() => { io.rows = []; io.ids = []; io.modes = []; io.readFails = 0; io.unique = null; io.hidden = new Set(); forgetUnconfirmedCreates(); });

describe('createRecordOnce', () => {
  it('lệnh không tới máy chủ: báo chưa rõ, bấm lại gửi đúng mã đó và tạo đúng một bản ghi', async () => {
    io.modes = ['drop-before'];
    await expect(createRecordOnce(asset('Máy lạnh A'))).rejects.toMatchObject({ outcome: 'unknown' });
    expect(io.rows).toHaveLength(0);
    const second = await createRecordOnce(asset('Máy lạnh A'));
    expect(second.replayed).toBe(false);
    expect(io.ids[1]).toBe(io.ids[0]);
    expect(io.rows).toHaveLength(1);
    expect(second.row.id).toBe(io.ids[0]);
  });

  it('tới nhưng mất phản hồi, đọc lại được ngay: nhận đúng bản ghi đó, không báo lỗi', async () => {
    io.modes = ['drop-after'];
    await expect(createRecordOnce(asset('Máy lạnh A'))).resolves.toMatchObject({ replayed: true, clientId: io.ids[0] });
    expect(io.rows).toHaveLength(1);
  });

  it('tới nhưng mất phản hồi và đọc lại hỏng: bấm lại nhận ra bản ghi của lần trước, không tạo bản thứ hai', async () => {
    io.modes = ['drop-after'];
    io.readFails = 1;
    await expect(createRecordOnce(asset('Máy lạnh A'))).rejects.toMatchObject({ outcome: 'unknown' });
    expect(io.rows).toHaveLength(1);
    const second = await createRecordOnce(asset('Máy lạnh A'));
    expect(second).toMatchObject({ replayed: true, clientId: io.ids[0] });
    expect(io.rows).toHaveLength(1);
  });

  it('xong rồi thì quên mã: lần tạo sau cùng tên là một bản ghi mới', async () => {
    await createRecordOnce(asset('Máy lạnh A'));
    await createRecordOnce(asset('Máy lạnh A'));
    expect(io.ids[1]).not.toBe(io.ids[0]);
    expect(io.rows).toHaveLength(2);
  });

  it('lần trước đã ghi với thông tin khác: báo mã đã có, không ghi thêm; lần bấm sau là lượt mới', async () => {
    io.modes = ['drop-after'];
    io.readFails = 1;
    await expect(createRecordOnce(asset('Máy lạnh A', 'cũ'))).rejects.toMatchObject({ outcome: 'unknown' });
    const error = await createRecordOnce(asset('Máy lạnh A', 'mới')).catch(e => e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(error.message).toContain(io.ids[0]);
    expect(io.rows).toHaveLength(1);
    await createRecordOnce(asset('Máy lạnh A', 'mới'));
    expect(io.ids[2]).not.toBe(io.ids[0]);
    expect(io.rows).toHaveLength(2);
  });

  it('đọc lại hỏng sau khi mất phản hồi: vẫn chưa rõ (không coi là chưa ghi), lần sau gửi lại đúng mã', async () => {
    io.modes = ['drop-after'];
    io.readFails = 1;
    const error = await createRecordOnce(asset('Máy lạnh A')).catch(e => e);
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error.outcome).toBe('unknown');
    const second = await createRecordOnce(asset('Máy lạnh A'));
    expect(second.replayed).toBe(true);
    expect(io.rows).toHaveLength(1);
  });

  it('trùng tên với một bản ghi KHÁC (chỉ mục duy nhất ngoài khoá chính): trả nguyên lời từ chối, không báo «mã đã có»', async () => {
    io.unique = { column: 'name', name: 'idx_rooms_unique_name_per_building' };
    io.rows.push({ id: 'r-cu', name: 'P101' });
    const error = await createRecordOnce({ ...asset('P101'), table: 'rooms', payload: { name: 'P101' } }).catch(e => e);
    expect(error).not.toBeInstanceOf(FinancialWorkflowError);
    expect(error).toMatchObject({ code: '23505' });
    expect(io.rows).toHaveLength(1);
    // Lời từ chối rõ của một mã mới: quên mã, lần sau mã mới.
    io.unique = null;
    await createRecordOnce({ ...asset('P101'), table: 'rooms', payload: { name: 'P101' } });
    expect(io.ids[1]).not.toBe(io.ids[0]);
  });

  it('khoá chính đã có mà không đọc thấy (RLS ẩn): báo «đã có trên máy chủ», không tạo', async () => {
    io.modes = ['drop-after'];
    io.readFails = 1;
    await expect(createRecordOnce(asset('Máy lạnh A'))).rejects.toMatchObject({ outcome: 'unknown' });
    io.hidden.add(io.ids[0]);
    await expect(createRecordOnce(asset('Máy lạnh A'))).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(io.rows).toHaveLength(1);
  });

  it('không có khoá nhận dạng: mỗi lần bấm một mã mới (không nhớ)', async () => {
    io.modes = ['drop-before'];
    await expect(createRecordOnce({ ...asset('X'), matchKeys: [] })).rejects.toMatchObject({ outcome: 'unknown' });
    await createRecordOnce({ ...asset('X'), matchKeys: [] });
    expect(io.ids[1]).not.toBe(io.ids[0]);
  });
});

describe('otherUniqueConstraint', () => {
  it('chỉ nhận 23505 nêu tên chỉ mục khác khoá chính của đúng bảng', () => {
    expect(otherUniqueConstraint({ code: '23505', message: 'duplicate key value violates unique constraint "rooms_pkey"' }, 'rooms')).toBe(false);
    expect(otherUniqueConstraint({ code: '23505', message: 'duplicate key value violates unique constraint "idx_rooms_unique_name_per_building"' }, 'rooms')).toBe(true);
    expect(otherUniqueConstraint({ code: '23505', message: 'duplicate key' }, 'rooms')).toBe(false);
    expect(otherUniqueConstraint({ code: '23503', message: 'violates unique constraint "x"' }, 'rooms')).toBe(false);
  });
});
