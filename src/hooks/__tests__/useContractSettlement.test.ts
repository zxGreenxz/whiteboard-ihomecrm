// @vitest-environment jsdom
// =============================================================================
// READ MODEL của khu "Hợp đồng & quyết toán" — phân loại phiếu và căn cứ đi kèm.
//
// VÌ SAO CÓ FILE NÀY (plan §3.6, T5a)
// D4 (truy vấn theo HẠNG MỤC KẾ TOÁN) trước đây chỉ lấy `income_expense_id` rồi
// vứt luôn thông tin hạng mục nào đã khớp, nên `kindOf` kết thúc bằng
// `return 'refund'` trần: hai phiếu THẬT PC2606169 và PC2608091 mang hạng mục
// HHMG nhưng thiếu `commission_kind` bị xếp vào Hoàn khách và không bao giờ
// được tra căn cứ hoa hồng.
//
// ĐỊNH DANH LUÔN LÀ (UUID, organization_id) — không bao giờ là MÃ phiếu. Trên
// production có nhiều phiếu trùng mã hiển thị (vd nhiều PC2607070 ở các phòng
// khác nhau), nên fixture dưới đây mô phỏng HÌNH DẠNG của hai ca thật còn định
// danh thì dùng UUID.
//
// Ranh giới giả lập: `fetchAllRows` (I/O phân trang) và `supabase.rpc`. Phần
// được kiểm là logic gộp/khử trùng/phân loại/tra căn cứ của chính hook.
// =============================================================================

import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContractSettlement } from '@/hooks/useContractSettlement';

const H = vi.hoisted(() => ({
  fetchAllRows: vi.fn(),
  rpc: vi.fn(),
  supplements: vi.fn(),
  /** Kết quả của `from('income_expense_types').select(...).eq(...)`. */
  loaiThuChi: { data: null as unknown, error: null as unknown },
  /** Mọi chuỗi builder đã dựng, để soi CỘT và BỘ LỌC thật sự gửi đi. */
  chuoi: [] as { bang: string; ops: [string, unknown[]][] }[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const dung = (bang: string) => {
    const ghi: { bang: string; ops: [string, unknown[]][] } = { bang, ops: [] };
    H.chuoi.push(ghi);
    const p: unknown = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        // Chỉ bảng loại thu chi được `await` thẳng; các builder còn lại đi qua
        // fetchAllRows nên KHÔNG được là thenable.
        if (prop === 'then') {
          if (bang !== 'income_expense_types') return undefined;
          return (ok: (v: unknown) => void) => ok(H.loaiThuChi);
        }
        return (...args: unknown[]) => { ghi.ops.push([prop, args]); return p; };
      },
    });
    return p;
  };
  return {
    supabase: {
      from: (bang: string) => dung(bang),
      rpc: (...a: unknown[]) => H.rpc(...a),
    },
  };
});

vi.mock('@/lib/supabaseFetchAll', () => ({
  fetchAllRows: (...a: unknown[]) => H.fetchAllRows(...a),
  SUPABASE_PAGE: 1000,
}));

vi.mock('@/hooks/income-expenses/supplements', () => ({
  hydrateIncomeExpenseSupplements: (...a: unknown[]) => H.supplements(...a),
}));

// ── Định danh ───────────────────────────────────────────────────────────────
const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const TOA = '0b0b0b0b-0000-4000-8000-000000000002';

const T_HHMG = '0e0e0e0e-0000-4000-8000-000000000001';
const T_HOAN = '0e0e0e0e-0000-4000-8000-000000000002';
const T_THUONG = '0e0e0e0e-0000-4000-8000-000000000003';
const T_DIEN = '0e0e0e0e-0000-4000-8000-000000000004';

const HD_THANG6 = '0c0c0c0c-0000-4000-8000-000000000006';
const HD_THANG8 = '0c0c0c0c-0000-4000-8000-000000000008';

const V_HHMG_T6 = '0f0f0f0f-0000-4000-8000-000000000001';
const V_HHMG_T8 = '0f0f0f0f-0000-4000-8000-000000000002';

