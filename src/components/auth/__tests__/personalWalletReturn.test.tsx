// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from '../ProtectedRoute';
import PublicRoute from '../PublicRoute';
import Login from '@/pages/auth/Login';

const auth = vi.hoisted(() => ({ getSession: vi.fn(), signInWithPassword: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const user = { id: 'personal-user-with-no-selected-company' };
const target = '/finance/personal-wallet?month=2026-10#transactions';

function Location() {
  const location = useLocation();
  return <output aria-label="current route">{location.pathname + location.search + location.hash}</output>;
}

function mount(entry: string | { pathname: string; search?: string; state?: unknown }, signedIn = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['auth', 'user'], signedIn ? user : null);
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Location />
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/forgot-password" element={<PublicRoute>Recover</PublicRoute>} />
          <Route path="/finance/personal-wallet" element={<ProtectedRoute><h1>Ví cá nhân</h1></ProtectedRoute>} />
          <Route path="/" element={<h1>Trang chủ</h1>} />
          <Route path="*" element={<h1>Other</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

beforeEach(() => {
  // jsdom has no layout observer; Radix Checkbox needs the browser API.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.signInWithPassword.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('personal wallet login return', () => {
  it('persists full requested route in the login URL, including query and fragment', async () => {
    mount(target);
    await screen.findByRole('button', { name: 'Đăng nhập' });
    expect(screen.getByLabelText('current route').textContent).toBe('/login?next=%2Ffinance%2Fpersonal-wallet%3Fmonth%3D2026-10%23transactions');
  });

  it('returns an already authenticated login entry to the wallet without company selection', async () => {
    mount('/login?next=%2Ffinance%2Fpersonal-wallet%3Fmonth%3D2026-10%23transactions', true);
    await screen.findByRole('heading', { name: 'Ví cá nhân' });
    expect(screen.getByLabelText('current route').textContent).toBe(target);
  });

  it.each([false, true])('login URL reload survives login success (auth event wins race: %s)', async (eventFirst) => {
    let finish!: (result: unknown) => void;
    auth.signInWithPassword.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const app = mount('/login?next=%2Ffinance%2Fpersonal-wallet%3Fmonth%3D2026-10%23transactions');
    // No router state is supplied: this is the URL after a document reload.
    fireEvent.change(screen.getByLabelText('Tài Khoản'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'fixture-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Đăng nhập' }).closest('form')!);
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalled());
    auth.getSession.mockResolvedValue({ data: { session: { user } }, error: null });
    if (eventFirst) {
      await act(async () => { app.client.setQueryData(['auth', 'user'], user); });
      await screen.findByRole('heading', { name: 'Ví cá nhân' });
    }
    await act(async () => { finish({ data: { user, session: { user } }, error: null }); });
    await screen.findByRole('heading', { name: 'Ví cá nhân' });
    expect(screen.getByLabelText('current route').textContent).toBe(target);
  });

  it('uses safe legacy state only when next is absent', async () => {
    mount({ pathname: '/login', state: { from: { pathname: '/finance/personal-wallet', search: '?month=2026-10', hash: '#transactions' } } }, true);
    await screen.findByRole('heading', { name: 'Ví cá nhân' });
    expect(screen.getByLabelText('current route').textContent).toBe(target);
  });

  it.each([
    '/login', '/login?next=https%3A%2F%2Fevil.example', '/login?next=%2F%2Fevil.example',
    '/login?next=%2F%5Cevil.example', '/login?next=%2F%252fevil.example',
    '/login?next=%2Flogin', '/login?next=%2FLOGIN%2F', '/login?next=%2Fforgot-password',
    '/login?next=%2Freset-password%3Ftoken%3Dx', '/login?next=%2Ffoo%2F..%2Flogin',
    '/forgot-password?next=%2Ffinance%2Fpersonal-wallet',
  ])('keeps unsafe, looping and ordinary auth entry at home: %s', async (entry) => {
    mount(entry, true);
    await screen.findByRole('heading', { name: 'Trang chủ' });
    expect(screen.getByLabelText('current route').textContent).toBe('/');
  });

  it('an invalid explicit next does not revive stale legacy state', async () => {
    mount({ pathname: '/login', search: '?next=https://evil.example', state: { from: { pathname: '/finance/personal-wallet' } } }, true);
    await screen.findByRole('heading', { name: 'Trang chủ' });
  });
});
