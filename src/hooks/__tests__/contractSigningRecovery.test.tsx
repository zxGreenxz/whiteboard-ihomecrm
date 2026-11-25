// @vitest-environment jsdom
// Đợt 7: ký hợp đồng từ nháp (cách B). Máy chủ giả dựng theo thân hàm production 26/11/2026:
// sign_and_checkin_contract_draft_v1 khoá phòng FOR UPDATE + khoá công ty + bản nháp FOR UPDATE, rồi tra lần ký THEO BẢN NHÁP
// (contract_draft_signings_draft_id_key): cùng nội dung ⇒ trả lần ký cũ (kể cả mã yêu cầu khác); khác nội dung ⇒ 23505.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ sign: vi.fn(), read: vi.fn(), signing: null as null | Record<string, unknown>, writes: 0, hideRead: 0 }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: vi.fn(), useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/contractSigningApi', () => ({ signAndCheckinDraft: h.sign, readContractDraftSigning: h.read, getOrCreateSignedContractDocument: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { useContractSigning } from '../contracts/useContractSigning';
import type { ContractSigningInput } from '@/lib/contractSigning';

const id = '11111111-1111-4111-8111-111111111111';
const NETWORK = () => new TypeError('Failed to fetch');
const input: ContractSigningInput = { source: { draftId: id, revision: 1, documentId: id, documentSha256: 'a'.repeat(64) }, requestId: id, receivedOn: '2026-09-28', roomReady: true, termsConfirmed: true, boundary: { state: 'VERIFIED', readings: [] }, creationOptions: {} };
const row = (requestId: string, receivedOn: string) => ({ id, organization_id: id, building_id: id, room_id: id, draft_id: id, revision: 1, document_id: id, document_sha256: 'a'.repeat(64), template_sha256: 'b'.repeat(64), template_path: 'template', template_snapshot: { id, name: 'Mẫu', updated_at: '2026-09-28' }, document_data: {}, terms: {}, party_snapshot: [], creation_options: {}, received_on: receivedOn, contract_id: id, contract_number: 'HD-01', request_id: requestId, signed_by: id, signed_at: '2026-09-28', official_document_path: 'signed', official_document_sha256: null });
type Mutation = { mutationFn: (input?: ContractSigningInput) => Promise<{ request_id: string }>; pendingRequestId: string | null; onError: (error: unknown, input?: ContractSigningInput) => void };
const sign = (value?: ContractSigningInput) => renderHook(() => useContractSigning(id, id) as unknown as Mutation).result.current.mutationFn(value);
const pendingKeys = () => Object.keys(localStorage).filter(key => key.startsWith('ihome:financial-pending:v1:'));
const signKeys = () => h.sign.mock.calls.map(call => (call[1] as ContractSigningInput).requestId);
/** Máy chủ giả: một lần ký mỗi bản nháp; băm nội dung (ở đây: ngày nhận). */
function install(failure?: 'drop-before' | 'drop-after') {
  let next = failure;
  h.sign.mockImplementation(async (_org: string, args: ContractSigningInput) => {
    const mode = next; next = undefined;
    if (mode === 'drop-before') throw NETWORK();
    if (h.signing) {
      if (h.signing.received_on !== args.receivedOn) throw { code: '23505', message: 'Định danh ký hoặc bản nháp đã dùng với nội dung khác' };
      return h.signing;
    }
    h.writes += 1; h.signing = row(args.requestId, args.receivedOn);
    if (mode === 'drop-after') throw NETWORK();
    return h.signing;
  });
  h.read.mockImplementation(async () => ({ server_today: '2026-09-28', signing: h.hideRead > 0 ? (h.hideRead -= 1, null) : h.signing }));
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', id); vi.clearAllMocks(); h.signing = null; h.writes = 0; h.hideRead = 0; });
afterEach(cleanup);

describe('ký hợp đồng từ nháp (cách B)', () => {
  it('lệnh không tới máy chủ: chưa có lần ký của nháp ⇒ lần bấm sau gửi lại ngay ĐÚNG mã cũ, ký một lần', async () => {
    install('drop-before');
    await expect(sign(input)).rejects.toThrow();
    await expect(sign(input)).resolves.toMatchObject({ contract_number: 'HD-01' });
    expect(signKeys()).toHaveLength(2);
    expect(new Set(signKeys()).size).toBe(1);
    expect(h.writes).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: đọc thấy lần ký đúng mã ⇒ trả kết quả, không gửi lần hai', async () => {
    install('drop-after');
    await expect(sign(input)).rejects.toThrow();
    await expect(sign(input)).resolves.toMatchObject({ request_id: signKeys()[0] });
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.writes).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn (bản trước, không tên thao tác), chưa có lần ký: gửi lại đúng mã của dấu', async () => {
    install();
    const key = 'ihome:financial-pending:v1:' + ['contract-signing', 'actor1', id, id].map(encodeURIComponent).join(':');
    const legacy = '22222222-2222-4222-8222-222222222222';
    localStorage.setItem(key, JSON.stringify({ namespace: 'contract-signing', userId: 'actor1', organizationId: id, businessKey: id, attemptId: legacy, requestKey: legacy, completedIds: [], startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await expect(sign(input)).resolves.toMatchObject({ request_id: legacy });
    expect(signKeys()).toEqual([legacy]);
    expect(pendingKeys()).toEqual([]);
  });

  it('bản nháp đã được ký bởi một lần gửi khác: báo đã ký kèm mã hợp đồng, gỡ dấu, không gửi', async () => {
    install('drop-before');
    await expect(sign(input)).rejects.toThrow();
    h.signing = row('33333333-3333-4333-8333-333333333333', '2026-09-28');
    await expect(sign(input)).rejects.toMatchObject({ alreadyRecorded: true, recordIds: [id], message: expect.stringContaining('HD-01') });
    expect(h.sign).toHaveBeenCalledOnce();
    expect(pendingKeys()).toEqual([]);
  });

  it('lệnh cũ ký xong ngay sau lần đọc đối chiếu, lần này đổi nội dung: 23505 ⇒ đọc lại, báo đã ký, không ký hai lần', async () => {
    install('drop-after');
    await expect(sign(input)).rejects.toThrow();
    h.hideRead = 1;
    await expect(sign({ ...input, receivedOn: '2026-09-27' })).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('HD-01') });
    expect(h.writes).toBe(1);
    expect(new Set(signKeys()).size).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('đối chiếu chỉ đọc khi chưa có lần ký: báo rõ, gỡ dấu (máy chủ chỉ cho một lần ký mỗi nháp), nút ký không còn chờ', async () => {
    install('drop-before');
    const hook = renderHook(() => useContractSigning(id, id) as unknown as Mutation);
    await act(async () => { const error = await hook.result.current.mutationFn(input).catch((cause: unknown) => cause); hook.result.current.onError(error, input); });
    expect(hook.result.current.pendingRequestId).toBeTruthy();
    await act(async () => { const error = await hook.result.current.mutationFn().catch((cause: unknown) => cause); expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('Chưa thấy lần ký') }); hook.result.current.onError(error); });
    expect(hook.result.current.pendingRequestId).toBeNull();
    expect(pendingKeys()).toEqual([]);
    expect(h.sign).toHaveBeenCalledOnce();
  });

  it('đọc lần ký hỏng: chưa kết luận được ⇒ giữ dấu, không gửi lại', async () => {
    install('drop-before');
    await expect(sign(input)).rejects.toThrow();
    h.read.mockRejectedValueOnce(NETWORK());
    await expect(sign(input)).rejects.toThrow(/đối chiếu/);
    expect(h.sign).toHaveBeenCalledOnce();
    expect(pendingKeys()).toHaveLength(1);
  });
});
