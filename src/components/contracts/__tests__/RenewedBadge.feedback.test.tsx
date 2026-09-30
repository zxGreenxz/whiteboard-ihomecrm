// @vitest-environment jsdom
import {render,screen,cleanup,fireEvent,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({response:{data:null as unknown,error:null as unknown}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>({select:()=>({in:()=>({in:()=>Promise.resolve(h.response)})})})}}));
import {RenewedBadge} from '../RenewedBadge';
let client:QueryClient;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});h.response={data:null,error:null};});
afterEach(()=>{cleanup();client.clear();});
it('unknown renewal state has an inline error and can retry into a confirmed badge',async()=>{
 render(<QueryClientProvider client={client}><RenewedBadge contractId="c1"/></QueryClientProvider>);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Chưa tải được trạng thái gia hạn'));
 expect(screen.queryByText('Đã gia hạn')).toBeNull();
 h.response={data:[{contract_id:'c1'}],error:null};
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
 await screen.findByText('Đã gia hạn');expect(screen.queryByRole('alert')).toBeNull();
});
it('a valid empty result produces no renewal badge or error',async()=>{
 h.response={data:[],error:null};
 render(<QueryClientProvider client={client}><RenewedBadge contractId="c1"/></QueryClientProvider>);
 await waitFor(()=>expect(client.getQueryState(['renewed-contract-ids',['c1']])?.status).toBe('success'));
 expect(screen.queryByText('Đã gia hạn')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
});
