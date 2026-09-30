// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
 pin: vi.fn(), unlock: vi.fn(), reset: vi.fn(), create: vi.fn(), revokeAll: vi.fn(), policy: vi.fn(),
 auth: vi.fn(), grantSourceError: false, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'admin' }) }));
vi.mock('sonner', () => ({ toast: m.toast }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { signInWithPassword: m.auth } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'admin', email: 'admin@example.com' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsSuperAdmin: () => ({ data: true }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org', organizations: [{ id: 'org', name: 'Công ty' }], selectOrganization: vi.fn() }) }));
vi.mock('../../plan/actionCatalog', () => ({ ACTION_CATALOG: {}, hanhDongConDung: () => [{ actionId: 'action', labelVi: 'Tạo nháp' }] }));
vi.mock('../../plan/stepUpClient', () => ({
 trangThaiPin: async () => ({ ok: true, trangThai: { daDat: false, failedAttempts: 0, lockedUntil: null } }),
 datPin: m.pin, moKhoaPinStepUp: m.unlock, resetPinStepUp: m.reset, tieuTokenStepUp: () => 'token',
}));
vi.mock('../../plan/standingGrantClient', () => ({
 dsGrant: async () => ({ ok: !m.grantSourceError, maLoi: 'private grants diagnostic', danhSach: [{ grantId: 'g', actionId: 'action', maxPerDay: 1, usedToday: 0, expiresAt: null, revokedAt: null }] }),
 baoCaoNgayGrant: async () => ({ ok: true, ke: [], tongTien: 0, ngay: '2026-09-30' }),
 taoGrant: m.create, thuHoiGrant: vi.fn(), thuHoiTatCaGrant: m.revokeAll,
}));
vi.mock('../hanhDongCopilot', () => ({
 SO_DONG_SO_MAC_DINH: 50, docChinhSachHanhDong: async () => ({ revision: 1, maxDirectRisk: 'L3', allowedRoles: ['superadmin'], standingGrantsEnabled: false }),
 docSoHanhDong: async () => [], doiChinhSachHanhDong: m.policy, locSuKienKeHoach: () => [], nhanSuKien: (v: string) => v,
 dinhDangThoiGian: (v: string | null) => v ?? '—', dienGiaiLoiChinhSach: () => 'Chưa đổi được chính sách.',
}));
vi.mock('../../StepUpPinModal', () => ({ default: () => <div data-testid="pin-modal" /> }));
import HanhDongTab from '../HanhDongTab';
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><HanhDongTab /></QueryClientProvider>);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); m.grantSourceError = false; m.auth.mockResolvedValue({ error: null }); });
afterEach(cleanup);
const settled = async () => { await screen.findByText('Chưa đặt PIN.'); await waitFor(() => expect(screen.getByRole('button', { name: 'Đổi chính sách' }).hasAttribute('disabled')).toBe(false)); };
it('lý do chính sách thiếu: hiện đỏ và focus, không gửi RPC', async () => {
 mount(); await settled(); fireEvent.click(screen.getByRole('button', { name: 'Đổi chính sách' }));
 await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Lý do bắt buộc')));
 expect(screen.getByLabelText('Lý do bắt buộc').getAttribute('aria-invalid')).toBe('true'); expect(m.policy).not.toHaveBeenCalled();
});
it('PIN mới sai: giữ nguyên chuỗi và focus, không re-auth', async () => {
 mount(); await screen.findByText('Chưa đặt PIN.'); fireEvent.change(screen.getByTestId('copilot-admin-pin-new'), { target: { value: '12a' } });
 fireEvent.click(screen.getByTestId('copilot-admin-pin-submit'));
 await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('copilot-admin-pin-new')));
 expect((screen.getByTestId('copilot-admin-pin-new') as HTMLInputElement).value).toBe('12a'); expect(m.auth).not.toHaveBeenCalled();
});
it('mật khẩu bị từ chối: lỗi ngay trường mật khẩu, giữ PIN', async () => {
 m.auth.mockResolvedValue({ error: { message: 'private auth diagnostic' } }); mount(); await screen.findByText('Chưa đặt PIN.');
 fireEvent.change(screen.getByTestId('copilot-admin-pin-new'), { target: { value: '9284' } }); fireEvent.change(screen.getByTestId('copilot-admin-pin-password'), { target: { value: 'wrong' } });
 fireEvent.click(screen.getByTestId('copilot-admin-pin-submit'));
 await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('copilot-admin-pin-password')));
 expect(screen.getByTestId('copilot-admin-pin-password').getAttribute('aria-invalid')).toBe('true'); expect((screen.getByTestId('copilot-admin-pin-new') as HTMLInputElement).value).toBe('9284'); expect(m.pin).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('private auth diagnostic');
});
it('hạn mức âm không bị bỏ thành không giới hạn trước khi mở PIN', async () => {
 mount(); await screen.findByText('Chưa đặt PIN.'); fireEvent.change(screen.getByTestId('copilot-admin-grant-action'), { target: { value: 'action' } });
 fireEvent.change(screen.getByTestId('copilot-admin-grant-reason'), { target: { value: 'Cấp thử' } }); fireEvent.change(screen.getByTestId('copilot-admin-grant-max-amount'), { target: { value: '-100' } });
 fireEvent.click(screen.getByTestId('copilot-admin-grant-submit'));
 await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('copilot-admin-grant-max-amount')));
 expect(screen.getByTestId('copilot-admin-grant-max-amount').getAttribute('aria-invalid')).toBe('true'); expect(screen.queryByTestId('pin-modal')).toBeNull();
});
it('mở khoá thiếu biên nhận: không success hoặc xóa đầu vào và chặn chạy lại', async () => {
 m.unlock.mockResolvedValue({ ok: true, daMoKhoa: false, userId: null }); mount(); await screen.findByText('Chưa đặt PIN.');
 fireEvent.change(screen.getByTestId('copilot-admin-pin-unlock-userid'), { target: { value: '11111111-1111-4111-8111-111111111111' } }); fireEvent.change(screen.getByTestId('copilot-admin-pin-unlock-reason'), { target: { value: 'Mở cho nhân viên' } });
 fireEvent.click(screen.getByTestId('copilot-admin-pin-unlock-submit'));
 await waitFor(() => expect(screen.getAllByRole('alert').some(el => el.textContent?.includes('Chưa xác nhận'))).toBe(true));
 expect((screen.getByTestId('copilot-admin-pin-unlock-reason') as HTMLInputElement).value).toBe('Mở cho nhân viên'); expect(m.toast.success).not.toHaveBeenCalled(); expect(screen.getByTestId('copilot-admin-pin-unlock-submit').hasAttribute('disabled')).toBe(true);
});
it('thu hồi tất cả trả count null không giả 0 hoặc success', async () => {
 m.revokeAll.mockResolvedValue({ ok: true, soLuongThuHoi: null }); mount(); await screen.findByText('Chưa đặt PIN.');
 fireEvent.change(screen.getByTestId('copilot-admin-grant-revoke-all-reason'), { target: { value: 'Dừng toàn bộ để kiểm tra' } }); fireEvent.click(screen.getByTestId('copilot-admin-grant-revoke-all'));
 await waitFor(() => expect(screen.getAllByRole('alert').some(el => el.textContent?.includes('Chưa xác nhận'))).toBe(true)); expect(m.toast.success).not.toHaveBeenCalled();
 expect((screen.getByTestId('copilot-admin-grant-revoke-all-reason') as HTMLInputElement).value).toBe('Dừng toàn bộ để kiểm tra');
});

