// @vitest-environment jsdom
// Đợt 8 (luật 5): ba hàm dùng chung cho thao tác ghi lặp lại được — chạy không giữ dấu, xoá khớp 0 dòng, gỡ dấu bản trước.
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflowError';
import { recordWriteBlocked, repeatableWrite, settleZeroRowDelete } from '@/lib/recordWriteOutcome';
import { forgetLegacyPending } from '@/lib/legacyPendingExit';
import { seedLegacyPending, pendingKeys } from '@/hooks/__tests__/fakeRecordServer';

const NETWORK = new TypeError('Failed to fetch');

beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); });

describe('repeatableWrite', () => {
  it('kết quả chưa rõ (mất mạng, 5xx, biên nhận sai mã) thành lỗi lặp lại được, không khoá form', async () => {
    for (const failure of [NETWORK, { code: '', message: 'Failed to fetch' }, { status: 503, message: 'upstream' }, new FinancialWorkflowError('biên nhận sai', 'unknown', [{ id: 'r1', label: 'x' }])]) {
      const error = await repeatableWrite('cập nhật xe', async () => { throw failure; }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
      expect(error).toMatchObject({ outcome: 'unknown', cause: failure, message: expect.stringContaining('Bấm lại') });
      expect(recordWriteBlocked(error)).toBe(false);
    }
    const partial = await repeatableWrite('cập nhật khách', async () => { throw new FinancialWorkflowError('dở', 'partial', [{ id: 'c1', label: 'Đã cập nhật khách' }]); }).catch((caught: unknown) => caught);
    expect(partial).toMatchObject({ completed: [{ id: 'c1', label: 'Đã cập nhật khách' }] });
  });

  it('lời từ chối rõ đi nguyên, không bị nói thành «chưa rõ»', async () => {
    const denied = { code: '42501', message: 'permission denied' };
    const notOne = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
    const already = new FinancialAlreadyRecordedError('Đã có', ['r1']);
    const rejected = new FinancialWorkflowError('Không cho', 'failure', []);
    for (const failure of [denied, notOne, already, rejected, new Error('Not authenticated')]) {
      await expect(repeatableWrite('xoá xe', async () => { throw failure; })).rejects.toBe(failure);
    }
    await expect(repeatableWrite('xoá xe', async () => 'ok')).resolves.toBe('ok');
  });

  it('các lỗi khoá form cũ vẫn khoá: chỉ lỗi lặp lại được là ngoại lệ', () => {
    expect(recordWriteBlocked(new FinancialWorkflowError('chưa rõ', 'unknown', []))).toBe(true);
    expect(recordWriteBlocked(NETWORK)).toBe(true);
    expect(recordWriteBlocked(new FinancialWorkflowError('từ chối', 'failure', []))).toBe(false);
    expect(recordWriteBlocked(new RepeatableWriteUnknownError('sửa xe', NETWORK))).toBe(false);
  });
});

describe('settleZeroRowDelete', () => {
  it('bản ghi không còn thấy, hoặc đã xoá mềm ⇒ đã xoá trước đó', async () => {
    await expect(settleZeroRowDelete('xoá xe', async () => ({ data: null, error: null }))).resolves.toBe('already-deleted');
    await expect(settleZeroRowDelete('xoá xe', async () => ({ data: [], error: null }))).resolves.toBe('already-deleted');
    await expect(settleZeroRowDelete('xoá xe', async () => ({ data: { id: 'v1', deleted_at: '2026-11-26T00:00:00Z' }, error: null }))).resolves.toBe('already-deleted');
    await expect(settleZeroRowDelete('xoá khu vực', async () => ({ data: { id: 'a1', is_active: false }, error: null }), row => row.is_active === false)).resolves.toBe('already-deleted');
  });

  it('bản ghi còn nguyên ⇒ máy chủ không xoá dòng nào: từ chối rõ, không giả là đã xoá', async () => {
    const error = await settleZeroRowDelete('xoá xe', async () => ({ data: { id: 'v1', deleted_at: null }, error: null })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('chưa có quyền xoá') });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
  });

  it('đọc lại hỏng ⇒ chưa rõ, bấm lại được', async () => {
    await expect(settleZeroRowDelete('xoá xe', async () => ({ data: null, error: { code: '', message: 'Failed to fetch' } }))).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(settleZeroRowDelete('xoá xe', async () => { throw NETWORK; })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
  });
});

describe('forgetLegacyPending', () => {
  it('gỡ đúng dấu bản trước đã «kết thúc» của bản ghi đó, không đụng dấu khác', async () => {
    const old = seedLegacyPending({ namespace: 'vehicle-update', userId: 'actor', organizationId: 'actor-scope', businessKey: 'v1' }, new Date(Date.now() - 10 * 60_000));
    const other = seedLegacyPending({ namespace: 'vehicle-update', userId: 'actor', organizationId: 'actor-scope', businessKey: 'v2' }, new Date(Date.now() - 10 * 60_000));
    await forgetLegacyPending({ namespace: 'vehicle-update', businessKey: 'v1' }, { organizationId: 'actor-scope' });
    expect(pendingKeys()).toEqual([other]);
    expect(localStorage.getItem(old)).toBeNull();
  });

  it('dấu chưa đủ 2 phút (tab bản cũ có thể còn đang gửi) để nguyên, không ném lỗi', async () => {
    const fresh = seedLegacyPending({ namespace: 'useUpdateLead', userId: 'actor', organizationId: 'org-a', businessKey: 'l1' }, new Date(Date.now() - 30_000));
    await expect(forgetLegacyPending({ namespace: 'useUpdateLead', businessKey: 'l1' })).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([fresh]);
  });

  it('dấu phạm vi công ty đang chọn được gỡ khi không khai công ty', async () => {
    seedLegacyPending({ namespace: 'useUpdateLead', userId: 'actor', organizationId: 'org-a', businessKey: 'l1' }, new Date(Date.now() - 10 * 60_000));
    await forgetLegacyPending({ namespace: 'useUpdateLead', businessKey: 'l1' });
    expect(pendingKeys()).toEqual([]);
  });
});
