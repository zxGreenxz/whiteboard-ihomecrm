// @vitest-environment jsdom
// =============================================================================
// Hộp Thu/Chi (IncomeExpensePostingDialog) — GOM thay đổi ảnh tới lúc xác nhận
// (E2, chủ chốt 25/09/2026).
//
// Lỗi cũ: dán ảnh là ghi lên phiếu NGAY (annotate), bấm X là gỡ khỏi phiếu NGAY;
// bấm Huỷ bỏ thì phiếu đã đổi rồi. Luật mới:
//   - dán/thêm ảnh chỉ tải lên kho, KHÔNG gọi lệnh ghi ảnh;
//   - Huỷ bỏ / đóng hộp ⇒ xoá đúng file vừa tải, phiếu không đổi, không ghi sổ;
//   - xác nhận ⇒ MỘT lệnh ghi ảnh (thêm + gỡ) → adopt → rồi mới ghi sổ với mã
//     chứng từ của chính các ảnh đó.
//
// Giả lập tới đâu: biên mạng (supabase.rpc, kho lưu trữ) và phiên đăng nhập.
// Phần được kiểm là hộp thoại THẬT + hook gom ảnh THẬT trong financeV2Mutations
// + adopt THẬT mà các trang truyền vào `onAdoptAttachments`.
// =============================================================================

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000aa';

const H = vi.hoisted(() => ({
  /** supabase.rpc — cố ý KHÔNG đặt tên `rpc`. */
  goiMayChu: vi.fn(),
  taiLen: vi.fn(),
  xoaFile: vi.fn(),
  /** Ba đường ghi-ngay cũ mà trang vẫn truyền vào — hộp thoại không được gọi. */
  dinhNgay: vi.fn(),
  goNgay: vi.fn(),
  /** Đường lùi: kho chứng từ riêng (uploadFinanceEvidence). */
  khoChungTu: vi.fn(),
  ghiSo: vi.fn(),
  toastLoi: vi.fn(),
  toastCanhBao: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => H.goiMayChu(...a) },
}));
vi.mock('@/lib/storage', () => ({
  uploadFile: (...a: unknown[]) => H.taiLen(...a),
  deleteFile: (...a: unknown[]) => H.xoaFile(...a),
  sanitizeStorageFileName: (ten: string) => ten,
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: USER } }) }));
vi.mock('@/components/ui/storage-image', () => ({
  StorageImage: ({ value, alt }: { value: string; alt: string }) => <img src={value} alt={alt} />,
}));
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => H.toastLoi(...a),
    warning: (...a: unknown[]) => H.toastCanhBao(...a),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import IncomeExpensePostingDialog from '../IncomeExpensePostingDialog';
import { adoptVoucherAttachmentsAsEvidence } from '@/hooks/income-expenses/financeV2Mutations';

const PHIEU = '0f0f0f0f-0000-4000-8000-00000000000a';
const SO = '0d0d0d0d-0000-4000-8000-000000000001';
const BUCKET = 'income-expense-attachments';
const KHO = `https://kho.test/storage/v1/object/public/${BUCKET}/`;
const ANH_CU = `${KHO}nguoi-lap/1758700000000-hoa-don.png`;
const EV_CU = '0e0e0e0e-0000-4000-8000-000000000001';

/** Máy chủ giả: ảnh đang nằm trên phiếu + lỗi (nếu có) của lệnh ghi ảnh. */
const may = {
  anh: [] as string[],
  loiGhiAnh: null as null | { message: string },
};
const maChungTu = (url: string) => (url === ANH_CU ? EV_CU : `ev:${url.slice(KHO.length)}`);

function goiMayChuGia(fn: string, args: Record<string, unknown>) {
  if (fn === 'adopt_voucher_attachments_as_evidence_v2') {
    return Promise.resolve({
      data: { evidence_ids: may.anh.map(maChungTu), skipped: [] },
      error: null,
    });
  }
  if (fn === 'annotate_income_expense_v1') {
    if (may.loiGhiAnh) return Promise.resolve({ data: null, error: may.loiGhiAnh });
    const go = (args.p_remove_attachments as string[] | null) ?? [];
    const them = (args.p_add_attachments as string[] | null) ?? [];
    may.anh = [...may.anh.filter((u) => !go.includes(u)), ...them.filter((u) => !may.anh.includes(u))];
    return Promise.resolve({ data: { id: PHIEU, changed: true }, error: null });
  }
  return Promise.reject(new Error(`RPC ngoài kịch bản: ${fn}`));
}

const lenhGhiAnh = () =>
  H.goiMayChu.mock.calls.filter(([fn]) => fn === 'annotate_income_expense_v1');

