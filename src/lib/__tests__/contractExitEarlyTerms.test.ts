import { describe, expect, it, vi } from 'vitest';
import {
  brokerFeeLine, contractNumberLabel, createExitCommission, exitEarlyTermsErrorMessage, extendExitHold, needsExitCommission, readExitEarlyTerms,
  refundFromHandoverDate, reopenExitHold, setExitEarlyTerms, updateExitBrokerFee, withBrokerFeeLine,
  type ExitEarlyTermsInvoker,
} from '@/lib/contractExitEarlyTerms';
import { exitTermsRow, linkedExitTermsRow, EXIT_FIXTURE_IDS as ID } from '@/components/contracts/__tests__/exitEarlyTermsFixture';

const requestId = '20000000-0000-4000-8000-000000000001';
const ok = (data: unknown) => vi.fn<ExitEarlyTermsInvoker>().mockResolvedValue({ data, error: null });

it('nhãn số hợp đồng: số đã có tiền tố HD/HĐ thì không thêm "HĐ" lần nữa', () => {
  expect(contractNumberLabel('HD-2026-00419')).toBe('HD-2026-00419');
  expect(contractNumberLabel(' HĐ-12 ')).toBe('HĐ-12');
  expect(contractNumberLabel('2026/07')).toBe('HĐ 2026/07');
  expect(contractNumberLabel('HDTEST')).toBe('HĐ HDTEST');
  expect(contractNumberLabel(null)).toBe('HĐ');
});

describe('lớp gọi RPC trường hợp trả phòng trước hạn', () => {
  it('đọc theo đúng một bộ lọc và kiểm dạng kết quả', async () => {
    const invoke = ok([exitTermsRow()]);
    expect(await readExitEarlyTerms(invoke, { roomId: ID.room }, ID.org)).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('read_contract_exit_early_terms_v1', { p_organization_id: ID.org, p_contract_id: null, p_exit_case_id: null, p_room_id: ID.room });
    await expect(readExitEarlyTerms(ok([{ ...exitTermsRow(), early_reason: 'OTHER' }]), { exitCaseId: ID.exitCase }, ID.org)).rejects.toThrow();
    await expect(readExitEarlyTerms(invoke, { roomId: 'khong-phai-uuid' }, ID.org)).rejects.toThrow();
  });
  it('đổi trường hợp: nhờ sale bắt tên sale, trường hợp khác bỏ tên sale, bắt lý do', async () => {
    const invoke = ok(exitTermsRow());
    await setExitEarlyTerms(invoke, { caseId: ID.exitCase, expectedVersion: 0, requestId, earlyReason: 'SELF_FOUND', saleName: 'Minh', reason: ' Phân loại ' }, ID.org);
    expect(invoke).toHaveBeenCalledWith('set_contract_exit_early_terms_v1', expect.objectContaining({ p_expected_version: 0, p_early_reason: 'SELF_FOUND', p_sale_name: null, p_reason: 'Phân loại' }));
    await expect(setExitEarlyTerms(invoke, { caseId: ID.exitCase, expectedVersion: 1, requestId, earlyReason: 'SALE_ASSISTED', saleName: ' ', reason: 'x' }, ID.org)).rejects.toThrow(/tên sale/);
    await expect(setExitEarlyTerms(invoke, { caseId: ID.exitCase, expectedVersion: 1, requestId, earlyReason: 'LANDLORD_AGREEMENT', reason: ' ' }, ID.org)).rejects.toThrow();
  });
  it('sửa phí, mở bán lại, giữ tiếp, lập phiếu hoa hồng dựng đúng tham số', async () => {
    const invoke = ok(exitTermsRow());
    await updateExitBrokerFee(invoke, { caseId: ID.exitCase, expectedVersion: 2, requestId, brokerFee: 0, reason: 'Sale nhận trực tiếp' }, ID.org);
    expect(invoke).toHaveBeenLastCalledWith('update_contract_exit_broker_fee_v1', expect.objectContaining({ p_broker_fee: 0, p_expected_version: 2 }));
    await expect(updateExitBrokerFee(invoke, { caseId: ID.exitCase, expectedVersion: 2, requestId, brokerFee: -1, reason: 'x' }, ID.org)).rejects.toThrow();
    await reopenExitHold(invoke, { caseId: ID.exitCase, expectedVersion: 3, requestId, reason: '  ' }, ID.org);
    expect(invoke).toHaveBeenLastCalledWith('reopen_contract_exit_hold_v1', expect.objectContaining({ p_reason: null }));
    await extendExitHold(invoke, { caseId: ID.exitCase, expectedVersion: 3, requestId }, ID.org);
    expect(invoke).toHaveBeenLastCalledWith('extend_contract_exit_hold_v1', expect.objectContaining({ p_days: 3 }));
    await expect(extendExitHold(invoke, { caseId: ID.exitCase, expectedVersion: 3, requestId, days: 31 }, ID.org)).rejects.toThrow();
    await createExitCommission(invoke, { caseId: ID.exitCase, expectedVersion: 4, requestId, accountId: null, recipientBank: ' VCB ', recipientAccount: '' }, ID.org);
    expect(invoke).toHaveBeenLastCalledWith('create_contract_exit_commission_v1', expect.objectContaining({ p_recipient_bank: 'VCB', p_recipient_account: null, p_account_id: null }));
  });
  it('lỗi quyền, lỗi kiểm tra, lỗi phiên bản và luật nghiệp vụ có câu khác nhau', () => {
    const messages = ['42501', '22023', 'PT409', '55000'].map(code => exitEarlyTermsErrorMessage({ code, message: 'Câu máy chủ' }));
    expect(new Set(messages).size).toBe(4);
    expect(messages[0]).toMatch(/không có quyền/);
    expect(messages[1]).toMatch(/Dữ liệu chưa hợp lệ: Câu máy chủ/);
    expect(messages[2]).toMatch(/Tải lại/);
    expect(messages[3]).toBe('Câu máy chủ');
  });
});

