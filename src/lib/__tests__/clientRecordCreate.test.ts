// Đợt 4 (review lượt 1): mã của lần tạo được nhớ TỪ TRƯỚC khi gửi, nên lần bấm khi lệnh cũ còn treo (đóng rồi mở lại
// hộp) dùng lại đúng mã đó và khoá chính chặn bản ghi thứ hai.
import { beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], pending: [] as ((value: unknown) => void)[], ids: [] as string[] }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      let payload: Record<string, unknown> | undefined;
      let wantedId: unknown;
      const query = {
        insert: (value: Record<string, unknown>) => { payload = value; return query; },
        select: () => query,
        eq: (_column: string, value: unknown) => { wantedId = value; return query; },
        // Lệnh chèn treo tới khi test cho chạy tiếp; lúc đó mới ghi (hoặc gặp trùng mã).
        single: () => {
          io.ids.push(String(payload?.id));
          return new Promise(resolve => io.pending.push(() => {
            if (io.rows.some(row => row.id === payload?.id)) resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "customers_pkey"' } });
            else { io.rows.push(payload!); resolve({ data: payload, error: null }); }
          }));
        },
        maybeSingle: async () => ({ data: io.rows.find(row => row.id === wantedId) ?? null, error: null }),
      };
      return query;
    },
  },
}));

import {createWithClientMemory,forgetUnconfirmedCreates} from '../clientRecordCreate';

const input = (name: string) => ({
  table: 'customers' as const, userId: 'u1', organizationId: 'o1', payload: { full_name: name, phone: '0900000001' },
  person: { name, phone: '0900000001' }, personOf: (row: Record<string, unknown>) => ({ name: row.full_name, phone: row.phone }),
  operation: 'tạo khách hàng', describe: () => 'Khách',
});
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => { io.rows = []; io.pending = []; io.ids = []; forgetUnconfirmedCreates(); });

it('lần bấm khi lệnh cũ còn treo dùng lại đúng mã; cả hai lần đều ra cùng một khách', async () => {
  const first = createWithClientMemory(input('Khách An'));
  await settle();
  const second = createWithClientMemory(input('Khách An'));
  await settle();
  expect(io.ids).toHaveLength(2);
  expect(io.ids[1]).toBe(io.ids[0]);
  io.pending.shift()!(undefined);
  await expect(first).resolves.toMatchObject({ replayed: false });
  io.pending.shift()!(undefined);
  await expect(second).resolves.toMatchObject({ replayed: true });
  expect(io.rows).toHaveLength(1);
});

it('xong rồi thì quên mã: lần tạo sau (khách khác hay cùng người) dùng mã mới', async () => {
  const first = createWithClientMemory(input('Khách An'));
  await settle();
  io.pending.shift()!(undefined);
  await first;
  const second = createWithClientMemory(input('Khách An'));
  await settle();
  expect(io.ids[1]).not.toBe(io.ids[0]);
  io.pending.shift()!(undefined);
  await second;
  expect(io.rows).toHaveLength(2);
});
