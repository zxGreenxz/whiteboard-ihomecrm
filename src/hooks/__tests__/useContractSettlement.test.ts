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
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContractSettlement } from '@/hooks/useContractSettlement';
import {
  CAN_CU_HOAN_TRA_KHI_MO_PHIEU, isBlocker, laneOf, matchScope, viewStatusOf,
  type PeriodScope,
} from '@/lib/contractSettlement';

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
  notes: string | null;
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
  active_posting_id_v2: string | null;
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
  system_source: null, commission_kind: null, notes: null,
  // Đủ bộ thông tin nhận tiền để MISSING_PAYMENT_INFO không nhiễu vào ca kiểm.
  payer_name: 'Môi giới X', receive_bank_name: 'VCB', receive_bank_account: '0123',
  account_id: null, posting_mode: null,
  approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
  review_state: 'PENDING', review_reason: null,
  review_version: 1, approval_version: 1, posting_version: 1,
  maker_user_id: null, posted_at_v2: null, active_posting_id_v2: null, attachments: [],
  buildings: { name: 'Toà A' }, rooms: { name: '101' }, accounts: null,
  contracts: null,
  ...p,
});

const hopDong = (so: string, ngayKy: string) => ({
  contract_number: so, signed_date: ngayKy,
  contract_customers: [{ customers: { full_name: 'Khách A' } }],
});

interface ItemGia { income_expense_id: string; income_expense_type_id: string }

/**
 * Bút toán hiệu lực đọc về được, theo `active_posting_id_v2`.
 * `null` nghĩa là ĐỌC HỎNG (fetchAllRows trả null), khác hẳn mảng rỗng — rỗng
 * là "RLS giấu hết", đúng cảnh của tài khoản chủ công ty trên org THẬT.
 */
let butToan: { id: string; posted_on: string }[] | null = [];

