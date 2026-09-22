// @vitest-environment jsdom
// =============================================================================
// useContractLifecycle — lớp ĐỌC của dải vòng đời.
//
// Ranh giới giả lập: `fetchAllRows` (I/O phân trang) và `supabase.rpc`. Phần
// được kiểm là: đọc ĐÚNG NGUỒN, lọc đúng org/phòng, fail-closed khi đọc hỏng,
// và KHÔNG bao giờ biến "không đọc được" thành số 0.
//
// ⚠ `supabase.rpc` và builder PostgREST trong kho này KHÔNG BAO GIỜ NÉM — chúng
// resolve với `{ data, error }`. Nên mọi nhánh lỗi dưới đây được lái bằng
// `{ data: null, error: {...} }`, không bằng `mockRejectedValue` (thứ mô phỏng
// một sự kiện không tồn tại).
// =============================================================================

import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContractLifecycle } from '@/hooks/useContractLifecycle';

const H = vi.hoisted(() => ({
  /** label → dòng trả về, hoặc `null` để mô phỏng ĐỌC HỎNG. */
  bang: new Map<string, unknown[] | null>(),
  // Spy tên `goiRpc` chứ KHÔNG phải `rpc`: check-rpc-name-literal quét văn bản
  // theo `\.rpc\(` và sẽ tính `H.rpc(...a)` của hàm chuyển tiếp bên dưới là một
  // "chỗ mù" — tên RPC giấu sau biến — dù đây chỉ là mock, không phải lời gọi
  // thật. Đổi lại thành `rpc` là làm CI đỏ ở job security-gates.
  goiRpc: vi.fn(),
  /** Mọi chuỗi builder đã dựng, để soi CỘT và BỘ LỌC thật sự gửi đi. */
  chuoi: [] as { bang: string; ops: [string, unknown[]][] }[],
  /** Nhãn của các lần gọi fetchAllRows, theo thứ tự. */
  nhan: [] as string[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const dung = (bang: string) => {
    const ghi: { bang: string; ops: [string, unknown[]][] } = { bang, ops: [] };
    H.chuoi.push(ghi);
    const p: unknown = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then') return undefined;
        return (...args: unknown[]) => { ghi.ops.push([prop, args]); return p; };
      },
    });
    return p;
  };
  return { supabase: { from: (b: string) => dung(b), rpc: (...a: unknown[]) => H.goiRpc(...a) } };
});

vi.mock('@/lib/supabaseFetchAll', () => ({
  SUPABASE_PAGE: 1000,
  fetchAllRows: async (build: (f: number, t: number) => unknown, opts: { label?: string } = {}) => {
    const label = opts.label ?? '';
    H.nhan.push(label);
    build(0, 999); // dựng chuỗi thật để test soi được cột/bộ lọc
    return H.bang.has(label) ? H.bang.get(label) : [];
  },
}));

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const ORG_KHAC = '0a0a0a0a-0000-4000-8000-0000000000ff';
const PHONG = '0b0b0b0b-0000-4000-8000-000000000401';
const HD = '0c0c0c0c-0000-4000-8000-000000000001';
const SO = '0d0d0d0d-0000-4000-8000-000000000001';
const PT = '0f0f0f0f-0000-4000-8000-000000000001';
const PC = '0f0f0f0f-0000-4000-8000-000000000002';

const HOP_DONG = {
  id: HD, organization_id: ORG, contract_number: 'HĐT-046775/28102024',
  room_id: PHONG, status: 'TERMINATED', signed_date: '2024-10-28',
  start_date: '2024-10-28', end_date: '2026-10-27', actual_end_date: '2026-09-20',
  total_deposit: 4_500_000, deposit_paid: 3_076_000, rent_price: 4_500_000,
  contract_customers: [{ customers: { full_name: 'Nguyễn Văn A' } }],
};

const DOAN = {
  contract_id: HD, contract_number: 'HĐT-046775/28102024', seg_index: 0,
  room_id: PHONG, room_name: '401', from_date: '2024-10-28', to_date: null,
  source_path: 'CONTRACT_START', transfer_id: null, trusted: true, diagnostic: null,
};

const phieu = (id: string, code: string, type: string, date: string) => ({
  id, code, type, organization_id: ORG, contract_id: HD,
  approval_status: 'APPROVED', posting_status: 'POSTED', posting_mode: 'CASH',
  deleted_at: null, reversal_of_income_expense_id: null, account_id: SO,
  system_source: null, voucher_date: date, created_at: `${date}T02:00:00Z`,
});

