import { describe, expect, it } from 'vitest';
import { createDemoState } from './demoFixtures';
import { applyDemoCommand, csvCell, findMatches, outstanding, transactionStatus, type BankTransaction } from './demoModel';

const at = '2026-10-17T10:00:00+07:00';
const get = (state: ReturnType<typeof createDemoState>, suffix: string) => {
  const t = state.transactions.find(x => x.id === `DEMO-GD-${suffix}`);
  if (!t) throw new Error('Missing fixture');
  return t;
};
describe('local bank reconciliation policy', () => {
  it.each([-10_001, -10_000, -9_999, 0, 9_999, 10_000, 10_001])('checks inclusive 10,000 boundary: %s', delta => {
    const state = createDemoState();
    const t = { ...get(state, '10'), amount: 3_000_000 + delta };
    expect(findMatches(state, t).candidates.some(c => c.invoice.id === '102')).toBe(Math.abs(delta) <= 10_000);
  });
  it('uses outstanding debt, excludes other books and conflicting rooms', () => {
    const state = createDemoState();
    expect(findMatches(state, get(state, '12')).candidates.map(c => [c.invoice.id, c.remaining])).toEqual([['104', 3_000_000]]);
    const wrongBook = { ...get(state, '12'), book: 'demo-binh' };
    expect(findMatches(state, wrongBook).candidates).toEqual([]);
    expect(findMatches(state, get(state, '10')).candidates.map(c => c.invoice.id)).toEqual(['102']);
  });
  it('does not offer a paid rounding residual or a carried debt source', () => {
    const state = createDemoState();
    expect(findMatches(state, { ...get(state, '14'), amount: 500_000 }).candidates).toEqual([]);
    expect(findMatches(state, get(state, '14')).candidates.map(c => c.invoice.id)).toEqual(['106']);
    expect(findMatches(state, { ...get(state, '09'), amount: 5_000, description: 'Phong 108 An Nhien' }).candidates).toEqual([]);
  });
  it('rejects outflows, unresolved books, suspicious duplicates and invalid money', () => {
    const state = createDemoState();
    for (const id of ['17', '18', '19', '21']) expect(findMatches(state, get(state, id)).blocked).toBeTruthy();
    for (const amount of [NaN, Infinity, -1, 1.5]) expect(findMatches(state, { ...get(state, '09'), amount }).blocked).toBeTruthy();
  });
  it('isolates organizations even with exact money and narration', () => {
    const state = createDemoState();
    const t = { ...get(state, '09'), org: 'OTHER' };
    expect(findMatches(state, t).candidates).toEqual([]);
  });
  it('keeps ties and reports transactions competing for a bill', () => {
    const state = createDemoState();
    const candidates = findMatches(state, get(state, '13')).candidates;
    expect(candidates.filter(c => c.delta === 0).map(c => c.invoice.id)).toEqual(['102', '104', '201', '202']);
    expect(candidates.find(c => c.invoice.id === '201')?.competitors).toBe(1);
    const next = applyDemoCommand(state, { type: 'collect', transactionId: get(state, '20').id, invoiceId: '201', expectedRevision: 1 }, at);
    expect(findMatches(next, get(next, '13')).candidates.some(c => c.invoice.id === '201')).toBe(false);
  });
  it('preserves shortage without auto rounding and rejects duplicate execution', () => {
    const state = createDemoState(), command = { type: 'collect' as const, transactionId: get(state, '10').id, invoiceId: '102', expectedRevision: 1 };
    const next = applyDemoCommand(state, command, at);
    const i = next.invoices.find(x => x.id === '102');
    expect(i && outstanding(i)).toBe(10_000);
    expect(i?.status).toBe('PARTIAL_PAID');
    expect(() => applyDemoCommand(next, command, at)).toThrow('đã được đối soát');
    expect(state.invoices.find(x => x.id === '102')?.paid).toBe(0);
  });
  it('retains overpayment as credit and never treats it as a second transaction', () => {
    const state = createDemoState();
    const next = applyDemoCommand(state, { type: 'collect', transactionId: get(state, '11').id, invoiceId: '103', expectedRevision: 1 }, at);
    expect(get(next, '11').link).toMatchObject({ applied: 2_800_000, credit: 10_000 });
    expect(next.receipts.find(r => r.invoiceId === '103')?.retained).toBe(2_810_000);
    expect(transactionStatus(next, get(next, '11'))).toBe('matched');
  });
  it('links an old retained receipt exactly without modifying debt or making a new receipt', () => {
    const state = createDemoState();
    expect(findMatches(state, get(state, '15')).receipts).toHaveLength(1);
    expect(findMatches(state, { ...get(state, '15'), amount: 3_000_000 }).receipts).toHaveLength(0);
    const next = applyDemoCommand(state, { type: 'link', transactionId: get(state, '15').id, receiptId: 'DEMO-PT-CU-01' }, at);
    expect(next.invoices).toEqual(state.invoices); expect(next.receipts).toEqual(state.receipts);
    const undone = applyDemoCommand(next, { type: 'undo', transactionId: get(next, '15').id, reason: 'Kiểm lại mẫu' }, at);
    expect(undone.invoices).toEqual(state.invoices); expect(undone.receipts).toEqual(state.receipts);
    expect(undone.audit).toHaveLength(2);
  });
  it('does not link inactive, unposted or already linked receipts', () => {
    for (const flag of ['active', 'posted'] as const) {
      const state = createDemoState(); state.receipts[0]![flag] = false;
      expect(findMatches(state, get(state, '15')).receipts).toHaveLength(0);
    }
    const state = createDemoState();
    const next = applyDemoCommand(state, { type: 'link', transactionId: get(state, '15').id, receiptId: 'DEMO-PT-CU-01' }, at);
    const duplicate: BankTransaction = { ...get(state, '15'), id: 'DEMO-SECOND' };
    expect(findMatches(next, duplicate).receipts).toHaveLength(0);
  });
  it('rejects stale previews and blocks new collection while an old receipt is possible', () => {
    const state = createDemoState();
    expect(() => applyDemoCommand(state, { type: 'collect', transactionId: get(state, '09').id, invoiceId: '101', expectedRevision: 0 }, at)).toThrow('đã thay đổi');
    expect(() => applyDemoCommand(state, { type: 'collect', transactionId: get(state, '15').id, invoiceId: '102', expectedRevision: 1 }, at)).toThrow('khoản thu đã có');
  });
  it('undoes a new collection, keeps audit and blocks undo after a later invoice change', () => {
    const state = createDemoState();
    const next = applyDemoCommand(state, { type: 'collect', transactionId: get(state, '09').id, invoiceId: '101', expectedRevision: 1 }, at);
    const command = { type: 'undo' as const, transactionId: get(next, '09').id, reason: 'Nhầm hóa đơn mẫu' };
    const undone = applyDemoCommand(next, command, at);
    expect(undone.invoices.find(i => i.id === '101')?.paid).toBe(0);
    expect(undone.receipts).toHaveLength(1); expect(undone.audit).toHaveLength(2);
    next.invoices.find(i => i.id === '101')!.revision++;
    expect(() => applyDemoCommand(next, command, at)).toThrow('thay đổi tiếp theo');
  });
  it('requires a reason and clears classification through an auditable undo', () => {
    const state = createDemoState();
    expect(() => applyDemoCommand(state, { type: 'classify', transactionId: get(state, '18').id, classification: 'waiting', reason: ' ' }, at)).toThrow('lý do');
    const next = applyDemoCommand(state, { type: 'classify', transactionId: get(state, '09').id, classification: 'other', reason: 'Cọc riêng' }, at);
    expect(findMatches(next, get(next, '09')).candidates).toEqual([]);
    const undone = applyDemoCommand(next, { type: 'undo', transactionId: get(next, '09').id, reason: 'Kiểm lại' }, at);
    expect(findMatches(undone, get(undone, '09')).candidates).toHaveLength(1);
  });
  it('escapes formulas and quotes in CSV cells', () => {
    expect(csvCell('=1+1')).toBe('"\'=1+1"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });
});
