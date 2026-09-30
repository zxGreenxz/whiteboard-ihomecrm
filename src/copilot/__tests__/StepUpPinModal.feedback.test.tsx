// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const verify = vi.hoisted(() => vi.fn());
vi.mock('../plan/stepUpClient', () => ({ xacThucPin: verify }));
import StepUpPinModal from '../StepUpPinModal';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it.each([['pin_invalid', 'PIN không đúng.', 2, null], ['pin_locked', 'PIN đang bị khóa.', null, 60]])('PIN %s hiện mô tả, đỏ đúng nhóm ô và focus ô đầu', async (code, message, attempts, seconds) => {
 verify.mockResolvedValue({ ok: false, maLoi: code, thongBao: message, soLanConLai: attempts, khoaConGiay: seconds });
 const done = vi.fn(); render(<StepUpPinModal organizationId="org" onXacThucXong={done} onHuy={vi.fn()} />);
 fireEvent.change(screen.getByTestId('copilot-step-up-digit-0'), { target: { value: '9284' } }); fireEvent.click(screen.getByTestId('copilot-step-up-submit'));
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message)); expect(done).not.toHaveBeenCalled(); expect(document.activeElement).toBe(screen.getByTestId('copilot-step-up-digit-0'));
 for (let i = 0; i < 4; i++) { expect(screen.getByTestId(`copilot-step-up-digit-${i}`).getAttribute('aria-invalid')).toBe('true'); expect(screen.getByTestId(`copilot-step-up-digit-${i}`).getAttribute('aria-describedby')).toBe('copilot-pin-error'); }
 expect(screen.getByRole('alert').textContent).toContain(seconds ? '60 giây' : '2 lần thử');
});
it('transport reject giữ PIN và kết thúc pending với lỗi an toàn', async () => {
 verify.mockRejectedValue(new Error('private transport body')); render(<StepUpPinModal organizationId="org" onXacThucXong={vi.fn()} onHuy={vi.fn()} />);
 fireEvent.change(screen.getByTestId('copilot-step-up-digit-0'), { target: { value: '9284' } }); fireEvent.click(screen.getByTestId('copilot-step-up-submit'));
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác thực được PIN')); expect(document.body.textContent).not.toContain('private transport body'); expect((screen.getByTestId('copilot-step-up-digit-0') as HTMLInputElement).value).toBe('9'); expect(screen.getByTestId('copilot-step-up-cancel').hasAttribute('disabled')).toBe(false);
});