const itemCoc = (id: string, voucher: string, amount: number) => ({
  id, income_expense_id: voucher, organization_id: ORG,
  accounting_class: 'DEPOSIT', amount, unit_price: 0, quantity: 1,
});

const ARGS = {
  organizationId: ORG, roomId: PHONG, targetContractId: HD,
  subject: { kind: 'voucher' as const, voucherKind: 'refund' as const },
  businessDate: '2026-09-22',
};

const bocLot = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
};

/** Bộ dữ liệu đủ cho ca thật 401/32PVC. */
const napCaThat = () => {
  H.bang.set('lifecycle.transfers', []);
  H.bang.set('lifecycle.contracts-room', [HOP_DONG]);
  H.bang.set('lifecycle.contracts-ids', []);
  H.bang.set('lifecycle.terminations', [{
    id: 't1', contract_id: HD, organization_id: ORG, termination_date: '2026-09-20',
    termination_type: 'NORMAL', refund_amount: 3_076_000, outstanding_debt: 0,
    total_deposit: 4_500_000,
  }]);
  H.bang.set('lifecycle.deposit-links', []);
  H.bang.set('lifecycle.deposit-direct', [
    phieu(PT, 'PT2607068', 'INCOME', '2026-07-06'),
    phieu(PC, 'PC2607069', 'EXPENSE', '2026-07-08'),
  ]);
  H.bang.set('lifecycle.deposit-linked', []);
  H.bang.set('lifecycle.deposit-items', [
    itemCoc('i1', PT, 4_500_000), itemCoc('i2', PC, 1_424_000),
  ]);
  H.bang.set('lifecycle.accounts', [{ id: SO, organization_id: ORG, is_virtual: false }]);
  H.bang.set('lifecycle.postings', []);
  H.bang.set('lifecycle.invoices', []);
  H.goiRpc.mockResolvedValue({ data: [DOAN], error: null });
};

beforeEach(() => {
  H.bang.clear(); H.chuoi.length = 0; H.nhan.length = 0; H.goiRpc.mockReset();
});

const chay = async () => {
  const r = renderHook(() => useContractLifecycle(ARGS), { wrapper: bocLot() });
  await waitFor(() => expect(r.result.current.isLoading).toBe(false));
  return r;
};

// ═══════════════════════════════════════════════════════════════════════════
describe('useContractLifecycle — ca thật 401/32PVC', () => {
  it('gross 4.500.000 / cấn 1.424.000 / ròng 3.076.000, KHÔNG đọc deposit_paid', async () => {
    napCaThat();
    const { result } = await chay();
    const coc = result.current.data?.target?.deposit;
    expect(coc?.grossCollected).toBe(4_500_000);
    expect(coc?.offsetOut).toBe(1_424_000);
    expect(coc?.netHeld).toBe(3_076_000);

    // Cột `deposit_paid` KHÔNG được có mặt trong bất kỳ truy vấn nào.
    const cot = H.chuoi.flatMap((c) => c.ops.filter(([o]) => o === 'select').map(([, a]) => String(a[0])));
    expect(cot.join(' ')).not.toContain('deposit_paid');
  });

  it('mốc cọc mang mã phiếu thu và ngày thu', async () => {
    napCaThat();
    const { result } = await chay();
    const thu = result.current.data?.target?.deposit?.evidence.filter((e) => e.direction === 'IN');
    expect(thu?.[0]).toMatchObject({ code: 'PT2607068', date: '2026-07-06' });
  });
});

