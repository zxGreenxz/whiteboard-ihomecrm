// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ invokeRpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
 auth: { onAuthStateChange: () => ({data:{subscription:{unsubscribe:()=>undefined}}}), getSession: async()=>({data:{session:{user:{id:'user-demo'},access_token:`header.${btoa(JSON.stringify({sub:'user-demo'}))}.signature`}},error:null}) },
 rpc: (...args: unknown[]) => { const result = args[0]==='set_my_ui_preference' ? Promise.resolve({data:{selectedOrganizationId:(args[1] as {p_value:string}).p_value},error:null}) : h.invokeRpc(...args); return {setHeader:()=>result,then:result.then.bind(result)}; },
 from:()=>({select:()=>({eq:()=>({single:()=>({setHeader:async()=>({data:{ui_preferences:{}},error:null})})})})})
} }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-demo' }, isLoading: false, isError: false }) }));
import { OrganizationProvider } from '../OrganizationContext';
import AccountOrganizationCard from '@/components/account/AccountOrganizationCard';
let client: QueryClient;
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId','org-demo'); h.invokeRpc.mockReset(); client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}}); });
afterEach(() => { cleanup(); client.clear(); });
it('invalid directory shows recoverable read error, keeps saved choice and does not claim no company', async () => {
 h.invokeRpc.mockResolvedValueOnce({data:{organizations:'invalid'},error:null});
 render(<QueryClientProvider client={client}><OrganizationProvider><AccountOrganizationCard variant="mobile"/></OrganizationProvider></QueryClientProvider>);
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa tải được danh sách công ty'));
 expect(screen.queryByText(/Tài khoản chưa có công ty khả dụng/)).toBeNull();
 expect(JSON.parse(localStorage.getItem('ihomecrm.selectedOrganizationId:user-demo')!).id).toBe('org-demo');
 expect(localStorage.getItem('ihomecrm.selectedOrganizationId')).toBeNull();
 h.invokeRpc.mockResolvedValueOnce({data:{organizations:[{id:'org-demo',name:'Công ty Demo',slug:null,member_type:'OWNER'}]},error:null});
 fireEvent.click(screen.getByRole('button',{name:'Thử lại'}));
 await waitFor(() => expect(screen.getByRole('combobox').getAttribute('disabled')).toBeNull());
 expect(screen.getByRole('combobox')).toHaveProperty('value','org-demo');
});