const LOAI_THAT = [
  { id: T_HHMG, category: 'HOA HỒNG', name: 'HHMG' },
  { id: T_HOAN, category: 'XỬ LÝ HĐ', name: 'Bổ sung hoàn cọc' },
  { id: T_THUONG, category: 'HOA HỒNG', name: 'Thưởng nóng Sale' },
  // Ngoài nhóm — phải bị `settlementTypeMatches` loại, không vào typeMap.
  { id: T_DIEN, category: 'Điện', name: 'Đóng tiền điện' },
];
const TRONG_KHU = new Set([T_HHMG, T_HOAN, T_THUONG]);

interface PhieuGia {
  id: string;
  code: string | null;
  organization_id: string;
  building_id: string | null;
  room_id: string | null;
  contract_id: string | null;
  total_amount: number;
  voucher_date: string | null;
  system_source: string | null;
  commission_kind: string | null;
  payer_name: string | null;
  receive_bank_name: string | null;
  receive_bank_account: string | null;
  account_id: string | null;
  posting_mode: string | null;
  approval_status: string | null;
  posting_status: string | null;
  review_state: string | null;
  review_reason: string | null;
  review_version: number;
  approval_version: number;
  posting_version: number;
  maker_user_id: string | null;
  posted_at_v2: string | null;
  attachments: unknown;
  buildings: { name: string } | null;
  rooms: { name: string } | null;
  accounts: { name: string | null } | null;
  contracts: {
    contract_number: string | null;
    signed_date: string | null;
    contract_customers: { customers: { full_name: string | null } | null }[] | null;
  } | null;
}

const phieu = (p: Partial<PhieuGia> & { id: string }): PhieuGia => ({
  code: 'PC-X', organization_id: ORG, building_id: TOA, room_id: null,
  contract_id: null, total_amount: 1_000_000, voucher_date: '2026-09-10',
  system_source: null, commission_kind: null,
  // Đủ bộ thông tin nhận tiền để MISSING_PAYMENT_INFO không nhiễu vào ca kiểm.
  payer_name: 'Môi giới X', receive_bank_name: 'VCB', receive_bank_account: '0123',
  account_id: null, posting_mode: null,
  approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
  review_state: 'PENDING', review_reason: null,
  review_version: 1, approval_version: 1, posting_version: 1,
  maker_user_id: null, posted_at_v2: null, attachments: [],
  buildings: { name: 'Toà A' }, rooms: { name: '101' }, accounts: null,
  contracts: null,
  ...p,
});

const hopDong = (so: string, ngayKy: string) => ({
  contract_number: so, signed_date: ngayKy,
  contract_customers: [{ customers: { full_name: 'Khách A' } }],
});

interface ItemGia { income_expense_id: string; income_expense_type_id: string }

/** Giả lập bốn truy vấn rời của hook từ MỘT tập phiếu + MỘT tập item. */
const nap = (ps: PhieuGia[], items: ItemGia[]) => {
  H.fetchAllRows.mockImplementation(async (build: unknown, opt: unknown) => {
    // Dựng chuỗi thật để test soi được cột/bộ lọc đã gửi.
    (build as (f: number, t: number) => unknown)(0, 999);
    const label = (opt as { label?: string })?.label;
    if (label === 'contract-settlement.items') return items;
    const coHangMuc = new Set(
      items.filter((i) => TRONG_KHU.has(i.income_expense_type_id)).map((i) => i.income_expense_id),
    );
    switch (label) {
      case 'cs.d1': return ps.filter((v) => (v.system_source ?? '').startsWith('termination.refund'));
      case 'cs.d2': return ps.filter((v) => (v.system_source ?? '').startsWith('reservation.refund'));
      case 'cs.d3': return ps.filter((v) => v.commission_kind === 'broker' || v.commission_kind === 'sale');
      case 'cs.d4': return ps.filter((v) => coHangMuc.has(v.id));
      default: return [];
    }
  });
};

interface DongCanCu {
  contract_id: string;
  expected_amount: number | string | null;
  tier_percent: number | string | null;
  voucher_id?: string | null;
  status?: string | null;
}

/** Giả lập `get_period_commissions`: kỳ ký → các dòng căn cứ. */
const napCanCu = (theoKy: Record<string, DongCanCu[]>) => {
  H.rpc.mockImplementation(async (ten: string, args: { p_period_month: string }) => {
    if (ten !== 'get_period_commissions') return { data: null, error: { message: `RPC lạ: ${ten}` } };
    return { data: theoKy[args.p_period_month] ?? [], error: null };
  });
};