/** Giả lập bốn truy vấn rời của hook từ MỘT tập phiếu + MỘT tập item. */
const nap = (ps: PhieuGia[], items: ItemGia[]) => {
  H.fetchAllRows.mockImplementation(async (build: unknown, opt: unknown) => {
    // Dựng chuỗi thật để test soi được cột/bộ lọc đã gửi.
    (build as (f: number, t: number) => unknown)(0, 999);
    const label = (opt as { label?: string })?.label;
    if (label === 'contract-settlement.items') return items;
    if (label === 'cs.postings') return butToan;
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

/**
 * Giả lập `get_period_commissions` HỎNG THẬT (mạng đứt, RPC nổ).
 *
 * ⚠ KHÁC HẲN "trả 0 dòng". Hàm này chỉ RAISE khi `auth.uid() IS NULL`; quyền
 * theo toà là BỘ LỌC trong CTE `bld`, nên thiếu quyền toà ⇒ 0 dòng ⇒
 * BASIS_NOT_FOUND (cảnh báo). Chỉ lỗi thật mới ra BASIS_UNAVAILABLE (chặn).
 */
const napCanCuHong = (message: string) => {
  H.rpc.mockImplementation(async () => ({ data: null, error: { message } }));
};

const chay = (period = '2026-09', scope: PeriodScope = 'all') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(
    () => useContractSettlement({ organizationId: ORG, buildingIds: [TOA], period, scope }),
    { wrapper },
  );
};

/** Bộ lọc đã gửi cho truy vấn phiếu, dạng [tên phương thức, tham số]. */
const locPhieu = () =>
  H.chuoi.filter((c) => c.bang === 'income_expenses').flatMap((c) => c.ops);

beforeEach(() => {
  H.chuoi.length = 0;
  butToan = [];
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

  // ĐÂY LÀ BLOCKER DUY NHẤT của khu này mà T5a mở rộng phạm vi tới. Trước đây
  // phiếu HHMG thủ công nằm nhầm ở Hoàn khách nên không bao giờ đi qua nhánh
  // căn cứ hoa hồng; giờ nó đi qua, nên nhánh "tra mà HỎNG" phải được ghim.
  //
  // ⚠ THỨ TỰ HAI CÂU `if` LÀ MỘT PHẦN CỦA LUẬT. `canCuHoaHong.isError` phải xét
  // TRƯỚC `!basisHH`: khi query lỗi thì `data` cũng undefined, nên đảo hai câu
  // này lại là biến một phiếu KHÔNG AI BIẾT SỐ ĐÚNG thành "Đang tra căn cứ" —
  // một cảnh báo xám — rồi thả nó về làn chờ duyệt, sẵn sàng bấm Duyệt.
  it('tra căn cứ mà HỎNG là chặn, KHÔNG phải "đang tra"', async () => {
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    napCanCuHong('không kết nối được máy chủ');
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('unavailable'));
    const r = result.current.rows[0];
    expect(r.basis).toEqual({ kind: 'unavailable', reason: 'Không đọc được bậc hoa hồng' });
    expect(r.issues).toContain('BASIS_UNAVAILABLE');
    expect(isBlocker('BASIS_UNAVAILABLE')).toBe(true);
    // Số trên phiếu vẫn nguyên và phiếu bị giữ lại để người ta nhìn.
    expect(r.amount).toBe(4_500_000);
    expect(laneOf(r)).toBe('can-ra-soat');
  });

  it('thiếu quyền toà (RPC trả 0 dòng) chỉ là CẢNH BÁO, không phải lỗi đọc', async () => {
    // `get_period_commissions` lọc toà trong CTE `bld` và GRANT cho
    // `authenticated`; không có quyền toà thì ra rỗng chứ không ném. Ghim ca này
    // cạnh ca trên để hai đường không bị gộp làm một.
    nap([V()], [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    napCanCu({ '2026-06': [] });
    const { result } = chay();
    await waitFor(() => expect(result.current.rows[0]?.basis.kind).toBe('not-found'));
    expect(result.current.rows[0].issues).toContain('BASIS_NOT_FOUND');
    expect(result.current.rows[0].issues).not.toContain('BASIS_UNAVAILABLE');
    expect(laneOf(result.current.rows[0])).toBe('cho-duyet');
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

  /**
   * ⚠ "Thử lại" phải chạm được TRUY VẤN GÂY LỖI, không riêng truy vấn phiếu.
   *
   * Hook gộp bốn truy vấn nhưng `isError` có cả `typeMap.isError`, trong khi
   * `vouchers` lại `enabled: … && !!typeMap.data`. Bảng loại thu chi hỏng ⇒ màn
   * báo lỗi, mà `vouchers.refetch()` không chạy nổi vì chính nó đang bị tắt:
   * nút "Thử lại" bấm bao nhiêu lần cũng vô ích, người dùng kẹt tới khi F5.
   */
  it('lỗi ở bảng loại thu chi: refetch phải gọi lại ĐÚNG truy vấn đó, không chỉ truy vấn phiếu', async () => {
    H.loaiThuChi = { data: null, error: { message: 'permission denied' } };
    nap([phieu({ id: V_HHMG_T6, system_source: 'termination.refund' })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.isError).toBe(true));

    const demLoai = () => H.chuoi.filter((c) => c.bang === 'income_expense_types').length;
    const truoc = demLoai();

    // Quyền được cấp lại (hoặc mạng hồi phục) rồi người dùng bấm Thử lại.
    H.loaiThuChi = { data: LOAI_THAT, error: null };
    await act(async () => { await result.current.refetch(); });

    expect(demLoai()).toBeGreaterThan(truoc);
    await waitFor(() => expect(result.current.isError).toBe(false));
    // Và vì typeMap đã có dữ liệu, truy vấn phiếu tự bật lên và chạy tới nơi.
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
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
    // ⚠ Ghim LÝ DO bằng chính hằng số mà modal so `===` để nhận ra. Không có
    // dòng này thì một sửa đổi sau làm `basisOf` đổi câu chữ vẫn xanh, và lời
    // hứa "tra khi mở phiếu" lặng lẽ quay lại in trong hộp thoại ĐANG MỞ — nơi
    // nó không bao giờ thành sự thật. Bài của modal dùng fixture chép cứng nên
    // không bắt được ca này; đây là chỗ duy nhất đi qua `basisOf` THẬT.
    expect(r.basis).toEqual({ kind: 'not-found', reason: CAN_CU_HOAN_TRA_KHI_MO_PHIEU });
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

// ── T3: read model phải mang ghi chú gốc + metadata component chung cần ─────
//
// Bản trước KHÔNG chọn cột `notes` và vứt luôn `system_source`/`commission_kind`
// khi dựng dòng, nên modal không có gì để đưa cho `VoucherNote` — nó chỉ còn
// một câu giữ chỗ. Bốn ca dưới ghim đúng ba cột đó, KHÔNG mở rộng thêm.

describe('useContractSettlement — mang đủ nguồn cho ghi chú và bảng căn cứ', () => {
  it('truy vấn phiếu đọc cột notes', async () => {
    nap([phieu({ id: V_HHMG_T6, contract_id: HD_THANG6, contracts: hopDong('HD-1', '2026-06-12') })],
      [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const q = H.chuoi.find((c) => c.bang === 'income_expenses');
    const cot = String(q?.ops.find(([m]) => m === 'select')?.[1][0] ?? '');
    expect(cot).toContain('notes');
    expect(cot).toContain('system_source');
    expect(cot).toContain('commission_kind');
  });

  it('dòng mang ghi chú gốc NGUYÊN VĂN, giữ xuống dòng', async () => {
    const ghiChu = '[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách.\nDòng thứ hai.';
    nap([phieu({ id: V_HHMG_T6, notes: ghiChu, contract_id: HD_THANG6,
      contracts: hopDong('HD-1', '2026-06-12') })],
      [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].notes).toBe(ghiChu);
  });

  it('dòng mang system_source và commission_kind THÔ như DB, không suy diễn', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000e1';
    nap([phieu({ id, system_source: 'termination.refund', total_amount: 3_076_000 })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].systemSource).toBe('termination.refund');
    expect(result.current.rows[0].commissionKind).toBeNull();
  });

  it('phiếu HHMG thủ công KHÔNG được gán dấu nguồn suy ra', async () => {
    nap([phieu({ id: V_HHMG_T6, code: 'PC2606169', notes: null, contract_id: HD_THANG6,
      contracts: hopDong('HD-1', '2026-06-12') })],
      [{ income_expense_id: V_HHMG_T6, income_expense_type_id: T_HHMG }]);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];
    expect(r.kind).toBe('commission');
    // Phân loại suy ra được, nhưng metadata thô vẫn PHẢI rỗng.
    expect(r.commissionKind).toBeNull();
    expect(r.systemSource).toBeNull();
    expect(r.notes).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T5 — NGÀY CHI THẬT, PHẠM VI KỲ VÀ TRẠNG THÁI KHÔNG BỊ CẮT TRƯỚC
//
// Bốn lỗi đang sửa:
//  1. "Mọi kỳ" ánh xạ sang scope 'open', mà 'open' lại CẮT POSTED/CANCELLED
//     ngay trong truy vấn — nên nó không phải mọi kỳ, cũng không phải mọi
//     trạng thái, và bộ lọc trạng thái của giao diện lọc trên một tập đã thiếu.
//  3. Chọn một tháng thì lọc `voucher_date`, nên phiếu lập tháng trước mà CHI
//     trong kỳ này biến mất.
//  4. Chân đế của "ngày chi" là `posted_at_v2` — dấu thời gian HỆ THỐNG GHI,
//     không phải ngày tiền ra. Đo thật 22/09: 856/1000 phiếu chi đã ghi sổ có
//     `posted_at_v2` NULL, 20/144 phiếu còn lại LỆCH với `posted_on`.
//
// Ranh giới đọc bút toán là RLS BÌNH THƯỜNG. Custodian đọc được thì có ngày
// thật; người khác nhận 0 dòng, KHÔNG lỗi, và phải hiện "chưa xác minh".
// ═══════════════════════════════════════════════════════════════════════════

const BT_1 = '0a1a1a1a-0000-4000-8000-000000000001';
const BT_2 = '0a1a1a1a-0000-4000-8000-000000000002';

/** Phiếu ĐÃ GHI SỔ, trỏ tới một bút toán hiệu lực. */
const daChi = (id: string, p: Partial<PhieuGia> = {}): PhieuGia => phieu({
  id, approval_status: 'APPROVED', posting_status: 'POSTED',
  account_id: 'so-quy-1', accounts: { name: 'Quỹ tiền mặt' },
  active_posting_id_v2: BT_1, ...p,
});

describe('useContractSettlement — ngày chi lấy từ posted_on của bút toán hiệu lực', () => {
  it('đọc bút toán theo active_posting_id_v2 và lấy posted_on làm ngày chi', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000a1';
    butToan = [{ id: BT_1, posted_on: '2026-09-03' }];
    nap([daChi(id, {
      system_source: 'termination.refund.v1', voucher_date: '2026-08-20',
      posted_at_v2: '2026-07-01T10:00:00Z',
    })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];

    expect(r.postedOn).toBe('2026-09-03');
    expect(r.status).toBe('paid');
    // Truy vấn phải đi qua bảng bút toán, kẹp theo org, lọc theo ID bút toán.
    const q = H.chuoi.find((c) => c.bang === 'income_expense_postings');
    expect(q, 'phải có truy vấn income_expense_postings').toBeTruthy();
    const cot = String(q?.ops.find(([m]) => m === 'select')?.[1][0] ?? '');
    expect(cot).toContain('posted_on');
    expect(q?.ops.some(([m, a]) => m === 'eq' && a[0] === 'organization_id')).toBe(true);
    expect(q?.ops.some(([m, a]) => m === 'in' && a[0] === 'id')).toBe(true);
    // Và cột nguồn phải nằm trong SELECT của phiếu.
    const cotPhieu = String(H.chuoi.find((c) => c.bang === 'income_expenses')
      ?.ops.find(([m]) => m === 'select')?.[1][0] ?? '');
    expect(cotPhieu).toContain('active_posting_id_v2');
  });

  // ĐÂY LÀ LÝ DO KHÔNG ĐƯỢC DÙNG `posted_at_v2` LÀM PHƯƠNG ÁN DỰ PHÒNG.
  it('posted_on KHÁC posted_at_v2 thì lấy posted_on, không bao giờ lấy cột kia', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000a2';
    butToan = [{ id: BT_1, posted_on: '2026-09-02' }];
    nap([daChi(id, {
      system_source: 'termination.refund.v1',
      posted_at_v2: '2026-07-14T03:00:00Z', voucher_date: '2026-07-10',
    })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].postedOn).toBe('2026-09-02');
    expect(JSON.stringify(result.current.rows[0])).not.toContain('2026-07-14');
  });

  it('mỗi phiếu lấy đúng bút toán của mình, không dùng chung một ngày', async () => {
    const a = '0f0f0f0f-0000-4000-8000-0000000000a3';
    const b = '0f0f0f0f-0000-4000-8000-0000000000a4';
    butToan = [{ id: BT_1, posted_on: '2026-09-03' }, { id: BT_2, posted_on: '2026-08-28' }];
    nap([
      daChi(a, { system_source: 'termination.refund.v1', active_posting_id_v2: BT_1 }),
      daChi(b, { system_source: 'termination.refund.v1', active_posting_id_v2: BT_2 }),
    ], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const theo = new Map(result.current.rows.map((r) => [r.voucherId, r.postedOn]));
    expect(theo.get(a)).toBe('2026-09-03');
    expect(theo.get(b)).toBe('2026-08-28');
  });

  it('phiếu chưa ghi sổ KHÔNG có ngày chi, kể cả khi còn dấu posted_at_v2 cũ', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000a5';
    butToan = [{ id: BT_1, posted_on: '2026-09-03' }];
    nap([phieu({
      id, system_source: 'termination.refund.v1',
      approval_status: 'APPROVED', posting_status: 'UNPOSTED',
      posted_at_v2: '2026-07-01T10:00:00Z', active_posting_id_v2: BT_1,
    })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].status).toBe('approved');
    expect(result.current.rows[0].postedOn).toBeNull();
  });

  // Ca của CHÍNH NGƯỜI DÙNG MÀN NÀY: chủ công ty thấy 1139 phiếu đã ghi sổ và
  // 0 dòng bút toán, còn tài khoản hệ thống thấy 3324 dòng. Không được đổi
  // trạng thái phiếu, không được báo 0, không được đi đường quyền cao hơn.
  it('RLS giấu hết bút toán: giữ nguyên Đã chi, đánh dấu chưa xác minh, KHÔNG lỗi', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000a6';
    butToan = [];
    nap([daChi(id, { system_source: 'termination.refund.v1', voucher_date: '2026-08-20' })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];

    expect(r.status).toBe('paid');
    expect(viewStatusOf(r)).toBe('paid');
    expect(r.postedOn).toBeNull();
    expect(result.current.isError).toBe(false);
    expect(result.current.postingRead).toBe('partial');
    // Không đủ nguồn để xếp kỳ ⇒ 'undetermined', và tuyệt đối không thành tồn cũ.
    expect(matchScope(r, 'current', '2026-09')).toBe('undetermined');
    expect(matchScope(r, 'prior', '2026-09')).toBe('out');
    // Và không có truy vấn nào đi đường khác để bù quyền.
    const bang = new Set(H.chuoi.map((c) => c.bang));
    expect(bang).toEqual(new Set([
      'income_expense_types', 'income_expense_items', 'income_expenses', 'income_expense_postings',
    ]));
  });

  it('đọc bút toán LỖI: vẫn ra bảng, đánh dấu chưa xác minh, không nuốt cả danh sách', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000a7';
    butToan = null;
    nap([daChi(id, { system_source: 'termination.refund.v1' })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.isError).toBe(false);
    expect(result.current.rows[0].status).toBe('paid');
    expect(result.current.rows[0].postedOn).toBeNull();
    expect(result.current.postingRead).toBe(false);
  });

  it('đọc đủ bút toán thì trạng thái đọc là ĐỦ', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000a8';
    butToan = [{ id: BT_1, posted_on: '2026-09-03' }];
    nap([daChi(id, { system_source: 'termination.refund.v1' })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.postingRead).toBe(true);
  });

  it('không có phiếu đã ghi sổ nào thì KHÔNG gọi bảng bút toán', async () => {
    nap([phieu({
      id: '0f0f0f0f-0000-4000-8000-0000000000a9', system_source: 'termination.refund.v1',
    })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(H.chuoi.some((c) => c.bang === 'income_expense_postings')).toBe(false);
    expect(result.current.postingRead).toBe(true);
  });

  // Route legacy: APPROVED + POSTED nhưng KHÔNG có bút toán hiệu lực. Giữ nhãn
  // theo cột thật, đánh dấu chưa xác minh — đây là cách hiển thị thiếu bằng
  // chứng, KHÔNG phải yêu cầu backfill posting.
  it('đã ghi sổ mà không có active posting: giữ Đã chi, ngày chi chưa xác minh', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000aa';
    butToan = [{ id: BT_1, posted_on: '2026-09-03' }];
    nap([daChi(id, { system_source: 'termination.refund.v1', active_posting_id_v2: null })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].status).toBe('paid');
    expect(result.current.rows[0].postedOn).toBeNull();
  });
});

describe('useContractSettlement — truy vấn theo phạm vi, ĐỘC LẬP trạng thái', () => {
  const dat = () => nap([phieu({
    id: '0f0f0f0f-0000-4000-8000-0000000000b1', system_source: 'termination.refund.v1',
  })], []);

  // Lỗi số 1: 'open' cắt CANCELLED và POSTED NGAY TRONG TRUY VẤN, nên bộ lọc
  // trạng thái của giao diện lọc trên một tập đã bị xén mất hai nhóm.
  it('KHÔNG cắt hủy/đã ghi sổ trong truy vấn ở mọi phạm vi', async () => {
    for (const scope of ['current', 'all'] as PeriodScope[]) {
      H.chuoi.length = 0;
      dat();
      const { result } = chay('2026-09', scope);
      await waitFor(() => expect(result.current.rows).toHaveLength(1));
      const ops = locPhieu();
      expect(ops.some(([m, a]) => m === 'neq' && a[0] === 'approval_status'), scope).toBe(false);
      expect(ops.some(([m, a]) => m === 'or' && String(a[0]).includes('posting_status')), scope)
        .toBe(false);
    }
  });

  it('Kỳ hiện tại KHÔNG kẹp voucher_date — phiếu tháng trước chi trong kỳ phải còn', async () => {
    dat();
    const { result } = chay('2026-09', 'current');
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const ops = locPhieu();
    expect(ops.some(([m, a]) => m === 'gte' && a[0] === 'voucher_date')).toBe(false);
    expect(ops.some(([m, a]) => m === 'lt' && a[0] === 'voucher_date')).toBe(false);
  });

  it('Tồn Cũ kẹp đúng một mốc: ngày phiếu TRƯỚC đầu kỳ', async () => {
    dat();
    const { result } = chay('2026-09', 'prior');
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const ops = locPhieu();
    expect(ops.some(([m, a]) => m === 'lt' && a[0] === 'voucher_date' && a[1] === '2026-09-01'))
      .toBe(true);
    expect(ops.some(([m, a]) => m === 'gte' && a[0] === 'voucher_date')).toBe(false);
    // Vẫn KHÔNG lọc trạng thái phía server — trạng thái là việc của lớp mặt.
    expect(ops.some(([m, a]) => m === 'neq' && a[0] === 'approval_status')).toBe(false);
  });

  it('phiếu hủy và tổ hợp lạ về TỚI read model, không bị cắt trước bộ lọc', async () => {
    const huy = '0f0f0f0f-0000-4000-8000-0000000000b2';
    const la = '0f0f0f0f-0000-4000-8000-0000000000b3';
    nap([
      phieu({ id: huy, system_source: 'termination.refund.v1', approval_status: 'CANCELLED' }),
      phieu({ id: la, system_source: 'termination.refund.v1', approval_status: 'SOMETHING_ELSE' }),
    ], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const theo = new Map(result.current.rows.map((r) => [r.voucherId, r.status]));
    expect(theo.get(huy)).toBe('cancelled');
    expect(theo.get(la)).toBe('unknown');
  });

  it('phiếu bị ĐẢO bút toán có trạng thái riêng, không quay về chờ chi', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000b4';
    nap([phieu({
      id, system_source: 'termination.refund.v1',
      approval_status: 'APPROVED', posting_status: 'REVERSED', active_posting_id_v2: null,
    })], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const r = result.current.rows[0];
    expect(r.status).toBe('reversed');
    expect(r.postedOn).toBeNull();
    // Hai cột THÔ vẫn nguyên để writer và bảng nút đọc, không suy từ `status`.
    expect(r.approvalStatus).toBe('APPROVED');
    expect(r.postingStatus).toBe('REVERSED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ĐỊNH DANH LÀ (UUID, org) — KHÔNG BAO GIỜ LÀ MÃ PHIẾU
//
// Trên production có nhiều phiếu chung mã hiển thị. Hai ca dưới mô phỏng HÌNH
// DẠNG của PC2609095 (chờ duyệt, còn blocker) và PC2607070 (đã duyệt, ghi sổ
// ảo) — CÙNG phòng, CÙNG số tiền — để chắc rằng không có chỗ nào ghép chúng
// bằng mã, bằng phòng+tiền, hay bằng tiền tố mã.
// ═══════════════════════════════════════════════════════════════════════════

describe('useContractSettlement — hai phiếu giống hệt trừ UUID và trạng thái', () => {
  const PHONG = '0b0b0b0b-0000-4000-8000-000000000401';
  const V_CHO_DUYET = '0f0f0f0f-0000-4000-8000-0000000000c1';
  const V_SO_AO = '0f0f0f0f-0000-4000-8000-0000000000c2';

  const doi = () => {
    nap([
      // Dạng PC2609095: chờ duyệt, thiếu thông tin nhận tiền ⇒ còn blocker.
      phieu({
        id: V_CHO_DUYET, code: 'PC2609095', room_id: PHONG, rooms: { name: '401' },
        total_amount: 3_076_000, system_source: 'termination.refund.v1',
        approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
        payer_name: null, receive_bank_name: null, receive_bank_account: null,
      }),
      // Dạng PC2607070: đã duyệt nhưng ghi SỔ ẢO — tiền chưa rời két.
      phieu({
        id: V_SO_AO, code: 'PC2607070', room_id: PHONG, rooms: { name: '401' },
        total_amount: 3_076_000, system_source: 'termination.refund.v1',
        approval_status: 'APPROVED', posting_status: 'NOT_APPLICABLE',
        posting_mode: 'NON_CASH',
      }),
    ], []);
  };

  it('cùng phòng, cùng tiền, cùng loại — vẫn hai dòng, hai trạng thái, hai làn', async () => {
    doi();
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const theo = new Map(result.current.rows.map((r) => [r.voucherId, r]));

    const choDuyet = theo.get(V_CHO_DUYET);
    const soAo = theo.get(V_SO_AO);
    expect(choDuyet?.status).toBe('pending');
    expect(viewStatusOf(choDuyet!)).toBe('review');
    expect(choDuyet!.issues.some(isBlocker)).toBe(true);
    expect(laneOf(choDuyet!)).toBe('can-ra-soat');

    expect(soAo?.status).toBe('noncash');
    expect(soAo?.postingMode).toBe('NON_CASH');
    expect(soAo?.postedOn).toBeNull();
    // Khoá dòng khác nhau dù mọi thứ nhìn thấy được đều giống nhau.
    expect(choDuyet?.key).not.toBe(soAo?.key);
    expect(choDuyet?.amount).toBe(soAo?.amount);
    expect(choDuyet?.roomId).toBe(soAo?.roomId);
  });

  it('phiếu sổ ảo KHÔNG lọt vào tập Đã chi', async () => {
    doi();
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const views = result.current.rows.map(viewStatusOf);
    expect(views).not.toContain('paid');
    expect(views).toContain('noncash');
  });

  it('hai phiếu TRÙNG MÃ nhưng khác UUID có thể khác hẳn trạng thái và ngày chi', async () => {
    const a = '0f0f0f0f-0000-4000-8000-0000000000c3';
    const b = '0f0f0f0f-0000-4000-8000-0000000000c4';
    butToan = [{ id: BT_2, posted_on: '2026-09-04' }];
    nap([
      phieu({
        id: a, code: 'PC2607070', room_id: PHONG, rooms: { name: '401' },
        total_amount: 1_200_000, system_source: 'termination.refund.v1',
        approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
      }),
      phieu({
        id: b, code: 'PC2607070', room_id: PHONG, rooms: { name: '401' },
        total_amount: 1_200_000, system_source: 'termination.refund.v1',
        approval_status: 'APPROVED', posting_status: 'POSTED', active_posting_id_v2: BT_2,
      }),
    ], []);
    const { result } = chay();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const theo = new Map(result.current.rows.map((r) => [r.voucherId, r]));
    expect(theo.get(a)?.status).toBe('pending');
    expect(theo.get(a)?.postedOn).toBeNull();
    expect(theo.get(b)?.status).toBe('paid');
    expect(theo.get(b)?.postedOn).toBe('2026-09-04');
  });
});
