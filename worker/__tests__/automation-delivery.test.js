import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/ctx.js', () => ({ sb: {} }));
const { validateAutomationDelivery } = await import('../lib/automation-delivery.js');

const now = new Date('2026-10-11T12:59:00Z');
const job = { account_id: 'a', organization_id: 'o', conversation_id: 'c',
  payload: { tu_dong: true }, not_before: now.toISOString() };
function database({ enabled = true, sale = true, recipients = ['c'], error = null,
  conversationOrg = 'o', conversationError = null, threadType = 'group', shot = null, shotError = null, automation = true,
  stopAt = null, stopError = null, saves = [] } = {}) {
  return { from: vi.fn(table => {
    const data = table === 'zalo_automations'
      ? (automation ? { enabled, config: { recipients, antiSpam: { allowedHours: { from: '08:00', to: '20:00' } } } } : null)
      : table === 'zalo_automation_oneshots' ? shot
        : table === 'zalo_automation_runs' ? (stopAt ? { created_at: stopAt } : null)
          : { account_id: 'a', organization_id: conversationOrg, is_sale_partner: sale, thread_type: threadType };
    const failure = table === 'zalo_automations' ? error : table === 'zalo_automation_oneshots' ? shotError
      : table === 'zalo_automation_runs' ? stopError : conversationError;
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data, error: failure }),
      // List read (only the one-shot stop check reads every automation row's updated_at).
      then: (res, rej) => Promise.resolve({ data: table === 'zalo_automations' ? saves.map(updated_at => ({ updated_at })) : [], error: null }).then(res, rej) };
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

  describe('one-shot (gửi ngay / hẹn giờ một lần)', () => {
    const shotJob = { ...job, payload: { tu_dong: true, oneshot_id: 's1' } };
    const shot = (over = {}) => ({ organization_id: 'o', status: 'running', recipients: ['c'], ...over });
    it('is its own authority: schedule off, no row, or recipient outside config.recipients still pass', async () => {
      for (const settings of [{ enabled: false }, { recipients: [] }, { automation: false }]) {
        expect(await validateAutomationDelivery(shotJob, database({ ...settings, shot: shot() }), now)).toEqual({ ok: true });
      }
      expect(await validateAutomationDelivery(shotJob, database({ shot: shot({ status: 'done' }) }), now)).toEqual({ ok: true });
    });
    it.each([
      [{ shot: shot({ status: 'cancelled' }) }, 'CANCELLED_AUTOMATION'],
      [{ shot: shot({ status: 'queued' }) }, 'CANCELLED_AUTOMATION'],
      [{ shot: shot({ recipients: ['other'] }) }, 'CANCELLED_AUTOMATION'],
      [{ shot: shot(), threadType: 'user' }, 'CANCELLED_AUTOMATION'],
      [{ shot: shot(), sale: false }, 'CANCELLED_AUTOMATION'],
      [{ shot: shot({ organization_id: 'other' }) }, 'REJECTED_SCOPE'],
      [{ shot: null }, 'REJECTED_SCOPE'],
      [{ shot: shot(), shotError: { message: 'offline' } }, 'AUTOMATION_UNVERIFIED'],
    ])('refuses a cancelled, foreign or no-longer-sale-group one-shot: %j', async (settings, reason) => {
      expect(await validateAutomationDelivery(shotJob, database(settings), now))
        .toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    });
    it('P2.1: emergency stop blocks a one-shot job created before the latest stop, and while the stop is not lifted', async () => {
      const at = { ...shotJob, created_at: '2026-10-11T12:00:00Z' };
      const done = shot({ status: 'done' });
      expect(await validateAutomationDelivery(at, database({ shot: done, stopAt: '2026-10-11T12:30:00Z', saves: ['2026-10-11T12:40:00Z'] }), now))
        .toMatchObject({ ok: false, reason: expect.stringContaining('trước lần dừng khẩn cấp') });
      expect(await validateAutomationDelivery(at, database({ shot: done, stopAt: '2026-10-11T11:00:00Z', saves: ['2026-10-11T10:00:00Z'] }), now))
        .toMatchObject({ ok: false, reason: expect.stringContaining('đang dừng khẩn cấp') });
      expect(await validateAutomationDelivery(at, database({ shot: done, stopAt: '2026-10-11T11:00:00Z', saves: [] }), now))
        .toMatchObject({ ok: false, reason: expect.stringContaining('đang dừng khẩn cấp') });
      expect(await validateAutomationDelivery(at, database({ shot: done, stopError: { message: 'offline' } }), now))
        .toMatchObject({ ok: false, reason: expect.stringContaining('AUTOMATION_UNVERIFIED') });
      // Lifted by a later save/toggle of either automation row: a newer job may send.
      expect(await validateAutomationDelivery(at, database({ shot: done, stopAt: '2026-10-11T11:00:00Z',
        saves: ['2026-10-11T10:00:00Z', '2026-10-11T11:30:00Z'] }), now)).toEqual({ ok: true });
    });
    it('keeps hours/day/due checks for one-shots', async () => {
      expect(await validateAutomationDelivery(shotJob, database({ shot: shot() }), new Date('2026-10-11T13:01:00Z')))
        .toMatchObject({ ok: false, reason: expect.stringContaining('EXPIRED_AUTOMATION') });
      expect(await validateAutomationDelivery({ ...shotJob, not_before: '2026-10-11T13:00:00Z' }, database({ shot: shot() }), now))
        .toMatchObject({ ok: false, reason: expect.stringContaining('NOT_DUE') });
    });
  });
});
