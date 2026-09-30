// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
type QueryFixture = { data: unknown; status: string; fetchStatus: string; isLoading: boolean; isError: boolean; error: unknown; refetch: ReturnType<typeof vi.fn> };
type CapturedQuery = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };
const h=vi.hoisted(()=>({qs:[] as CapturedQuery[],contract:{} as QueryFixture,invoice:{} as QueryFixture,error:{code:'XX000',message:'SELECT private'}}));
vi.mock('react-router-dom',()=>({useNavigate:()=>vi.fn()}));
vi.mock('@/hooks/useRooms',()=>({useRoom:()=>({data:{id:'r',name:'101',building:{name:'A'},rent_price:0,status:'AVAILABLE'},status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:CapturedQuery)=>{h.qs.push(o);return o.queryKey[0]==='room-active-contract'?h.contract:h.invoice;}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const b:Record<string,unknown>={};for(const k of ['select','eq','in','order','limit'])b[k]=()=>b;b.maybeSingle=async()=>({data:null,error:h.error});return b;}}}));
vi.mock('@/components/rooms/RoomTurnoverPanel',()=>({RoomTurnoverPanel:()=>null}));
vi.mock('@/components/contracts/ContractFormDialog',()=>({ContractFormDialog:()=>null}));
import {RoomDetailDialog} from '../RoomDetailDialog';
beforeEach(()=>{h.qs=[];h.contract={data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:h.error,refetch:vi.fn()};h.invoice={...h.contract};});afterEach(cleanup);
it('contract source failure is an inline error rather than a room without a contract',async()=>{render(<RoomDetailDialog open onOpenChange={()=>{}} roomId="r"/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải được thông tin phòng, hợp đồng và hóa đơn');expect(document.body.textContent).not.toContain('SELECT private');await expect(h.qs[0].queryFn()).rejects.toBe(h.error);});
it('invoice source error is retained separately when contract is known',async()=>{h.contract={...h.contract,data:{id:'c',start_date:'2026-09-01',end_date:'2027-09-01',rent_price:1000,tenant:{full_name:'Khách'}},status:'success',isError:false,error:null};render(<RoomDetailDialog open onOpenChange={()=>{}} roomId="r"/>);expect(screen.getByRole('alert')).toBeTruthy();await expect(h.qs[1].queryFn()).rejects.toBe(h.error);});
