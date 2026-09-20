/** Monetary facts for display. These never authorize or dispatch a voucher action. */
export type SettlementMoneyFact = { state: 'verified'; amount: number; basis: string } | { state: 'unavailable'; reason: string };
const unavailable = (reason: string): SettlementMoneyFact => ({ state: 'unavailable', reason });
const verified = (amount: number, basis: string): SettlementMoneyFact => Number.isSafeInteger(amount) && amount >= 0
  ? { state: 'verified', amount, basis } : unavailable('INVALID_AMOUNT');
const nonnegative = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;

export interface SettlementCashReceipt {
  id: string; organizationId: string; type: 'INCOME' | 'EXPENSE'; amount: number;
  approvalStatus: 'UNAPPROVED' | 'APPROVED' | 'CANCELLED'; postingStatus: 'UNPOSTED' | 'POSTED' | 'REVERSED' | 'NOT_APPLICABLE';
  postingMode: 'CASHBOOK' | 'NON_CASH'; accountId: string | null; activePostingId: string | null;
  sourceVerified: boolean; itemsComplete: boolean; isTargetRefund: boolean;
  items: { id: string; accountingClass: string; amount: number }[];
  ledger: { netEffect: number; allPostingsVirtual: boolean; active: {
    id: string; voucherId: string; organizationId: string; accountId: string; amount: number;
    netEffect: number; virtual: boolean; reversed: boolean;
  } | null };
}
type CashSplit = { state: 'verified'; amount: number; deposit: number; other: number } | { state: 'unavailable'; reason: string };
export function classifySettlementCash(receipt: SettlementCashReceipt): CashSplit {
  const unknown = (reason: string): CashSplit => ({ state: 'unavailable', reason });
  const zero: CashSplit = { state: 'verified', amount: 0, deposit: 0, other: 0 };
  const { ledger } = receipt;
  if (!receipt.sourceVerified || !nonnegative(receipt.amount) || !Number.isSafeInteger(ledger.netEffect)) return unknown('SOURCE_OR_AMOUNT_UNVERIFIED');
  const noActive = receipt.activePostingId === null && ledger.active === null && ledger.netEffect === 0;
  if (noActive && ((receipt.postingMode === 'NON_CASH' && receipt.postingStatus === 'NOT_APPLICABLE')
    || (receipt.postingMode === 'CASHBOOK' && ['UNPOSTED', 'REVERSED'].includes(receipt.postingStatus)))) return zero;
  const active = ledger.active;
  if (receipt.postingMode !== 'CASHBOOK' || receipt.postingStatus !== 'POSTED' || receipt.approvalStatus !== 'APPROVED'
    || active === null || active.id !== receipt.activePostingId || active.voucherId !== receipt.id
    || active.organizationId !== receipt.organizationId || active.accountId !== receipt.accountId || active.reversed
    || active.amount !== receipt.amount || active.netEffect !== ledger.netEffect) return unknown('POSTING_UNVERIFIED');
  if (active.virtual && ledger.allPostingsVirtual) return zero;
  const direction = receipt.type === 'INCOME' ? 1 : -1;
  if (active.virtual || ledger.netEffect * direction !== receipt.amount) return unknown('CASH_ALLOCATION_UNVERIFIED');
  if (!receipt.itemsComplete || receipt.items.length === 0 || new Set(receipt.items.map(item => item.id)).size !== receipt.items.length
    || receipt.items.some(item => !nonnegative(item.amount) || !['DEPOSIT', 'REVENUE', 'PNL', 'INTERNAL', 'CUSTOMER_CREDIT'].includes(item.accountingClass))) return unknown('ITEM_ALLOCATION_UNVERIFIED');
  const itemTotal = receipt.items.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(itemTotal) || itemTotal !== receipt.amount) return unknown('ITEM_ALLOCATION_UNVERIFIED');
  const deposit = receipt.items.filter(item => item.accountingClass === 'DEPOSIT').reduce((sum, item) => sum + item.amount, 0);
  return { state: 'verified', amount: receipt.amount, deposit, other: itemTotal - deposit };
}
export function aggregateSettlementCash(receipts: readonly SettlementCashReceipt[], complete: boolean) {
  const result = (depositReceived: SettlementMoneyFact, otherReceived: SettlementMoneyFact, refunded: SettlementMoneyFact) => ({ depositReceived, otherReceived, refunded });
  if (!complete || new Set(receipts.map(receipt => receipt.id)).size !== receipts.length) {
    const missing = unavailable('RECEIPT_COVERAGE_UNVERIFIED'); return result(missing, missing, missing);
  }
  let deposit = 0; let other = 0; let refund = 0; let incomeError: string | null = null; let refundError: string | null = null;
  for (const receipt of receipts) {
    if (receipt.type === 'EXPENSE' && !receipt.isTargetRefund) continue;
    const cash = classifySettlementCash(receipt);
    if (cash.state !== 'verified') { if (receipt.type === 'INCOME') incomeError = cash.reason; else refundError = cash.reason; continue; }
    if (receipt.type === 'INCOME') { deposit += cash.deposit; other += cash.other; } else refund += cash.amount;
  }
  return result(incomeError ? unavailable(incomeError) : verified(deposit, 'EFFECTIVE_CASH_DEPOSIT_ITEMS'),
    incomeError ? unavailable(incomeError) : verified(other, 'EFFECTIVE_CASH_OTHER_ITEMS'),
    refundError ? unavailable(refundError) : verified(refund, 'EFFECTIVE_TARGET_REFUND_POSTINGS'));
}

