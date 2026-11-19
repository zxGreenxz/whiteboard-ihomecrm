// @vitest-environment jsdom
// Màn cổ đông tự xem theo sổ tổng (máy tính): chỉ tiền của chính mình; tỷ lệ % / số toà chỉ khi có quyền
// VÀ máy chủ gửi kèm; phiếu tự lập còn chờ thì "Huỷ yêu cầu"; nút "Chi tạm ứng cho tôi" theo quyền + công tắc.
// Chủ yêu cầu 16/11/2026: bỏ thẻ "Doanh thu và lợi nhuận toà đã chốt"; bảng Nhà × Tháng có bộ lọc nhà tự tạo.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({
  distribute: vi.fn(),
  cancel: vi.fn(),
  /** Vị thế của chính mình (R2): dữ liệu, 'pending', hoặc lỗi đọc. */
  position: 'pending' as unknown,
  positionOrgs: [] as (string | null)[],
  retry: vi.fn(),
}));
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyShareholderPosition: (org: string | null) => {
    h.positionOrgs.push(org);
    if (h.position === 'pending') return { data: undefined, isError: false, error: null, refetch: h.retry };
    if (h.position && typeof h.position === 'object' && 'code' in h.position) return { data: undefined, isError: true, error: h.position, refetch: h.retry };
    return { data: h.position, isError: false, error: null, refetch: h.retry };
  },
}));
// Bảng public.settings giả (bộ lọc nhà lưu theo tài khoản) + người đang đăng nhập.
const db = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), user: { id: 'user-1' } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: db.user }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const where: Record<string, unknown> = {};
      let payload: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { where[column] = value; return builder; },
        maybeSingle: async () => {
          const row = db.rows.get(`${String(where.user_id)}|${String(where.key)}`);
          return { data: row ? { value: row.value } : null, error: null };
        },
        upsert: (next: Record<string, unknown>) => { payload = next; return builder; },
        single: async () => {
          const row = { id: `row-${db.rows.size + 1}`, ...payload };
          db.rows.set(`${String(payload.user_id)}|${String(payload.key)}`, row);
          return { data: row, error: null };
        },
      };
      return builder;
    },
  },
}));

vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ name, children }: { name: string; children?: ReactNode }) => createElement('div', { 'data-slot': name }, children),
}));
vi.mock('@/components/shareholders/ProfitSelfAdvanceDialog', () => ({
  default: (props: Record<string, unknown>) => {
    h.distribute(props);
    return props.open ? createElement('div', { 'data-testid': 'advance-dialog' }) : null;
  },
}));
vi.mock('@/components/shareholders/ProfitPayoutCancelDialog', () => ({
  ProfitPayoutCancelDialog: (props: { open: boolean; target: unknown }) => {
    h.cancel(props);
    return props.open ? createElement('div', { 'data-testid': 'cancel-dialog' }) : null;
  },
}));

import ShareholderLedgerSelfView, { type ShareholderSelfAccess } from '../ShareholderLedgerSelfView';

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'CANONICAL', ready: true, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: 8_650_000, status: 'OWED', allocated: 15_450_000, paid: 3_000_000, paid_pending: 3_000_000,
  paid_via_salary: 1_200_000, advance_recovered: 400_000,
  marker: null,
  months: [{ period_month: `${new Date().getFullYear()}-08-01`, amount: 2_450_000, excluded_by_marker: false, buildings: [
    { building_id: 'b2', building_name: 'Toà Hai', amount: -1_550_000 }, { building_id: 'b1', building_name: 'Toà Một', amount: 4_000_000 },
  ] }],
  payouts: [
    { voucher_id: 'v1', voucher_code: 'PC-DUYET', voucher_date: '2026-09-01', amount: 3_000_000, status: 'APPROVED', posting_status: 'POSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
    { voucher_id: 'v2', voucher_code: 'PC-CHO', voucher_date: '2026-10-10', amount: 3_000_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: true, is_mine: true, is_mine_pending: true, excluded_by_marker: false },
    { voucher_id: 'v3', voucher_code: 'PC-CHU-LAP', voucher_date: '2026-10-11', amount: 500_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
  ],
  salary: [{ period_month: '2026-08-01', investment: 1_200_000, advance_offset: 400_000, excluded_by_marker: false }],
  ...over,
});

