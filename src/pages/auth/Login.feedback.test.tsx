// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('@/hooks/useAuth', () => ({ useLogin: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/lib/appSplash', () => ({ hideAppSplash: vi.fn() }));
import Login from './Login';
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(cleanup);
it('đăng nhập thiếu tài khoản focus ô đầu sai và giữ lỗi truy cập được', async () => {
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Login /></MemoryRouter>);
  fireEvent.submit(screen.getByLabelText('Tài Khoản').closest('form')!);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Tài Khoản')));
  expect(screen.getByLabelText('Tài Khoản').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByLabelText('Mật khẩu').getAttribute('aria-invalid')).toBe('true');
});
