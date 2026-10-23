import { beforeEach, describe, expect, it, vi } from 'vitest';

// Giả lập PostgREST theo TÊN BẢNG: lọc eq/neq/in đơn giản + phân trang theo range,
// ghi lại chuỗi lệnh để kiểm order('id') và range. Số liệu giả, không phải dữ liệu thật.
const mocks = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Op = [string, unknown[]];
  const state = {
    tables: {} as Record<string, Row[]>,
    errors: {} as Record<string, unknown>,
    calls: [] as { table: string; ops: Op[] }[],
  };
  const from = (table: string) => {
    const call = { table, ops: [] as Op[] };
    state.calls.push(call);
    const resolve = () => {
      if (state.errors[table]) return { data: null, error: state.errors[table] };
      let rows = state.tables[table] ?? [];
      let range: [number, number] | null = null;
      for (const [op, args] of call.ops) {
        if (op === 'eq') rows = rows.filter((r) => r[args[0] as string] === args[1]);
        if (op === 'neq') rows = rows.filter((r) => r[args[0] as string] !== args[1]);
        if (op === 'in') rows = rows.filter((r) => (args[1] as unknown[]).includes(r[args[0] as string]));
        if (op === 'range') range = [args[0] as number, args[1] as number];
      }
      return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null };
    };
    const chain: Record<string, unknown> = new Proxy({}, {
      get: (_t, name: string) => {
        if (name === 'then') {
          const p = Promise.resolve(resolve());
          return p.then.bind(p);
        }
        return (...args: unknown[]) => {
          call.ops.push([name, args]);
          return chain;
        };
      },
    });
    return chain;
  };
  return { state, from };
});

vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => mocks.from(t) } }));

// useQuery bị mock thành hàm trả options ⇒ gọi như một hàm dựng truy vấn, ngoài React.
import { useVacantRoomNotes as vacantRoomNotesQuery } from '../realEstateReports';
import type { VacantRoomNote } from '../types';
import { summarizeRoomNotes } from '@/lib/profitReportChecks';

const MONTH_END = '2026-10-31';
const room = (id: string) => ({ id, name: id.toUpperCase(), status: 'AVAILABLE', building_id: 'b1', buildings: { id: 'b1', name: 'Toà Một' } });
const contract = (id: string, room_id: string, status: string, start: string, end: string | null, actual: string | null = null) => ({
  id, room_id, status, start_date: start, start_billing_date: null, end_date: end, actual_end_date: actual, contract_number: `HD-${id}`,
});
const invoice = (id: string, contract_id: string, total: number, paid: number, extra: Record<string, unknown> = {}) => ({
  id, contract_id, room_id: 'khac', status: paid >= total ? 'PAID' : 'APPROVED', kind: 'MONTHLY', billing_month: '2026-10',
  total_amount: total, paid_amount: paid, remaining_amount: total - paid, is_overdue: false, ...extra,
});