/** Vị thế của chính mình (R2): chưa chi 9.000.000, tạm ứng đã duyệt 350.000, một lần chốt còn chờ chi tiền. */
const myPosition = (over: Record<string, unknown> = {}) => ({
  organization_id: 'org-a', route: 'CANONICAL', shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  unpaid_profit: 9_000_000, advance_outstanding: 350_000, advance_pending: 0, settlement_cash_pending: 0, balance: 8_650_000,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 0, payouts_pending: 0, payouts_approved: 0, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 9_000_000, advance_outstanding_raw: 350_000, advance_overoffset: 0 },
  settlements: [], ...over,
});
const settlementRow = (over: Record<string, unknown> = {}) => ({
  id: 'st-1', through_month: '2026-10-01', recognized_amount: 5_000_000, advance_offset_amount: 2_000_000, cash_amount: 3_000_000,
  cash_voucher_id: 'v-cash', cash_voucher_code: 'PC-CHOT', cash_voucher_status: 'UNAPPROVED', cash_voucher_posting_status: 'UNPOSTED',
  created_at: '2026-11-18T10:00:00+07:00', excluded_by_marker: false, ...over,
});

const NO_ACCESS: ShareholderSelfAccess = { canViewPercent: false, canViewBuildingTotals: false, canAdvanceOwn: false };
const view = (l: MyProfitLedger, access: Partial<ShareholderSelfAccess> = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ShareholderLedgerSelfView ledger={l} access={{ ...NO_ACCESS, ...access }} />
    </QueryClientProvider>,
  );
};
const SETTING_KEY = 'ln_nha_thang_bo_loc:v1:org-a:sh-1';
const kpis = () => document.querySelector('[data-slot="kpis"]') as HTMLElement;
const SENSITIVE = {
  percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
  building_totals: [{ period_month: `${new Date().getFullYear()}-08-01`, building_id: 'b1', building_name: 'Toà Một', revenue: null, expense: 40_000_000, profit: 60_000_000 }],
};

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { value() { return false; }, configurable: true });
});
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); db.rows.clear(); db.user = { id: 'user-1' };
  h.position = myPosition(); h.positionOrgs = [];
});
afterEach(cleanup);

