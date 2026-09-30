// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BuildingWithRelations } from '@/types/building';
const io = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), services: vi.fn(), save: vi.fn(), load: vi.fn() }));
vi.mock('@/hooks/useBuildings', () => ({useCreateBuilding:()=>({mutateAsync:io.create,isPending:false}),useUpdateBuilding:()=>({mutateAsync:io.update,isPending:false})}));
vi.mock('@/hooks/useBuildingServices',()=>({BuildingServicesPartialError:class extends Error {},useBuildingServices:()=>({}),useUpsertBuildingServices:()=>({mutateAsync:io.services,isPending:false})}));
vi.mock('@/hooks/useServices',()=>({useServices:()=>({})}));
vi.mock('@/hooks/useDocumentTemplates',()=>({useDocumentTemplatesByType:()=>({})}));
vi.mock('../BuildingAddressSection',()=>({default:({setValue}:{setValue:(key:string,value:string)=>void})=><button type="button" onClick={()=>{for(const key of ['province','district','ward','street_address'])setValue(key,'Fixture');}}>Địa chỉ thử</button>}));
vi.mock('../BuildingGeoSection',()=>({default:()=>null}));
vi.mock('../BuildingServicesSection',()=>({default:()=>null}));
vi.mock('../CommissionTiersField',()=>({CommissionTiersField:()=>null}));
vi.mock('@/components/residence/BuildingOwnershipDocs',()=>({default:()=>null}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 const writer={select:()=>writer,in:()=>writer,eq:()=>writer,is:async()=>({data:[{id:io.create.mock.results.length?'created-once':'toa-sua',organization_id:'org-a',...(io.create.mock.calls[0]?.[0]??io.update.mock.calls[0]?.[0]?.updates??{})}],error:null})};return writer;
}}}));
vi.mock('@/lib/buildingLegalOwner',async importOriginal=>({...await importOriginal<typeof import('@/lib/buildingLegalOwner')>(),loadBuildingLegalOwner:io.load,saveBuildingLegalOwner:io.save}));
import BuildingFormDialog from '../BuildingFormDialog';
vi.stubGlobal('ResizeObserver',class { observe() {} unobserve() {} disconnect() {} });
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
afterEach(()=>{cleanup();vi.resetAllMocks();});
// Sổ nhận TK/TT của toà chỉ cài ở màn "Sổ nhận tiền" (đợt 1 sửa phiếu): form toà không được gửi hai cột này, kể cả null.
const COT_SO_NHAN = ['default_account_id_tk','default_account_id_tt'];
it('retries a failed owner save against the created building without creating a duplicate',async()=>{
 io.create.mockResolvedValue({id:'created-once'});io.services.mockResolvedValue(undefined);io.load.mockResolvedValue(null);
 io.save.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
 const close=vi.fn();render(<BuildingFormDialog open onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên toà nhà'),{target:{value:'Fixture'}});
 fireEvent.click(screen.getByText('Địa chỉ thử'));
 fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'),{target:{value:'Chủ đúng'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await screen.findByText(/Tòa nhà đã lưu với ID created-once. Lần lưu tiếp theo/);
 await waitFor(()=>expect(io.save).toHaveBeenCalledTimes(1));
 expect(close).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(close).toHaveBeenCalledWith(false));
 expect(io.create).toHaveBeenCalledTimes(1);
 expect(io.save).toHaveBeenLastCalledWith('created-once',expect.objectContaining({full_name:'Chủ đúng'}));
 for(const cot of COT_SO_NHAN)expect(Object.keys(io.create.mock.calls[0][0])).not.toContain(cot);
});
it('đọc lại chủ sở hữu sau kết quả lưu chưa rõ và bỏ qua ghi lại khi bản ghi đã khớp',async()=>{
 io.create.mockResolvedValue({id:'created-once'});io.services.mockResolvedValue(undefined);
 io.save.mockRejectedValueOnce(new Error('offline'));
 io.load.mockResolvedValue({full_name:'Chủ đúng',birth_year:null,id_number:'',id_issue_date:null,id_issue_place:'Cục Cảnh sát',permanent_address:''});
 const close=vi.fn();render(<BuildingFormDialog open onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên toà nhà'),{target:{value:'Fixture'}});
 fireEvent.click(screen.getByText('Địa chỉ thử'));
 fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'),{target:{value:'Chủ đúng'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await screen.findByText(/Tòa nhà đã lưu với ID created-once/);
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(close).toHaveBeenCalledWith(false));
 expect(io.create).toHaveBeenCalledTimes(1);
 expect(io.save).toHaveBeenCalledTimes(1);
 expect(io.load).toHaveBeenCalledWith('created-once');
});
it('sửa toà không gửi sổ nhận chuyển khoản / thanh toán (không ghi đè cấu hình ở màn Sổ nhận tiền)',async()=>{
 io.load.mockResolvedValue(null);io.update.mockResolvedValue({id:'toa-sua'});io.services.mockResolvedValue(undefined);
 const toa={id:'toa-sua',name:'Toà sửa',code:'TS',province:'Tỉnh',district:'Quận',ward:'Phường',street_address:'1 Đường',status:'ACTIVE',has_elevator:false,contract_template_id:null,invoice_template_id:null,commission_tiers:[{min_months:5,max_months:6,rate_percent:50}],default_account_id_tk:'so-tk',default_account_id_tt:'so-tt'} as unknown as BuildingWithRelations;
 const close=vi.fn();render(<BuildingFormDialog open onOpenChange={close} building={toa}/>);
 expect(screen.queryByText(/Sổ quỹ T[KT] mặc định/)).toBeNull();
 expect(screen.getByText('Sổ nhận chuyển khoản / thanh toán cài ở Tài chính → Sổ quỹ → Sổ nhận tiền.')).toBeTruthy();
 const luu=screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement;
 await waitFor(()=>expect(luu.disabled).toBe(false));
 fireEvent.click(luu);
 await waitFor(()=>expect(close).toHaveBeenCalledWith(false));
 expect(io.update).toHaveBeenCalledTimes(1);
 const {id,updates}=io.update.mock.calls[0][0];
 expect(id).toBe('toa-sua');expect(updates.name).toBe('Toà sửa');
 for(const cot of COT_SO_NHAN)expect(Object.keys(updates)).not.toContain(cot);
});