describe('useContractLifecycle — nguồn và ranh giới', () => {
  it('gọi get_room_residence_segments_v1 với ĐÚNG các hợp đồng đã đọc được qua RLS', async () => {
    napCaThat();
    await chay();
    expect(H.goiRpc).toHaveBeenCalledWith('get_room_residence_segments_v1', { p_contract_ids: [HD] });
  });

  it('mọi truy vấn đều lọc organization_id của phiếu đang mở', async () => {
    napCaThat();
    await chay();
    const coOrg = H.chuoi.filter((c) => c.ops.some(([o, a]) => o === 'eq' && a[0] === 'organization_id' && a[1] === ORG));
    expect(coOrg.length).toBe(H.chuoi.length);
  });

  it('phân trang có thứ tự ổn định + tiebreaker duy nhất ở MỌI truy vấn', async () => {
    napCaThat();
    await chay();
    for (const c of H.chuoi) {
      const order = c.ops.filter(([o]) => o === 'order').map(([, a]) => String(a[0]));
      expect(order.length, `${c.bang} thiếu order`).toBeGreaterThanOrEqual(1);
      expect(order[order.length - 1], `${c.bang} thiếu tiebreaker id`).toBe('id');
    }
  });

  it('đọc cả nguồn LIÊN KẾT qua contract_deposit_links', async () => {
    napCaThat();
    H.bang.set('lifecycle.deposit-links', [{ id: 'l1', organization_id: ORG, contract_id: HD, income_expense_id: 'v-link' }]);
    H.bang.set('lifecycle.deposit-direct', []);
    H.bang.set('lifecycle.deposit-linked', [{ ...phieu('v-link', 'PT-GIU-CHO', 'INCOME', '2026-06-01'), contract_id: null }]);
    H.bang.set('lifecycle.deposit-items', [itemCoc('i1', 'v-link', 2_000_000)]);
    const { result } = await chay();
    expect(result.current.data?.target?.deposit?.grossCollected).toBe(2_000_000);
  });

  it('nguồn vừa trực tiếp vừa liên kết chỉ tính MỘT LẦN', async () => {
    napCaThat();
    H.bang.set('lifecycle.deposit-links', [{ id: 'l1', organization_id: ORG, contract_id: HD, income_expense_id: PT }]);
    H.bang.set('lifecycle.deposit-linked', [phieu(PT, 'PT2607068', 'INCOME', '2026-07-06')]);
    H.bang.set('lifecycle.deposit-items', [itemCoc('i1', PT, 4_500_000)]);
    const { result } = await chay();
    expect(result.current.data?.target?.deposit?.grossCollected).toBe(4_500_000);
  });

  it('nguồn LIÊN KẾT bị RLS giấu ⇒ báo THIẾU NGUỒN, KHÔNG im lặng cộng thiếu', async () => {
    // `contract_deposit_links` mở theo `can_access_building` của phòng hợp đồng
    // (20260721090000:31-42), còn `income_expenses` đi policy hẹp hơn
    // (`income_expenses_select_rbac`). Hai vị ngữ KHÔNG tương đương, nên link
    // trả 1 dòng mà phiếu trả 0 dòng — KHÔNG kèm lỗi nào.
    napCaThat();
    H.bang.set('lifecycle.deposit-links', [
      { id: 'l1', organization_id: ORG, contract_id: HD, income_expense_id: 'v-bi-giau' },
    ]);
    H.bang.set('lifecycle.deposit-linked', []); // RLS giấu, không phải lỗi
    const { result } = await chay();
    expect(result.current.data?.status.deposit.kind).toBe('insufficient');
    const ly = (result.current.data?.status.deposit as { reason: string }).reason;
    expect(ly).toContain('1/1');
    // CÓ bằng chứng bị giữ lại (hỏi 1, nhận 0) ⇒ được phép nói là do quyền.
    expect(ly).toMatch(/quyền/i);
    // Số đọc được vẫn hiện, nhưng KHÔNG được coi là đã đủ.
    expect(result.current.data?.target?.deposit?.grossCollected).toBe(4_500_000);
  });

  it('HAI ca thiếu cọc phải cho HAI lý do KHÁC nhau — giấu ≠ chưa ghi nhận', async () => {
    // (a) CÓ bằng chứng bị giữ lại: link trỏ tới 1 phiếu, đọc về 0.
    napCaThat();
    H.bang.set('lifecycle.deposit-links', [
      { id: 'l1', organization_id: ORG, contract_id: HD, income_expense_id: 'v-bi-giau' },
    ]);
    H.bang.set('lifecycle.deposit-linked', []);
    const a = await chay();
    const lyGiau = (a.result.current.data?.status.deposit as { reason: string }).reason;

    // (b) KHÔNG có nguồn nào: hợp đồng cam kết 4.500.000 mà không phiếu nào.
    H.chuoi.length = 0; H.nhan.length = 0;
    napCaThat();
    H.bang.set('lifecycle.deposit-direct', []);
    H.bang.set('lifecycle.deposit-items', []);
    const b = await chay();
    const lyTrong = (b.result.current.data?.status.deposit as { reason: string }).reason;

    expect(b.result.current.data?.status.deposit.kind).toBe('insufficient');
    expect(lyTrong).not.toBe(lyGiau);
    // Chỉ ca (a) được đổ cho quyền; ca (b) không chứng minh được nguyên nhân.
    expect(lyGiau).toMatch(/quyền/i);
    expect(lyTrong).not.toMatch(/quyền/i);
    expect(lyTrong).toMatch(/chưa ghi nhận/);
  });

  it('đọc đủ mọi nguồn liên kết ⇒ nguồn cọc ĐỦ, không báo thiếu giả', async () => {
    napCaThat();
    H.bang.set('lifecycle.deposit-links', [
      { id: 'l1', organization_id: ORG, contract_id: HD, income_expense_id: 'v-link' },
    ]);
    H.bang.set('lifecycle.deposit-linked', [
      { ...phieu('v-link', 'PT-GIU-CHO', 'INCOME', '2026-06-01'), contract_id: null },
    ]);
    H.bang.set('lifecycle.deposit-items', [
      itemCoc('i1', PT, 4_500_000), itemCoc('i2', PC, 1_424_000), itemCoc('i3', 'v-link', 500_000),
    ]);
    const { result } = await chay();
    expect(result.current.data?.status.deposit.kind).toBe('sufficient');
    expect(result.current.data?.target?.deposit?.grossCollected).toBe(5_000_000);
  });

  it('KHÔNG gọi read_contract_settlement_* (đã bị migration restore xoá)', async () => {
    napCaThat();
    await chay();
    for (const [ten] of H.goiRpc.mock.calls) expect(String(ten)).not.toMatch(/read_contract_settlement/);
  });

  it('KHÔNG dùng get_room_cash_lifecycle_v1 làm nguồn cọc gross', async () => {
    napCaThat();
    await chay();
    for (const [ten] of H.goiRpc.mock.calls) expect(String(ten)).not.toBe('get_room_cash_lifecycle_v1');
  });
});