function Khung({ giuKhiDong = false }: { giuKhiDong?: boolean }) {
  const [mo, setMo] = useState(true);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  // Như các trang: phiếu truyền vào là ẢNH CHỤP lúc bấm mở, không tự đổi theo máy chủ.
  const [phieu] = useState(() => ({
    subjectKind: 'VOUCHER' as const,
    subjectId: PHIEU,
    type: 'EXPENSE' as const,
    approvedTotal: 1_500_000,
    name: 'Sửa máy bơm',
    defaultCashbookId: SO,
    attachments: [...may.anh],
  }));
  const hop = (
    <IncomeExpensePostingDialog
      open={mo}
      onOpenChange={setMo}
      mode="POST_APPROVED"
      voucher={phieu}
      capability={{ isCustodian: true, canApprove: false }}
      cashbookOptions={[{ id: SO, name: 'Tiền mặt Hiệp' }]}
      expectedExecutionRevision={0}
      expectedApprovalVersion={2}
      expectedPostingVersion={1}
      onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
      onAttachEvidence={H.dinhNgay}
      onRemoveAttachment={H.goNgay}
      onUploadEvidence={H.khoChungTu}
      onSubmit={async (input) => {
        await H.ghiSo(input);
        setMo(false); // như các trang: ghi sổ xong thì đóng hộp
      }}
    />
  );
  // Trang Thu chi có chỗ gỡ hẳn hộp khi đóng, có chỗ giữ lại với open=false.
  return <QueryClientProvider client={client}>{giuKhiDong || mo ? hop : null}</QueryClientProvider>;
}

function oAnh(url: string) {
  const anh = screen.queryAllByRole('img').find((i) => i.getAttribute('src') === url);
  return anh?.parentElement ?? null;
}

/** Chọn một ảnh mới qua ô "Thêm chứng từ"; trả URL + đường dẫn trong kho. */
async function themAnh(ten = 'bien-lai.png') {
  const soLanTruoc = H.taiLen.mock.calls.length;
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], ten, { type: 'image/png' })] } });
  await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(soLanTruoc + 1));
  const [bucket, path] = H.taiLen.mock.calls[soLanTruoc] as [string, string];
  const url = `https://kho.test/storage/v1/object/public/${bucket}/${path}`;
  await waitFor(() => expect(oAnh(url)).not.toBeNull());
  return { url, path };
}

function bamGo(url: string) {
  const o = oAnh(url);
  if (!o) throw new Error(`Không thấy ảnh ${url}`);
  fireEvent.click(within(o).getByRole('button', { name: 'Gỡ chứng từ' }));
}

beforeEach(() => {
  may.anh = [];
  may.loiGhiAnh = null;
  H.goiMayChu.mockReset().mockImplementation(goiMayChuGia);
  H.taiLen.mockReset().mockImplementation(
    async (bucket: string, path: string) =>
      `https://kho.test/storage/v1/object/public/${bucket}/${path}`,
  );
  H.xoaFile.mockReset().mockResolvedValue(undefined);
  H.dinhNgay.mockReset();
  H.goNgay.mockReset();
  H.khoChungTu.mockReset().mockResolvedValue('ev-kho-chung-tu-rieng');
  H.ghiSo.mockReset().mockResolvedValue(undefined);
  H.toastLoi.mockReset();
  H.toastCanhBao.mockReset();
});
afterEach(cleanup);

