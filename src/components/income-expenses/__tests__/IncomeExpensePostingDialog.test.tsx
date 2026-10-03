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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  /** Chuẩn bị đường tải (làm mới phiên + mở sẵn kết nối). */
  lamAm: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => H.goiMayChu(...a) },
}));
vi.mock('@/lib/storage', () => ({
  uploadFile: (...a: unknown[]) => H.taiLen(...a),
  // Hộp tải bằng uploadFileDetailed (có số đo); cùng giả lập `taiLen` trả URL kho.
  uploadFileDetailed: async (bucket: string, path: string, file: File, opts?: unknown) => {
    const url = (await H.taiLen(bucket, path, file, opts)) as string;
    // Như đường thật: trả kèm bản ĐÃ NÉN nằm trong kho (đổi đuôi .webp).
    const daNen = new File([file], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' });
    return { url, path, type: daNen.type, size: daNen.size, stats: { attempts: 1 }, file: daNen };
  },
  deleteFile: (...a: unknown[]) => H.xoaFile(...a),
  sanitizeStorageFileName: (ten: string) => ten,
}));
vi.mock('@/lib/storage/resilientUpload', () => ({ warmUploadConnection: () => H.lamAm() }));
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

function Khung({
  giuKhiDong = false,
  loai = 'EXPENSE',
  che = 'POST_APPROVED',
}: {
  giuKhiDong?: boolean;
  loai?: 'INCOME' | 'EXPENSE';
  che?: 'POST_APPROVED' | 'APPROVE_AND_POST';
}) {
  const [mo, setMo] = useState(true);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  // Như các trang: phiếu truyền vào là ẢNH CHỤP lúc bấm mở, không tự đổi theo máy chủ.
  const [phieu] = useState(() => ({
    subjectKind: 'VOUCHER' as const,
    subjectId: PHIEU,
    type: loai,
    approvedTotal: 1_500_000,
    name: 'Sửa máy bơm',
    defaultCashbookId: SO,
    attachments: [...may.anh],
  }));
  const hop = (
    <IncomeExpensePostingDialog
      open={mo}
      onOpenChange={setMo}
      mode={che}
      voucher={phieu}
      capability={{ isCustodian: true, canApprove: che === 'APPROVE_AND_POST' }}
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

/** Ô ảnh theo URL kho — ảnh vừa thêm vẽ từ URL tạm trên máy nên không tra theo src. */
function oAnh(url: string) {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-evidence-url]')).find(
      (o) => o.dataset.evidenceUrl === url,
    ) ?? null
  );
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
  H.lamAm.mockReset();
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
    // Đường lùi tải lại BẢN ĐÃ NÉN, không phải ảnh gốc (có thể tới 25 MB) lúc hộp đang khoá.
    expect((H.khoChungTu.mock.calls[0][0] as File).name).toBe('bien-lai.webp');
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


describe('C26/C27 — chứng từ lỗi có trạng thái bền vững', () => {
  it('thiếu chứng từ báo đỏ và focus đúng nút thêm chứng từ', async () => {
    render(<Khung />);
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await screen.findByText('Thêm ít nhất một ảnh hoặc tệp chứng từ cho lần thu/chi này.');
    const them = screen.getByRole('button', { name: 'Thêm chứng từ' });
    await waitFor(() => expect(document.activeElement).toBe(them));
    expect(them.getAttribute('aria-invalid')).toBe('true');
    expect(H.ghiSo).not.toHaveBeenCalled();
  });
  it('không đọc được ảnh đã có báo lỗi, không giả danh sách rỗng', async () => {
    may.anh = [ANH_CU];
    H.goiMayChu.mockResolvedValue({data:null,error:{code:'42501',message:'permission denied'}});
    render(<Khung />);
    await screen.findByText(/Chưa kiểm tra được chứng từ đã đính kèm/);
    expect(H.ghiSo).not.toHaveBeenCalled();
  });
  it('timeout ghi sổ giữ hộp thoại và chặn gửi lại', async () => {
    may.anh = [ANH_CU]; H.ghiSo.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Khung />);
    await waitFor(() => expect(H.goiMayChu).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await screen.findByText(/Chưa xác nhận được kết quả ghi nhận thu\/chi/);
    const ghi = screen.getByRole('button', { name: 'Chi' }) as HTMLButtonElement;
    expect(ghi.disabled).toBe(true); fireEvent.click(ghi); expect(H.ghiSo).toHaveBeenCalledOnce();
  });
});


describe('chứng từ đã ghi nhưng kiểm tra lại lỗi', () => {
  it('giữ ảnh đã đính, báo phần chưa hoàn tất và không xoá ảnh khi đóng', async () => {
    render(<Khung />);
    const uploaded = await themAnh();
    H.goiMayChu.mockImplementation((fn, args) => fn === 'adopt_voucher_attachments_as_evidence_v2'
      ? Promise.resolve({data:null,error:{code:'42501',message:'permission denied'}})
      : goiMayChuGia(fn,args));
    fireEvent.click(screen.getByRole('button',{name:'Chi'}));
    await screen.findByText(/Ảnh đã lưu trên phiếu nhưng chưa kiểm tra được chứng từ/);
    expect(H.ghiSo).not.toHaveBeenCalled();
    expect(may.anh).toContain(uploaded.url);
    fireEvent.click(screen.getByRole('button',{name:'Huỷ bỏ'}));
    expect(H.xoaFile).not.toHaveBeenCalled();
  });
});

// Ảnh vừa chọn vẽ NGAY từ file trên máy (URL tạm), không phải ký URL rồi tải ngược
// cả ảnh từ kho mới hiện được ô 80×80. Đóng hộp thì thu hồi URL tạm.
describe('ô ảnh vừa thêm hiện ngay từ máy', () => {
  const taoUrlTam = vi.fn();
  const thuHoi = vi.fn();
  beforeEach(() => {
    let dem = 0;
    taoUrlTam.mockReset().mockImplementation(() => `blob:anh-tren-may-${++dem}`);
    thuHoi.mockReset();
    // URL tạm đoán trước được + theo dõi thu hồi. Lớp con giữ `new URL(...)` chạy được
    // (stub bằng object thường như `{...URL}` làm hỏng nó).
    class UrlCoXemTruoc extends URL {
      static createObjectURL = taoUrlTam;
      static revokeObjectURL = thuHoi;
    }
    vi.stubGlobal('URL', UrlCoXemTruoc);
  });
  afterEach(() => vi.unstubAllGlobals());

  const coAnh = (src: string) => screen.queryAllByRole('img').some((i) => i.getAttribute('src') === src);
  const chonAnh = () => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'bill.png', { type: 'image/png' })] } });
  };

  it('vẽ bằng URL tạm của file trên máy, đóng hộp thì thu hồi', async () => {
    render(<Khung />);
    chonAnh();
    await waitFor(() => expect(coAnh('blob:anh-tren-may-1')).toBe(true));
    // Không ô nào phải chờ ký URL kho cho ảnh vừa thêm.
    expect(screen.queryAllByRole('img').some((i) => (i.getAttribute('src') ?? '').startsWith(KHO))).toBe(false);
    expect(thuHoi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ bỏ' }));
    await waitFor(() => expect(thuHoi).toHaveBeenCalledWith('blob:anh-tren-may-1'));
  });

  it('bấm X trên ảnh vừa thêm thì thu hồi URL tạm của đúng ảnh đó', async () => {
    render(<Khung />);
    chonAnh();
    await waitFor(() => expect(coAnh('blob:anh-tren-may-1')).toBe(true));
    const o = screen.queryAllByRole('img').find((i) => i.getAttribute('src') === 'blob:anh-tren-may-1')!.parentElement!;
    fireEvent.click(within(o).getByRole('button', { name: 'Gỡ chứng từ' }));
    await waitFor(() => expect(coAnh('blob:anh-tren-may-1')).toBe(false));
    expect(thuHoi).toHaveBeenCalledWith('blob:anh-tren-may-1');
  });

  it('không tạo được URL tạm: ảnh vẫn vào danh sách chờ, ô ảnh đọc từ kho, không vỡ luồng tải', async () => {
    taoUrlTam.mockImplementation(() => { throw new Error('không tạo được URL tạm'); });
    render(<Khung />);
    const { url } = await themAnh();
    expect(oAnh(url)).not.toBeNull();
    expect(coAnh(url)).toBe(true); // StorageImage (giả) vẽ bằng URL kho
    // Ảnh vẫn đi cùng lần xác nhận như mọi ảnh chờ ghi.
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(lenhGhiAnh()).toHaveLength(1));
    expect(lenhGhiAnh()[0][1]).toMatchObject({ p_add_attachments: [url] });
  });

  it('ảnh trên máy không vẽ được thì ô ảnh quay về đọc từ kho', async () => {
    render(<Khung />);
    chonAnh();
    await waitFor(() => expect(coAnh('blob:anh-tren-may-1')).toBe(true));
    const [, duongDan] = H.taiLen.mock.calls[0] as [string, string];
    const anh = screen.queryAllByRole('img').find((i) => i.getAttribute('src') === 'blob:anh-tren-may-1')!;
    fireEvent.error(anh);
    await waitFor(() => expect(coAnh(`${KHO}${duongDan}`)).toBe(true));
    expect(coAnh('blob:anh-tren-may-1')).toBe(false);
    expect(thuHoi).toHaveBeenCalledWith('blob:anh-tren-may-1');
  });
});