const chay = (period = '2026-09') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(
    () => useContractSettlement({ organizationId: ORG, buildingIds: [TOA], period, scope: 'open' }),
    { wrapper },
  );
};

beforeEach(() => {
  H.chuoi.length = 0;
  H.fetchAllRows.mockReset();
  H.rpc.mockReset();
  H.supplements.mockReset();
  H.supplements.mockImplementation(async (vs: { id: string }[]) =>
    vs.map((v) => ({ ...v, supplements: [] })));
  H.loaiThuChi = { data: LOAI_THAT, error: null };
  napCanCu({});
});

// ── Ca chính: HHMG thủ công ─────────────────────────────────────────────────

describe('useContractSettlement — HHMG thủ công vào Hoa hồng', () => {
  const V = () => phieu({
    id: V_HHMG_T6, code: 'PC2606169', contract_id: HD_THANG6,
    total_amount: 4_500_000, voucher_date: '2026-09-02',
    contracts: hopDong('HD-2606-01', '2026-06-12'),
  });

  it('phiếu hạng mục HHMG thiếu metadata xếp vào Hoa hồng, không Hoàn khách', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];
    expect(r.kind).toBe('commission');
    expect(r.kindSource).toBe('accounting_item');
    expect(r.kindConflict).toBe(false);
    expect(r.voucherId).toBe(V_HHMG_T6);
  });

  it('tra căn cứ theo KỲ KÝ hợp đồng chứ không phải kỳ phiếu', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-06': [{ contract_id: HD_THANG6, expected_amount: 4_500_000, tier_percent: 50 }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('matched'));
    expect(H.rpc).toHaveBeenCalledWith('get_period_commissions',
      expect.objectContaining({ p_period_month: '2026-06' }));
    expect(result.current.rows[0].basis).toEqual({ kind: 'matched', amount: 4_500_000 });
  });

  it('lệch số thì báo lệch — số trên phiếu KHÔNG bị thay bằng số căn cứ', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-06': [{ contract_id: HD_THANG6, expected_amount: 3_000_000, tier_percent: 30 }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('mismatch'));
    expect(result.current.rows[0].amount).toBe(4_500_000);
    expect(result.current.rows[0].issues).toContain('AMOUNT_MISMATCH');
  });

  it('KHÔNG gọi RPC ghi chú tự sinh và KHÔNG bịa dấu nguồn cho phiếu thủ công', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-06': [{ contract_id: HD_THANG6, expected_amount: 4_500_000, tier_percent: 50 }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('matched'));
    // Căn cứ SỐ TIỀN có, nhưng ghi chú chi tiết tự sinh thì không — RPC đó đòi
    // commission_kind broker/sale, và giả mạo dấu nguồn là điều cấm.
    const tenRpc = H.rpc.mock.calls.map((c) => c[0]);
    expect(tenRpc).not.toContain('get_commission_voucher_facts_v1');
    expect(new Set(tenRpc)).toEqual(new Set(['get_period_commissions']));
  });

  it('ghi chú bổ sung vẫn chạy cho phiếu vừa đổi nhóm', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    H.supplements.mockImplementation(async (vs: { id: string }[]) =>
      vs.map((v) => ({ ...v, supplements: [{ note: '[CẦN BỔ SUNG] thiếu ảnh chuyển khoản' }] })));
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.supplementPending).toBe(true));
    expect(result.current.rows[0].issues).toContain('SUPPLEMENT_PENDING');
    expect(H.supplements).toHaveBeenCalledWith([{ id: V_HHMG_T6 }]);
  });

  it('read model KHÔNG ghi gì xuống DB — loại suy ra không bao giờ quay lại phiếu', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-06': [{ contract_id: HD_THANG6, expected_amount: 4_500_000, tier_percent: 50 }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('matched'));
    const moiThaoTac = H.chuoi.flatMap((c) => c.ops.map(([m]) => m));
    for (const ghi of ['insert', 'update', 'upsert', 'delete']) {
      expect(moiThaoTac, `PHẢI không có .${ghi}()`).not.toContain(ghi);
    }
  });
});

// ── D4 phải GIỮ hạng mục ────────────────────────────────────────────────────

