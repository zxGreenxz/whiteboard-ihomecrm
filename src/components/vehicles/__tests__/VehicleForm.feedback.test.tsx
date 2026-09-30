// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),retry:vi.fn(),sourceError:false}));
vi.mock('@/hooks/useVehicles',()=>({useCreateVehicle:()=>({mutateAsync:io.save,isPending:false}),useUpdateVehicle:()=>({mutateAsync:io.save,isPending:false})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[],isError:io.sourceError,isLoading:false,refetch:io.retry})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:[],isError:false,isLoading:false,refetch:io.retry})}));
vi.mock('@/hooks/useCustomers',()=>({useCustomers:()=>({data:{data:[],count:0},isError:false,isLoading:false,refetch:io.retry}),useCustomer:()=>({data:null,isError:false,isLoading:false,refetch:io.retry})}));
vi.mock('@/components/customers/ImageUploadZone',()=>({default:()=>null}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:()=>null}));
vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
import VehicleFormDialog from '../VehicleFormDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
const vehicle={id:'v1',vehicle_type:'MOTORBIKE',vehicle_name:'Wave',color:'Đen',license_plate:'123',owner_name:'Khách'} as never;
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
it('vehicle form source error has retry and prevents writing',()=>{io.sourceError=true;render(<VehicleFormDialog open onOpenChange={vi.fn()} vehicle={vehicle}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải');fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(io.save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));expect(io.retry).toHaveBeenCalled();});
it('vehicle unknown retains server ID and edited draft across closing and source refresh',async()=>{io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận xe.','unknown',[{id:'v1',label:'Xe cần đối chiếu'}]));const props={open:true,onOpenChange:vi.fn(),vehicle};const view=render(<VehicleFormDialog {...props}/>);fireEvent.change(screen.getByDisplayValue('Wave'),{target:{value:'Wave mới'}});fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('v1'));view.rerender(<VehicleFormDialog {...props} open={false}/>);view.rerender(<VehicleFormDialog {...props} vehicle={{...vehicle as object,vehicle_name:'Server'} as never}/>);expect(screen.getByDisplayValue('Wave mới')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(io.save).toHaveBeenCalledTimes(1);});
