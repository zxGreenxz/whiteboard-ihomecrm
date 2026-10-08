import { describe, expect, it } from 'vitest';
import { inferPaymentKind, selectPaymentWallet, type PaymentWalletCandidate } from '../payment';
import { draftFromBill, draftsFromText, enrichFromAi, markTouched, type ComposeContext } from '../compose';
import { parseAiResult, type AiResult } from '../aiSchema';
import { resolvePersonalDraft } from '../personalRefs';
import { deserializeCards, serializeCards } from '../feedStorage';
import { validateDraft } from '../draft';
import type { Wallet } from '@/lib/personalFinance/contract';

const wallets: PaymentWalletCandidate[] = [
  { id: 'bank', kind: 'bank', accountId: 'bank-book' },
  { id: 'cash', kind: 'cash', accountId: 'cash-book' },
  { id: 'sp', kind: 'sp_card', accountId: 'sp-book' },
  { id: 'credit', kind: 'credit_card', accountId: 'credit-book' },
];
const ctx = (mode: 'company' | 'personal' = 'company', overrides: Partial<ComposeContext> = {}): ComposeContext => ({
  mode, entrySource: 'personal_wallet', companyOrganizationId: 'org-one', createdAt: 100,
  today: '2026-10-08', refs: { buildings: [], rooms: [] }, categories: [],
  personalWalletId: 'legacy-default', paymentWallets: wallets,
  newId: () => crypto.randomUUID(), defaultAccountFor: () => 'unconfigured-book', ...overrides,
});
const bill = (overrides: Partial<AiResult> = {}): AiResult => {
  const parsed = parseAiResult(JSON.stringify({ items: [{ desc: 'Vật tư', amount_vnd: 50_000, transactionType: 'EXPENSE' }], ...overrides }), 0);
  if (!parsed.ok) throw new Error('Invalid test bill');
  return parsed.value;
};

describe('payment evidence policy', () => {
  it.each([
    [{ userText: 'mua Shopee 50k', billPayment: 'bank_transfer' }, 'sp_card'],
    [{ userText: 'dùng thẻ SP' }, 'sp_card'],
    [{ platform: 'shopee', userText: 'dùng thẻ tín dụng', billPayment: 'bank_transfer' }, 'sp_card'],
    [{ merchant: 'SHOPEE', billPayment: 'cash' }, 'sp_card'],
    [{ userText: 'dùng thẻ', billPayment: 'bank_transfer' }, 'credit_card'],
    [{ userText: 'thẻ tín dụng', billPayment: 'bank_transfer' }, 'credit_card'],
    [{ userText: 'ăn sáng', billPayment: 'bank_transfer' }, 'bank'],
    [{ userText: 'CK tiền công' }, 'bank'],
    [{ userText: 'trả tiền mặt' }, 'cash'],
    [{ billPayment: 'cash' }, 'cash'],
    [{ userText: 'có thể mua thêm bóng đèn', billPayment: 'bank_transfer' }, 'bank'],
    [{ userText: 'không dùng thẻ, chuyển khoản tiền công' }, 'bank'],
    [{ merchant: 'VISA Mastercard ngân hàng', billPayment: null }, null],
  ] as const)('chooses %j as %s', (evidence, kind) => {
    expect(inferPaymentKind(evidence)).toBe(kind);
  });

  it('never falls back across kinds, hidden wallets, or multiple equally eligible wallets', () => {
    const evidence = { userText: 'mua Shopee' };
    expect(selectPaymentWallet(evidence, wallets.filter(wallet => wallet.kind !== 'sp_card')).wallet).toBeNull();
    expect(selectPaymentWallet(evidence, [{ id: 'hidden', kind: 'sp_card', hidden: true }]).wallet).toBeNull();
    const many = [...wallets, { id: 'sp-two', kind: 'sp_card' }];
    expect(selectPaymentWallet(evidence, many).wallet).toBeNull();
    expect(selectPaymentWallet(evidence, many.map(wallet => ({ ...wallet, isPreferred: wallet.id === 'sp-two' }))).wallet?.id).toBe('sp-two');
    expect(selectPaymentWallet(evidence, many.map(wallet => ({ ...wallet, isPreferred: wallet.kind === 'sp_card' }))).wallet).toBeNull();
    expect(selectPaymentWallet({ userText: 'mua đồ' }, [{ id: 'cash', kind: 'cash', isPreferred: true }]).wallet).toBeNull();
  });

  it('AI schema accepts evidence but forbids credit-card inference and wallet IDs', () => {
    expect(parseAiResult('{"payment_method":"bank_transfer","platform":"shopee"}', 0).ok).toBe(true);
    expect(parseAiResult('{"payment_method":"credit_card"}', 0).ok).toBe(false);
    expect(parseAiResult('{"walletId":"recipient-bank"}', 0).ok).toBe(false);
    expect(parseAiResult('{}', 0).ok).toBe(true);
  });
});