it('RESET thiếu thì chỉ focus xác nhận, không gọi reset dù user/lý do hợp lệ', async () => {
 mount(); await screen.findByText('Chưa đặt PIN.');
 fireEvent.change(screen.getByTestId('copilot-admin-pin-unlock-userid'), { target: { value: '11111111-1111-4111-8111-111111111111' } }); fireEvent.change(screen.getByTestId('copilot-admin-pin-unlock-reason'), { target: { value: 'Quên PIN đăng nhập' } });
 fireEvent.click(screen.getByTestId('copilot-admin-pin-reset-submit'));
 await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('copilot-admin-pin-reset-confirm'))); expect(m.reset).not.toHaveBeenCalled();
});
it('policy receipt null giữ lý do, không báo đổi chính sách và khóa gửi lại', async () => {
 m.policy.mockResolvedValue(null); mount(); await settled(); fireEvent.change(screen.getByLabelText('Lý do bắt buộc'), { target: { value: 'Mở pilot' } }); fireEvent.change(screen.getByLabelText('Liên kết bằng chứng'), { target: { value: 'ticket-1' } });
 fireEvent.click(screen.getByRole('button', { name: 'Đổi chính sách' }));
 await waitFor(() => expect(screen.getAllByRole('alert').some(el => el.textContent?.includes('Chưa xác nhận'))).toBe(true)); expect((screen.getByLabelText('Lý do bắt buộc') as HTMLInputElement).value).toBe('Mở pilot'); expect(m.toast.success).not.toHaveBeenCalled();
 expect(screen.getByRole('button', { name: 'Đổi chính sách' }).hasAttribute('disabled')).toBe(true);
});

it('danh sách grant lỗi không giả rỗng hoặc cho cấp mặc định', async () => {
 m.grantSourceError = true; mount(); await screen.findByText('Chưa đặt PIN.'); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa tải được'));
 expect(screen.queryByTestId('copilot-admin-grant-submit')).toBeNull(); expect(screen.queryByText('Chưa có hạn mức nào cho công ty này.')).toBeNull(); expect(document.body.textContent).not.toContain('private grants diagnostic');
});

it('unlock unknown sau remount giữ barrier và không gửi RPC lần hai', async () => {
 const userId = '11111111-1111-4111-8111-111111111111'; m.unlock.mockResolvedValue({ ok: true, daMoKhoa: true, userId: 'another-user' });
 const fill = () => { fireEvent.change(screen.getByTestId('copilot-admin-pin-unlock-userid'), { target: { value: userId } }); fireEvent.change(screen.getByTestId('copilot-admin-pin-unlock-reason'), { target: { value: 'Đối chiếu tài khoản' } }); };
 const first = mount(); await screen.findByText('Chưa đặt PIN.'); fill(); fireEvent.click(screen.getByRole('button', { name: 'Mở khoá' })); await waitFor(() => expect(m.unlock).toHaveBeenCalledOnce()); first.unmount();
 mount(); await screen.findByText('Chưa đặt PIN.'); fill(); fireEvent.click(screen.getByRole('button', { name: 'Mở khoá' })); await waitFor(() => expect(screen.getAllByRole('alert').some(node => /Chưa xác nhận/.test(node.textContent ?? ''))).toBe(true)); expect(m.unlock).toHaveBeenCalledOnce();
});
