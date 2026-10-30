import { describe, expect, it, vi } from 'vitest';
import {
  discardExitSettlementDraft, ExitSettlementDraftTooLargeError, exitSettlementDraftErrorMessage, getExitSettlementDraft, listExitSettlementDrafts, saveExitSettlementDraft,
  type ExitSettlementDraftPayload, type ExitSettlementDraftRpcInvoker,
} from '@/lib/contractExitSettlementDrafts';

const org = '00000000-0000-4000-8000-000000000001';
const caseId = '00000000-0000-4000-8000-000000000010';
const actor = '00000000-0000-4000-8000-000000000002';
const payload: ExitSettlementDraftPayload = {
  schema: 1, kind: 'EARLY_RETURN', changeReason: '',
  extra: { fromDate: '', toDate: '2026-10-03', proratedAmount: 0, proratedTouched: false, cleaningAmount: 200_000, customRows: [], meter: null },
  refund: { fromDate: '2026-10-04', toDate: '2026-10-31', proratedAmount: 3_948_000, proratedTouched: false, customRows: [] },
  moveOut: { depositRefund: 4_000_000, excessRent: 0, notes: '', shortfallMode: 'PAID', receiptAccountId: '' },
};
const row = (value: unknown) => ({ case_id: caseId, case_version: 2, version: 3, payload: value, created_at: '2026-10-30T03:00:00Z', created_by: actor,
  updated_at: '2026-10-30T03:45:00Z', updated_by: actor, updated_by_name: 'Người A' });
const invoker = (data: unknown, error: { code?: string; message?: string } | null = null) => vi.fn<ExitSettlementDraftRpcInvoker>(async () => ({ data, error }));

describe('nháp quyết toán ở biên RPC', () => {
  it('lưu gửi đúng tham số; tạo mới gửi version NULL', async () => {
    const invoke = invoker(row(payload));
    const draft = await saveExitSettlementDraft(invoke, { caseId, expectedVersion: null, payload }, org);
    expect(invoke).toHaveBeenCalledWith('save_contract_exit_settlement_draft_v1', { p_organization_id: org, p_case_id: caseId, p_expected_version: null, p_payload: payload });
    expect(draft).toEqual({ caseId, version: 3, updatedAt: '2026-10-30T03:45:00Z', updatedByName: 'Người A', payload });
  });
  it('không gửi nháp sai khuôn (số âm, khoá lạ, loại lạ) lên máy chủ', async () => {
    const invoke = invoker(row(payload));
    for (const bad of [{ ...payload, moveOut: { ...payload.moveOut!, depositRefund: -1 } }, { ...payload, extra2: 1 }, { ...payload, kind: 'OTHER' }]) {
      await expect(saveExitSettlementDraft(invoke, { caseId, expectedVersion: 1, payload: bad as ExitSettlementDraftPayload }, org)).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it('nháp quá dài (máy chủ nhận ≤ 32 KB) báo rõ, không gửi lên máy chủ', async () => {
    const invoke = invoker(row(payload));
    const long = { ...payload, changeReason: 'đ'.repeat(4000), moveOut: { ...payload.moveOut!, notes: 'ữ'.repeat(8000) } };
    const error = await saveExitSettlementDraft(invoke, { caseId, expectedVersion: null, payload: long }, org).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExitSettlementDraftTooLargeError);
    expect(exitSettlementDraftErrorMessage(error)).toContain('Nháp quá dài');
    expect(invoke).not.toHaveBeenCalled();
    await saveExitSettlementDraft(invoke, { caseId, expectedVersion: null, payload: { ...payload, moveOut: { ...payload.moveOut!, notes: 'ữ'.repeat(8000) } } }, org);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('nháp khuôn cũ/khác vẫn đọc được version để ghi đè hoặc bỏ, nội dung là null', async () => {
    expect(await getExitSettlementDraft(invoker(row({ schema: 99 })), caseId, org)).toMatchObject({ version: 3, payload: null });
    expect(await getExitSettlementDraft(invoker(null), caseId, org)).toBeNull();
  });
  it('danh sách chỉ lấy dấu hiệu, tối đa 100 hồ sơ', async () => {
    const invoke = invoker([{ case_id: caseId, version: 2, updated_at: '2026-10-30T03:45:00Z', updated_by: actor, updated_by_name: null }]);
    expect(await listExitSettlementDrafts(invoke, [caseId], org)).toEqual([{ caseId, version: 2, updatedAt: '2026-10-30T03:45:00Z', updatedByName: null }]);
    await expect(listExitSettlementDrafts(invoke, Array.from({ length: 101 }, () => caseId), org)).rejects.toThrow();
  });
  it('bỏ nháp bắt buộc version; lỗi máy chủ được ném ra', async () => {
    const invoke = invoker({ case_id: caseId, discarded: true });
    await discardExitSettlementDraft(invoke, { caseId, expectedVersion: 4 }, org);
    expect(invoke).toHaveBeenCalledWith('discard_contract_exit_settlement_draft_v1', { p_organization_id: org, p_case_id: caseId, p_expected_version: 4 });
    await expect(discardExitSettlementDraft(invoker(null, { code: 'PT409' }), { caseId, expectedVersion: 4 }, org)).rejects.toMatchObject({ code: 'PT409' });
  });
  it('câu báo lỗi phân biệt người khác vừa lưu, thiếu quyền, nháp không hợp lệ', () => {
    expect(exitSettlementDraftErrorMessage({ code: 'PT409' })).toContain('người khác lưu');
    expect(exitSettlementDraftErrorMessage({ code: '42501' })).toContain('không có quyền');
    expect(exitSettlementDraftErrorMessage({ code: '22023' })).toContain('không hợp lệ');
  });
});
