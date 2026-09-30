// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
const h=vi.hoisted(()=>({
 response:{total:7,expiring:2,expired:1,terminated:1},
 fail:true,reads:vi.fn(),
 row:{id:'c1',contract_number:'HD1',status:'ACTIVE',start_date:'2026-09-01',end_date:'2027-09-01',rent_price:1000000,total_deposit:0,deposit_paid:0,room:{name:'101',building:{name:'Tòa Demo'}},contract_customers:[]},
}));
vi.mock('@/hooks/useContracts',async()=>{
 const {useQuery}=await import('@tanstack/react-query');
 const read=async()=>{h.reads();if(h.fail)throw new Error('network unavailable');return h.response;};
 return {
  useContractsPaged:()=>({data:{data:[h.row],count:1},isLoading:false,isError:false,refetch:vi.fn()}),
  useContract:()=>({data:undefined}),fetchContractsForExport:vi.fn(),
  useContractStats:(ids:string[])=>useQuery({queryKey:['contract-stats-test',ids],queryFn:read,retry:false}),
  useContractDashboardCounts:(id:string|null)=>useQuery({queryKey:['contract-counts-test',id],queryFn:async()=>{await read();return {active:7,newThisMonth:2,expiringSoon:1,terminatedThisMonth:1};},retry:false}),
 };
});
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',name:'Tòa Demo'}]})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:[]})}));
vi.mock('@/hooks/useProfile',()=>({useProfile:()=>({data:null})}));
vi.mock('@/hooks/useMyBuildingScope',()=>({useMyBuildingScope:()=>({hasAnyScope:false})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/hooks/useCopilotPageContext',()=>({useCopilotPageContext:()=>{}}));
vi.mock('@/hooks/usePersistedState',async()=>{const {useState}=await import('react');return {usePersistedState:(_key:string,value:unknown)=>useState(value)};});
vi.mock('@/hooks/useRenewedContracts',()=>({useRenewedContractIds:()=>({data:new Set(),status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()})}));
vi.mock('@/hooks/useDashboard',()=>({
 useDashboardStats:()=>({data:{revenueThisMonth:100,totalDebt:10,occupancyRate:50,occupiedRooms:1,totalRooms:2,unresolvedIssues:0}}),
 useRevenueChart:()=>({data:[]}),useOccupancyChart:()=>({data:[]}),useAlerts:()=>({data:[]}),useRecentActivities:()=>({data:[]}),
}));
vi.mock('@/hooks/useLeads',()=>({useLeads:()=>({data:[]})}));
vi.mock('@/hooks/useDeposits',()=>({useDeposits:()=>({data:[]})}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:ReactNode})=><main>{children}</main>}));
vi.mock('@/components/contracts/ContractListFilters',()=>({default:()=>null}));
vi.mock('@/components/contracts/ContractListTable',()=>({default:()=> <p>Danh sách hợp đồng đã tải</p>}));
vi.mock('@/components/contracts/ContractWorkspaceTabList',()=>({ContractWorkspaceTabList:()=>null}));
vi.mock('@/components/contracts/ContractFormDialog',()=>({ContractFormDialog:()=>null}));
vi.mock('@/components/contracts/RenewDialog',()=>({RenewDialog:()=>null}));
vi.mock('@/components/contracts/TransferRoomDialog',()=>({TransferRoomDialog:()=>null}));
vi.mock('@/components/contracts/MoveOutDialog',()=>({MoveOutDialog:()=>null}));
vi.mock('@/components/contracts/MoveOutNoticeQueue',()=>({MoveOutNoticeQueue:()=>null}));
vi.mock('@/components/contracts/ContractDraftWorkspace',()=>({ContractDraftWorkspace:()=>null}));
vi.mock('@/components/contracts/ContractCommissionFollowupPanel',()=>({ContractCommissionFollowupPanel:()=>null}));
vi.mock('@/components/contracts/ContractExitQueue',()=>({ContractExitQueue:()=>null}));
vi.mock('@/components/contracts/ContractMeterFollowupQueue',()=>({ContractMeterFollowupQueue:()=>null}));
vi.mock('@/components/contracts/TransferContractDialog',()=>({TransferContractDialog:()=>null}));
vi.mock('@/components/contracts/TerminateDialog',()=>({TerminateDialog:()=>null}));
vi.mock('@/components/contracts/DeleteContractDialog',()=>({DeleteContractDialog:()=>null}));
vi.mock('@/components/contracts/ContractImportExportDialog',()=>({ContractImportExportDialog:()=>null}));
vi.mock('@/components/contracts/PrintContractDialog',()=>({PrintContractDialog:()=>null}));
vi.mock('@/components/contracts/ContractQRDialog',()=>({default:()=>null}));
vi.mock('@/components/contracts/ContractDetailModal',()=>({default:()=>null}));
import ContractsPage from '../ContractsPage';
import ContractsMobilePage from '../ContractsMobilePage';
import DashboardMobilePage from '../../DashboardMobilePage';
let client:QueryClient;
beforeEach(()=>{
 h.fail=true;h.reads.mockClear();sessionStorage.clear();
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})});
});
afterEach(()=>{cleanup();client.clear();});
const show=(children:ReactNode)=>render(<QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>);
it('desktop stats show read error instead of four zeroes; retry retains search and list',async()=>{
 show(<ContractsPage/>);
 const alert=await screen.findByRole('alert');
 expect(alert.textContent).toContain('Chưa tải được thống kê hợp đồng');
 expect(screen.queryByRole('button',{name:'0 Tất cả'})).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'Tìm hợp đồng'}),{target:{value:'Nguyễn'}});
 expect(screen.getByText('Danh sách hợp đồng đã tải')).toBeTruthy();
 h.fail=false;fireEvent.click(within(alert).getByRole('button',{name:'Tải lại'}));
 await screen.findByRole('button',{name:'7 Tất cả'});
 expect((screen.getByRole('textbox',{name:'Tìm hợp đồng'}) as HTMLInputElement).value).toBe('Nguyễn');
 expect(screen.queryByRole('alert')).toBeNull();
});
it('mobile contract stats do not label a failed read zero contracts; retry keeps selected building and rows',async()=>{
 show(<ContractsMobilePage/>);
 let alert=await screen.findByRole('alert');
 expect(alert.textContent).toContain('Chưa tải được thống kê hợp đồng');
 expect(screen.queryByText('0 hợp đồng thuê')).toBeNull();
 expect(screen.queryByRole('button',{name:'Còn hạn 0'})).toBeNull();
 fireEvent.change(screen.getByRole('combobox',{name:'Toà nhà'}),{target:{value:'b1'}});
 await waitFor(()=>expect(h.reads.mock.calls.length).toBeGreaterThan(1));
 alert=await screen.findByRole('alert');
 h.fail=false;fireEvent.click(within(alert).getByRole('button',{name:'Tải lại'}));
 await screen.findByText('7 hợp đồng thuê');
 expect(screen.getByRole('button',{name:'Còn hạn 6'})).toBeTruthy();
 expect((screen.getByRole('combobox',{name:'Toà nhà'}) as HTMLSelectElement).value).toBe('b1');
 expect(screen.getByText('P.101 · Tòa Demo')).toBeTruthy();
});
it('mobile dashboard contract block shows error and targeted retry while other blocks and building filter remain',async()=>{
 show(<DashboardMobilePage/>);
 let alert=await screen.findByRole('alert');
 expect(alert.textContent).toContain('Chưa tải được tổng quan hợp đồng');
 const card=screen.getByText('Tổng quan hợp đồng').closest('.opsb') as HTMLElement;
 expect(card.querySelector('.opsb-stat')).toBeNull();
 expect(screen.getByText('Tổng quan khách hẹn')).toBeTruthy();
 fireEvent.change(screen.getByRole('combobox',{name:'Toà nhà'}),{target:{value:'b1'}});
 await waitFor(()=>expect(h.reads.mock.calls.length).toBeGreaterThan(1));
 alert=await screen.findByRole('alert');
 h.fail=false;fireEvent.click(within(alert).getByRole('button',{name:'Tải lại'}));
 await waitFor(()=>expect(card.querySelectorAll('.opsb-stat').length).toBe(4));
 expect(card.querySelector('.opsb-v')?.textContent).toBe('7');
 expect((screen.getByRole('combobox',{name:'Toà nhà'}) as HTMLSelectElement).value).toBe('b1');
 expect(screen.queryByRole('alert')).toBeNull();
});
