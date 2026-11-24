import { describe, expect, it, vi } from 'vitest';
import {
  exitHoldLinksStart, exitSupportCaps, exitSupportError, exitSupportSettlementNote, pendingExitHold,
} from '@/lib/contractExitSupport';
import { canReverseExitSupport, reverseExitSupport, type ExitEarlyTermsInvoker } from '@/lib/contractExitEarlyTerms';
import { exitTermsRow, linkedExitTermsRow, EXIT_FIXTURE_IDS as ID } from '@/components/contracts/__tests__/exitEarlyTermsFixture';

const requestId = '20000000-0000-4000-8000-000000000009';

describe('trần số tiền khách cũ hỗ trợ khách mới (cùng hai trần máy chủ kiểm)', () => {
  it('nhờ sale: cọc cũ đã thu trừ phí môi giới; tự tìm: cả cọc cũ; trần chung là số nhỏ hơn với phần cọc còn thiếu', () => {
    expect(exitSupportCaps(exitTermsRow(), 4_000_000, 1_000_000)).toEqual({ oldCap: 2_000_000, newCap: 3_000_000, cap: 2_000_000 });
    expect(exitSupportCaps(exitTermsRow({ early_reason: 'SELF_FOUND', sale_name: null, broker_fee: 0 }), 4_000_000, 3_500_000))
      .toEqual({ oldCap: 4_000_000, newCap: 500_000, cap: 500_000 });
    // Phí còn ghi trên hồ sơ nhưng trường hợp không phải nhờ sale: không trừ.
    expect(exitSupportCaps(exitTermsRow({ early_reason: 'SELF_FOUND', broker_fee: 2_000_000 }), 4_000_000, 0).oldCap).toBe(4_000_000);
    // Đã nộp nhiều hơn cọc mới hoặc cọc cũ nhỏ hơn phí: trần về 0, không âm.
    expect(exitSupportCaps(exitTermsRow({ old_contract_deposit_paid: 1_000_000 }), 1_000_000, 2_000_000)).toEqual({ oldCap: 0, newCap: 0, cap: 0 });
    expect(exitSupportCaps(exitTermsRow({ old_contract_deposit_paid: null }), 1, 0).oldCap).toBe(0);
  });

  it('lý do từ chối nói đúng trần bị vượt; đúng bằng trần thì hợp lệ', () => {
    const caps = exitSupportCaps(exitTermsRow(), 4_000_000, 1_000_000);
    expect(exitSupportError(2_000_000, caps)).toBeNull();
    expect(exitSupportError(0, caps)).toBeNull();
    expect(exitSupportError(2_000_001, caps)).toMatch(/Vượt cọc cũ đã thu sau khi trừ phí môi giới \(tối đa 2\.000\.000 đ\)/);
    const tight = exitSupportCaps(exitTermsRow(), 1_500_000, 1_000_000);
    expect(exitSupportError(600_000, tight)).toMatch(/Vượt phần cọc còn thiếu của hợp đồng mới \(tối đa 500\.000 đ\)/);
    expect(exitSupportError(-1, caps)).toMatch(/không hợp lệ/);
    expect(exitSupportError(1.005, caps)).toMatch(/không hợp lệ/);
    expect(exitSupportError(Number.NaN, caps)).toMatch(/không hợp lệ/);
  });
});

describe('hồ sơ nào nhận số hỗ trợ', () => {
  it('chọn hồ sơ chờ nối cũ nhất của trường hợp nhờ sale / tự tìm (như trigger tự nối)', () => {
    const older = exitTermsRow({ exit_case_id: '10000000-0000-4000-8000-0000000000a1', created_at: '2026-11-20T00:00:00Z' });
    const newer = exitTermsRow({ exit_case_id: '10000000-0000-4000-8000-0000000000a2', created_at: '2026-11-22T00:00:00Z' });
    expect(pendingExitHold([newer, older])?.exit_case_id).toBe(older.exit_case_id);
    expect(pendingExitHold([exitTermsRow({ early_reason: 'LANDLORD_AGREEMENT', sale_name: null, hold_until: null })])).toBeUndefined();
    expect(pendingExitHold([linkedExitTermsRow()])).toBeUndefined();
    expect(pendingExitHold(undefined)).toBeUndefined();
  });

  it('chỉ nối khi hợp đồng mới bắt đầu từ ngày khách cũ trả phòng', () => {
    const terms = exitTermsRow();
    expect(exitHoldLinksStart(terms, '2026-12-01')).toBe(true);
    expect(exitHoldLinksStart(terms, '2026-12-05')).toBe(true);
    expect(exitHoldLinksStart(terms, '2026-11-30')).toBe(false);
    expect(exitHoldLinksStart(terms, '')).toBe(false);
    expect(exitHoldLinksStart(terms, null)).toBe(false);
  });
});

describe('quyết toán và đảo', () => {
  it('ghi chú quyết toán nêu số hỗ trợ, hợp đồng mới và mã phiếu; không có số hỗ trợ thì không ghi', () => {
    expect(exitSupportSettlementNote(linkedExitTermsRow({ support_amount: 1_500_000, support_out_code: 'PC1', support_in_code: 'PT2' })))
      .toBe('Khách cũ hỗ trợ khách nhận phòng 1.500.000đ: đã cấn sang cọc hợp đồng mới HD-0202 (phiếu PC1 / PT2).');
    expect(exitSupportSettlementNote(linkedExitTermsRow())).toBeNull();
  });

  it('đảo: kiểm dạng, gửi đúng tham số; chỉ hồ sơ còn chờ quyết toán mới đảo được', async () => {
    const invoke = vi.fn<ExitEarlyTermsInvoker>().mockResolvedValue({ data: linkedExitTermsRow({ version: 4 }), error: null });
    await reverseExitSupport(invoke, { caseId: ID.exitCase, expectedVersion: 3, requestId, reason: ' Khách nhận huỷ ' }, ID.org);
    expect(invoke).toHaveBeenCalledWith('reverse_contract_exit_support_v1', { p_organization_id: ID.org, p_exit_case_id: ID.exitCase,
      p_expected_version: 3, p_request_id: requestId, p_reason: 'Khách nhận huỷ' });
    await expect(reverseExitSupport(invoke, { caseId: ID.exitCase, expectedVersion: 3, requestId, reason: '  ' }, ID.org)).rejects.toThrow(/lý do/);
    const failing = vi.fn<ExitEarlyTermsInvoker>().mockResolvedValue({ data: null, error: { code: '55000', message: 'đã quyết toán' } });
    await expect(reverseExitSupport(failing, { caseId: ID.exitCase, expectedVersion: 3, requestId, reason: 'x' }, ID.org)).rejects.toMatchObject({ code: '55000' });
    expect(canReverseExitSupport(linkedExitTermsRow({ support_amount: 1 }))).toBe(true);
    expect(canReverseExitSupport(linkedExitTermsRow({ support_amount: 1, exit_state: 'FINALIZED' }))).toBe(false);
    expect(canReverseExitSupport(linkedExitTermsRow())).toBe(false);
  });
});