it('core unknown keeps entered draft through close/reopen and never retries core in the same form',async()=>{
 const {FinancialWorkflowError}=await import('@/lib/financialWorkflow');
 io.create.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận kết quả tạo tòa.','unknown',[]));io.load.mockResolvedValue(null);
 const close=vi.fn();const view=render(<BuildingFormDialog open onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên toà nhà'),{target:{value:'Tòa draft'}});fireEvent.click(screen.getByText('Địa chỉ thử'));
 fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'),{target:{value:'Chủ đúng'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await screen.findByRole('alert');expect(close).not.toHaveBeenCalled();
 view.rerender(<BuildingFormDialog open={false} onOpenChange={close}/>);view.rerender(<BuildingFormDialog open onOpenChange={close}/>);
 expect((screen.getByPlaceholderText('Nhập tên toà nhà') as HTMLInputElement).value).toBe('Tòa draft');
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.create).toHaveBeenCalledTimes(1);expect(io.services).not.toHaveBeenCalled();
});
it('closing partial for reconciliation preserves the saved core ID and draft on reopening',async()=>{
 io.create.mockResolvedValue({id:'created-once'});io.services.mockResolvedValue(undefined);io.load.mockResolvedValue(null);io.save.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
 const close=vi.fn();const view=render(<BuildingFormDialog open onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên toà nhà'),{target:{value:'Tòa partial'}});fireEvent.click(screen.getByText('Địa chỉ thử'));fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'),{target:{value:'Chủ đúng'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await screen.findByText(/Tòa nhà đã lưu với ID created-once/);
 fireEvent.click(screen.getByRole('button',{name:'Đóng để đối chiếu tòa đã lưu'}));view.rerender(<BuildingFormDialog open={false} onOpenChange={close}/>);view.rerender(<BuildingFormDialog open onOpenChange={close}/>);
 expect(screen.getByText(/Tòa nhà đã lưu với ID created-once/)).toBeTruthy();expect((screen.getByPlaceholderText('Nhập tên toà nhà') as HTMLInputElement).value).toBe('Tòa partial');
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(io.services).toHaveBeenCalledTimes(1));expect(io.create).toHaveBeenCalledTimes(1);
});
it('full remount resumes verified children and never creates the saved building again',async()=>{
 io.create.mockResolvedValue({id:'created-once'});io.services.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);io.save.mockResolvedValue(undefined);
 io.load.mockResolvedValue({full_name:'Chủ đúng',birth_year:null,id_number:'',id_issue_date:null,id_issue_place:'Cục Cảnh sát',permanent_address:''});
 const close=vi.fn();const first=render(<BuildingFormDialog open onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên toà nhà'),{target:{value:'Tòa reload'}});fireEvent.click(screen.getByText('Địa chỉ thử'));fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'),{target:{value:'Chủ đúng'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await screen.findByText(/Tòa nhà đã lưu với ID created-once/);first.unmount();
 render(<BuildingFormDialog open onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên toà nhà'),{target:{value:'Tòa reload'}});fireEvent.click(screen.getByText('Địa chỉ thử'));fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'),{target:{value:'Chủ đúng'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(close).toHaveBeenCalledWith(false));expect(io.create).toHaveBeenCalledTimes(1);expect(io.save).toHaveBeenCalledTimes(1);expect(io.services).toHaveBeenCalledTimes(2);
});