describe('ShareholderLedgerSelfView — tiền của chính mình', () => {
  it('KPI: được chia, đã nhận + chờ duyệt, qua lương (Y − D), và HAI số của vị thế — không còn "Còn được nhận"', () => {
    view(ledger());
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toMatch(/15\.450\.000/);
    expect(within(kpis()).getByTestId('self-kpi-paid').textContent).toMatch(/Đã nhận3\.000\.000.*chờ duyệt 3\.000\.000/);
    expect(within(kpis()).getByTestId('self-kpi-salary').textContent).toMatch(/Qua lương800\.000.*trừ tạm ứng 400\.000/);
    expect(within(kpis()).getByTestId('self-kpi-unpaid').textContent).toMatch(/Lợi nhuận chưa chi9\.000\.000.*chờ chủ chốt chi/);
    expect(within(kpis()).getByTestId('self-kpi-advance').textContent).toMatch(/Tạm ứng đang có350\.000.*khấu trừ khi chủ chốt chi/);
    expect(screen.queryByTestId('self-kpi-balance')).toBeNull();
    expect(kpis().textContent).not.toMatch(/Còn được nhận|Đang tạm ứng/);
    expect(h.positionOrgs.every((org) => org === 'org-a')).toBe(true);
  });

  it('tạm ứng chờ duyệt / tiền chốt chờ chi hiện ở dòng phụ; mốc ⇒ "sau mốc đã trả đủ hết MM/YYYY"', () => {
    h.position = myPosition({ unpaid_profit: 4_000_000, advance_outstanding: 350_000, advance_pending: 650_000, settlement_cash_pending: 3_000_000, balance: 3_000_000 });
    view(ledger({ marker: { settled_through_month: '2026-08-01' } }));
    expect(within(kpis()).getByTestId('self-kpi-unpaid').textContent).toMatch(/4\.000\.000.*đang chờ chi 3\.000\.000/);
    expect(within(kpis()).getByTestId('self-kpi-advance').textContent).toMatch(/350\.000.*chờ duyệt 650\.000/);
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toContain('sau mốc đã trả đủ hết 08/2026');
  });

  it('lợi nhuận chưa chi ÂM vẫn hiện đúng dấu, kèm một dòng giải thích', () => {
    h.position = myPosition({ unpaid_profit: -300_000, advance_outstanding: 0, balance: -300_000, components: { ...myPosition().components, unpaid_profit_raw: -300_000, advance_outstanding_raw: 0 } });
    view(ledger());
    expect(within(kpis()).getByTestId('self-kpi-unpaid').textContent).toMatch(/-300\.000/);
    expect(screen.getAllByRole('note').some((n) => /Lợi nhuận chưa chi âm/.test(n.textContent ?? ''))).toBe(true);
  });

  it('vị thế đang tải ⇒ khung chờ, không hiện 0; lỗi ⇒ "—" + câu báo có nút tải lại, phần còn lại vẫn hiện', () => {
    h.position = 'pending';
    const pending = view(ledger());
    expect(within(kpis()).getByTestId('self-kpi-unpaid').textContent).toBe('Lợi nhuận chưa chi');
    expect(within(kpis()).getByLabelText('Đang tải tạm ứng đang có')).toBeTruthy();
    expect(screen.queryByTestId('self-settlements-card')).toBeNull();
    pending.unmount();
    h.position = { code: 'XX000', message: 'PROFIT_LEDGER_POSITION_DRIFT: lệch' };
    view(ledger());
    expect(within(kpis()).getByTestId('self-kpi-unpaid').textContent).toMatch(/—chưa tải được/);
    expect(within(kpis()).getByTestId('self-kpi-advance').textContent).toMatch(/—chưa tải được/);
    const error = screen.getByTestId('self-position-error');
    expect(error.textContent).toMatch(/không cộng ra đúng số dư sổ tổng/);
    fireEvent.click(within(error).getByRole('button', { name: 'Tải lại' }));
    expect(h.retry).toHaveBeenCalled();
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toMatch(/15\.450\.000/);
  });

  it('các lần chốt chi lợi nhuận: tháng, phần ghi nhận, khấu trừ tạm ứng, thực chi, trạng thái phiếu', () => {
    h.position = myPosition({ settlements: [
      settlementRow(),
      settlementRow({ id: 'st-0', through_month: '2026-09-01', recognized_amount: 800_000, advance_offset_amount: 800_000, cash_amount: 0, cash_voucher_id: null, cash_voucher_code: null, cash_voucher_status: null, cash_voucher_posting_status: null, excluded_by_marker: true }),
    ] });
    view(ledger());
    const card = screen.getByTestId('self-settlements-card');
    expect(within(card).getByTestId('self-settlement-st-1').textContent).toMatch(/10\/2026.*5\.000\.000.*2\.000\.000.*3\.000\.000.*Phiếu chi chờ duyệt · PC-CHOT/);
    const noCash = within(card).getByTestId('self-settlement-st-0');
    expect(noCash.textContent).toMatch(/09\/2026.*trước mốc.*Không ra tiền/);
    expect(noCash.getAttribute('style')).toMatch(/opacity/);
    // Cổ đông chỉ XEM: không có nút huỷ chốt ở màn tự xem.
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('bảng phiếu: mã phiếu tạm ứng đứng RIÊNG một phần tử (nhãn "Tạm ứng" không dính vào mã — tìm đúng mã được)', () => {
    view(ledger());
    // Như spec e2e (Playwright getByText exact xét TOÀN BỘ chữ của phần tử, kể cả con): phải có một phần tử mà toàn bộ
    // chữ đúng bằng mã. Trước đây mã là chữ trần cạnh nhãn ⇒ chữ của cả ô là "PC-CHOTạm ứng", không phần tử nào khớp.
    // (getByText của testing-library chỉ xét chữ TRỰC TIẾP của phần tử nên không bắt được lỗi này.)
    const exactly = (code: string) => Array.from(document.querySelectorAll('td *, td'))
      .filter((el) => (el.textContent ?? '').trim() === code);
    expect(exactly('PC-CHO').length).toBeGreaterThan(0);
    expect(exactly('PC-DUYET').length).toBeGreaterThan(0);
    expect(exactly('PC-CHO')[0]!.closest('td')?.textContent).toMatch(/PC-CHO.*Tạm ứng/);
  });

  it('chưa có lần chốt nào ⇒ thẻ nói rõ, không để trống', () => {
    view(ledger());
    expect(screen.getByTestId('self-settlements-card').textContent).toMatch(/chưa chốt chi lợi nhuận lần nào/);
  });

  it('không có dòng lương ⇒ không có ô "Qua lương" (không hiện 0)', () => {
    view(ledger({ salary: [], paid_via_salary: 0, advance_recovered: 0 }));
    expect(screen.queryByTestId('self-kpi-salary')).toBeNull();
  });
});

describe('ShareholderLedgerSelfView — tỷ lệ % và số toà theo quyền', () => {
  it('thiếu quyền ⇒ không "%" trong vùng số, không thẻ tỷ lệ / số toà — kể cả khi payload lỡ mang hai mảng', () => {
    view(ledger(SENSITIVE));
    expect(kpis().textContent).not.toContain('%');
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
    expect(document.body.textContent).not.toContain('20%');
    expect(document.body.textContent).not.toMatch(/60\.000\.000/);
  });

  it('có quyền + máy chủ gửi ⇒ thẻ "Tỷ lệ của bạn"; thẻ doanh thu / lợi nhuận toà đã bỏ dù có quyền và có dữ liệu', () => {
    view(ledger(SENSITIVE), { canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.getByTestId('self-percent-card').textContent).toMatch(/Toà Một20%/);
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
    expect(screen.queryByText(/Doanh thu và lợi nhuận toà đã chốt/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/60\.000\.000/);
    expect(kpis().textContent).not.toContain('%');
  });

  it('có quyền nhưng máy chủ không gửi khoá ⇒ không thẻ (không đoán)', () => {
    view(ledger(), { canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
  });
});

describe('ShareholderLedgerSelfView — bộ lọc nhà của bảng Nhà × Tháng', () => {
  const headers = () => screen.getAllByRole('columnheader').map((c) => c.textContent);
  const createFilter = (name: string, building: string) => {
    fireEvent.click(screen.getByRole('button', { name: /Tạo bộ lọc/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Tên bộ lọc'), { target: { value: name } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: building }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu bộ lọc' }));
  };

  it('mặc định "Tất cả": đủ cột nhà và "Tổng chia" là tổng cả tháng', () => {
    view(ledger());
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một', 'Tổng chia']));
    expect(screen.getByRole('button', { name: 'Tất cả' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('tạo bộ lọc ⇒ chỉ còn cột nhà đã chọn, tổng theo nhà đang hiện; KPI và phiếu không đổi; "Tất cả" trả lại đủ cột', () => {
    view(ledger());
    const kpiBefore = kpis().textContent;
    createFilter('Chỉ Toà Một', 'Toà Một');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(headers()).toContain('Toà Một');
    expect(headers()).not.toContain('Toà Hai');
    expect(headers()).toContain('Tổng 1 nhà');
    const row = screen.getByRole('cell', { name: 'T8' }).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['T8', expect.stringMatching(/^4\.000\.000/), expect.stringMatching(/^4\.000\.000/)]);
    expect(screen.getByRole('button', { name: 'Chỉ Toà Một' }).getAttribute('aria-pressed')).toBe('true');
    expect(kpis().textContent).toBe(kpiBefore);
    expect(screen.getAllByRole('button', { name: 'Huỷ yêu cầu' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Tất cả' }));
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một', 'Tổng chia']));
  });

  it('bộ lọc lưu theo tài khoản (công ty + cổ đông): mở lại — kể cả trình duyệt khác — vẫn còn và đang chọn; cổ đông / tài khoản khác không thấy', async () => {
    view(ledger());
    createFilter('Chỉ Toà Hai', 'Toà Hai');
    await waitFor(() => expect(db.rows.get(`user-1|${SETTING_KEY}`)).toBeTruthy());
    expect(db.rows.get(`user-1|${SETTING_KEY}`)).toMatchObject({ organization_id: 'org-a', key: SETTING_KEY });
    cleanup();
    window.localStorage.clear(); // trình duyệt khác / cửa sổ ẩn danh: không còn bộ đệm
    view(ledger());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Chỉ Toà Hai' }).getAttribute('aria-pressed')).toBe('true'));
    expect(headers()).not.toContain('Toà Một');
    cleanup();
    view(ledger({ shareholder: { id: 'sh-2', name: 'Cổ đông 2' } }));
    expect(screen.queryByRole('button', { name: 'Chỉ Toà Hai' })).toBeNull();
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một']));
    cleanup();
    window.localStorage.clear();
    db.user = { id: 'user-2' };
    view(ledger());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tất cả' }).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.queryByRole('button', { name: 'Chỉ Toà Hai' })).toBeNull();
  });

  it('bộ lọc trỏ nhà đã rời sổ ⇒ bảng báo rõ, hộp sửa đếm 0 nhà và không cho lưu bộ lọc rỗng', async () => {
    db.rows.set(`user-1|${SETTING_KEY}`, {
      id: 'r1', user_id: 'user-1', key: SETTING_KEY, organization_id: 'org-a',
      value: { activeId: 'p1', presets: [{ id: 'p1', name: 'Nhà cũ', keys: ['nha-da-roi-so'] }] },
    });
    view(ledger());
    await waitFor(() => expect(screen.getByText(/Bộ lọc “Nhà cũ” không có nhà nào có phần chia/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Sửa bộ lọc/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Nhà hiển thị (0/2)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Chọn ít nhất một nhà');
    expect((db.rows.get(`user-1|${SETTING_KEY}`)?.value as { presets: { keys: string[] }[] }).presets[0]?.keys).toEqual(['nha-da-roi-so']);
  });

  it('thiếu tên hoặc chưa chọn nhà ⇒ báo lỗi trong hộp, không tạo; sửa đổi tên và xoá bộ lọc được', () => {
    view(ledger());
    fireEvent.click(screen.getByRole('button', { name: /Tạo bộ lọc/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Nhập tên bộ lọc');
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Tên bộ lọc'), { target: { value: 'Cụm thử' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Chọn ít nhất một nhà');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Toà Một' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(screen.getByRole('button', { name: 'Cụm thử' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sửa bộ lọc/ }));
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Tên bộ lọc'), { target: { value: 'Cụm đổi tên' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(screen.getByRole('button', { name: 'Cụm đổi tên' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cụm thử' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Sửa bộ lọc/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Xoá bộ lọc' }));
    expect(screen.queryByRole('button', { name: 'Cụm đổi tên' })).toBeNull();
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một', 'Tổng chia']));
  });
});

describe('ShareholderLedgerSelfView — phiếu và tạm ứng', () => {
  it('ngày phiếu dd/MM/yyyy (định dạng trên chuỗi date, không hiện ISO)', () => {
    view(ledger());
    for (const shown of ['01/09/2026', '10/10/2026', '11/10/2026']) expect(screen.getByText(shown)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/2026-(09-01|10-10|10-11)/);
  });

  it('chỉ phiếu TỰ LẬP còn chờ có "Huỷ yêu cầu"; bấm mở hộp huỷ đúng phiếu, đúng công ty', () => {
    view(ledger());
    const buttons = screen.getAllByRole('button', { name: 'Huỷ yêu cầu' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(screen.getByTestId('cancel-dialog')).toBeTruthy();
    expect(h.cancel).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true,
      target: expect.objectContaining({ voucherId: 'v2', organizationId: 'org-a', kind: 'SHAREHOLDER', amount: 3_000_000, approvalStatus: 'UNAPPROVED' }),
    }));
  });

  it('không có quyền tạm ứng ⇒ không nút, không hộp', () => {
    view(ledger());
    expect(screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ })).toBeNull();
    expect(h.distribute).not.toHaveBeenCalled();
  });

  it('có quyền + sổ tổng chạy thật ⇒ nút mở hộp tạm ứng cho CHÍNH MÌNH đúng công ty', () => {
    view(ledger(), { canAdvanceOwn: true });
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true, organizationId: 'org-a', me: { shareholderId: 'sh-1', name: 'Cổ đông 1' },
    }));
  });

  it.each(['SHADOW', 'FROZEN'] as const)('%s ⇒ nút khoá kèm câu giải thích', (route) => {
    view(ledger({ route }), { canAdvanceOwn: true });
    expect((screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/chưa/);
  });
});