// Ảnh trong hộp mới chỉ TẢI LÊN KHO, chưa gắn vào phiếu nào: tải quá hạn thì lần
// tải lại dùng tên file mới, file lỡ tải xong muộn bị xoá (uploadToStorageWithDeadline)
// ⇒ tải lại an toàn. Câu báo chung "không tải lại tệp này khi kết quả còn chưa rõ"
// (dành cho giao dịch) sai với ca này và khiến người chi kẹt, không chi được.
describe('ảnh chứng từ tải quá hạn', () => {
  it('báo mạng chậm và mời tải lại — không bảo "đừng tải lại"', async () => {
    const { FinancialWorkflowError } = await import('@/lib/financialWorkflowError');
    const { UploadTimeoutError } = await import('@/lib/uploadDeadline');
    // Đúng hình dạng storage.ts ném: lỗi giao dịch "chưa rõ" bọc UploadTimeoutError.
    H.taiLen.mockImplementationOnce(async () => {
      throw new FinancialWorkflowError(
        'Tải file quá lâu. Chưa xác nhận được tệp đã tải. Giữ tệp và đường dẫn để đối chiếu; không tải lại tệp này khi kết quả còn chưa rõ.',
        'unknown', [], new UploadTimeoutError(20_000));
    });
    render(<Khung />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'bill.png', { type: 'image/png' })] } });
    await waitFor(() => expect(H.toastLoi).toHaveBeenCalled());
    const loi = String(H.toastLoi.mock.calls[0][0]);
    expect(loi).toMatch(/Mạng chậm — quá 20 giây chưa tải xong “bill\.png”/);
    expect(loi).toMatch(/Ảnh chưa gắn vào phiếu — tải lại ảnh này/);
    expect(loi).not.toMatch(/không tải lại/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Thêm chứng từ' })).toBeTruthy());
  });

  it('tệp lớn được chờ lâu hơn: câu báo nói đúng số giây đã chờ', async () => {
    const { UploadTimeoutError } = await import('@/lib/uploadDeadline');
    // PDF 2,5 MB: 20 giây + 20 giây mỗi MB vượt 1 MB = 60 giây (uploadDeadlineMs).
    H.taiLen.mockImplementationOnce(async () => { throw new UploadTimeoutError(60_000); });
    render(<Khung />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'hoa-don.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(H.toastLoi).toHaveBeenCalled());
    const loi = String(H.toastLoi.mock.calls[0][0]);
    expect(loi).toMatch(/Mạng chậm — quá 60 giây chưa tải xong “hoa-don\.pdf”/);
    expect(loi).toMatch(/tải lại ảnh này/);
  });
});

