// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
type ReadFixture = { data: unknown; error: unknown };
const h=vi.hoisted(()=>({account:{data:{id:'cashbook',name:'Sổ thối'},error:null} as ReadFixture,list:{data:[],error:null} as ReadFixture,from:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:h.from}}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:React.PropsWithChildren)=><main>{children}</main>}));
vi.mock('@/hooks/use-mobile',()=>({useIsMobile:()=>false}));
import RefundLogPage from '../RefundLogPage';
function show(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});render(<MemoryRouter initialEntries={['/payments/refund-log?account_id=cashbook']}><QueryClientProvider client={client}><RefundLogPage/></QueryClientProvider></MemoryRouter>);return client;}
beforeEach(()=>{sessionStorage.clear();h.account={data:{id:'cashbook',name:'Sổ thối'},error:null};h.list={data:[],error:null};h.from.mockReset().mockImplementation((table:string)=>{const response=table==='accounts'?()=>h.account:()=>h.list;const builder:Record<string,unknown>={then:(ok:(value:ReadFixture)=>unknown)=>Promise.resolve(response()).then(ok)};for(const k of ['select','eq','is','gte','lte','order','maybeSingle'])builder[k]=()=>builder;return builder;});});
afterEach(cleanup);
it.each(['account','list','null-list','invalid-money'])('%s failure preserves period filter and hides zero/empty report',async(kind)=>{
 if(kind==='account')h.account={data:null,error:{code:'42501',message:'SQL secret'}};
 if(kind==='list')h.list={data:null,error:{code:'XX000',message:'SQL secret'}};
 if(kind==='null-list')h.list={data:null,error:null};
 if(kind==='invalid-money')h.list={data:[{id:'v',change_amount:null,total_amount:4}],error:null};
 show();await screen.findByRole('alert');expect(screen.getByText('Kỳ')).toBeTruthy();expect(screen.queryByText('Tổng tiền thối')).toBeNull();expect(screen.queryByText(/Chưa có phiếu thối/)).toBeNull();expect(document.body.textContent).not.toContain('SQL secret');
 h.account={data:{id:'cashbook',name:'Sổ thối'},error:null};h.list={data:[],error:null};fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await screen.findByText('Chưa có phiếu thối nào trong kỳ này');
});
it('confirmed empty report shows zero and empty result',async()=>{show();await screen.findByText('Chưa có phiếu thối nào trong kỳ này');expect(screen.getByText('Tổng tiền thối')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();});