describe('useContractSettlement — D4 giữ income_expense_type_id', () => {
  it('truy vấn item đọc cả hai cột', async () => {
    nap([phieu({ id: V_HHMG_T6, contract_id: HD_THANG6, contracts: hopDong('HD-1', '2026-06-12') })],
      [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const q = H.chuoi.find((c) => c.bang === 'income_expense_items');
    const cot = String(q?.ops.find(([m]) => m === 'select')?.[1][0] ?? '');
    expect(cot).toContain('income_expense_id');
    expect(cot).toContain('income_expense_type_id');
  });

  it('item của hạng mục NGOÀI nhóm không đổi loại của phiếu', async () => {
    // Bộ lọc `.in(type_id, typeIds)` phía server đã chặn loại ngoài nhóm; ca này
    // ghim thêm hàng rào phía client (typeMap.get trả undefined ⇒ bỏ qua).
    nap([phieu({ id: V_HHMG_T6, contract_id: HD_THANG6, contracts: hopDong('HD-1', '2026-06-12') })], [
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG },
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_DIEN },
    ]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].kind).toBe('commission');
    expect(result.current.rows[0].kindConflict).toBe(false);
  });

  it('nhiều item cùng loại vẫn MỘT phiếu, MỘT lần cộng tiền', async () => {
    nap([phieu({
      id: V_HHMG_T6, contract_id: HD_THANG6, total_amount: 4_500_000,
      contracts: hopDong('HD-1', '2026-06-12'),
    })], [
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG },
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG },
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG },
    ]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].amount).toBe(4_500_000);
  });

  it('phiếu vừa có commission_kind vừa có hạng mục (D3 ∩ D4) chỉ ra một dòng', async () => {
    nap([phieu({
      id: V_HHMG_T6, commission_kind: 'broker', contract_id: HD_THANG6,
      contracts: hopDong('HD-1', '2026-06-12'),
    })], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].kindSource).toBe('commission_kind');
  });

  it('không đọc được hạng mục thì NÉM, không coi là danh sách rỗng', async () => {
    H.fetchAllRows.mockImplementation(async (build: unknown, opt: unknown) => {
      (build as (f: number, t: number) => unknown)(0, 999);
      return (opt as { label?: string })?.label === 'contract-settlement.items' ? null : [];
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.rows).toHaveLength(0);
  });

  it('không đọc được danh sách hạng mục kế toán (thiếu quyền) thì báo lỗi', async () => {
    H.loaiThuChi = { data: null, error: { message: 'permission denied' } };
    nap([], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── Xung đột phân loại ──────────────────────────────────────────────────────

describe('useContractSettlement — xung đột và chưa xác định', () => {
  it('metadata chỏi hạng mục: giữ loại theo metadata, gắn nhãn cần đối chiếu', async () => {
    nap([phieu({
      id: V_HHMG_T6, commission_kind: 'broker', contract_id: HD_THANG6,
      contracts: hopDong('HD-1', '2026-06-12'),
    })], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HOAN }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];
    expect(r.kind).toBe('commission');
    expect(r.kindConflict).toBe(true);
    expect(r.issues).toContain('CLASSIFICATION_REVIEW');
  });

  it('nhiều loại hạng mục không dấu nguồn: chưa xác định loại, vẫn MỘT phiếu', async () => {
    nap([phieu({ id: V_HHMG_T6, total_amount: 2_000_000 })], [
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG },
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HOAN },
    ]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];
    expect(r.kind).toBe('unknown');
    expect(r.kindConflict).toBe(true);
    expect(r.amount).toBe(2_000_000);
    expect(r.issues).toContain('CLASSIFICATION_REVIEW');
  });

  it('nhãn cần đối chiếu là CẢNH BÁO, không chặn duyệt', async () => {
    const { isBlocker, laneOf } = await import('@/lib/contractSettlement');
    expect(isBlocker('CLASSIFICATION_REVIEW')).toBe(false);
    nap([phieu({ id: V_HHMG_T6, total_amount: 2_000_000 })], [
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG },
      { income_expense_id: V_HHMG_T6, income_expense_type_id: T_HOAN },
    ]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(laneOf(result.current.rows[0])).toBe('cho-duyet');
  });
});

// ── Căn cứ hoa hồng: bậc thiếu ≠ bậc 0% ─────────────────────────────────────

describe('useContractSettlement — tier_percent tại boundary reader', () => {
  const V = () => phieu({
    id: V_HHMG_T8, code: 'PC2608091', contract_id: HD_THANG8, total_amount: 0,
    contracts: hopDong('HD-2608-01', '2026-08-05'),
  });

  it('thiếu bậc (tier_percent null) báo thiếu cấu hình, KHÔNG coi 0đ là khớp', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T8, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-08': [{ contract_id: HD_THANG8, expected_amount: 0, tier_percent: null }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBeDefined());
    const b = result.current.rows[0].basis;
    expect(b.kind).toBe('not-found');
    expect(b.kind === 'not-found' && b.reason).toContain('bậc hoa hồng');
    expect(result.current.rows[0].issues).not.toContain('AMOUNT_MISMATCH');
  });

  it('bậc 0% hợp lệ vẫn là căn cứ thật', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T8, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-08': [{ contract_id: HD_THANG8, expected_amount: 0, tier_percent: 0 }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('matched'));
    expect(result.current.rows[0].basis).toEqual({ kind: 'matched', amount: 0 });
  });

  it('reader gợi ý phiếu KHÁC cùng hợp đồng không đổi định danh/trạng thái phiếu đang xem', async () => {
    const phieuKhac = '0f0f0f0f-0000-4000-8000-0000000000ff';
    nap([V()], [{ income_expense_id: V_HHMG_T8, income_expense_type_id: T_HHMG }]);
    napCanCu({
      '2026-08': [{
        contract_id: HD_THANG8, expected_amount: 0, tier_percent: 0,
        voucher_id: phieuKhac, status: 'paid',
      }],
    });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('matched'));
    const r = result.current.rows[0];
    expect(r.voucherId).toBe(V_HHMG_T8);
    expect(r.status).toBe('pending');
    expect(r.approvalStatus).toBe('UNAPPROVED');
  });

  it('không tìm thấy hợp đồng trong kỳ ký thì báo thiếu căn cứ, không báo khớp', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T8, income_expense_type_id: T_HHMG }]);
    napCanCu({ '2026-08': [] });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await waitFor(() => expect(result.current.rows[0].basis.kind).toBe('not-found'));
    const b = result.current.rows[0].basis;
    expect(b.kind === 'not-found' && b.reason).toContain('kỳ ký');
  });
});