// Chủ chốt 30/09/2026: bước ghi ảnh lên phiếu (annotate + adopt) KHOÁ hộp vì chưa
// rõ phiếu đã đổi hay chưa — nhưng chỉ chờ tối đa 20 giây. Quá hạn: mở khoá hộp,
// báo chưa xác nhận, KHÔNG chi tiền; ảnh có thể đã nằm trên phiếu nên không xoá.
describe('bước ghi ảnh lên phiếu kẹt mạng', () => {
  it('quá 20 giây: mở khoá hộp, báo chưa xác nhận, không chi tiền, không xoá ảnh khi đóng', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Khung />);
      const { path } = await themAnh();
      H.goiMayChu.mockImplementation((fn: string, args: Record<string, unknown>) =>
        fn === 'annotate_income_expense_v1' ? new Promise(() => {}) : goiMayChuGia(fn, args));
      fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
      await waitFor(() => expect(lenhGhiAnh()).toHaveLength(1));
      const huy = () => screen.getByRole('button', { name: 'Huỷ bỏ' }) as HTMLButtonElement;
      expect(huy().disabled).toBe(true);
      // Chưa tới 20 giây: vẫn khoá. Đồng hồ giả còn chạy theo giờ thật (shouldAdvanceTime)
      // nên chừa 5 giây cho máy chạy đầy tải; vẫn bắt được hạn bị rút còn ≤ 15 giây.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(huy().disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => expect(huy().disabled).toBe(false));
      expect(screen.getByRole('alert').textContent).toMatch(/quá 20 giây/);
      expect(screen.getByRole('alert').textContent).toMatch(/Chưa gửi lệnh chi tiền/);
      // Kết quả chưa rõ ⇒ không cho bấm Chi lần nữa trong hộp này (ảnh chụp phiếu đã cũ).
      expect((screen.getByRole('button', { name: 'Chi' }) as HTMLButtonElement).disabled).toBe(true);
      expect(H.ghiSo).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Huỷ bỏ' }));
      await vi.advanceTimersByTimeAsync(50);
      expect(H.xoaFile).not.toHaveBeenCalledWith(BUCKET, path);
    } finally {
      vi.useRealTimers();
    }
  });

  it('phiếu thu: câu báo nói chưa ghi nhận thu, không nói "chi tiền"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Khung loai="INCOME" />);
      await themAnh();
      H.goiMayChu.mockImplementation((fn: string, args: Record<string, unknown>) =>
        fn === 'annotate_income_expense_v1' ? new Promise(() => {}) : goiMayChuGia(fn, args));
      fireEvent.click(screen.getByRole('button', { name: 'Thu' }));
      await waitFor(() => expect(lenhGhiAnh()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(20_000);
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/quá 20 giây/));
      expect(screen.getByRole('alert').textContent).toMatch(/Chưa gửi lệnh ghi nhận thu/);
      expect(screen.getByRole('alert').textContent).not.toMatch(/chi tiền/);
      expect(H.ghiSo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Duyệt và Chi: câu báo nói rõ CHƯA GỬI lệnh duyệt và chi (không khẳng định trạng thái phiếu)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Khung che="APPROVE_AND_POST" />);
      await themAnh();
      H.goiMayChu.mockImplementation((fn: string, args: Record<string, unknown>) =>
        fn === 'annotate_income_expense_v1' ? new Promise(() => {}) : goiMayChuGia(fn, args));
      fireEvent.click(screen.getByRole('button', { name: 'Duyệt và Chi' }));
      await waitFor(() => expect(lenhGhiAnh()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(20_000);
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/quá 20 giây/));
      expect(screen.getByRole('alert').textContent).toMatch(/Chưa gửi lệnh duyệt và chi\./);
      expect(H.ghiSo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Chủ chốt 03/10/2026 "làm sao upload nhanh nhất": ô ảnh hiện ngay lúc chọn kèm %,
// tải song song, mạng hỏng thì giữ tệp để Thử lại, bấm Chi lúc ảnh còn đang tải
// thì hộp tự chờ — và gỡ ảnh / đóng hộp là huỷ THẬT lệnh tải.
type TuyChonTai = {
  imagePolicy?: string;
  maxBytes?: number;
  resilient?: { signal?: AbortSignal; onProgress?: (p: unknown) => void };
};

/** Một lệnh tải CHƯA xong: test tự báo %, tự cho xong. */
function taiCho() {
  let xong: (url: string) => void = () => {};
  let opts: TuyChonTai = {};
  let duongDan = '';
  H.taiLen.mockImplementationOnce((_bucket: string, path: string, _file: File, o?: TuyChonTai) => {
    opts = o ?? {};
    duongDan = path;
    return new Promise<string>((resolve) => { xong = resolve; });
  });
  return {
    url: () => `${KHO}${duongDan}`,
    opts: () => opts,
    xong: () => act(() => xong(`${KHO}${duongDan}`)),
    baoTien: (loaded: number, total: number) =>
      act(() => opts.resilient?.onProgress?.({ loaded, total, attempt: 1, phase: 'sending' })),
  };
}

describe('tải ảnh nhanh và chịu mạng chập chờn', () => {
  const oDangTai = () => document.querySelector<HTMLElement>('[data-evidence-pending]');
  const chon = (...ten: string[]) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = (ten.length ? ten : ['bill.png']).map((t) => new File(['x'], t, { type: 'image/png' }));
    fireEvent.change(input, { target: { files } });
  };

  it('mở hộp là chuẩn bị đường tải ngay; chạm "Thêm chứng từ" chuẩn bị lại', () => {
    render(<Khung />);
    expect(H.lamAm).toHaveBeenCalled();
    const truoc = H.lamAm.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Thêm chứng từ' }));
    expect(H.lamAm.mock.calls.length).toBeGreaterThan(truoc);
  });

  it('ô ảnh hiện NGAY lúc chọn kèm %, tải xong hiện cỡ ảnh và thời gian; tải bằng đường chịu mạng chập chờn', async () => {
    const tai = taiCho();
    render(<Khung />);
    chon();
    expect(oDangTai()).not.toBeNull(); // chưa gửi byte nào đã thấy ô ảnh
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    expect(tai.opts()).toMatchObject({ imagePolicy: 'evidence', maxBytes: 5 * 1024 * 1024 });
    expect(tai.opts().resilient?.signal).toBeInstanceOf(AbortSignal);

    tai.baoTien(40, 100);
    await waitFor(() => expect(oDangTai()!.textContent).toContain('40%'));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');

    tai.xong();
    await waitFor(() => expect(oDangTai()).toBeNull());
    expect(oAnh(tai.url())!.textContent).toMatch(/^1 KB · \d+,\ds$/);
  });

  it('bấm Chi khi ảnh còn đang tải: nút báo đang chờ, ảnh xong tự ghi ảnh rồi ghi sổ', async () => {
    const tai = taiCho();
    render(<Khung />);
    chon();
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    const nut = screen.getByRole('button', { name: 'Chi' }) as HTMLButtonElement;
    expect(nut.disabled).toBe(false); // ảnh đang tải không khoá nút

    fireEvent.click(nut);
    await screen.findByRole('button', { name: 'Đang chờ ảnh tải xong...' });
    expect(lenhGhiAnh()).toHaveLength(0);
    expect(H.ghiSo).not.toHaveBeenCalled();

    tai.xong();
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));
    expect(lenhGhiAnh()).toHaveLength(1);
    expect(lenhGhiAnh()[0][1]).toMatchObject({ p_add_attachments: [tai.url()] });
    expect(H.ghiSo.mock.calls[0][0].evidenceIds).toEqual([maChungTu(tai.url())]);
  });

  it('tải hỏng: giữ tệp, bấm Chi bị chặn có lý do; "Thử lại" tải lại đúng tệp đó rồi Chi được', async () => {
    may.anh = [ANH_CU];
    H.taiLen.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Khung />);
    await waitFor(() => expect(screen.queryByText('Đang kiểm ảnh của phiếu…')).toBeNull());
    chon('bill-hong.png');
    await waitFor(() => expect(oDangTai()?.dataset.phase).toBe('failed'));
    expect(H.toastLoi).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await screen.findByText(/Còn 1 ảnh chưa tải được/);
    expect(H.ghiSo).not.toHaveBeenCalled();
    expect(lenhGhiAnh()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Thử lại bill-hong.png' }));
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(2));
    expect((H.taiLen.mock.calls[1][2] as File).name).toBe('bill-hong.png');
    await waitFor(() => expect(oDangTai()).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));
    const [, duongDan] = H.taiLen.mock.calls[1] as [string, string];
    expect(lenhGhiAnh()[0][1]).toMatchObject({ p_add_attachments: [`${KHO}${duongDan}`] });
  });

  it('gỡ ảnh đang tải: huỷ THẬT lệnh tải; máy chủ lỡ nhận xong thì xoá, ảnh không lên phiếu', async () => {
    may.anh = [ANH_CU];
    const tai = taiCho();
    render(<Khung />);
    chon('bill.png');
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Gỡ ảnh bill.png' }));
    expect(tai.opts().resilient?.signal?.aborted).toBe(true);
    await waitFor(() => expect(oDangTai()).toBeNull());

    tai.xong();
    await waitFor(() => expect(H.xoaFile).toHaveBeenCalledWith(BUCKET, tai.url().slice(KHO.length)));
    await waitFor(() => expect(screen.queryByText('Đang kiểm ảnh của phiếu…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));
    expect(lenhGhiAnh()).toHaveLength(0);
    expect(H.ghiSo.mock.calls[0][0].evidenceIds).toEqual([EV_CU]);
  });

  it('đã bấm Chi, đang chờ ảnh: ô Ngày / Sổ quỹ KHOÁ — tiền đi đúng sổ lúc bấm, không đổi được giữa chừng', async () => {
    const tai = taiCho();
    render(<Khung />);
    chon();
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    const oSo = screen.getByRole('combobox') as HTMLButtonElement;
    expect(oSo.matches(':disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await screen.findByRole('button', { name: 'Đang chờ ảnh tải xong...' });
    expect(oSo.matches(':disabled')).toBe(true);
    const oNgay = Array.from(document.querySelectorAll('fieldset input')) as HTMLInputElement[];
    expect(oNgay.length).toBeGreaterThan(0);
    expect(oNgay.every((i) => i.matches(':disabled'))).toBe(true);
    tai.xong();
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));
    expect(H.ghiSo.mock.calls[0][0]).toMatchObject({ cashbookId: SO });
  });

  it('phiếu chưa có ảnh, ảnh duy nhất tải hỏng: bấm Chi ra đúng câu "còn ảnh chưa tải được"', async () => {
    H.taiLen.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Khung />);
    chon('bill-hong.png');
    await waitFor(() => expect(oDangTai()?.dataset.phase).toBe('failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await screen.findByText(/Còn 1 ảnh chưa tải được/);
    expect(screen.queryByText('Thêm ít nhất một ảnh hoặc tệp chứng từ cho lần thu/chi này.')).toBeNull();
    expect(H.ghiSo).not.toHaveBeenCalled();
  });

  it('đang chờ ảnh mà gỡ ảnh đó: hộp thôi chờ nhưng KHÔNG tự chi bằng ảnh còn lại — phải bấm lại', async () => {
    may.anh = [ANH_CU];
    const tai = taiCho();
    render(<Khung />);
    await waitFor(() => expect(screen.queryByText('Đang kiểm ảnh của phiếu…')).toBeNull());
    chon('bill.png');
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await screen.findByRole('button', { name: 'Đang chờ ảnh tải xong...' });
    fireEvent.click(screen.getByRole('button', { name: 'Gỡ ảnh bill.png' }));
    expect(tai.opts().resilient?.signal?.aborted).toBe(true);
    await screen.findByText(/Bạn vừa gỡ ảnh trong lúc chờ tải/);
    expect(H.ghiSo).not.toHaveBeenCalled();
    expect(lenhGhiAnh()).toHaveLength(0);
    // Người dùng xem lại rồi bấm lần nữa: chi bằng chứng từ của ảnh còn trên phiếu.
    fireEvent.click(screen.getByRole('button', { name: 'Chi' }));
    await waitFor(() => expect(H.ghiSo).toHaveBeenCalledTimes(1));
    expect(H.ghiSo.mock.calls[0][0].evidenceIds).toEqual([EV_CU]);
  });

  it('đóng hộp khi ảnh đang tải: huỷ thật lệnh tải', async () => {
    const tai = taiCho();
    render(<Khung />);
    chon();
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ bỏ' }));
    await waitFor(() => expect(tai.opts().resilient?.signal?.aborted).toBe(true));
    expect(H.ghiSo).not.toHaveBeenCalled();
  });

  it('chọn 4 ảnh: tải cùng lúc tối đa 3 tấm, xong một tấm thì tấm thứ tư mới đi', async () => {
    const lenh = [taiCho(), taiCho(), taiCho(), taiCho()];
    render(<Khung />);
    chon('a.png', 'b.png', 'c.png', 'd.png');
    expect(document.querySelectorAll('[data-evidence-pending]')).toHaveLength(4);
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(3));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(H.taiLen).toHaveBeenCalledTimes(3);
    lenh[0].xong();
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(4));
    expect((H.taiLen.mock.calls[3][2] as File).name).toBe('d.png');
  });
});
