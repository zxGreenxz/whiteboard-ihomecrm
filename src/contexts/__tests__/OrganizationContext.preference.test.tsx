// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ user: 'alice' as string | null, jwtSub: null as string | null, headers: [] as string[], server: null as string | null, invokeRpc: vi.fn(), read: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: h.user ? { id: h.user } : null, isLoading: false, isError: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
 auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }), getSession: async () => ({ data: { session: h.user ? { user: { id: h.user }, access_token: `header.${btoa(JSON.stringify({sub:h.jwtSub ?? h.user}))}.signature` } : null }, error:null }) },
 rpc: (...args: unknown[]) => { const result = h.invokeRpc(...args); return { setHeader: (_name:string,value:string) => {h.headers.push(value);return result;}, then: result.then.bind(result) }; },
 from: () => ({ select: () => ({ eq: () => ({ single: () => { const result=h.read(); return {setHeader:()=>result,then:result.then.bind(result)}; } }) }) })
} }));
import { OrganizationProvider, useOrganization } from '../OrganizationContext';
import { companySessionToken } from '@/lib/companyPreference';
function View() { const c=useOrganization(); return <><p data-testid="org">{c.selectedOrganizationId ?? 'none'}</p><p data-testid="loading">{String(c.isLoading)}</p><button onClick={()=>c.selectOrganization('org-a')}>A</button><button onClick={()=>c.selectOrganization('org-b')}>B</button><button onClick={()=>void c.refetchOrganizations()}>Retry</button><p data-testid="error">{c.preferenceError}</p></>; }
let client: QueryClient;
const mount = () => render(<QueryClientProvider client={client}><OrganizationProvider><View/></OrganizationProvider></QueryClientProvider>);
beforeEach(()=> {localStorage.clear();h.user='alice';h.jwtSub=null;h.headers=[];h.server='org-b';h.invokeRpc.mockReset();h.read.mockReset();h.read.mockImplementation(async()=>({data:{ui_preferences:{selectedOrganizationId:h.server}},error:null}));h.invokeRpc.mockImplementation(async(name:string,args?:{p_value:string})=>name==='set_my_ui_preference'?{data:{selectedOrganizationId:args?.p_value},error:null}:{data:{organizations:[{id:'org-a',name:'A'},{id:'org-b',name:'B'}]},error:null});client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});});
afterEach(()=>{cleanup();client.clear();});
it('restores server selection in empty browser/PWA storage',async()=>{mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));expect(localStorage.getItem('ihomecrm.selectedOrganizationId')).toBe('org-b');});
it('does not adopt another account active legacy selection',async()=>{localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');localStorage.setItem('ihomecrm.selectedOrganizationOwner','bob');h.server=null;mount();await waitFor(()=>expect(screen.getByTestId('loading').textContent).toBe('false'));expect(screen.getByTestId('org').textContent).toBe('none');});

const deferred = <T,>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
it('waits for remembered preference before prompting for a company',async()=>{
 const read=deferred<{data:{ui_preferences:{selectedOrganizationId:string}},error:null}>();h.read.mockReturnValueOnce(read.promise);mount();
 await waitFor(()=>expect(h.read).toHaveBeenCalled());expect(screen.getByTestId('loading').textContent).toBe('true');
 await act(async()=>read.resolve({data:{ui_preferences:{selectedOrganizationId:'org-a'}},error:null}));await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-a'));
});
it('fences stale preference reads on account switch and keeps caches separate',async()=>{
 const read=deferred<{data:{ui_preferences:{selectedOrganizationId:string}},error:null}>();h.read.mockReturnValueOnce(read.promise);const view=mount();await waitFor(()=>expect(h.read).toHaveBeenCalled());
 h.user='bob';h.server='org-a';view.rerender(<QueryClientProvider client={client}><OrganizationProvider><View/></OrganizationProvider></QueryClientProvider>);await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-a'));
 await act(async()=>read.resolve({data:{ui_preferences:{selectedOrganizationId:'org-b'}},error:null}));expect(screen.getByTestId('org').textContent).toBe('org-a');expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toBeNull();
});
it('logout clears active scope and relogin restores the account choice',async()=>{
 const view=mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));
 h.user=null;view.rerender(<QueryClientProvider client={client}><OrganizationProvider><View/></OrganizationProvider></QueryClientProvider>);await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('none'));expect(localStorage.getItem('ihomecrm.selectedOrganizationId')).toBeNull();expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toContain('org-b');
 h.user='alice';view.rerender(<QueryClientProvider client={client}><OrganizationProvider><View/></OrganizationProvider></QueryClientProvider>);await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));
});
it('removed membership never chooses first of many or erases remembered choice',async()=>{
 h.server='removed';mount();await waitFor(()=>expect(screen.getByTestId('loading').textContent).toBe('false'));expect(screen.getByTestId('org').textContent).toBe('none');expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toContain('removed');expect(localStorage.getItem('ihomecrm.selectedOrganizationId')).toBeNull();
});
it('offline read uses validated local fallback and exposes retryable error',async()=>{
 localStorage.setItem('ihomecrm.selectedOrganizationId:alice',JSON.stringify({id:'org-a',pending:false}));h.read.mockRejectedValueOnce(new Error('offline'));mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-a'));expect(screen.getByTestId('error').textContent).toContain('Thử lại');fireEvent.click(screen.getByText('Retry'));await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));expect(screen.getByTestId('error').textContent).toBe('');
});
it('failed save keeps latest choice locally and retries atomic server save',async()=>{
 mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));h.invokeRpc.mockImplementationOnce(async()=>({data:null,error:new Error('offline')}));fireEvent.click(screen.getByText('A'));await waitFor(()=>expect(screen.getByTestId('error').textContent).toContain('Chưa lưu'));expect(screen.getByTestId('org').textContent).toBe('org-a');expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toContain('"pending":true');fireEvent.click(screen.getByText('Retry'));await waitFor(()=>expect(screen.getByTestId('error').textContent).toBe(''));expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toContain('"pending":false');
});
it('serializes rapid explicit switches so earlier save cannot win',async()=>{
 mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));const first=deferred<{data:{selectedOrganizationId:string},error:null}>();h.invokeRpc.mockImplementationOnce(()=>first.promise);fireEvent.click(screen.getByText('A'));await waitFor(()=>expect(h.invokeRpc.mock.calls.filter(c=>c[0]==='set_my_ui_preference')).toHaveLength(1));fireEvent.click(screen.getByText('B'));expect(screen.getByTestId('org').textContent).toBe('org-b');expect(h.invokeRpc.mock.calls.filter(c=>c[0]==='set_my_ui_preference')).toHaveLength(1);
 await act(async()=>first.resolve({data:{selectedOrganizationId:'org-a'},error:null}));await waitFor(()=>expect(h.invokeRpc.mock.calls.filter(c=>c[0]==='set_my_ui_preference').map(c=>c[1].p_value)).toEqual(['org-a','org-b']));await waitFor(()=>expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toContain('"pending":false'));expect(screen.getByTestId('org').textContent).toBe('org-b');
});