// ── Không làm hỏng hai nhóm còn lại ─────────────────────────────────────────

describe('useContractSettlement — Hoàn khách và Thưởng sale không đổi', () => {
  it('hoàn thanh lý vẫn là Hoàn khách, căn cứ tra khi mở phiếu', async () => {
    const id = '0f0f0f0f-0000-4000-8000-00000000000a';
    nap([phieu({ id, system_source: 'termination.refund.v1', total_amount: 3_076_000 })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];
    expect(r.kind).toBe('refund');
    expect(r.kindSource).toBe('system_source');
    expect(r.basis.kind).toBe('not-found');
  });

  it('thưởng sale vẫn là Thưởng sale, không có công thức căn cứ', async () => {
    const id = '0f0f0f0f-0000-4000-8000-00000000000b';
    nap([phieu({ id, commission_kind: 'sale', contract_id: HD_THANG6, contracts: hopDong('HD-1', '2026-06-12') })],
      [{ income_expense_id: id, income_expense_type_id: T_THUONG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].kind).toBe('bonus');
    expect(result.current.rows[0].basis).toEqual({ kind: 'not-applicable' });
  });

  it('nhiều phiếu TRÙNG MÃ vẫn là nhiều dòng, khoá theo UUID, tổng không đổi', async () => {
    const a = '0f0f0f0f-0000-4000-8000-00000000000c';
    const b = '0f0f0f0f-0000-4000-8000-00000000000d';
    nap([
      phieu({ id: a, code: 'PC2607070', room_id: 'r1', rooms: { name: '201' }, total_amount: 1_200_000 }),
      phieu({ id: b, code: 'PC2607070', room_id: 'r2', rooms: { name: '202' }, total_amount: 800_000 }),
    ], [
      { income_expense_id: a, income_expense_type_id: T_HOAN },
      { income_expense_id: b, income_expense_type_id: T_HOAN },
    ]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const rows = result.current.rows;
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(new Set(rows.map((r) => r.voucherId))).toEqual(new Set([a, b]));
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(2_000_000);
  });
});
