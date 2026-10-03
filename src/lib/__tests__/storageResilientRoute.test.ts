// uploadFileDetailed + `resilient` (03/10/2026): ảnh chứng từ đi đường tải chịu mạng
// chập chờn thay cho lệnh storage-js một phát. Kiểm chỗ nối: đúng đường, đúng khoá
// sau nén, lỗi huỷ không bị bọc thành lỗi giao dịch, quá hạn sau khi đã tự tải lại
// thì mời tải lại (không bảo "đừng tải lại"), và 5 MB tính SAU khi nén.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ resilient: vi.fn(), storageUpload: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: h.storageUpload,
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://kho.test/public/${path}` } }),
      }),
    },
  },
}));
vi.mock('../signedUrlBatcher', () => ({ createSignedUrlBatched: vi.fn() }));
vi.mock('../storage/r2Client', () => ({ uploadToR2: vi.fn(), signR2: vi.fn() }));
vi.mock('../storage/resilientUpload', () => ({ uploadResilient: h.resilient }));
// Ảnh nhỏ (dưới mức bỏ qua) nên không qua bước nén — chỉ kiểm phần đi đường tải.
vi.mock('../imageCompress', () => ({ compressImage: async (f: File) => f }));

import { uploadFileDetailed } from '../storage';
import { FinancialWorkflowError } from '../financialWorkflowError';
import { UploadTimeoutError, UploadTooLargeError } from '../uploadDeadline';

const anh = (bytes = 10) => new File([new Uint8Array(bytes)], 'bill.png', { type: 'image/png' });

beforeEach(() => {
  h.resilient.mockReset();
  h.storageUpload.mockReset();
});

describe('uploadFileDetailed — đường chịu mạng chập chờn', () => {
  it('có `resilient` thì đi đường mới (không gọi storage-js), trả URL + số đo', async () => {
    const signal = new AbortController().signal;
    h.resilient.mockResolvedValue({ path: 'u/k-bill.png', attempts: 2, elapsedMs: 640 });
    const out = await uploadFileDetailed('income-expense-attachments', 'u/k-bill.png', anh(), {
      imagePolicy: 'evidence',
      resilient: { signal },
    });
    expect(h.storageUpload).not.toHaveBeenCalled();
    expect(h.resilient).toHaveBeenCalledWith('income-expense-attachments', 'u/k-bill.png', expect.any(File), { signal });
    expect(out).toMatchObject({ url: 'https://kho.test/public/u/k-bill.png', path: 'u/k-bill.png', stats: { attempts: 2, uploadMs: 640 } });
  });

  it('không truyền `resilient`: các trang khác vẫn đi storage-js như cũ', async () => {
    h.storageUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
    await uploadFileDetailed('customer-images', 'u/a.png', anh());
    expect(h.resilient).not.toHaveBeenCalled();
    expect(h.storageUpload).toHaveBeenCalledTimes(1);
  });

  it('người dùng huỷ: AbortError đi thẳng ra, không bọc thành lỗi giao dịch', async () => {
    h.resilient.mockRejectedValue(new DOMException('huỷ', 'AbortError'));
    const loi = await uploadFileDetailed('b', 'u/a.png', anh(), { resilient: {} }).catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(DOMException);
    expect((loi as DOMException).name).toBe('AbortError');
  });

  it('hết lượt tự tải lại: lỗi "failure" mời Thử lại, giữ UploadTimeoutError làm nguyên nhân', async () => {
    h.resilient.mockRejectedValue(new UploadTimeoutError(27_000));
    const loi = await uploadFileDetailed('b', 'u/a.png', anh(), { resilient: {} }).catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(FinancialWorkflowError);
    expect(loi).toMatchObject({ outcome: 'failure' });
    expect((loi as FinancialWorkflowError).message).toMatch(/quá 27 giây chưa tải xong tệp\. Tệp chưa được lưu; bấm Thử lại/);
    expect((loi as FinancialWorkflowError).message).not.toMatch(/không tải lại/);
    expect((loi as FinancialWorkflowError).cause).toBeInstanceOf(UploadTimeoutError);
  });

  it('trả kèm ĐÚNG tệp đã nằm trong kho (để đường lùi không phải tải ảnh gốc)', async () => {
    h.resilient.mockResolvedValue({ path: 'u/a.png', attempts: 1, elapsedMs: 10 });
    const goc = anh();
    const out = await uploadFileDetailed('b', 'u/a.png', goc, { resilient: {} });
    expect(out.file).toBe(goc); // compressImage giả trả nguyên tệp
  });

  it('máy chủ lưu trữ lỗi 5xx cả 3 lượt: "failure" mời Thử lại, không bảo "đừng tải lại"', async () => {
    const { UploadRejectedError } = await import('../uploadDeadline');
    h.resilient.mockRejectedValue(new UploadRejectedError(503, 'Máy chủ lưu trữ đang lỗi'));
    const loi = await uploadFileDetailed('b', 'u/a.png', anh(), { resilient: {} }).catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(FinancialWorkflowError);
    expect(loi).toMatchObject({ outcome: 'failure' });
    expect((loi as FinancialWorkflowError).message).toMatch(/Bấm Thử lại/);
    expect((loi as FinancialWorkflowError).message).not.toMatch(/không tải lại/);
  });

  it('ảnh bị gỡ trong lúc chờ nén (hàng đợi trả ảnh gốc to): báo huỷ, KHÔNG báo nhầm "quá 5 MB"', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const loi = await uploadFileDetailed('b', 'u/a.png', anh(6 * 1024 * 1024), {
      resilient: { signal: ctl.signal },
      maxBytes: 5 * 1024 * 1024,
    }).catch((e: unknown) => e);
    expect((loi as DOMException).name).toBe('AbortError');
    expect(loi).not.toBeInstanceOf(UploadTooLargeError);
    expect(h.resilient).not.toHaveBeenCalled();
  });

  it('5 MB tính SAU khi nén: vượt thì từ chối trước khi gửi byte nào', async () => {
    const loi = await uploadFileDetailed('b', 'u/a.png', anh(6 * 1024 * 1024), {
      resilient: {},
      maxBytes: 5 * 1024 * 1024,
    }).catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(UploadTooLargeError);
    expect(h.resilient).not.toHaveBeenCalled();
  });
});