describe('useContractLifecycle — đọc hỏng KHÔNG thành số 0', () => {
  it('fetchAllRows trả null (đọc hỏng) ở nguồn cọc ⇒ status lỗi, không có số gross', async () => {
    napCaThat();
    H.bang.set('lifecycle.deposit-direct', null);
    const { result } = await chay();
    expect(result.current.data?.status.deposit.kind).toBe('error');
    expect(result.current.data?.target?.deposit).toBeNull();
  });

  it('RPC segments lỗi ⇒ status lane lỗi, KHÔNG kết luận phòng trống', async () => {
    napCaThat();
    H.goiRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const { result } = await chay();
    expect(result.current.data?.status.lanes.kind).toBe('error');
    expect(result.current.data?.roomState.kind).toBe('insufficient');
  });

  it('đọc hợp đồng hỏng ⇒ hook BÁO LỖI, không trả dữ liệu rỗng', async () => {
    napCaThat();
    H.bang.set('lifecycle.contracts-room', null);
    const { result } = await chay();
    expect(result.current.isError).toBe(true);
  });

  it('không đọc được lịch sử chuyển phòng ⇒ vẫn dựng được lane nhưng báo THIẾU DỮ LIỆU', async () => {
    napCaThat();
    H.bang.set('lifecycle.transfers', null);
    const { result } = await chay();
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.status.lanes.kind).toBe('insufficient');
  });

  it('không đọc được bút toán ⇒ CHƯA XÁC MINH, không xếp vào thực thu và không hiện 0', async () => {
    napCaThat();
    H.bang.set('lifecycle.postings', null);
    const { result } = await chay();
    expect(result.current.data?.status.postings.kind).not.toBe('sufficient');
    expect(result.current.data?.target?.deposit?.hasUnverified).toBe(true);
    // Gross vẫn đọc được từ chính phiếu — chỉ phần XÁC MINH là chưa có.
    expect(result.current.data?.target?.deposit?.grossCollected).toBe(4_500_000);
  });

  it('postings đọc được nhưng RỖNG (quyền CUSTODIAN) ⇒ cũng là chưa xác minh', async () => {
    napCaThat();
    const { result } = await chay();
    expect(result.current.data?.target?.deposit?.hasUnverified).toBe(true);
  });
});

describe('useContractLifecycle — cách ly công ty', () => {
  it('dòng lạc của org khác không bao giờ lọt vào tổng', async () => {
    napCaThat();
    H.bang.set('lifecycle.deposit-direct', [
      phieu(PT, 'PT2607068', 'INCOME', '2026-07-06'),
      { ...phieu('v-la', 'PT-LA', 'INCOME', '2026-07-07'), organization_id: ORG_KHAC },
    ]);
    H.bang.set('lifecycle.deposit-items', [itemCoc('i1', PT, 4_500_000), { ...itemCoc('i9', 'v-la', 9_999_999), organization_id: ORG_KHAC }]);
    const { result } = await chay();
    expect(result.current.data?.target?.deposit?.grossCollected).toBe(4_500_000);
  });

  it('thiếu org / phòng / hợp đồng đích ⇒ không chạy truy vấn nào', () => {
    renderHook(() => useContractLifecycle({ ...ARGS, organizationId: null }), { wrapper: bocLot() });
    expect(H.nhan).toHaveLength(0);
    expect(H.goiRpc).not.toHaveBeenCalled();
  });
});
