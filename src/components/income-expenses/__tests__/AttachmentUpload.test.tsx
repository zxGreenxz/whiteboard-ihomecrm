// @vitest-environment jsdom
// =============================================================================
// AttachmentUpload — nút X chỉ xoá file khỏi kho khi file do CHÍNH lần mở
// form/hộp này tải lên (E1, chủ chốt 25/09/2026).
//
// Lỗi cũ: X luôn xoá file khỏi Storage. Form Sửa, form Tạo bản sao (dùng CHUNG
// URL ảnh với phiếu gốc) và hộp Duyệt đều nạp ảnh có sẵn vào đây — bấm X để bỏ
// ảnh khỏi form là làm phiếu gốc mất chứng từ.
// =============================================================================

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  taiLen: vi.fn(),
  xoaFile: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  uploadFile: (...a: unknown[]) => H.taiLen(...a),
  deleteFile: (...a: unknown[]) => H.xoaFile(...a),
}));
vi.mock('@/components/ui/storage-image', () => ({
  StorageImage: ({ value, alt }: { value: string; alt: string }) => <img src={value} alt={alt} />,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

vi.mock('@/lib/storage/resilientUpload', () => ({ warmUploadConnection: vi.fn() }));

import AttachmentUpload, { validateAttachmentFile } from '../AttachmentUpload';

const BUCKET = 'income-expense-attachments';
const KHO = `https://kho.test/storage/v1/object/public/${BUCKET}/`;
const USER = '00000000-0000-4000-8000-0000000000aa';
/** Ảnh của phiếu gốc — nằm đúng thư mục của người đang thao tác, như ngoài đời. */
const ANH_CU = `${KHO}${USER}/1758700000000-phieu-goc.png`;

function Khung({ dau, deleteOnRemove }: { dau: string[]; deleteOnRemove?: boolean }) {
  const [anh, setAnh] = useState(dau);
  return (
    <>
      <AttachmentUpload
        attachments={anh}
        onChange={setAnh}
        userId={USER}
        deleteOnRemove={deleteOnRemove}
      />
      <output data-testid="ds">{anh.join('|')}</output>
    </>
  );
}

const danhSach = () => screen.getByTestId('ds').textContent;

function nutGo(url: string) {
  const anh = screen.getAllByRole('img').find((i) => i.getAttribute('src') === url);
  if (!anh?.parentElement) throw new Error(`Không thấy ảnh ${url}`);
  return within(anh.parentElement).getByRole('button', { name: 'Gỡ tệp đính kèm' });
}

/** Chọn một ảnh mới qua ô chọn tệp; trả URL + đường dẫn mà kho đã nhận. */
async function taiAnhMoi() {
  const soLanTruoc = H.taiLen.mock.calls.length;
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'bien-lai.png', { type: 'image/png' })] },
  });
  await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(soLanTruoc + 1));
  const path = H.taiLen.mock.calls[soLanTruoc][1] as string;
  const url = `${KHO}${path}`;
  await waitFor(() => expect(danhSach()).toContain(url));
  return { url, path };
}

