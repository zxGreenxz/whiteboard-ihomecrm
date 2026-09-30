// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-demo' }, isLoading: false, isError: false }) }));
import { OrganizationProvider } from '../OrganizationContext';
import AccountOrganizationCard from '@/components/account/AccountOrganizationCard';
let client: QueryClient;
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId','org-demo'); h.rpc.mockReset(); client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}}); });
afterEach(() => { cleanup(); client.clear(); });
it('invalid directory shows recoverable read error, keeps saved choice and does not claim no company', async () => {
 h.rpc.mockResolvedValueOnce({data:{organizations:'invalid'},error:null});
 render(<QueryClientProvider client={client}><OrganizationProvider><AccountOrganizationCard variant="mobile"/></OrganizationProvider></QueryClientProvider>);
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa tải được danh sách công ty'));
 expect(screen.queryByText(/Tài khoản chưa có công ty khả dụng/)).toBeNull();
 expect(localStorage.getItem('ihomecrm.selectedOrganizationId')).toBe('org-demo');
 h.rpc.mockResolvedValueOnce({data:{organizations:[{id:'org-demo',name:'Công ty Demo',slug:null,member_type:'OWNER'}]},error:null});
 fireEvent.click(screen.getByRole('button',{name:'Thử lại'}));
 await waitFor(() => expect(screen.getByRole('combobox').getAttribute('disabled')).toBeNull());
 expect(screen.getByRole('combobox')).toHaveProperty('value','org-demo');
});
