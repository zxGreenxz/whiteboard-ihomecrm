import { describe, expect, it } from 'vitest';
import {
  buildMoveOutNoticeArgs,
  invokeMoveOutNotice,
  moveOutNoticeErrorMessage,
  parseMoveOutNoticeSnapshot,
} from '../contractMoveOutNotice';

const snapshot = {
  contract_id: 'contract', organization_id: 'org', expected_move_out_date: '2026-09-28',
  updated_at: '2026-09-27T18:00:00.123456+00:00', today: '2026-09-28', status: 'ACTIVE',
};

describe('move-out notice responses and concurrency', () => {
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