beforeEach(() => {
  H.taiLen.mockReset().mockImplementation(
    async (bucket: string, path: string) =>
      `https://kho.test/storage/v1/object/public/${bucket}/${path}`,
  );
  H.xoaFile.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('AttachmentUpload — X chỉ xoá file tải lên trong lần mở này (E1)', () => {
  it('giữ tệp và lỗi có tên khi xóa kho thất bại', async () => {
    render(<Khung dau={[]} />);
    const { url } = await taiAnhMoi();
    H.xoaFile.mockRejectedValueOnce(new Error('permission denied for bucket private'));
    fireEvent.click(nutGo(url));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xóa được'));
    expect(danhSach()).toContain(url);
    expect(screen.getByRole('alert').textContent).not.toContain('bucket');
  });
  it('tải một phần giữ tên tệp lỗi và chỉ thử lại tệp đó', async () => {
    render(<Khung dau={[]} />);
    H.taiLen.mockRejectedValueOnce(new Error('R2 upload failed: secret SQL'));
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [
      new File(['a'], 'loi.png', { type: 'image/png' }),
      new File(['b'], 'duoc.png', { type: 'image/png' }),
    ] } });
    await waitFor(() => expect(screen.getByText(/Đã tải 1\/2 tệp/)).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('loi.png');
    expect(screen.getByRole('alert').textContent).not.toMatch(/secret|SQL|R2/);
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại loi.png' }));
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(3));
    expect(H.taiLen.mock.calls[2][2].name).toBe('loi.png');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Thử lại loi.png' })).toBeNull());
  });
  it('X trên ảnh có sẵn chỉ gỡ khỏi danh sách của form, KHÔNG xoá file trong kho', async () => {
    render(<Khung dau={[ANH_CU]} />);
    fireEvent.click(nutGo(ANH_CU));
    await waitFor(() => expect(danhSach()).toBe(''));
    expect(H.xoaFile).not.toHaveBeenCalled();
  });

  it('X trên ảnh vừa tải trong lần mở này xoá đúng file đó khỏi kho, ảnh cũ còn nguyên', async () => {
    render(<Khung dau={[ANH_CU]} />);
    const { url, path } = await taiAnhMoi();
    expect(path.startsWith(`${USER}/`)).toBe(true);

    fireEvent.click(nutGo(url));
    await waitFor(() => expect(H.xoaFile).toHaveBeenCalledWith(BUCKET, path));
    expect(H.xoaFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(danhSach()).toBe(ANH_CU));
  });

  it('lần mở sau coi ảnh tải ở lần trước là ảnh có sẵn (không xoá)', async () => {
    const lanDau = render(<Khung dau={[]} />);
    const { url } = await taiAnhMoi();
    lanDau.unmount();

    render(<Khung dau={[url]} />);
    fireEvent.click(nutGo(url));
    await waitFor(() => expect(danhSach()).toBe(''));
    expect(H.xoaFile).not.toHaveBeenCalled();
  });

  it('deleteOnRemove={false} giữ nghĩa cũ: X không bao giờ xoá file, kể cả ảnh vừa tải', async () => {
    render(<Khung dau={[]} deleteOnRemove={false} />);
    const { url } = await taiAnhMoi();
    fireEvent.click(nutGo(url));
    await waitFor(() => expect(danhSach()).toBe(''));
    expect(H.xoaFile).not.toHaveBeenCalled();
  });
});

