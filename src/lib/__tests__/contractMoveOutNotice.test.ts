import { describe, expect, it } from 'vitest';
import {
  buildMoveOutNoticeArgs,
  getMoveOutNoticeState,
  invokeMoveOutNotice,
  moveOutNoticeErrorMessage,
  parseMoveOutNoticeSnapshot,
} from '../contractMoveOutNotice';

const snapshot = {
  contract_id: 'contract', organization_id: 'org', expected_move_out_date: '2026-09-28',
  updated_at: '2026-09-27T18:00:00.123456+00:00', today: '2026-09-28', status: 'ACTIVE',
};

describe('move-out notice civil date and concurrency boundary', () => {
  it('keeps due and overdue notices actionable until the tenant actually leaves', () => {
    expect(getMoveOutNoticeState('2026-09-29', '2026-09-28')).toBe('upcoming');
    expect(getMoveOutNoticeState('2026-09-28', '2026-09-28')).toBe('due');
    expect(getMoveOutNoticeState('2026-09-27', '2026-09-28')).toBe('overdue');
    expect(getMoveOutNoticeState(null, '2026-09-28')).toBe('none');
  });

  it('preserves the precise version and date without timezone conversion', () => {
    expect(buildMoveOutNoticeArgs({ organizationId: 'org', contractId: 'contract',
      expectedUpdatedAt: snapshot.updated_at, expectedMoveOutDate: '2026-09-28', reason: '  khách báo lại  ',
    })).toEqual({ p_organization_id: 'org', p_contract_id: 'contract',
      p_expected_updated_at: snapshot.updated_at, p_expected_move_out_date: '2026-09-28', p_reason: 'khách báo lại' });
  });

  it('allows cancellation with a reason and rejects ambiguous or impossible dates', () => {
    const input = { organizationId: 'org', contractId: 'contract', expectedUpdatedAt: snapshot.updated_at };
    expect(buildMoveOutNoticeArgs({ ...input, expectedMoveOutDate: null, reason: 'Khách ở tiếp' }).p_expected_move_out_date).toBeNull();
    for (const date of ['2026-02-30', '28/09/2026', '2026-09-28T00:00:00Z', '']) {
      expect(() => buildMoveOutNoticeArgs({ ...input, expectedMoveOutDate: date })).toThrow();
    }
    expect(() => buildMoveOutNoticeArgs({ ...input, expectedMoveOutDate: null, reason: ' ' })).toThrow();
  });

  it('rejects malformed responses instead of treating a failed read as no notice', () => {
    expect(parseMoveOutNoticeSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseMoveOutNoticeSnapshot({ ...snapshot, today: '2026-02-30' })).toThrow();
    expect(() => parseMoveOutNoticeSnapshot(null)).toThrow();
  });

  it('surfaces a stale version without retrying or accepting an empty write response', async () => {
    let calls = 0;
    await expect(invokeMoveOutNotice(async () => { calls++; return { data: null, error: { code: 'PT409' } }; },
      buildMoveOutNoticeArgs({ organizationId: 'org', contractId: 'contract', expectedUpdatedAt: snapshot.updated_at,
        expectedMoveOutDate: '2026-09-29' }))).rejects.toMatchObject({ code: 'PT409' });
    expect(calls).toBe(1);
    expect(moveOutNoticeErrorMessage({ code: 'PT409' })).toMatch(/tải lại/i);
    expect(moveOutNoticeErrorMessage({ code: '42501', message: 'internal SQL' })).not.toContain('internal SQL');
    await expect(invokeMoveOutNotice(async () => ({ data: null, error: null }),
      buildMoveOutNoticeArgs({ organizationId: 'org', contractId: 'contract', expectedUpdatedAt: snapshot.updated_at,
        expectedMoveOutDate: '2026-09-29' }))).rejects.toThrow();
  });
});
