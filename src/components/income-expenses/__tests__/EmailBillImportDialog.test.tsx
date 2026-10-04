// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ form: vi.fn(), connect: vi.fn(), search: vi.fn(), hook: {} as Record<string, unknown> }));
vi.mock('@/hooks/useEmailBillImport', () => ({ useEmailBillImport: () => h.hook }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: [{ id: 'type1', name: 'Đi lại', type: 'expense', organization_id: 'org1' }], isLoading: false, isError: false }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: [] }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => true }));
vi.mock('../IncomeExpenseForm', () => ({ default: (props: Record<string, unknown>) => { h.form(props); return <div>Form phiếu chi</div>; } }));
import EmailBillImportDialog from '../EmailBillImportDialog';
const source = { provider: 'grab', mailbox: 'owner@gmail.com', receipt_id: 'GRAB123', message_id: 'abc123' };
const bill = { source, subject: 'Your Grab receipt', description: 'Chi Grab', date: '2026-10-04', amount: 85000, text: '<img src="https://evil.test/a">', warnings: [], blocked: false };
const renderDialog = () => render(<EmailBillImportDialog organizationId="org1" userId="user1" onClose={() => {}} />);
beforeEach(() => {
  h.form.mockClear(); h.connect.mockClear(); h.search.mockClear();
  h.hook = { configured: true, authReady: true, connected: true, mailbox: source.mailbox, busy: false, error: null, bills: [bill], imported: new Set(), nextPageToken: null, failedCount: 0, searched: true, connect: h.connect, search: h.search, markImported: vi.fn() };
});
afterEach(cleanup);
describe('Gmail bill preview', () => {
  it('viewing mail never opens or saves a voucher and never renders email HTML', () => {
    renderDialog(); fireEvent.click(screen.getByRole('button', { name: /Xem hóa đơn/ }));
    expect(h.form).not.toHaveBeenCalled();
    expect(document.querySelector('img[src="https://evil.test/a"]')).toBeNull();
    expect(screen.getByText('<img src="https://evil.test/a">')).toBeTruthy();
  });
  it('only explicit continue prefills the existing form, with no guessed building/account', () => {
    renderDialog(); fireEvent.click(screen.getByRole('button', { name: /Xem hóa đơn/ }));
    fireEvent.change(screen.getByLabelText('Hạng mục chi'), { target: { value: 'type1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Điền vào phiếu chi' }));
    expect(h.form).toHaveBeenCalled();
    const props = h.form.mock.calls.at(-1)![0];
    expect(props.emailBillSource).toEqual(source);
    expect(props.defaultPrefill).toMatchObject({ name: 'Chi Grab', voucher_date: '2026-10-04', items: [{ quantity: 1, unit_price: 85000, income_expense_type_id: 'type1' }] });
    expect(props.defaultPrefill.building_id).toBeUndefined();
    expect(props.defaultPrefill.account_id).toBeUndefined();
  });
  it('blocked or already imported bill cannot continue', () => {
    h.hook.bills = [{ ...bill, blocked: true, warnings: ['Đơn đã hủy.'] }];
    renderDialog(); fireEvent.click(screen.getByRole('button', { name: /Xem hóa đơn/ }));
    expect((screen.getByRole('button', { name: 'Điền vào phiếu chi' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('missing setup is actionable and does not expose technical config on the user flow', () => {
    h.hook.configured = false; renderDialog();
    expect(screen.getByText(/chưa được bật/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kết nối Gmail' })).toBeNull();
  });
});
