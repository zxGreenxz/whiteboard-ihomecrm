// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

// K11-37: trang Ví (cả tab Cá nhân, qua khung nhập phiếu công ty) nạp ảnh chụp ví công ty.
// Lỗi phải hiện tại chỗ, KHÔNG bắn toast toàn cục mỗi lần mở trang.
const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: h.toast } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'owner' }, isLoading: false, error: null }) }));
vi.mock('@/lib/companyWallet/transport', () => ({ createCompanyWalletTransport: () => ({}) }));
vi.mock('@/lib/companyWallet/service', async (importOriginal) => {
 const actual = await importOriginal<typeof import('@/lib/companyWallet/service')>();
 return { ...actual, createCompanyWalletService: () => ({ snapshot: () => Promise.reject(new actual.CompanyWalletError('permission', 'company_wallet_permission: organization')) }) };
});
import { xuLyLoiQuery } from '@/app/providers/QueryProvider';
import { useCompanyWallets } from '../useCompanyWallets';

afterEach(cleanup);

it('snapshot failure is shown inline by the wallet screen, never as a global toast', async () => {
 const client = new QueryClient({ queryCache: new QueryCache({ onError: (error, query) => xuLyLoiQuery(error, query as never) }), defaultOptions: { queries: { retry: false } } });
 const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
 const { result } = renderHook(() => useCompanyWallets('org'), { wrapper });
 await waitFor(() => expect(result.current.isError).toBe(true));
 expect(client.getQueryCache().find({ queryKey: ['company-wallets', 'owner', 'org'] })?.meta).toMatchObject({ errorDisplay: 'inline' });
 await new Promise(resolve => setTimeout(resolve, 20));
 expect(h.toast).not.toHaveBeenCalled();
});
