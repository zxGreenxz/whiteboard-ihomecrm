// @vitest-environment jsdom
// Nút "Đổi hình thức thu" trên chi tiết phiếu Thu chi (đợt 1 sửa phiếu, 25/09/2026):
// chỉ khoản thu hoá đơn kiểu mới còn hiệu lực; nút chỉ cho người đã thu / chủ công ty /
// super admin; có tiền thối thì nút khoá kèm lý do.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tender: null as unknown,
  userId: 'thu-ngan',
  isAdmin: false,
  isOwner: false,
  enabledSeen: [] as boolean[],
}));

vi.mock('@/hooks/useCollectionTenders', async (importOriginal) => {
  const that = await importOriginal<typeof import('@/hooks/useCollectionTenders')>();
  return {
    ...that,
    useTenderForVoucher: (_id: string, opts?: { enabled?: boolean }) => {
      h.enabledSeen.push(opts?.enabled ?? true);
      return { data: opts?.enabled === false ? undefined : h.tender };
    },
  };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: h.userId } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: h.isAdmin }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: h.isOwner }) }));
vi.mock('@/components/invoices/ChangeCollectionMethodDialog', () => ({ default: () => null }));

import { CollectionMethodAction } from '../CollectionMethodAction';

const dongThu = (over: Record<string, unknown> = {}) => ({
  id: 't1', collection_id: 'c1', organization_id: 'o1', line_index: 0, payment_method: 'TK',
  account_id: 'a1', account_name: 'MBHIEP', gross_amount: 3500000, change_amount: 0, rounding_amount: 0,
  voucher_id: 'v1', collector_name: 'NATHAN', building_id: 'b1', building_name: '102LVT',
  collection: { id: 'c1', invoice_id: 'i1', status: 'ACTIVE', actor_id: 'thu-ngan', created_at: '2026-09-25T08:00:00Z', collection_date: '2026-09-25' },
  ...over,
});
const phieuThu = { id: 'v1', type: 'INCOME', invoice_id: 'i1', approval_status: 'APPROVED', organization_id: 'o1' };
const ve = (v = phieuThu) =>
  render(<CollectionMethodAction voucher={v} row={(label, value) => <div><span>{label}</span>{value}</div>} />);

beforeEach(() => {
  h.tender = dongThu(); h.userId = 'thu-ngan'; h.isAdmin = false; h.isOwner = false; h.enabledSeen = [];
});
afterEach(cleanup);

describe('Đổi hình thức thu trên chi tiết phiếu', () => {
  it('người đã thu thấy hình thức + sổ hiện tại và nút đổi', () => {
    ve();
    expect(screen.getByText('Chuyển khoản · MBHIEP')).toBeTruthy();
    expect((screen.getByTestId('ie-change-collection-method') as HTMLButtonElement).disabled).toBe(false);
  });

  it('người khác (không phải người thu / chủ / super admin): chỉ xem, không có nút', () => {
    h.userId = 'nguoi-khac';
    ve();
    expect(screen.getByText('Chuyển khoản · MBHIEP')).toBeTruthy();
    expect(screen.queryByTestId('ie-change-collection-method')).toBeNull();
  });

  it('chủ công ty đổi hộ được', () => {
    h.userId = 'nguoi-khac'; h.isOwner = true;
    ve();
    expect(screen.getByTestId('ie-change-collection-method')).toBeTruthy();
  });

  it('có tiền thối ⇒ nút khoá kèm lý do', () => {
    h.tender = dongThu({ payment_method: 'TM', change_amount: 20000 });
    ve();
    const nut = screen.getByTestId('ie-change-collection-method') as HTMLButtonElement;
    expect(nut.disabled).toBe(true);
    expect(nut.title).toMatch(/tiền thối/);
  });

  it('khoản thu đã hoàn tác, phiếu chi, phiếu không gắn hoá đơn ⇒ không hiện gì, không hỏi máy chủ', () => {
    h.tender = dongThu({ collection: { ...dongThu().collection, status: 'REVERSED' } });
    const { container } = ve();
    expect(container.innerHTML).toBe('');
    cleanup();
    h.enabledSeen = [];
    ve({ ...phieuThu, type: 'EXPENSE' });
    ve({ ...phieuThu, invoice_id: null });
    expect(h.enabledSeen.every((x) => x === false)).toBe(true);
  });
});
