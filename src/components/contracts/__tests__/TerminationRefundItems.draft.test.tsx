// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import type { RefundItem } from '@/lib/contractValidation';
import type { RefundItemsDraft } from '@/lib/contractExitSettlementDrafts';
import { calcProratedDays, prorateAmount } from '@/lib/prorateCalculation';
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
import { TerminationRefundItems } from '../TerminationRefundItems';

const contract = { id: 'c1', rent_price: 3_100_000, contract_services: [], contract_customers: [], room: { building_id: 'b1' } } as unknown as ContractWithRelations;
afterEach(cleanup);
const show = (initialDraft?: RefundItemsDraft | null) => {
  const items: RefundItem[][] = []; const drafts: RefundItemsDraft[] = [];
  render(<TerminationRefundItems contract={contract} moveOutDate="2026-10-03" onChange={value => items.push(value)}
    initialDraft={initialDraft} onDraftChange={draft => drafts.push(draft)} />);
  return { items, drafts };
};
const dates = () => screen.getAllByPlaceholderText('dd/mm/yyyy').map(input => (input as HTMLInputElement).value);

describe('Hoàn lại khách: mở từ nháp', () => {
  it('form mới vẫn gợi ý "không ở" từ ngày sau trả phòng đến hết tháng', async () => {
    const { items } = show();
    await waitFor(() => expect(dates()).toEqual(['04/10/2026', '31/10/2026']));
    expect(items[items.length - 1]).toEqual([expect.objectContaining({ kind: 'PRORATED_REFUND', days: 28 })]);
  });
  it('nháp đã xoá ngày "không ở" thì giữ trống — không tự gợi ý lại và không tự hoàn tiền ngày không ở', async () => {
    const { items, drafts } = show({ fromDate: '', toDate: '2026-10-31', proratedAmount: 0, proratedTouched: false, customRows: [] });
    await waitFor(() => expect(drafts.length).toBeGreaterThan(0));
    expect(dates()).toEqual(['', '31/10/2026']);
    expect(items[items.length - 1]).toEqual([]);
    expect(drafts[drafts.length - 1]).toEqual({ fromDate: '', toDate: '2026-10-31', proratedAmount: 0, proratedTouched: false, customRows: [] });
  });
  it('nháp có số tự gõ và dòng tuỳ ý thì điền lại đúng', async () => {
    const { items } = show({ fromDate: '2026-10-10', toDate: '2026-10-31', proratedAmount: 1_500_000, proratedTouched: true,
      customRows: [{ name: 'Hoàn tiền dịch vụ', amount: 120_000 }] });
    await waitFor(() => expect(items[items.length - 1]).toEqual([
      expect.objectContaining({ kind: 'PRORATED_REFUND', amount: 1_500_000 }),
      { kind: 'CUSTOM', description: 'Hoàn tiền dịch vụ', amount: 120_000 }]));
    expect(dates()).toEqual(['10/10/2026', '31/10/2026']);
  });
});

// Lỗi dựng lại trên TEST 23/11/2026: quản lý gõ số hoàn, con trỏ rời ô ngày (không đổi ngày) thì số gõ bị thay bằng số tự
// tính, hộp xác nhận và phiếu chi dùng số tự tính ⇒ công ty chi hoàn nhiều hơn ý định.
describe('Hoàn lại khách: số gõ tay không bị ô ngày đè', () => {
  const amountInput = () => screen.getByPlaceholderText('0') as HTMLInputElement;
  const dateInputs = () => screen.getAllByPlaceholderText('dd/mm/yyyy') as HTMLInputElement[];
  const last = <T,>(list: T[]) => list[list.length - 1];
  /** Chờ số tự tính của khoảng gợi ý 04/10–31/10; trả kèm hàm tính số tự động theo đúng cơ sở tháng component đang dùng. */
  const ready = async () => {
    const view = show();
    await waitFor(() => expect(last(view.items)).toEqual([expect.objectContaining({ kind: 'PRORATED_REFUND', days: 28 })]));
    const base = last(view.items)[0].unit_price!;
    const auto = (from: string, to: string) => prorateAmount(base, calcProratedDays(from, to));
    expect(last(view.items)[0].amount).toBe(auto('2026-10-04', '2026-10-31'));
    expect(auto('2026-10-04', '2026-10-31')).toBeGreaterThan(500_000);
    return { ...view, auto };
  };

  it.each([[0, '0'], [500_000, '500.000']])('gõ %i rồi đi qua hai ô ngày (không đổi ngày): số gõ còn nguyên tới khoản hoàn và nháp', async (typed, shown) => {
    const { items, drafts } = await ready();
    fireEvent.change(amountInput(), { target: { value: String(typed) } });
    for (const input of dateInputs()) { fireEvent.focus(input); fireEvent.blur(input); }
    expect(amountInput().value).toBe(shown);
    expect(last(items)).toEqual(typed > 0 ? [expect.objectContaining({ kind: 'PRORATED_REFUND', amount: typed })] : []);
    expect(last(drafts)).toMatchObject({ fromDate: '2026-10-04', toDate: '2026-10-31', proratedAmount: typed, proratedTouched: true });
  });

  it('ô ngày phát lại đúng ngày đang có (gõ lại cho đủ ngày cũ) cũng không đè số gõ tay', async () => {
    const { items, drafts } = await ready();
    fireEvent.change(amountInput(), { target: { value: '500000' } });
    const [from] = dateInputs();
    fireEvent.change(from, { target: { value: '04/10/202' } });
    fireEvent.change(from, { target: { value: '04/10/2026' } });
    expect(amountInput().value).toBe('500.000');
    expect(last(items)).toEqual([expect.objectContaining({ kind: 'PRORATED_REFUND', amount: 500_000 })]);
    expect(last(drafts)).toMatchObject({ proratedAmount: 500_000, proratedTouched: true });
  });

  it('đổi ngày thật thì bỏ số gõ tay và tính lại theo khoảng ngày mới', async () => {
    const { items, drafts, auto } = await ready();
    fireEvent.change(amountInput(), { target: { value: '500000' } });
    fireEvent.change(dateInputs()[0], { target: { value: '10/10/2026' } });
    const recalculated = auto('2026-10-10', '2026-10-31');
    expect(recalculated).not.toBe(500_000);
    expect(last(items)).toEqual([expect.objectContaining({ kind: 'PRORATED_REFUND', amount: recalculated, days: 22 })]);
    expect(last(drafts)).toMatchObject({ fromDate: '2026-10-10', proratedAmount: recalculated, proratedTouched: false });
    expect(amountInput().value).toBe(recalculated.toLocaleString('vi-VN'));
  });
});