beforeEach(() => {
  mocks.state.calls = [];
  mocks.state.errors = {};
  mocks.state.tables = {
    rooms: ['r1', 'r2', 'r3', 'r4', 'r5'].map(room),
    contracts: [
      contract('c1', 'r1', 'ACTIVE', '2026-01-01', '2026-12-31'),
      contract('c2', 'r2', 'ACTIVE', '2026-01-01', '2026-12-31'),
      // HĐ đã đổi phòng tại chỗ: hoá đơn còn ghi phòng cũ — vẫn khớp theo contract_id.
      contract('c3', 'r3', 'ACTIVE', '2026-01-01', '2026-12-31'),
      // r4: thanh lý giữa tháng có bản ghi thanh lý ⇒ phòng trống, không phải F46.
      contract('c4', 'r4', 'TERMINATED', '2026-01-01', '2026-12-31', '2026-10-10'),
      // r5: HĐ cũ kết thúc 03/10 KHÔNG thanh lý, không hoá đơn; HĐ mới từ 14/10 đã thu đủ.
      contract('c5', 'r5', 'TERMINATED', '2026-01-01', '2026-09-30', '2026-10-03'),
      contract('c6', 'r5', 'ACTIVE', '2026-10-14', '2027-10-13'),
      // Hết hạn 15/10, thanh lý đã duyệt, không hoá đơn ⇒ đã quyết toán, không cờ.
      contract('c7', 'r4', 'EXPIRED', '2026-01-01', '2026-10-15'),
      // Thanh lý NHÁP và chưa có hoá đơn kỳ ⇒ cờ.
      contract('c8', 'r4', 'TERMINATED', '2026-01-01', '2026-12-31', '2026-10-20'),
      // Kết thúc tháng trước ⇒ không thuộc F46 tháng này.
      contract('c9', 'r4', 'TERMINATED', '2026-01-01', '2026-12-31', '2026-09-20'),
    ],
    invoices: [
      invoice('i1', 'c1', 5_000_000, 0, { status: 'OVERDUE', is_overdue: true }),
      invoice('i3', 'c3', 4_000_000, 1_000_000),
      invoice('i6', 'c6', 3_000_000, 3_000_000),
      invoice('i5-old', 'c5', 1_000_000, 0, { billing_month: '2026-09' }),
      invoice('ix', 'c2', 9_000_000, 0, { status: 'CANCELLED' }),
      invoice('iset', 'c2', 500_000, 0, { kind: 'SETTLEMENT' }),
    ],
    contract_terminations: [
      { contract_id: 'c4', termination_type: 'NORMAL', termination_date: '2026-10-10', actual_move_out_date: '2026-10-10', status: 'COMPLETED' },
      { contract_id: 'c7', termination_type: 'NORMAL', termination_date: '2026-10-15', actual_move_out_date: null, status: 'APPROVED' },
      { contract_id: 'c8', termination_type: 'NORMAL', termination_date: '2026-10-20', actual_move_out_date: null, status: 'DRAFT' },
      { contract_id: 'c5', termination_type: 'NORMAL', termination_date: '2026-10-03', actual_move_out_date: null, status: 'CANCELLED' },
    ],
    contract_transfers: [],
  };
});

const run = (opts?: { includeEndedContracts?: boolean }, buildingIds: string[] = []) =>
  (vacantRoomNotesQuery(buildingIds, MONTH_END, true, opts) as unknown as { queryFn: () => Promise<Map<string, VacantRoomNote>> }).queryFn();

describe('useVacantRoomNotes — hoá đơn kỳ (F14)', () => {
  it('tách "chưa có hoá đơn" với "có hoá đơn chưa thu", khớp theo contract_id', async () => {
    const notes = await run();
    expect(notes.get('r1')).toMatchObject({
      kind: 'active', invoiceState: 'unpaid', invoiceIds: ['i1'], invoiceTotal: 5_000_000, invoicePaid: 0,
      invoiceRemaining: 5_000_000, invoiceOverdue: true,
    });
    // Hoá đơn huỷ và hoá đơn thanh lý không phải hoá đơn tiền phòng tháng.
    expect(notes.get('r2')).toMatchObject({ kind: 'active', invoiceState: 'none', invoiceIds: [], invoiceRemaining: 0 });
    expect(notes.get('r3')).toMatchObject({ kind: 'active', invoiceState: 'partial', invoiceRemaining: 3_000_000, invoiceOverdue: false });
    expect(notes.get('r5')).toMatchObject({ kind: 'active', invoiceState: 'paid' });
    expect(notes.get('r4')).toMatchObject({ kind: 'vacant', reason: expect.any(String) });
  });

  it('mặc định KHÔNG trả ghi chú HĐ kết thúc (nơi gọi cũ không vỡ)', async () => {
    const notes = await run();
    expect([...notes.keys()].filter((k) => k.startsWith('ended:'))).toEqual([]);
    expect([...notes.values()].every((n) => n.kind === 'active' || n.kind === 'vacant')).toBe(true);
  });

  it('đếm phòng trống theo ghi chú vacant (F45) qua summarizeRoomNotes', async () => {
    expect(summarizeRoomNotes(await run())).toMatchObject({
      vacantRooms: 1, missingInvoiceRooms: 1, unpaidInvoiceRooms: 1, unpaidInvoiceAmount: 5_000_000, overdueInvoiceRooms: 1,
    });
  });
});

