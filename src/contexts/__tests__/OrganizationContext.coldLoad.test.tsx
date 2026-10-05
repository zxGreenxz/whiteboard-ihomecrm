// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ failInitialization: true }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: {id:'actor'}, isLoading:false, isError:false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
 auth: { getSession:async()=>({data:{session:{user:{id:'actor'},access_token:`header.${btoa(JSON.stringify({sub:'actor'}))}.signature`}},error:null}), onAuthStateChange:()=>({data:{subscription:{unsubscribe:()=>undefined}}}) },
 rpc:()=>({setHeader:async()=>({data:{organizations:[{id:'org-a',name:'A'},{id:'org-b',name:'B'}]},error:null})}),
 from:()=>({select:()=>({eq:()=>({single:()=>({setHeader:async()=>({data:{ui_preferences:{selectedOrganizationId:'org-b'}},error:null})})})})})
} }));
vi.mock('@/lib/companyPreferenceRemote', async original => {
 const real = await original<typeof import('@/lib/companyPreferenceRemote')>();
 return {...real, CompanyPreferenceSession: class extends real.CompanyPreferenceSession {
   constructor(...args:ConstructorParameters<typeof real.CompanyPreferenceSession>) {
     if(h.failInitialization) throw new Error('temporary initialization failure');
     super(...args);
   }
 }};
});
import { OrganizationProvider, useOrganization } from '../OrganizationContext';
function Status(){const org=useOrganization();return <><p>{org.preferenceError}</p><output>{org.selectedOrganizationId ?? 'none'}</output><button onClick={()=>void org.refetchOrganizations()}>Retry</button><span data-testid="loading">{String(org.isLoading)}</span></>;}
let client:QueryClient;
beforeEach(()=>{localStorage.clear();h.failInitialization=true;client=new QueryClient({defaultOptions:{queries:{retry:false}}});});
afterEach(()=>{cleanup();client.clear();});
it('cold-loaded preference controller failure remains retryable and can initialize on retry',async()=>{
 render(<QueryClientProvider client={client}><OrganizationProvider><Status/></OrganizationProvider></QueryClientProvider>);
 expect(screen.getByRole('status', {name:'Đang tải công ty'})).toBeTruthy();
 expect(screen.queryByTestId('loading')).toBeNull();
 await screen.findByText('Chưa tải được lựa chọn công ty đã lưu. Thử lại để đồng bộ.');
 expect(screen.getByRole('status').textContent).toBe('none');
 h.failInitialization=false;
 fireEvent.click(screen.getByText('Retry'));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('org-b'));
 expect(screen.getByTestId('loading').textContent).toBe('false');
});
