// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Không ca nào được chạm Supabase thật (.env của worktree trỏ production): client giả chỉ có
// `functions.invoke`. Hook + wrapper + hộp thoại chạy thật phía trên nó.
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: h.invoke } } }));

import { RESET_PASSWORD_UNKNOWN_MESSAGE } from '@/lib/edgeFunctions';
import { RANDOM_PASSWORD_ALPHABET } from '@/lib/resetUserPassword';
import { ResetUserPasswordDialog, type ResetUserPasswordTarget } from '../ResetUserPasswordDialog';

const A: ResetUserPasswordTarget = { userId: 'u-a', name: 'Nguyễn Văn A' };
const B: ResetUserPasswordTarget = { userId: 'u-b', name: 'Trần Thị B' };

const THANH_CONG = { data: { ok: true, via: 'COMPANY_OWNER' }, error: null };
/** Lỗi non-2xx đúng hình supabase-js: `context` giống Response (status + json()). */
const loiHttp = (status: number, body: unknown) => ({
  data: null,
  error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => body } },
});

let queryClient: QueryClient;
const onOpenChange = vi.fn();

const ve = (target: ResetUserPasswordTarget | null) => (
  <QueryClientProvider client={queryClient}>
    <ResetUserPasswordDialog target={target} onOpenChange={onOpenChange} />
  </QueryClientProvider>
);

const oMatKhau = () => screen.getByLabelText('Mật khẩu mới') as HTMLInputElement;
const nutGui = () => screen.getByRole('button', { name: 'Đặt lại mật khẩu' }) as HTMLButtonElement;
const datClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value });

