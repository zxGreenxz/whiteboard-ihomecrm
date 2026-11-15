// @vitest-environment jsdom
// Lối tắt "Tạm ứng lợi nhuận" ở Lương của tôi: chỉ khi người đăng nhập là cổ đông VÀ có quyền tạm ứng;
// SalarySelfView chỉ vẽ lối tắt khi trang truyền vào (màn quản trị xem lương người khác không truyền).
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { salCalc, type SalManager } from '@/lib/managerSalary';
import SalarySelfView from '@/components/salary/SalarySelfView';

const h = vi.hoisted(() => ({ perms: {} as unknown, me: null as unknown }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: h.perms }) }));
vi.mock('@/hooks/useShareholders', () => ({ useMyShareholder: () => ({ data: h.me }) }));

import SelfAdvanceLink, { SELF_ADVANCE_HREF } from '../SelfAdvanceLink';

const shareholder = { id: 'sh-1', name: 'Cổ đông 1', organization_id: 'org-a' };
const link = () => screen.queryByRole('link', { name: /Tạm ứng lợi nhuận/ });

beforeEach(() => { h.perms = {}; h.me = null; });
afterEach(cleanup);

describe('SelfAdvanceLink', () => {
  it('cổ đông có quyền tạm ứng ⇒ lối tắt tới tab Tạm ứng LN', () => {
    h.perms = { shareholder_profit: { advance_own_cashbook: { org_wide: true, building_ids: [] } } };
    h.me = shareholder;
    render(<MemoryRouter><SelfAdvanceLink /></MemoryRouter>);
    expect(link()?.getAttribute('href')).toBe(SELF_ADVANCE_HREF);
    expect(SELF_ADVANCE_HREF).toBe('/reports/finance/profit-distribution?tab=my-advance');
  });

  it.each([
    ['không có quyền tạm ứng', { reports_finance: { profit_distribution: true } }, shareholder],
    ['không phải cổ đông', { shareholder_profit: { advance_own_cashbook: true } }, null],
  ])('%s ⇒ không có lối tắt', (_case, perms, me) => {
    h.perms = perms;
    h.me = me;
    render(<MemoryRouter><SelfAdvanceLink /></MemoryRouter>);
    expect(link()).toBeNull();
  });
});

function mgr(): SalManager {
  const m = {
    id: 's1', name: 'Nhân viên A', short: 'A', alias: '', role: 'Quản lý vận hành', initials: 'A', tone: 'primary',
    workdays: 18, base: 4_000_000, roomRent: 0, incomeGoal: 0, bonusAuto: [], adjustments: [],
    investment: 0, investmentBy: [], investmentLocked: true, commission: 0, commissionItems: [], commissionFlagged: [],
    advance: 0, advanceItems: [], roomRentItems: [], roomRentInvoice: null, paid: 0,
    stats: { jobs: 0, repairs: 0, afterHour: 0, workdays: 18, streak: 0 }, trend: [],
    status: 'DRAFT', salaryMonthlyId: null, ledger: [],
  } as unknown as SalManager;
  m.calc = salCalc(m);
  return m;
}

describe('SalarySelfView — chỗ gắn lối tắt', () => {
  it.each([false, true])('điện thoại %s: chỉ hiện khi trang truyền lối tắt', (phone) => {
    const period = { label: 'Tháng 1', year: 2026 };
    const first = render(<SalarySelfView m={mgr()} period={period} phone={phone} />);
    expect(screen.queryByTestId('slot-probe')).toBeNull();
    first.unmount();
    render(<SalarySelfView m={mgr()} period={period} phone={phone} profitAdvance={<span data-testid="slot-probe">lối tắt</span>} />);
    expect(screen.getByTestId('slot-probe')).toBeTruthy();
  });
});