describe('Hộp Thu/Chi — ảnh gom tới lúc xác nhận (E2)', () => {
  it('dán ảnh rồi Huỷ bỏ: xoá đúng file vừa tải, không ghi ảnh lên phiếu, không ghi sổ', async () => {
    render(<Khung />);
    const { path } = await themAnh();
    expect(path.startsWith(`${USER}/`)).toBe(true);
    // Dán xong phiếu vẫn nguyên: không lệnh ghi ảnh nào, không đi đường ghi-ngay cũ.
    expect(lenhGhiAnh()).toHaveLength(0);
    expect(H.dinhNgay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Huỷ bỏ' }));

    await waitFor(() => expect(H.xoaFile).toHaveBeenCalledWith(BUCKET, path));
    expect(H.xoaFile).toHaveBeenCalledTimes(1);
    expect(lenhGhiAnh()).toHaveLength(0);
    expect(H.ghiSo).not.toHaveBeenCalled();
    expect(may.anh).toEqual([]);
  });

  it('hộp chỉ đóng (vẫn gắn, open=false) cũng xoá file vừa tải', async () => {
    render(<Khung giuKhiDong />);
    const { path } = await themAnh();
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ bỏ' }));
    await waitFor(() => expect(H.xoaFile).toHaveBeenCalledWith(BUCKET, path));
    expect(lenhGhiAnh()).toHaveLength(0);
    expect(H.ghiSo).not.toHaveBeenCalled();
  });

  it('X trên ảnh vừa thêm xoá file ngay; X trên ảnh cũ chỉ ẩn — Huỷ bỏ thì ảnh cũ còn nguyên', async () => {
    may.anh = [ANH_CU];
    render(<Khung />);
    await waitFor(() => expect(oAnh(ANH_CU)).not.toBeNull());

    const { url, path } = await themAnh();
    bamGo(url);
    await waitFor(() => expect(H.xoaFile).toHaveBeenCalledWith(BUCKET, path));

    bamGo(ANH_CU);
    await waitFor(() => expect(oAnh(ANH_CU)).toBeNull());
    expect(H.goNgay).not.toHaveBeenCalled();
    expect(lenhGhiAnh()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Huỷ bỏ' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Huỷ bỏ' })).toBeNull());
    // Ảnh cũ là chứng từ của phiếu: không bao giờ bị xoá file, phiếu không đổi.
    expect(H.xoaFile).toHaveBeenCalledTimes(1);
    expect(lenhGhiAnh()).toHaveLength(0);
    expect(may.anh).toEqual([ANH_CU]);
    expect(H.ghiSo).not.toHaveBeenCalled();
  });

  it('xác nhận: MỘT lệnh ghi ảnh (thêm + gỡ) → adopt → rồi mới ghi sổ bằng chứng từ của ảnh mới', async () => {
    may.anh = [ANH_CU];
    render(<Khung />);
    await waitFor(() => expect(oAnh(ANH_CU)).not.toBeNull());

    const { url } = await themAnh();
    bamGo(ANH_CU);
    await waitFor(() => expect(oAnh(ANH_CU)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));

    expect(lenhGhiAnh()).toEqual([
      ['annotate_income_expense_v1', {
        p_voucher: PHIEU,
        p_add_attachments: [url],
        p_remove_attachments: [ANH_CU],
      }],
    ]);
    const thuTu = (fn: string) =>
      H.goiMayChu.mock.calls
        .map(([ten], i) => (ten === fn ? H.goiMayChu.mock.invocationCallOrder[i] : -1))
        .filter((n) => n >= 0);
    const [ghiAnh] = thuTu('annotate_income_expense_v1');
    const adoptSauGhiAnh = thuTu('adopt_voucher_attachments_as_evidence_v2').filter((n) => n > ghiAnh);
    expect(adoptSauGhiAnh).toHaveLength(1);
    expect(adoptSauGhiAnh[0]).toBeLessThan(H.ghiSo.mock.invocationCallOrder[0]);

    expect(H.ghiSo.mock.calls[0][0]).toMatchObject({
      subjectKind: 'VOUCHER',
      subjectId: PHIEU,
      cashbookId: SO,
      evidenceIds: [maChungTu(url)],
      expectedApprovalVersion: 2,
      expectedPostingVersion: 1,
    });
    expect(may.anh).toEqual([url]);

    // Ghi sổ xong trang đóng hộp: ảnh đã nằm trên phiếu nên KHÔNG được xoá.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Chi' })).toBeNull());
    expect(H.xoaFile).not.toHaveBeenCalled();
    expect(H.dinhNgay).not.toHaveBeenCalled();
    expect(H.goNgay).not.toHaveBeenCalled();
  });

  it('không đổi ảnh: ghi sổ thẳng bằng chứng từ adopt lúc mở, không có lệnh ghi ảnh', async () => {
    may.anh = [ANH_CU];
    render(<Khung />);
    await waitFor(() => expect(oAnh(ANH_CU)).not.toBeNull());
    await waitFor(() => expect(screen.queryByText('Đang kiểm ảnh của phiếu…')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));
    expect(H.ghiSo.mock.calls[0][0].evidenceIds).toEqual([EV_CU]);
    expect(lenhGhiAnh()).toHaveLength(0);
  });

  it('đường lùi: máy chủ không cho đính ảnh ⇒ chứng từ đi kho riêng, file ở kho ảnh bị xoá, vẫn ghi sổ', async () => {
    may.loiGhiAnh = { message: 'Không có quyền bổ sung ảnh/ghi chú cho phiếu này' };
    render(<Khung />);
    const { path } = await themAnh();

    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));

    expect(H.khoChungTu).toHaveBeenCalledTimes(1);
    expect((H.khoChungTu.mock.calls[0][0] as File).name).toBe('bien-lai.png');
    expect(H.ghiSo.mock.calls[0][0].evidenceIds).toEqual(['ev-kho-chung-tu-rieng']);
    expect(H.xoaFile).toHaveBeenCalledWith(BUCKET, path);
    expect(H.toastCanhBao).toHaveBeenCalled();
    expect(may.anh).toEqual([]);
  });

  it('gỡ ảnh bị từ chối: phiếu không đổi, ảnh cũ trả lại danh sách, không ghi sổ', async () => {
    may.anh = [ANH_CU];
    render(<Khung />);
    await waitFor(() => expect(oAnh(ANH_CU)).not.toBeNull());
    await themAnh();
    bamGo(ANH_CU);
    await waitFor(() => expect(oAnh(ANH_CU)).toBeNull());

    may.loiGhiAnh = { message: 'Chỉ người có quyền sửa thu chi mới gỡ được ảnh chứng từ' };
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));

    await waitFor(() => expect(H.toastLoi).toHaveBeenCalled());
    expect(String(H.toastLoi.mock.calls[0][0])).toContain('Chỉ người có quyền sửa thu chi');
    await waitFor(() => expect(oAnh(ANH_CU)).not.toBeNull());
    expect(H.ghiSo).not.toHaveBeenCalled();
    expect(H.khoChungTu).not.toHaveBeenCalled();
    expect(may.anh).toEqual([ANH_CU]);
  });
});