function guiMatKhau(matKhau: string) {
  fireEvent.change(oMatKhau(), { target: { value: matKhau } });
  fireEvent.click(nutGui());
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  h.invoke.mockReset();
  onOpenChange.mockReset();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('ResetUserPasswordDialog', () => {
  it('ô username ẩn mang tên đăng nhập của NGƯỜI BỊ ĐỔI để trình quản lý mật khẩu không ghi đè mật khẩu của người bấm', () => {
    const { container, rerender } = render(ve({ ...A, login: 'nhanvien.a@username.ihomecrm.local' }));
    const o = container.ownerDocument.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(o.value).toBe('nhanvien.a@username.ihomecrm.local');
    expect(o.readOnly).toBe(true);
    expect(o.tabIndex).toBe(-1);
    rerender(ve(B));
    // Không có tên đăng nhập ⇒ dùng tên hiển thị, không bỏ trống (bỏ trống thì trình duyệt lấy tài khoản của người bấm).
    expect((container.ownerDocument.querySelector('input[autocomplete="username"]') as HTMLInputElement).value).toBe('Trần Thị B');
  });

  it('kiểm lỗi tại chỗ: báo dưới ô, aria-invalid + aria-describedby, focus ô, không gọi máy chủ', async () => {
    render(ve(A));
    expect(screen.getByRole('heading', { name: 'Đặt lại mật khẩu' })).toBeTruthy();
    expect(screen.getByText('Nguyễn Văn A')).toBeTruthy();

    const o = oMatKhau();
    guiMatKhau('abc');
    const loi = await screen.findByText('Mật khẩu phải có ít nhất 6 ký tự.');
    expect(loi.getAttribute('role')).toBe('alert');
    expect(o.getAttribute('aria-invalid')).toBe('true');
    expect(o.getAttribute('aria-describedby')?.split(' ')).toContain(loi.id);
    await waitFor(() => expect(document.activeElement).toBe(o));

    guiMatKhau('matkhau ');
    expect(await screen.findByText('Mật khẩu không được có dấu cách ở đầu hoặc cuối.')).toBeTruthy();
    guiMatKhau('');
    expect(await screen.findByText('Nhập mật khẩu mới.')).toBeTruthy();

    // Sửa ô thì lỗi cũ biến mất.
    fireEvent.change(o, { target: { value: 'abcdef' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(o.getAttribute('aria-invalid')).toBe('false');

    expect(h.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('thành công: gửi đúng người + mật khẩu, thay form bằng màn xác nhận có nút Chép, làm mới nhật ký', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    datClipboard({ writeText });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    h.invoke.mockResolvedValue(THANH_CONG);
    render(ve(A));

    guiMatKhau('MatKhau123');
    expect(await screen.findByText('Đã đặt lại mật khẩu cho Nguyễn Văn A.')).toBeTruthy();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith('admin-reset-user-password', {
      body: { userId: 'u-a', password: 'MatKhau123' },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['authz', 'organization'] });

    const daDat = oMatKhau();
    expect(daDat.value).toBe('MatKhau123');
    expect(daDat.readOnly).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(daDat));
    expect(screen.queryByRole('button', { name: 'Đặt lại mật khẩu' })).toBeNull();
    expect(
      screen.getByText('Gửi mật khẩu này cho người dùng qua kênh riêng; họ nên tự đổi lại ở trang Hồ sơ sau khi đăng nhập.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Chép' }));
    expect(await screen.findByText('Đã chép mật khẩu.')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('MatKhau123');

    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ['trình duyệt từ chối', { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) }],
    ['trang không HTTPS (không có clipboard)', undefined],
  ])('chép lỗi (%s) ⇒ báo tại chỗ, mật khẩu vẫn hiện để tự chép', async (_ten, clipboard) => {
    datClipboard(clipboard);
    h.invoke.mockResolvedValue(THANH_CONG);
    render(ve(A));
    guiMatKhau('MatKhau123');
    fireEvent.click(await screen.findByRole('button', { name: 'Chép' }));
    expect(await screen.findByText('Chưa chép được. Chọn ô mật khẩu rồi tự sao chép.')).toBeTruthy();
    expect(oMatKhau().value).toBe('MatKhau123');
  });

  it('lỗi máy chủ chắc chắn chưa đổi: hiện câu của máy chủ dưới form, giữ mật khẩu, cho gửi lại', async () => {
    h.invoke.mockResolvedValue(loiHttp(403, { error: 'forbidden', message: 'Người này còn thuộc công ty khác.' }));
    render(ve(A));

    guiMatKhau('MatKhau123');
    const canhBao = await screen.findByRole('alert');
    expect(canhBao.textContent).toBe('Người này còn thuộc công ty khác.');
    expect(oMatKhau().value).toBe('MatKhau123');
    expect(oMatKhau().type).toBe('password');
    expect(nutGui().disabled).toBe(false);
    expect(screen.queryByText(/Đã đặt lại mật khẩu cho/)).toBeNull();

    h.invoke.mockResolvedValue(THANH_CONG);
    fireEvent.click(nutGui());
    expect(await screen.findByText('Đã đặt lại mật khẩu cho Nguyễn Văn A.')).toBeTruthy();
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['mạng đứt', { data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } }],
    ['502 outcome_unknown', loiHttp(502, { error: 'outcome_unknown', message: 'Auth không trả lời rõ.' })],
    ['200 sai dạng', { data: { ok: true }, error: null }],
  ])('chưa rõ kết quả (%s): câu riêng, hiện mật khẩu để thử đăng nhập, không báo thành công', async (_ten, ketQua) => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    h.invoke.mockResolvedValue(ketQua);
    render(ve(A));

    guiMatKhau('MatKhau123');
    const canhBao = await screen.findByRole('alert');
    expect(canhBao.textContent).toBe(RESET_PASSWORD_UNKNOWN_MESSAGE);
    expect(oMatKhau().value).toBe('MatKhau123');
    expect(oMatKhau().type).toBe('text');
    expect(screen.queryByText(/Đã đặt lại mật khẩu cho/)).toBeNull();
    // Máy chủ vẫn ghi dòng UNKNOWN vào nhật ký ⇒ làm mới để trang Tổ chức thấy.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['authz', 'organization'] });
  });

  it('đang gửi: khoá nút gửi (có vòng xoay), Huỷ, Tạo ngẫu nhiên; ẩn nút đóng; không gửi lần hai', async () => {
    let traLoi: (value: unknown) => void = () => undefined;
    h.invoke.mockReturnValue(
      new Promise((resolve) => {
        traLoi = resolve;
      }),
    );
    render(ve(A));
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    guiMatKhau('MatKhau123');
    await waitFor(() => expect(nutGui().disabled).toBe(true));
    expect(nutGui().querySelector('.animate-spin')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Huỷ' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Tạo ngẫu nhiên' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    fireEvent.click(nutGui());
    expect(h.invoke).toHaveBeenCalledTimes(1);

    traLoi(THANH_CONG);
    expect(await screen.findByText('Đã đặt lại mật khẩu cho Nguyễn Văn A.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy());
  });

  it('Tạo ngẫu nhiên điền 12 ký tự không dễ nhầm và hiện chữ; nút mắt đổi hiện/ẩn', () => {
    render(ve(A));
    const o = oMatKhau();
    expect(o.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Hiện mật khẩu' }));
    expect(o.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Ẩn mật khẩu' }));
    expect(o.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Tạo ngẫu nhiên' }));
    expect(o.value).toMatch(new RegExp(`^[${RANDOM_PASSWORD_ALPHABET}]{12}$`));
    expect(o.value).not.toMatch(/[0O1lI]/);
    expect(o.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Ẩn mật khẩu' })).toBeTruthy();
  });

  it('đổi người khi đang mở, hay đóng rồi mở lại, đều xoá sạch mật khẩu, lỗi và kết quả', async () => {
    h.invoke.mockResolvedValue(loiHttp(429, { error: 'rate_limited', message: 'Đợi một phút rồi thử lại.' }));
    const view = render(ve(A));
    guiMatKhau('MatKhau123');
    expect(await screen.findByText('Đợi một phút rồi thử lại.')).toBeTruthy();

    view.rerender(ve(B));
    expect(screen.getByText('Trần Thị B')).toBeTruthy();
    expect(oMatKhau().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();

    h.invoke.mockResolvedValue(THANH_CONG);
    guiMatKhau('MatKhau456');
    expect(await screen.findByText('Đã đặt lại mật khẩu cho Trần Thị B.')).toBeTruthy();

    view.rerender(ve(null));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.rerender(ve(B));
    expect(screen.queryByText(/Đã đặt lại mật khẩu cho/)).toBeNull();
    expect(screen.queryByText('MatKhau456')).toBeNull();
    expect(oMatKhau().value).toBe('');
    expect(oMatKhau().type).toBe('password');
  });
});