describe.each(['personal', 'company'] as const)('wallet-page composition: %s', mode => {
  const walletId = (state: ReturnType<typeof draftFromBill>) => mode === 'company' ? state.draft.companyWalletId : state.draft.personalWalletId;
  it('uses bank for transfer bills, and only user caption can select credit card', () => {
    const bank = draftFromBill(bill({ payment_method: 'bank_transfer', vendor: 'Người nhận' }), ctx(mode));
    expect(walletId(bank)).toBe('bank');
    expect(bank.draft.transactionType).toBe('EXPENSE');
    const credit = draftFromBill(bill({ payment_method: 'bank_transfer' }), ctx(mode, { sourceText: 'đã dùng thẻ' }));
    expect(walletId(credit)).toBe('credit');
    expect(credit.paymentSourceText).toBe('đã dùng thẻ');
    expect(draftFromBill(bill({ payment_method: 'bank_transfer', platform: 'shopee' }), ctx(mode)).draft.paymentKind).toBe('sp_card');
  });

  it('keeps Shopee refund direction independent from wallet choice', () => {
    const refund = draftFromBill(bill({ platform: 'shopee', items: [{ desc: 'Hoàn tiền Shopee', amount_vnd: 50_000, transactionType: 'INCOME', confidence: 1, category: null }] }), ctx(mode));
    expect(walletId(refund)).toBe('sp');
    expect(refund.draft.transactionType).toBe('INCOME');
  });

  it('preserves manual selection, including clearing it, after late AI or a retry', () => {
    for (const selected of ['cash', null]) {
      const [initial] = draftsFromText('mua đồ 50k', ctx(mode));
      const path = mode === 'company' ? 'companyWalletId' : 'personalWalletId';
      const manual = markTouched({ ...initial, draft: { ...initial.draft, [path]: selected, accountId: selected ? 'cash-book' : null } }, path);
      const enriched = enrichFromAi(manual, bill({ platform: 'shopee', payment_method: 'bank_transfer' }), ctx(mode));
      expect(walletId(enriched)).toBe(selected);
      expect(enriched.draft.accountId).toBe(manual.draft.accountId);
    }
  });

  it('splits different explicit payment methods and retains a shared card header', () => {
    const cards = draftsFromText('Shopee 50k; trả tiền công chuyển khoản 100k; mua đồ tiền mặt 20k', ctx(mode));
    expect(cards.map(walletId)).toEqual(['sp', 'bank', 'cash']);
    expect(cards.flatMap(card => card.draft.lines).map(line => line.amount)).toEqual([50_000, 100_000, 20_000]);
    const header = draftsFromText('ăn sáng 50k; mua cà phê 20k', ctx(mode, { sourceText: 'dùng thẻ: ăn sáng 50k; mua cà phê 20k' }));
    expect(header).toHaveLength(1);
    expect(walletId(header[0])).toBe('credit');
    const partlyShopee = draftsFromText('mua Shopee 50k; ăn sáng 20k', ctx(mode));
    expect(partlyShopee.map(walletId)).toEqual(['sp', null]);
    expect(draftsFromText('Shopee: mua áo 50k; mua quần 20k', ctx(mode)).map(walletId)).toEqual(['sp']);
  });

  it('keeps payment metadata and submission order through storage without treating AI descriptions as user text', () => {
    const first = draftFromBill(bill({ payment_method: 'bank_transfer', items: [{ desc: 'Thẻ tín dụng VISA', amount_vnd: 50_000, confidence: 1, category: null }] }), ctx(mode, { createdAt: 10 }));
    first.draft.attachmentUrls = mode === 'company' ? ['https://example.test/bill'] : [];
    const newer = draftsFromText('mua Shopee 50k', ctx(mode, { createdAt: 20 }))[0];
    const sameSubmission = draftsFromText('tiền mặt 20k', ctx(mode, { createdAt: 20 }))[0];
    const stored = [first, newer, sameSubmission].map(state => ({ state, personalDone: 0, status: { kind: 'draft' as const } }));
    const restored = deserializeCards(serializeCards(stored, 30), 31);
    expect(restored.map(card => card.state.draft.id)).toEqual([newer.draft.id, sameSubmission.draft.id, first.draft.id]);
    expect(restored[2].state.draft.paymentKind).toBe('bank');
    expect(restored[2].state.paymentSourceText).toBe('');
    expect(restored[2].state.draft.companyOrganizationId).toBe(mode === 'company' ? 'org-one' : undefined);
  });
});