describe('quy tắc hiển thị quyết toán', () => {
  it('dòng phí môi giới đúng một dòng BROKER_FEE theo hồ sơ; người dùng không tự thêm được', () => {
    const line = brokerFeeLine(exitTermsRow());
    expect(line).toEqual({ kind: 'BROKER_FEE', description: 'Phí môi giới (50% cọc cũ)', amount: 2_000_000 });
    expect(brokerFeeLine(exitTermsRow({ broker_fee: 1_500_000 }))?.description).toBe('Phí môi giới sang nhượng phòng');
    expect(brokerFeeLine(exitTermsRow({ broker_fee: 0 }))).toBeNull();
    expect(brokerFeeLine(exitTermsRow({ early_reason: 'SELF_FOUND', broker_fee: 0, sale_name: null }))).toBeNull();
    const manual = [{ kind: 'CUSTOM' as const, description: 'Vệ sinh', amount: 200_000 }, { kind: 'BROKER_FEE' as const, description: 'tự thêm', amount: 1 }];
    expect(withBrokerFeeLine(manual, line)).toEqual([manual[0], line]);
    expect(withBrokerFeeLine(manual, null)).toEqual([manual[0]]);
  });
  it('hoàn tiền phòng từ chính ngày bàn giao khi hợp đồng mới tính tiền từ ngày đó', () => {
    expect(refundFromHandoverDate(linkedExitTermsRow({ new_contract_billing_start: '2026-12-01' }))).toBe(true);
    expect(refundFromHandoverDate(linkedExitTermsRow({ new_contract_billing_start: '2026-12-02' }))).toBe(false);
    expect(refundFromHandoverDate(exitTermsRow({ early_reason: 'LANDLORD_AGREEMENT', new_contract_billing_start: '2026-12-01' }))).toBe(false);
  });
  it('nhắc lập phiếu hoa hồng chỉ khi nhờ sale đã quyết toán, có phí, có hợp đồng mới và chưa có phiếu', () => {
    const done = linkedExitTermsRow({ exit_state: 'FINALIZED' });
    expect(needsExitCommission(done)).toBe(true);
    expect(needsExitCommission({ ...done, commission_voucher_id: ID.newContract })).toBe(false);
    expect(needsExitCommission({ ...done, broker_fee: 0 })).toBe(false);
    expect(needsExitCommission({ ...done, exit_state: 'PENDING' })).toBe(false);
    expect(needsExitCommission({ ...done, early_reason: 'SELF_FOUND' })).toBe(false);
  });
});
