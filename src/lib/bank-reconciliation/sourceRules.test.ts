import { describe, expect, it } from 'vitest';
import { cashbooks, createDemoState } from './demoFixtures';
import { applyDemoCommand, findMatches, saveDemoSourceRules } from './demoModel';
import { createSourceRules, demoSources, mbDemoSample } from './sourceFixtures';
import { emailAddress, resolveSourceMessages, ruleMatches, validateSourceRule, type SourceRule } from './sourceRules';

const rules = createSourceRules();
const appRule = rules.find(r => r.id === 'demo-mbdemo-notification')!;
const mailRule = rules.find(r => r.id === 'demo-mbdemo-gmail')!;
const at = '2026-10-17T12:00:00+07:00';
const save = (state: ReturnType<typeof createDemoState>, next: SourceRule[]) => saveDemoSourceRules(state, next, demoSources, cashbooks.map(b => b.id), at);

describe('source to cashbook routing', () => {
  it('resolves MBDemo only through the configured source, package and account token', () => {
    expect(resolveSourceMessages([mbDemoSample], rules, 'DEMO')).toMatchObject({ status: 'resolved', bookId: 'demo-mbdemo', ruleIds: [appRule.id] });
    for (const patch of [{ sourceId: 'src-chung' }, { packageName: 'MB Bank' }, { channel: 'sms' as const }, { org: 'OTHER' }, { body: 'TK 00xxx124 | +650000' }]) {
      expect(ruleMatches(appRule, { ...mbDemoSample, ...patch })).toBe(false);
    }
  });
  it('requires every configured condition and does not match account suffixes accidentally', () => {
    const rule = { ...appRule, textIncludes: 'BIẾN ĐỘNG SỐ DƯ' };
    expect(ruleMatches(rule, mbDemoSample)).toBe(true);
    expect(ruleMatches({ ...rule, textIncludes: 'nội dung khác' }, mbDemoSample)).toBe(false);
    expect(ruleMatches({ ...rule, accountToken: '123' }, mbDemoSample)).toBe(false);
    expect(ruleMatches({ ...rule, accountToken: '' }, { ...mbDemoSample, body: 'TK 123456 | GD +650000' })).toBe(true);
  });
  it('supports exact SMS sender without treating body mentions as sender identity', () => {
    const smsRule = rules.find(r => r.id === 'demo-mbdemo-sms')!;
    expect(ruleMatches(smsRule, { ...mbDemoSample, channel: 'sms', sender: ' mb-demo ' })).toBe(true);
    expect(ruleMatches(smsRule, { ...mbDemoSample, channel: 'sms', sender: 'SCAM', body: `MB-DEMO ${mbDemoSample.body}` })).toBe(false);
  });
  it('matches the full email address, never its display name, suffix or domain alone', () => {
    const message = { ...mbDemoSample, sourceId: 'src-mail', channel: 'gmail' as const, sender: 'Ngân hàng <BANK-ALERTS@EXAMPLE.TEST>' };
    expect(ruleMatches(mailRule, message)).toBe(true);
    for (const sender of ['bank-alerts@example.test <stranger@example.test>', 'bank-alerts@example.test.evil.test', 'bank-alerts@example.test, other@example.test', 'example.test']) {
      expect(ruleMatches(mailRule, { ...message, sender })).toBe(false);
    }
    expect(emailAddress('Ngân hàng <bank-alerts@example.test>')).toBe('bank-alerts@example.test');
  });
  it('never chooses first or most specific rule when different books match', () => {
    const broad = { ...appRule, id: 'broad', name: 'Quy tắc rộng', bookId: 'demo-chung', accountToken: '' };
    for (const list of [[broad, appRule], [appRule, broad]]) expect(resolveSourceMessages([mbDemoSample], list, 'DEMO')).toMatchObject({ status: 'conflict', bookId: null });
    expect(resolveSourceMessages([mbDemoSample], [appRule, { ...appRule, id: 'same-book' }], 'DEMO').bookId).toBe('demo-mbdemo');
  });
  it('detects conflict between channels already grouped into one transaction', () => {
    const otherRule = { ...mailRule, bookId: 'demo-chung' };
    const mail = { ...mbDemoSample, sourceId: 'src-mail', channel: 'gmail' as const, sender: mailRule.identity };
    expect(resolveSourceMessages([mbDemoSample, mail], [appRule, otherRule], 'DEMO').status).toBe('conflict');
  });
  it('ignores disabled rules and organizations outside the authenticated scope', () => {
    expect(resolveSourceMessages([mbDemoSample], [{ ...appRule, enabled: false }], 'DEMO').status).toBe('unmatched');
    expect(resolveSourceMessages([mbDemoSample], [{ ...appRule, org: 'OTHER' }], 'DEMO').status).toBe('unmatched');
    expect(resolveSourceMessages([{ ...mbDemoSample, org: 'OTHER' }], [{ ...appRule, org: 'OTHER' }], 'DEMO').status).toBe('unmatched');
  });
  it('rejects invalid source, book, channel and identities before saving', () => {
    for (const patch of [{ sourceId: 'missing' }, { bookId: '' }, { channel: 'gmail' as const }, { identity: 'MB Bank' }, { name: ' ' }, { identity: '' }]) {
      expect(validateSourceRule({ ...appRule, ...patch }, demoSources, cashbooks.map(b => b.id)).length).toBeGreaterThan(0);
    }
    expect(() => save(createDemoState(), [appRule, appRule])).toThrow('trùng');
    expect(() => save(createDemoState(), [{ ...appRule, org: 'OTHER' }])).toThrow('ngoài công ty');
  });
  it('updates pending suggestions when a rule pauses and restores them when re-enabled', () => {
    const state = createDemoState();
    const original = state.transactions.find(t => t.id === 'DEMO-GD-MB01')!;
    expect(findMatches(state, original).candidates.map(c => c.invoice.id)).toEqual(['D06']);
    const next = save(state, state.sourceRules.map(r => r.id === appRule.id ? { ...r, enabled: false } : r));
    const pending = next.transactions.find(t => t.id === original.id)!;
    expect(pending.book).toBeNull(); expect(findMatches(next, pending).blocked).toBeTruthy();
    expect(() => applyDemoCommand(next, { type: 'collect', transactionId: pending.id, invoiceId: 'D06', expectedRevision: 1 }, at)).toThrow();
    expect(state.transactions.find(t => t.id === original.id)?.book).toBe('demo-mbdemo');
    const restored = save(next, state.sourceRules);
    expect(findMatches(restored, restored.transactions.find(t => t.id === original.id)!).candidates).toHaveLength(1);
    expect(restored.sourceHistory).toHaveLength(2);
  });
  it('keeps confirmed book and evidence; undo re-evaluates against current rules', () => {
    const state = createDemoState();
    const collected = applyDemoCommand(state, { type: 'collect', transactionId: 'DEMO-GD-MB01', invoiceId: 'D06', expectedRevision: 1 }, at);
    const changed = save(collected, collected.sourceRules.map(r => r.id === appRule.id ? { ...r, bookId: 'demo-an' } : r));
    expect(changed.transactions.find(t => t.id === 'DEMO-GD-MB01')?.book).toBe('demo-mbdemo');
    expect(changed.receipts.find(r => r.invoiceId === 'D06')?.book).toBe('demo-mbdemo');
    const undone = applyDemoCommand(changed, { type: 'undo', transactionId: 'DEMO-GD-MB01', reason: 'Thử cấu hình' }, at);
    expect(undone.transactions.find(t => t.id === 'DEMO-GD-MB01')?.book).toBe('demo-an');
    expect(findMatches(undone, undone.transactions.find(t => t.id === 'DEMO-GD-MB01')!).candidates).toHaveLength(0);
  });
  it('routing does not clear other blocks such as duplicate or unclear debt', () => {
    const state = save(createDemoState(), rules);
    for (const id of ['DEMO-GD-19', 'DEMO-GD-21']) expect(findMatches(state, state.transactions.find(t => t.id === id)!).blocked).toBeTruthy();
  });
});