describe('scope boundaries and backward compatibility', () => {
  it('does not reinstate personal default when scoped recognition requires selection', () => {
    const [state] = draftsFromText('mua đồ 50k', ctx('personal'));
    const defaultWallet: Wallet = { id: 'default', name: 'Ví mặc định', kind: 'cash', icon: 'wallet', user_id: 'user', version: 1, balance: 0, opening_balance: 0, hidden: false, is_default: true };
    expect(state.draft.personalWalletId).toBeNull();
    expect(resolvePersonalDraft(state.draft, [defaultWallet], []).personalWalletId).toBeNull();
    expect(resolvePersonalDraft({ ...state.draft, entrySource: undefined }, [defaultWallet], []).personalWalletId).toBe('default');
  });

  it('cannot select an unconfigured cashbook or replace a pinned company from another context', () => {
    const [unknown] = draftsFromText('mua đồ 50k', ctx());
    expect(unknown.draft.companyWalletId).toBeNull();
    expect(unknown.draft.accountId).toBeNull();
    expect(validateDraft(unknown.draft)).toMatchObject({ ok: false, issues: { companyWalletId: 'Chọn ví Công ty đã cài đặt.' } });
    const [bank] = draftsFromText('ck tiền công 50k', ctx());
    const stale = enrichFromAi(bank, bill({ platform: 'shopee' }), ctx('company', { companyOrganizationId: 'org-two', paymentWallets: [{ id: 'foreign', kind: 'sp_card', accountId: 'foreign-book' }] }));
    expect(stale.draft.companyWalletId).toBe('bank');
    expect(stale.draft.companyOrganizationId).toBe('org-one');
    expect(draftFromBill(bill({ payment_method: 'bank_transfer' }), ctx('company', { paymentWallets: [{ id: 'broken', kind: 'bank' }] })).draft.companyWalletId).toBeNull();
  });

  it('retains ordinary quick-entry cashbook defaults outside wallet page', () => {
    const unscoped = ctx('company', { entrySource: undefined });
    expect(draftsFromText('mua Shopee 50k', unscoped)[0].draft.accountId).toBe('unconfigured-book');
    expect(draftFromBill(bill({ payment_method: 'bank_transfer' }), unscoped).draft.accountId).toBe('unconfigured-book');
  });
});
