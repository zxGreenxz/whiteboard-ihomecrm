// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '../types';
import type { FinancePostingInput } from '../financeV2Mutations';

const h = vi.hoisted(() => ({ rpc: vi.fn(), download: vi.fn(), upload: vi.fn(), storage: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc, storage: { from: h.storage } } }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options, useQuery: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { createQuickExpenseBatchEvidenceSession, prepareQuickExpenseBatchEvidence, useApproveAndPostIncomeExpenseV2 } from '../financeV2Mutations';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { quickExpenseAttachmentKeys, runQuickExpenseQueue } from '@/lib/quickExpenseQueue';

const origin = 'https://evidence-test.supabase.co';
const bucket = 'income-expense-attachments';
const path = 'actor/shared.png';
const url = `${origin}/storage/v1/object/public/${bucket}/${path}`;
const bytes = new Uint8Array([137, 80, 78, 71, 0, 1, 254, 255]);
const voucher = (attachments = [url], id = 'voucher-1') => ({ id, organization_id: 'org', attachments } as IncomeExpenseWithRelations);
const adopted = (skipped = [{ url, reason: 'ATTACHED' }], evidence_ids: string[] = []) => ({ data: { evidence_ids, skipped }, error: null });
const blobBytes = (blob: Blob) => new Promise<number[]>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});
function postingInput(id: string, evidenceIds: string[]): FinancePostingInput {
  return { subjectKind: 'VOUCHER', subjectId: id, organizationId: 'org', cashbookId: 'cashbook',
    postedOn: '2026-10-20', evidenceIds, expectedExecutionRevision: 1,
    expectedApprovalVersion: 1, expectedPostingVersion: 1, idempotencyKey: id };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', origin);
  localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org');
  h.storage.mockImplementation(() => ({ download: h.download, upload: h.upload }));
  h.download.mockResolvedValue({ data: new Blob([bytes], { type: 'image/png' }), error: null });
  h.upload.mockImplementation(async (objectName: string) => ({ data: { path: objectName }, error: null }));
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'adopt_voucher_attachments_as_evidence_v2') return adopted();
    if (fn === 'create_finance_evidence_upload_intent_v2') return { data: { evidence_id: 'copy-1', bucket_id: bucket, object_name: 'v2/org/actor/copy-1' }, error: null };
    if (fn === 'finalize_finance_evidence_v2') return { data: { evidence_id: 'copy-1', state: 'FINALIZED' }, error: null };
    throw new Error(`Unexpected RPC ${fn}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Chứng từ dùng chung trong chi nhanh phiếu tổng', () => {
  it('13 phiếu dùng chung ảnh chạy tối đa 3 phiếu đồng thời, tải nguồn một lần và giữ evidence riêng', async () => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    let consumed = false;
    let created = 0;
    let writing = 0;
    let peak = 0;
    const attached = new Set<string>();
    const written: string[][] = [];
    h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'adopt_voucher_attachments_as_evidence_v2') return consumed ? adopted() : adopted([], ['original']);
      if (fn === 'create_finance_evidence_upload_intent_v2') {
        const id = `copy-${++created}`;
        return { data: { evidence_id: id, bucket_id: bucket, object_name: `v2/org/actor/${id}` }, error: null };
      }
      if (fn === 'finalize_finance_evidence_v2') return { data: { evidence_id: args.p_evidence_id, state: 'FINALIZED' }, error: null };
      if (fn === 'approve_and_post_income_expense_v2') {
        const input = args.input as FinancePostingInput;
        for (const id of input.evidenceIds) {
          if (attached.has(id)) return { data: null, error: { code: '55000', message: 'Evidence must be FINALIZED' } };
          attached.add(id);
        }
        writing++;
        peak = Math.max(peak, writing);
        await new Promise(resolve => setTimeout(resolve, 5));
        written.push(input.evidenceIds);
        consumed = true;
        writing--;
        return { data: { voucherId: input.subjectId, approvalStatus: 'APPROVED', postingStatus: 'POSTED' }, error: null };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });
    const writer = renderHook(() => useApproveAndPostIncomeExpenseV2({ deferFeedback: true })).result.current as unknown as {
      mutationFn: (input: FinancePostingInput) => Promise<unknown>;
    };
    await runQuickExpenseQueue(Array.from({ length: 13 }, (_, index) => voucher([url], `voucher-${index}`)), {
      concurrency: 3, attachmentKeys: quickExpenseAttachmentKeys, shouldStop: () => false,
      skip: () => { throw new Error('Unexpected skipped voucher'); },
      run: async row => {
        await writer.mutationFn(postingInput(row.id, (await prepare(row)).evidenceIds));
        return true;
      },
    });
    expect(peak).toBe(3);
    expect(h.download).toHaveBeenCalledExactlyOnceWith(path);
    expect(h.upload).toHaveBeenCalledTimes(12);
    expect(h.rpc.mock.calls.filter(([fn]) => fn === 'adopt_voucher_attachments_as_evidence_v2')).toHaveLength(13);
    expect(h.rpc.mock.calls.filter(([fn]) => fn === 'create_finance_evidence_upload_intent_v2')).toHaveLength(12);
    expect(h.rpc.mock.calls.filter(([fn]) => fn === 'finalize_finance_evidence_v2')).toHaveLength(12);
    expect(written.flat()).toEqual(['original', ...Array.from({ length: 12 }, (_, i) => `copy-${i + 1}`)]);
    for (const [, file] of h.upload.mock.calls) {
      expect((file as File).type).toBe('image/png');
      expect(await blobBytes(file as File)).toEqual([...bytes]);
    }
  });

  it('cache tách theo tổ chức, URL chính xác và lần chạy; phiên sau đọc lại bytes mới', async () => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    await prepare(voucher());
    await prepare({ ...voucher(), organization_id: 'other-org' });
    expect(h.download).toHaveBeenCalledTimes(2);
    const otherUrl = `${url}?version=2`;
    h.rpc.mockResolvedValueOnce(adopted([{ url: otherUrl, reason: 'ATTACHED' }]));
    await prepare(voucher([otherUrl]));
    expect(h.download).toHaveBeenCalledTimes(3);
    const newBytes = new Uint8Array([7, 8, 9]);
    h.download.mockResolvedValue({ data: new Blob([newBytes], { type: 'image/png' }), error: null });
    await createQuickExpenseBatchEvidenceSession()(voucher());
    expect(h.download).toHaveBeenCalledTimes(4);
    expect(await blobBytes(h.upload.mock.lastCall![1] as File)).toEqual([...newBytes]);
  });

  it.each(['QUARANTINED', 'FILE_THUOC_TO_CHUC_KHAC', 'FILE_KHONG_CON_TRONG_STORAGE'])('có cache vẫn từ chối adoption mới trả %s', async reason => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    await prepare(voucher());
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => fn === 'adopt_voucher_attachments_as_evidence_v2'
      ? Promise.resolve(adopted([{ url, reason }])) : original(fn, args));
    await expect(prepare(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.rpc.mock.calls.filter(([fn]) => fn === 'adopt_voucher_attachments_as_evidence_v2')).toHaveLength(2);
    expect(h.download).toHaveBeenCalledOnce();
    expect(h.upload).toHaveBeenCalledOnce();
  });

  it('cache không vượt qua lỗi quyền hoặc nguồn ngoài snapshot trong lần chuẩn bị sau', async () => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    await prepare(voucher());
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => fn === 'adopt_voucher_attachments_as_evidence_v2'
      ? Promise.resolve({ data: null, error: { code: '42501', message: 'Denied' } }) : original(fn, args));
    await expect(prepare(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    h.rpc.mockImplementation(original);
    await expect(prepare(voucher([`${url}?changed`]))).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.upload).toHaveBeenCalledOnce();
  });

  it('kiểm toàn bộ URL trước khi dùng cache, không tải hay upload khi URL sau bị sai', async () => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    await prepare(voucher());
    const invalidUrl = url.replace(origin, 'https://another-project.supabase.co');
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => fn === 'adopt_voucher_attachments_as_evidence_v2'
      ? Promise.resolve(adopted([{ url, reason: 'ATTACHED' }, { url: invalidUrl, reason: 'ATTACHED' }])) : original(fn, args));
    await expect(prepare(voucher([url, invalidUrl]))).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.download).toHaveBeenCalledOnce();
    expect(h.upload).toHaveBeenCalledOnce();
  });

  it('download lỗi không được cache; lỗi upload xoá bytes để retry đọc lại', async () => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    h.download.mockResolvedValueOnce({ data: null, error: { message: 'Download failed' } });
    await expect(prepare(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    h.upload.mockResolvedValueOnce({ data: null, error: { message: 'Upload failed' } });
    await expect(prepare(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    await prepare(voucher());
    expect(h.download).toHaveBeenCalledTimes(3);
    expect(h.upload).toHaveBeenCalledTimes(2);
  });

  it('cache không giữ hơn 20 MiB trong một lần chạy', async () => {
    const prepare = createQuickExpenseBatchEvidenceSession();
    h.download.mockResolvedValue({ data: new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'image/png' }), error: null });
    const prepareUrl = async (index: number) => {
      const nextUrl = url.replace('shared.png', `image-${index}.png`);
      h.rpc.mockResolvedValueOnce(adopted([{ url: nextUrl, reason: 'ATTACHED' }]));
      await prepare(voucher([nextUrl]));
    };
    for (let index = 0; index < 5; index++) await prepareUrl(index);
    await prepareUrl(0);
    await prepareUrl(4);
    expect(h.download).toHaveBeenCalledTimes(6);
    expect(h.upload).toHaveBeenCalledTimes(7);
  });

  it('hai phiếu dùng cùng URL: ghi sổ lần đầu tiêu thụ evidence gốc, lần sau tạo evidence riêng và giữ nguyên bytes', async () => {
    const states = new Map<string, string>([['original', 'FINALIZED']]);
    const written: string[][] = [];
    h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'adopt_voucher_attachments_as_evidence_v2') {
        return states.get('original') === 'FINALIZED' ? adopted([], ['original']) : adopted();
      }
      if (fn === 'create_finance_evidence_upload_intent_v2') {
        expect(args.p_organization_id).toBe('org');
        states.set('copy-1', 'UPLOAD_INTENT');
        return { data: { evidence_id: 'copy-1', bucket_id: bucket, object_name: 'v2/org/actor/copy-1' }, error: null };
      }
      if (fn === 'finalize_finance_evidence_v2') {
        expect(h.upload).toHaveBeenCalledOnce();
        expect(states.get('copy-1')).toBe('UPLOAD_INTENT');
        states.set('copy-1', 'FINALIZED');
        return { data: { evidence_id: 'copy-1', state: 'FINALIZED' }, error: null };
      }
      if (fn === 'approve_and_post_income_expense_v2') {
        const input = args.input as FinancePostingInput;
        for (const id of input.evidenceIds) {
          if (states.get(id) !== 'FINALIZED') return { data: null, error: { code: '55000', message: 'Evidence must be FINALIZED' } };
          states.set(id, 'ATTACHED');
        }
        written.push(input.evidenceIds);
        return { data: { voucherId: input.subjectId, approvalStatus: 'APPROVED', postingStatus: 'POSTED' }, error: null };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    });
    const writer = renderHook(() => useApproveAndPostIncomeExpenseV2({ deferFeedback: true })).result.current as unknown as {
      mutationFn: (input: FinancePostingInput) => Promise<unknown>;
    };
    const first = voucher();
    const second = voucher([url], 'voucher-2');
    await writer.mutationFn(postingInput(first.id, (await prepareQuickExpenseBatchEvidence(first)).evidenceIds));
    expect(states.get('original')).toBe('ATTACHED');
    expect(h.upload).not.toHaveBeenCalled();
    await writer.mutationFn(postingInput(second.id, (await prepareQuickExpenseBatchEvidence(second)).evidenceIds));
    expect(written).toEqual([['original'], ['copy-1']]);
    expect(states.get('original')).toBe('ATTACHED');
    expect(states.get('copy-1')).toBe('ATTACHED');
    expect(h.download).toHaveBeenCalledExactlyOnceWith(path);
    expect(h.storage.mock.calls.every(([name]) => name === bucket)).toBe(true);
    const copiedFile = h.upload.mock.calls[0][1] as File;
    expect(copiedFile.name).toBe('shared.png');
    expect(copiedFile.type).toBe('image/png');
    expect(await blobBytes(copiedFile)).toEqual([...bytes]);
    expect(h.upload.mock.calls[0][2]).toEqual({ contentType: 'image/png', upsert: false });
    expect(first.attachments).toEqual([url]); expect(second.attachments).toEqual([url]);
    expect(h.rpc.mock.calls.some(([fn]) => String(fn).includes('annotate'))).toBe(false);
  });

  it('nhận ATTACHED từ payment-receipts cùng allowlist adoption, tạo evidence mới ở bucket intent', async () => {
    const receiptUrl = url.replace(bucket, 'payment-receipts');
    h.rpc.mockResolvedValueOnce(adopted([{ url: receiptUrl, reason: 'ATTACHED' }]));
    await expect(prepareQuickExpenseBatchEvidence(voucher([receiptUrl]))).resolves.toEqual({ evidenceIds: ['copy-1'], skipped: [] });
    expect(h.storage).toHaveBeenNthCalledWith(1, 'payment-receipts');
    expect(h.storage).toHaveBeenNthCalledWith(2, bucket);
    expect(h.download).toHaveBeenCalledExactlyOnceWith(path);
    expect(await blobBytes(h.upload.mock.calls[0][1] as File)).toEqual([...bytes]);
  });

  it('giữ evidence FINALIZED đã nhận và chỉ sao chép một lần cho URL ATTACHED trùng', async () => {
    h.rpc.mockResolvedValueOnce(adopted([{ url, reason: 'ATTACHED' }, { url, reason: 'ATTACHED' }], ['ready']));
    await expect(prepareQuickExpenseBatchEvidence(voucher())).resolves.toEqual({ evidenceIds: ['ready', 'copy-1'], skipped: [] });
    expect(h.download).toHaveBeenCalledOnce();
  });

  it.each(['QUARANTINED', 'FILE_THUOC_TO_CHUC_KHAC', 'FILE_KHONG_CON_TRONG_STORAGE', 'KHONG_PHAI_FILE_STORAGE', 'attached', 'UNKNOWN'])('không sao chép khi server bỏ qua vì %s', async reason => {
    h.rpc.mockResolvedValueOnce(adopted([{ url, reason }]));
    await expect(prepareQuickExpenseBatchEvidence(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.download).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledOnce();
  });

  it.each([
    url.replace(origin, 'https://another-project.supabase.co'),
    url.replace(origin, 'https://evidence-test.supabase.co.evil.test'),
    url.replace(bucket, 'documents'),
    url.replace('/public/', '/sign/'),
    url.replace(path, 'actor/../shared.png'),
    url.replace(path, 'actor/%73hared.png'),
    `${url}#fragment`,
  ])('không đọc URL ngoài kho/path gốc: %s', async invalidUrl => {
    h.rpc.mockResolvedValueOnce(adopted([{ url: invalidUrl, reason: 'ATTACHED' }]));
    await expect(prepareQuickExpenseBatchEvidence(voucher([invalidUrl]))).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(h.download).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
  });

  it('không sao chép URL trả về không còn trong snapshot attachments', async () => {
    await expect(prepareQuickExpenseBatchEvidence(voucher([`${url}?different`]))).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(h.download).not.toHaveBeenCalled();
  });

  it('adoption bị từ chối không tự lấy ảnh để vượt qua kiểm tenant', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Denied' } });
    await expect(prepareQuickExpenseBatchEvidence(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.download).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'Denied' } },
    { data: null, error: null },
    { data: new Blob([]), error: null },
  ])('đọc storage không đủ tệp thì không tạo intent', async response => {
    h.download.mockResolvedValue(response);
    await expect(prepareQuickExpenseBatchEvidence(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.rpc).toHaveBeenCalledOnce(); expect(h.upload).not.toHaveBeenCalled();
  });

  it('download bị treo có hạn chờ và không upload sau khi đã báo lỗi', async () => {
    vi.useFakeTimers(); h.download.mockImplementation(() => new Promise(() => {}));
    const checked = expect(prepareQuickExpenseBatchEvidence(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    await vi.advanceTimersByTimeAsync(20_000); await checked;
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('upload lỗi không finalize và không trả evidence để ghi sổ', async () => {
    h.upload.mockResolvedValue({ data: null, error: { message: 'Upload failed' } });
    await expect(prepareQuickExpenseBatchEvidence(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.rpc.mock.calls.some(([fn]) => fn === 'finalize_finance_evidence_v2')).toBe(false);
  });

  it.each([
    { data: null, error: { message: 'Finalize failed' } },
    { data: null, error: null },
    { data: { evidence_id: 'other', state: 'FINALIZED' }, error: null },
    { data: { evidence_id: 'copy-1', state: 'ATTACHED' }, error: null },
  ])('finalize thiếu/sai biên nhận không trả evidence', async response => {
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => fn === 'finalize_finance_evidence_v2' ? Promise.resolve(response) : original(fn, args));
    await expect(prepareQuickExpenseBatchEvidence(voucher())).rejects.toMatchObject({ outcome: 'failure' });
    expect(h.upload).toHaveBeenCalledOnce();
  });
});