it('rejects a session whose JWT subject differs from captured account',async()=>{h.jwtSub='bob';await expect(companySessionToken('alice')).rejects.toThrow('Phiên đăng nhập đã thay đổi');expect(h.invokeRpc).not.toHaveBeenCalled();});
it('late read cannot replace an explicit selection made during preference loading',async()=>{
 const read=deferred<{data:{ui_preferences:{selectedOrganizationId:string}},error:null}>();h.read.mockReturnValueOnce(read.promise);mount();await waitFor(()=>expect(h.invokeRpc).toHaveBeenCalled());fireEvent.click(screen.getByText('A'));await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-a'));
 await act(async()=>read.resolve({data:{ui_preferences:{selectedOrganizationId:'org-b'}},error:null}));expect(screen.getByTestId('org').textContent).toBe('org-a');
});
it('queued old-account writes never use the new-account JWT and late save cannot change its UI',async()=>{
 const view=mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));const first=deferred<{data:{selectedOrganizationId:string},error:null}>();h.invokeRpc.mockImplementationOnce(()=>first.promise);fireEvent.click(screen.getByText('A'));await waitFor(()=>expect(h.invokeRpc.mock.calls.filter(c=>c[0]==='set_my_ui_preference')).toHaveLength(1));fireEvent.click(screen.getByText('B'));
 h.user='bob';h.server='org-a';view.rerender(<QueryClientProvider client={client}><OrganizationProvider><View/></OrganizationProvider></QueryClientProvider>);await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-a'));await act(async()=>first.resolve({data:{selectedOrganizationId:'org-a'},error:null}));expect(h.invokeRpc.mock.calls.filter(c=>c[0]==='set_my_ui_preference')).toHaveLength(1);expect(screen.getByTestId('org').textContent).toBe('org-a');expect(JSON.parse(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')!).id).toBe('org-b');expect(localStorage.getItem('ihomecrm.selectedOrganizationOwner')).toBe('bob');
});
it('restores unsynced explicit choice on remount and retries instead of overwriting with older server value',async()=>{
 const view=mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-b'));h.invokeRpc.mockImplementationOnce(async()=>({data:null,error:new Error('offline')}));fireEvent.click(screen.getByText('A'));await waitFor(()=>expect(screen.getByTestId('error').textContent).toContain('Chưa lưu'));view.unmount();client.clear();mount();await waitFor(()=>expect(screen.getByTestId('org').textContent).toBe('org-a'));await waitFor(()=>expect(localStorage.getItem('ihomecrm.selectedOrganizationId:alice')).toContain('"pending":false'));
});
