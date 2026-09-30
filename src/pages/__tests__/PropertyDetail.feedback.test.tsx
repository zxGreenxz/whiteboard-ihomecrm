// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
const h=vi.hoisted(()=>({primaryError:null as unknown,relatedError:{code:'500',message:'raw SQL table'} as unknown}));
const query=(data:unknown,error:unknown)=>({data,error,isError:!!error,isLoading:false,status:error?'error':'success',fetchStatus:'idle',refetch:vi.fn()});
vi.mock('@/components/layout/MainLayout',()=>({default:({title,subtitle,children}:{title:string;subtitle?:string;children:ReactNode})=><main><h1>{title}</h1><p>{subtitle}</p>{children}</main>}));
vi.mock('@/hooks/useRooms',()=>({useRoom:()=>query({id:'r',name:'Private room',code:'Private code',status:'AVAILABLE',rent_price:3000000,deposit_amount:3000000},h.primaryError),useRooms:()=>query(h.relatedError?undefined:[],h.relatedError)}));
vi.mock('@/hooks/useBuildings',()=>({useBuilding:()=>query({id:'b',name:'Private building',code:'Private code',status:'ACTIVE',type:'APARTMENT'},h.primaryError)}));
vi.mock('@/hooks/useCustomers',()=>({useCustomer:()=>query({id:'c',full_name:'Private customer'},h.primaryError)}));
vi.mock('@/hooks/useVehicles',()=>({useVehicles:()=>query(undefined,h.relatedError)}));
vi.mock('@/hooks/usePropertyDetailQueries',()=>({useRoomDetailContracts:()=>query(undefined,h.relatedError),useRoomDetailTenants:()=>query(undefined,h.relatedError),useRoomDetailInvoices:()=>query(undefined,h.relatedError),useRoomDetailAssets:()=>query(undefined,h.relatedError),useBuildingDetailContracts:()=>query(undefined,h.relatedError),useBuildingDetailInvoices:()=>query(undefined,h.relatedError)}));
vi.mock('@/hooks/useCustomerDetailContracts',()=>({useCustomerDetailContracts:()=>query(undefined,h.relatedError)}));
vi.mock('@/hooks/use-mobile',()=>({usePhoneViewport:()=>false}));
vi.mock('@/components/rooms/EditRoomDialog',()=>({EditRoomDialog:()=>null}));
vi.mock('@/components/buildings/EditBuildingDialog',()=>({EditBuildingDialog:()=>null}));
vi.mock('@/components/customers/DeleteCustomerDialog',()=>({default:()=>null}));
vi.mock('@/components/rooms/RoomTurnoverPanel',()=>({RoomTurnoverPanel:()=>null}));
vi.mock('@/components/deposits/RoomReservationPanel',()=>({RoomReservationPanel:()=>null}));
import Room from '../rooms/RoomDetailPage';
import Building from '../buildings/BuildingDetailPage';
import Customer from '../customers/CustomerDetailPage';
afterEach(()=>{cleanup();h.primaryError=null;h.relatedError={code:'500',message:'raw SQL table'};});
function open(element:ReactNode){render(<MemoryRouter initialEntries={['/detail/id']}><Routes><Route path="/detail/:id" element={element}/></Routes></MemoryRouter>);}
it.each([['room',<Room/>],['building',<Building/>],['customer',<Customer/>]])('hides cached %s identity after permission is revoked',(_name,element)=>{
 h.primaryError={code:'42501',message:'denied'};open(element);
 expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
 expect(document.body.textContent).not.toContain('Private');expect(document.body.textContent).not.toContain('raw SQL');
});
it.each([['Khách hàng','khách hàng đang thuê phòng'],['Hợp đồng','hợp đồng của phòng'],['Tài sản','tài sản của phòng'],['Hóa đơn','hóa đơn của phòng']])('shows room %s load failure inside the tab instead of an empty list', (tab,label)=>{
 open(<Room/>);const trigger=screen.getByRole('tab',{name:new RegExp(tab)});expect(trigger.textContent).toContain('…');
 fireEvent.mouseDown(trigger,{button:0,ctrlKey:false});
 expect(screen.getByText(`Chưa tải được ${label}.`)).toBeTruthy();expect(document.body.textContent).not.toContain('raw SQL');
 expect(document.body.textContent).not.toMatch(/Chưa có (hợp đồng|tài sản|hóa đơn)/);
});
it('blocks building statistics when the rooms source fails',()=>{
 open(<Building/>);expect(screen.getByText('Chưa tải được thống kê phòng của tòa nhà.')).toBeTruthy();
 expect(screen.getByRole('tab',{name:/Căn hộ/}).textContent).toContain('…');
});
it.each([['Hợp đồng','hợp đồng của tòa nhà'],['Hóa đơn','hóa đơn của tòa nhà']])('shows building %s failure rather than zero/empty', (tab,label)=>{
 open(<Building/>);fireEvent.mouseDown(screen.getByRole('tab',{name:new RegExp(tab)}),{button:0,ctrlKey:false});
 expect(screen.getByText(`Chưa tải được ${label}.`)).toBeTruthy();expect(document.body.textContent).not.toMatch(/Chưa có (hợp đồng|hóa đơn)/);
});