describe('useVacantRoomNotes — HĐ kết thúc giữa tháng chưa thanh lý (F46)', () => {
  it('gắn cờ HĐ không có thanh lý, và thanh lý nháp chưa có hoá đơn kỳ', async () => {
    const notes = await run({ includeEndedContracts: true });
    const ended = [...notes.entries()].filter(([k]) => k.startsWith('ended:'));
    expect(ended.map(([k]) => k).sort()).toEqual(['ended:c5', 'ended:c8']);
    expect(notes.get('ended:c5')).toMatchObject({
      kind: 'ended_unsettled', roomId: 'r5', contractId: 'c5', contractNumber: 'HD-c5', endedOn: '2026-10-03',
      missingTermination: true, hasFinalInvoice: false, finalInvoiceRemaining: 0,
    });
    expect(notes.get('ended:c8')).toMatchObject({ missingTermination: false, hasFinalInvoice: false });
    // Phòng r5 vẫn giữ ghi chú phòng của HĐ mới.
    expect(notes.get('r5')).toMatchObject({ kind: 'active', invoiceState: 'paid' });
    expect(summarizeRoomNotes(notes).endedUnsettled).toBe(2);
  });

  it('không cờ khi đã có thanh lý và có hoá đơn cuối', async () => {
    mocks.state.tables.contract_terminations.push({
      contract_id: 'c5', termination_type: 'NORMAL', termination_date: '2026-10-03', actual_move_out_date: null, status: 'DRAFT',
    });
    mocks.state.tables.invoices.push(invoice('i5', 'c5', 600_000, 0));
    const notes = await run({ includeEndedContracts: true });
    expect(notes.has('ended:c5')).toBe(false);
  });

  it('có hoá đơn cuối nhưng chưa thanh lý vẫn cờ, kèm số còn nợ', async () => {
    mocks.state.tables.invoices.push(invoice('i5', 'c5', 600_000, 100_000, { kind: 'SETTLEMENT' }));
    const notes = await run({ includeEndedContracts: true });
    expect(notes.get('ended:c5')).toMatchObject({ missingTermination: true, hasFinalInvoice: true, finalInvoiceRemaining: 500_000 });
  });
});

describe('useVacantRoomNotes — đọc đủ dòng (F57)', () => {
  it('rooms/contracts/invoices phân trang bằng range + order("id"), không cắt ở 4999', async () => {
    await run();
    for (const table of ['rooms', 'contracts', 'invoices']) {
      const calls = mocks.state.calls.filter((c) => c.table === table);
      // Trang 1 có dữ liệu ⇒ phải hỏi tiếp trang 2 (rỗng) rồi mới dừng.
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const c of calls) {
        expect(c.ops).toContainEqual(['order', ['id', { ascending: true }]]);
        const range = c.ops.find(([op]) => op === 'range');
        expect(range?.[1][1] as number - (range?.[1][0] as number)).toBe(999);
      }
    }
    const invoiceCall = mocks.state.calls.find((c) => c.table === 'invoices');
    expect(invoiceCall?.ops).toContainEqual(['eq', ['billing_month', '2026-10']]);
    expect(invoiceCall?.ops).toContainEqual(['neq', ['status', 'CANCELLED']]);
  });

  it('lỗi đọc hoá đơn thì báo lỗi, không coi là "chưa có hoá đơn"', async () => {
    const error = { code: '42501', message: 'denied' };
    mocks.state.errors.invoices = error;
    await expect(run()).rejects.toBe(error);
  });
});
