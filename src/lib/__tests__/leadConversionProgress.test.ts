// @vitest-environment jsdom
// Đợt 7: dấu `lead-conversion` của luồng chuyển khách hẹn BẢN TRƯỚC (khách thuê → phiếu cọc → khách hẹn). Luồng hiện hành
// không ghi dấu này nữa; dấu cũ được kết luận một lần, không chạy lại bước ghi nào, không chặn mãi.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLeadConversionTrace, readLeadConversionTrace, resolveLegacyLeadConversion, type LeadConversionTrace } from '../leadConversionProgress';
import type { FinancialPendingRecord } from '../financialPending';

const LEAD = 'lead-1';
const pending = (over: Partial<FinancialPendingRecord> = {}): FinancialPendingRecord => ({
  namespace: 'lead-conversion', userId: 'actor', organizationId: 'org-a', businessKey: LEAD,
  attemptId: 'legacy-attempt', requestKey: 'legacy-attempt', completedIds: [], startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), ...over,
});
const trace = (value: Partial<LeadConversionTrace>) => localStorage.setItem('ihome:lead-conversion-trace:v1:legacy-attempt', JSON.stringify({ leadId: LEAD, stage: 'tenant', canResume: true, ...value }));
const ports = () => ({ readDeposit: vi.fn(async (id: string) => ({ id })), findDeposits: vi.fn(async () => [] as string[]) });
beforeEach(() => localStorage.clear());

describe('dấu chuyển khách hẹn bản trước', () => {
  it('phiếu cọc đã nhận mã ở lần trước và đọc thấy: chỉ còn bước đánh dấu khách hẹn, không tạo phiếu khác', async () => {
    trace({ stage: 'lead', tenantId: 'tenant-1', depositId: 'deposit-1', canResume: true });
    const io = ports();
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1', 'deposit-1'] }), LEAD, io)).resolves.toEqual({ kind: 'deposit', depositId: 'deposit-1', exact: true });
    expect(io.findDeposits).not.toHaveBeenCalled();
  });

  it('bước tạo phiếu chưa bắt đầu (lệnh không tới máy chủ ở bước khách thuê): chưa có tiền ⇒ gỡ dấu, làm như bình thường', async () => {
    trace({ stage: 'tenant', canResume: false });
    await expect(resolveLegacyLeadConversion(pending(), LEAD, ports())).resolves.toEqual({ kind: 'clear' });
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: true });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, ports())).resolves.toEqual({ kind: 'clear' });
  });

  it('phiếu cọc đã gửi mà mất phản hồi: tra gần đúng theo khách thuê, thấy thì chỉ báo «có thể» (mới nhất trước), không tự tạo', async () => {
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: false });
    const io = ports();io.findDeposits.mockResolvedValue(['deposit-new', 'deposit-old']);
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, io)).resolves.toEqual({ kind: 'deposit', depositId: 'deposit-new', exact: false });
    expect(io.findDeposits).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ attemptId: 'legacy-attempt' }));
  });

  it('phiếu cọc đã gửi, tra không thấy phiếu nào và lần gửi đã kết thúc: lần trước chưa ghi ⇒ gỡ dấu', async () => {
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: false });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, ports())).resolves.toEqual({ kind: 'clear' });
  });

  it('dấu chưa đủ 2 phút: chưa kết luận «chưa ghi» được ⇒ chặn (hộp cảnh báo)', async () => {
    trace({ stage: 'tenant', canResume: false });
    await expect(resolveLegacyLeadConversion(pending({ startedAt: new Date().toISOString() }), LEAD, ports())).resolves.toEqual({ kind: 'block' });
  });

  it('không có vết, vết của khách hẹn khác, mã phiếu không nằm trong dấu, hay phiếu không còn: chặn, không đoán', async () => {
    await expect(resolveLegacyLeadConversion(pending(), LEAD, ports())).resolves.toEqual({ kind: 'block' });
    trace({ leadId: 'lead-other', stage: 'tenant' });
    await expect(resolveLegacyLeadConversion(pending(), LEAD, ports())).resolves.toEqual({ kind: 'block' });
    trace({ stage: 'lead', tenantId: 'tenant-1', depositId: 'deposit-1' });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, ports())).resolves.toEqual({ kind: 'block' });
    const io = ports();io.readDeposit.mockResolvedValue(null as unknown as { id: string });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1', 'deposit-1'] }), LEAD, io)).resolves.toEqual({ kind: 'block' });
  });

  it('đọc máy chủ hỏng thì ném (nơi gọi giữ dấu)', async () => {
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: false });
    const io = ports();io.findDeposits.mockRejectedValue({ code: '42501' });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, io)).rejects.toMatchObject({ code: '42501' });
  });

  it('vết hỏng không chứng minh được gì; gỡ vết không ném', () => {
    localStorage.setItem('ihome:lead-conversion-trace:v1:legacy-attempt', '{không phải json');
    expect(readLeadConversionTrace('legacy-attempt')).toBeNull();
    forgetLeadConversionTrace('legacy-attempt');
    expect(localStorage.getItem('ihome:lead-conversion-trace:v1:legacy-attempt')).toBeNull();
  });
});
