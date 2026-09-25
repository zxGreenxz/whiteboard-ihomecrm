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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import AttachmentUpload from '../AttachmentUpload';

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
