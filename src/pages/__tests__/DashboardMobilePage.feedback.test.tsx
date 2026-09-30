// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({failed:null as string|null,empty:false,selected:'b1',permission:false,reads:[] as string[]}));
type DashboardFixtures={
 buildings:{id:string;name:string}[];
 stats:{revenueThisMonth:number;totalDebt:number;occupancyRate:number;occupiedRooms:number;totalRooms:number;unresolvedIssues:number};
 contracts:{active:number;newThisMonth:number;expiringSoon:number;terminatedThisMonth:number};
 revenue:{month:string;revenue:number;growth:number}[];
 occupancy:{status:string;count:number;percentage:number}[];
 alerts:{id:string;title:string;description:string;type:string;severity:string;date:string}[];
 activities:{id:string;title:string;description:string;type:string;date:string}[];
 leads:{id:string;created_at:string;status:string}[];
 deposits:{id:string;created_at:string;status:string}[];
};
const fixture=<Source extends keyof DashboardFixtures>(source:Source):DashboardFixtures[Source]=>{
 const data:DashboardFixtures=h.empty?{
  buildings:[],stats:{revenueThisMonth:0,totalDebt:0,occupancyRate:0,occupiedRooms:0,totalRooms:0,unresolvedIssues:0},
  contracts:{active:0,newThisMonth:0,expiringSoon:0,terminatedThisMonth:0},
  revenue:[],occupancy:[],alerts:[],activities:[],leads:[],deposits:[],
 }:{
  buildings:[{id:'b1',name:'Tòa Demo'}],
  stats:{revenueThisMonth:100,totalDebt:10,occupancyRate:50,occupiedRooms:1,totalRooms:2,unresolvedIssues:0},
  contracts:{active:7,newThisMonth:2,expiringSoon:1,terminatedThisMonth:1},
  revenue:[{month:'09/2026',revenue:100,growth:0}],
  occupancy:[{status:'Đã thuê',count:1,percentage:50}],
  alerts:[{id:'a1',title:'Cảnh báo Demo',description:'Khoản thu đang quá hạn',type:'overdue_invoice',severity:'high',date:'2026-09-30'}],
  activities:[{id:'ac1',title:'Hoạt động Demo',description:'Đã tạo hợp đồng',type:'contract',date:'2026-09-30'}],
  leads:[{id:'l1',created_at:new Date().toISOString(),status:'CONVERTED'}],
  deposits:[{id:'d1',created_at:new Date().toISOString(),status:'CONVERTED'}],
 };
 return data[source];
};
vi.mock('@/hooks/useDashboard',async()=>{
 const {useQuery}=await import('@tanstack/react-query');
 const useFixtureQuery=<Source extends keyof DashboardFixtures>(source:Source,scope:string|null)=>useQuery({queryKey:['mobile-dashboard-test',source,scope],queryFn:async()=>{h.reads.push(source);if(h.failed===source)throw h.permission?{code:'42501',message:'SELECT secret FROM private'}:new Error('network unavailable');return fixture(source);},retry:false});
 return {useDashboardStats:(scope:string|null)=>useFixtureQuery('stats',scope),useRevenueChart:(_months:number,scope:string|null)=>useFixtureQuery('revenue',scope),useOccupancyChart:(scope:string|null)=>useFixtureQuery('occupancy',scope),useAlerts:(scope:string|null)=>useFixtureQuery('alerts',scope),useRecentActivities:(scope:string|null)=>useFixtureQuery('activities',scope)};
});
vi.mock('@/hooks/useBuildings',async()=>{const {useQuery}=await import('@tanstack/react-query');return {useBuildings:()=>useQuery({queryKey:['mobile-dashboard-test','buildings'],queryFn:async()=>{h.reads.push('buildings');if(h.failed==='buildings')throw new Error('network unavailable');return fixture('buildings');},retry:false})};});
vi.mock('@/hooks/useLeads',async()=>{const {useQuery}=await import('@tanstack/react-query');return {useLeads:()=>useQuery({queryKey:['mobile-dashboard-test','leads'],queryFn:async()=>{h.reads.push('leads');if(h.failed==='leads')throw new Error('network unavailable');return fixture('leads');},retry:false})};});
vi.mock('@/hooks/useDeposits',async()=>{const {useQuery}=await import('@tanstack/react-query');return {useDeposits:()=>useQuery({queryKey:['mobile-dashboard-test','deposits'],queryFn:async()=>{h.reads.push('deposits');if(h.failed==='deposits')throw new Error('network unavailable');return fixture('deposits');},retry:false})};});
vi.mock('@/hooks/useContracts',async()=>{const {useQuery}=await import('@tanstack/react-query');return {useContractDashboardCounts:(scope:string|null)=>useQuery({queryKey:['mobile-dashboard-test','contracts',scope],queryFn:async()=>{h.reads.push('contracts');return fixture('contracts');},retry:false})};});
vi.mock('@/hooks/usePersistedState',async()=>{const {useState}=await import('react');return {usePersistedState:()=>useState(h.selected)};});
import DashboardMobilePage from '../DashboardMobilePage';
let client:QueryClient;
beforeEach(()=>{h.failed=null;h.empty=false;h.selected='b1';h.permission=false;h.reads=[];client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});});
afterEach(()=>{cleanup();client.clear();});
const show=()=>render(<QueryClientProvider client={client}><MemoryRouter><DashboardMobilePage/></MemoryRouter></QueryClientProvider>);
const alertFor=async(label:string)=>{await waitFor(()=>expect(screen.getAllByRole('alert').some(node=>node.textContent?.includes(label))).toBe(true));return screen.getAllByRole('alert').find(node=>node.textContent?.includes(label))!;};
it.each([
 ['buildings','danh sách tòa nhà'],
 ['stats','số liệu bảng tin'],
 ['revenue','doanh thu theo tháng'],
 ['occupancy','tỷ lệ lấp đầy'],
 ['alerts','cảnh báo'],
 ['activities','hoạt động gần đây'],
 ['leads','tổng quan khách hẹn'],
 ['deposits','tổng quan đặt cọc'],
])('%s read failure is visible in its block and retry preserves selected building without reloading unrelated sources',async(source,label)=>{
 h.failed=source;show();
 const alert=await alertFor('Chưa tải được '+label);
 if(source==='buildings')expect(screen.queryByRole('combobox',{name:'Toà nhà'})).toBeNull();
 else expect((screen.getByRole('combobox',{name:'Toà nhà'}) as HTMLSelectElement).value).toBe('b1');
 if(source==='stats'){expect(document.querySelector('.kcard')).toBeNull();expect(screen.getByText('Tổng quan khách hẹn')).toBeTruthy();}
 if(source==='revenue')expect(document.querySelector('.chart-bw')).toBeNull();
 if(source==='occupancy')expect(document.querySelector('.occ-leg')).toBeNull();
 if(source==='alerts')expect(screen.queryByText(/Không có cảnh báo/)).toBeNull();
 if(source==='activities')expect(screen.queryByText('Chưa có hoạt động nào.')).toBeNull();
 if(source==='leads'||source==='deposits'){
  const card=screen.getByText(source==='leads'?'Tổng quan khách hẹn':'Tổng quan đặt cọc').closest('.opsb')!;
  expect(card.querySelector('.opsb-stat')).toBeNull();
 }
 const readCounts=Object.fromEntries(h.reads.map(name=>[name,h.reads.filter(other=>other===name).length]));
 h.failed=null;fireEvent.click(within(alert).getByRole('button',{name:'Tải lại'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 expect((screen.getByRole('combobox',{name:'Toà nhà'}) as HTMLSelectElement).value).toBe('b1');
 expect(h.reads.filter(name=>name===source).length).toBe(readCounts[source]+1);
 const allowed=source==='occupancy'?new Set(['occupancy','stats']):new Set([source]);
 for(const [name,count]of Object.entries(readCounts))if(!allowed.has(name))expect(h.reads.filter(other=>other===name).length).toBe(count);
});
it('confirmed empty datasets remain empty and confirmed zero stats remain zero after all reads succeed',async()=>{
 h.empty=true;h.selected='';show();
 await waitFor(()=>expect(document.querySelectorAll('.kcard').length).toBe(4));
 expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.getByText(/Không có cảnh báo/)).toBeTruthy();expect(screen.getByText('Chưa có hoạt động nào.')).toBeTruthy();
 expect(screen.getByText('0 phòng')).toBeTruthy();
 expect(document.querySelector('.chart')).toBeTruthy();expect(document.querySelector('.chart-bw')).toBeNull();
 expect(document.querySelectorAll('.opsb-stat').length).toBe(12);
 expect(Array.from(document.querySelectorAll('.kc-val')).every(node=>node.textContent==='0'||node.textContent==='0.0%')).toBe(true);
});

it.each([false,true])('cached alerts refetch permission=%s distinguishes stale data from data that must be hidden',async permission=>{
 show();await screen.findByText('Cảnh báo Demo');
 h.failed='alerts';h.permission=permission;
 await client.refetchQueries({queryKey:['mobile-dashboard-test','alerts','b1']});
 const alert=await alertFor(permission?'Chưa tải được cảnh báo':'Chưa cập nhật được cảnh báo');
 expect((screen.getByRole('combobox',{name:'Toà nhà'}) as HTMLSelectElement).value).toBe('b1');
 expect(screen.getByText('Hoạt động Demo')).toBeTruthy();
 if(permission)expect(screen.queryByText('Cảnh báo Demo')).toBeNull();
 else {expect(screen.getByText('Cảnh báo Demo')).toBeTruthy();expect(alert.textContent).toContain('Đang hiển thị kết quả tải lúc');}
 expect(document.body.textContent).not.toContain('SELECT secret');
 h.failed=null;fireEvent.click(within(alert).getByRole('button',{name:'Tải lại'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());expect(screen.getByText('Cảnh báo Demo')).toBeTruthy();
});