export interface SettlementDebtInvoice {
  id: string; status: string; total: number; paid: number; remaining: number; previousDebt: number;
  previousSources: { type: string; id: string; amount: number }[];
}
/** Current invoice obligations, not cash receipts or a reconstructed historical debt snapshot. */
export function calculateSettlementCurrentDebt(invoices: readonly SettlementDebtInvoice[], complete: boolean): SettlementMoneyFact {
  if (!complete || new Set(invoices.map(invoice => invoice.id)).size !== invoices.length) return unavailable('INVOICE_COVERAGE_UNVERIFIED');
  const open = invoices.filter(invoice => ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'].includes(invoice.status));
  if (invoices.some(invoice => !['APPROVED', 'PARTIAL_PAID', 'OVERDUE', 'PAID', 'DRAFT', 'CANCELLED', 'PENDING_APPROVAL'].includes(invoice.status))) return unavailable('INVOICE_STATUS_UNVERIFIED');
  const byId = new Map(open.map(invoice => [invoice.id, invoice])); const carriedBy = new Map<string, string>();
  for (const invoice of open) {
    if (![invoice.total, invoice.paid, invoice.remaining, invoice.previousDebt].every(nonnegative)
      || invoice.total - invoice.paid !== invoice.remaining || invoice.previousDebt > invoice.total) return unavailable('INVOICE_AMOUNT_UNVERIFIED');
    let previous = 0;
    for (const source of invoice.previousSources) {
      const sourceInvoice = byId.get(source.id);
      if (source.type !== 'invoice' || !nonnegative(source.amount) || source.amount === 0 || sourceInvoice === undefined
        || source.id === invoice.id || source.amount !== sourceInvoice.remaining || carriedBy.has(source.id)) return unavailable('CARRIED_DEBT_UNVERIFIED');
      previous += source.amount; carriedBy.set(source.id, invoice.id);
    }
    if (!Number.isSafeInteger(previous) || previous !== invoice.previousDebt) return unavailable('CARRIED_DEBT_UNVERIFIED');
  }
  for (const invoice of open) {
    const seen = new Set<string>(); let next: string | undefined = invoice.id;
    while (next !== undefined) { if (seen.has(next)) return unavailable('CARRIED_DEBT_CYCLE'); seen.add(next); next = carriedBy.get(next); }
  }
  return verified(open.filter(invoice => !carriedBy.has(invoice.id)).reduce((sum, invoice) => sum + invoice.remaining, 0), 'CURRENT_INVOICE_OBLIGATIONS');
}