// Chủ chốt 03/10/2026: tải nhanh và chịu mạng chập chờn — đi đường tải mới (có %,
// tự tải lại, huỷ thật), giới hạn 5 MB tính SAU khi nén, chọn nhiều tải song song.
describe('AttachmentUpload — tải nhanh, chịu mạng chập chờn', () => {
  type TuyChon = { imagePolicy?: string; maxBytes?: number; resilient?: { signal?: AbortSignal; onProgress?: (p: unknown) => void } };
  const chon = (files: File[]) =>
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } });
  const anh = (ten: string) => new File(['x'], ten, { type: 'image/png' });

  it('kho ảnh thu chi: ảnh camera gốc 8 MB không bị từ chối oan — 5 MB tính SAU khi nén', () => {
    const nenTruoc = { compressFirst: true };
    expect(validateAttachmentFile({ type: 'image/jpeg', size: 8 * 1024 * 1024 }, nenTruoc)).toBeNull();
    expect(validateAttachmentFile({ type: 'image/jpeg', size: 26 * 1024 * 1024 }, nenTruoc)).toBe('Ảnh gốc tối đa 25MB');
    expect(validateAttachmentFile({ type: 'application/pdf', size: 6 * 1024 * 1024 }, nenTruoc)).toBe('Kích thước file tối đa 5MB');
    expect(validateAttachmentFile({ type: 'image/heic', size: 1 }, nenTruoc)).toBe('Chỉ chấp nhận file JPG, PNG, PDF');
    // Kho khác (ảnh công việc…) giữ luật cũ: 5 MB trên tệp gốc.
    expect(validateAttachmentFile({ type: 'image/jpeg', size: 8 * 1024 * 1024 })).toBe('Kích thước file tối đa 5MB');
  });

  it('kho khác (ảnh công việc): vẫn đi đường cũ, không đổi tham số tải, tải LẦN LƯỢT như cũ', async () => {
    const xong: Array<() => void> = [];
    H.taiLen.mockImplementation((_b: string, path: string) =>
      new Promise<string>((r) => { xong.push(() => r(`${KHO}${path}`)); }));
    render(
      <AttachmentUpload attachments={[]} onChange={() => {}} userId={USER} bucket="job-attachments" />,
    );
    chon([anh('cua.png'), anh('tuong.png')]);
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    expect(H.taiLen.mock.calls[0]).toHaveLength(3);
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(H.taiLen).toHaveBeenCalledTimes(1); // đường cũ có hạn cứng mỗi lệnh: không chia băng thông
    act(() => xong[0]());
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(2));
    act(() => xong[1]());
  });

  it('ảnh sau nén vẫn quá 5 MB: báo rõ lý do, KHÔNG mời "Thử lại" vô ích', async () => {
    const { UploadTooLargeError } = await import('@/lib/uploadDeadline');
    H.taiLen.mockRejectedValueOnce(new UploadTooLargeError(6 * 1024 * 1024, 5 * 1024 * 1024));
    render(<Khung dau={[]} />);
    chon([anh('to.png')]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('sau khi nén vẫn lớn hơn 5MB'));
    expect(screen.queryByRole('button', { name: 'Thử lại to.png' })).toBeNull();
  });

  it('tải bằng đường chịu mạng chập chờn: nén kiểu chứng từ, chặn 5 MB sau nén, có %', async () => {
    let bao: ((p: unknown) => void) | undefined;
    let xong: (url: string) => void = () => {};
    H.taiLen.mockImplementationOnce((_b: string, path: string, _f: File, o: TuyChon) => {
      bao = o.resilient?.onProgress;
      return new Promise<string>((r) => { xong = () => r(`${KHO}${path}`); });
    });
    render(<Khung dau={[]} />);
    chon([anh('bill.png')]);
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    expect(H.taiLen.mock.calls[0][3]).toMatchObject({ imagePolicy: 'evidence', maxBytes: 5 * 1024 * 1024 });
    act(() => bao?.({ loaded: 30, total: 100, attempt: 1, phase: 'sending' }));
    await screen.findByText('Đang tải lên... 30%');
    act(() => xong(''));
    await waitFor(() => expect(danhSach()).not.toBe(''));
  });

  it('chọn 4 ảnh: tải cùng lúc tối đa 3, danh sách giữ đúng thứ tự đã chọn', async () => {
    const xong: Array<() => void> = [];
    H.taiLen.mockImplementation((_b: string, path: string) =>
      new Promise<string>((r) => { xong.push(() => r(`${KHO}${path}`)); }));
    render(<Khung dau={[]} />);
    chon(['a.png', 'b.png', 'c.png', 'd.png'].map(anh));
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(3));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(H.taiLen).toHaveBeenCalledTimes(3);
    act(() => xong[1]());
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(4));
    act(() => { xong[0](); xong[2](); xong[3](); });
    await waitFor(() => expect(danhSach()!.split('|')).toHaveLength(4));
    const thuTu = danhSach()!.split('|').map((u) => u.replace(/^.*-/, ''));
    expect(thuTu).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
    // Tên tệp có đuôi ngẫu nhiên: tải song song cùng mili-giây không trùng khoá.
    const khoa = H.taiLen.mock.calls.map((c) => c[1] as string);
    expect(new Set(khoa).size).toBe(4);
  });

  it('đóng form khi đang tải: huỷ THẬT lệnh tải, không thêm ảnh mồ côi', async () => {
    let tin: AbortSignal | undefined;
    H.taiLen.mockImplementationOnce((_b: string, _p: string, _f: File, o: TuyChon) => {
      tin = o.resilient?.signal;
      return new Promise<string>((_, reject) => {
        tin?.addEventListener('abort', () => reject(new DOMException('huỷ', 'AbortError')));
      });
    });
    const { unmount } = render(<Khung dau={[]} />);
    chon([anh('bill.png')]);
    await waitFor(() => expect(H.taiLen).toHaveBeenCalledTimes(1));
    unmount();
    expect(tin?.aborted).toBe(true);
  });
});
