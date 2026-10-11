import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/ctx.js', () => ({ sb: {} }));
const { validateAutomationDelivery } = await import('../lib/automation-delivery.js');

const now = new Date('2026-10-11T12:59:00Z');
const job = { account_id: 'a', organization_id: 'o', conversation_id: 'c',
  payload: { tu_dong: true }, not_before: now.toISOString() };
function database({ enabled = true, sale = true, recipients = ['c'], error = null,
  conversationOrg = 'o', conversationError = null } = {}) {
  return { from: vi.fn(table => {
    const data = table === 'zalo_automations'
      ? { enabled, config: { recipients, antiSpam: { allowedHours: { from: '08:00', to: '20:00' } } } }
      : { account_id: 'a', organization_id: conversationOrg, is_sale_partner: sale };
    const q = { select: () => q, eq: () => q,
      maybeSingle: async () => ({ data, error: table === 'zalo_automations' ? error : conversationError }) };
    return q;
  }) };
}
describe('automation dispatch checks current conditions', () => {
  it('leaves manually sent messages outside automation controls', async () => {
    const db = database({ enabled: false });
    expect(await validateAutomationDelivery({ ...job, payload: {} }, db, now)).toEqual({ ok: true });
    expect(db.from).not.toHaveBeenCalled();
  });
  it('permits an eligible recipient before closing time', async () => {
    expect(await validateAutomationDelivery(job, database(), now)).toEqual({ ok: true });
  });
  it.each([
    [{ enabled: false }, 'CANCELLED_AUTOMATION'],
    [{ recipients: [] }, 'CANCELLED_AUTOMATION'],
    [{ error: { message: 'offline' } }, 'AUTOMATION_UNVERIFIED'],
    [{ conversationError: { message: 'offline' } }, 'AUTOMATION_UNVERIFIED'],
    [{ conversationOrg: 'other' }, 'REJECTED_SCOPE'],
  ])('refuses changed or unverifiable state: %j', async (settings, reason) => {
    expect(await validateAutomationDelivery(job, database(settings), now))
      .toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });
  it('refuses backlog after the configured window and on the following day', async () => {
    for (const time of ['2026-10-11T13:01:00Z', '2026-10-12T01:00:00Z']) {
      expect(await validateAutomationDelivery(job, database(), new Date(time)))
        .toMatchObject({ ok: false, reason: expect.stringContaining('EXPIRED_AUTOMATION') });
    }
  });
  it('refuses future jobs even inside the window', async () => {
    expect(await validateAutomationDelivery({ ...job, not_before: '2026-10-11T13:00:00Z' }, database(), now))
      .toMatchObject({ ok: false, reason: expect.stringContaining('NOT_DUE') });
  });
  it('rechecks the sale flag for auto-reply without imposing broadcast recipients', async () => {
    const reply = { ...job, payload: { tu_dong: true, auto_reply: true } };
    expect(await validateAutomationDelivery(reply, database({ sale: false }), now)).toMatchObject({ ok: false });
    expect(await validateAutomationDelivery(reply, database({ recipients: [] }), now)).toEqual({ ok: true });
  });
});
