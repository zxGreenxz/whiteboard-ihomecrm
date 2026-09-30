// @vitest-environment jsdom
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { afterEach,beforeEach,it,expect,vi } from 'vitest';
const m=vi.hoisted(()=>({save:vi.fn(),create:vi.fn(),update:vi.fn(),sync:vi.fn(),queryError:false}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
const q=(data:unknown[]=[])=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:m.queryError,error:{message:'internal table'},refetch:vi.fn()});
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock('@/hooks/useAdminUsers',()=>({useAdminUsers:()=>q([{id:'u',full_name:'An'}])}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>q()}));
vi.mock('@/hooks/useAreas',()=>({useAreas:()=>q()}));
vi.mock('@/hooks/useProfitManagers',()=>({useProfitManagers:()=>q(),useManagerSalaries:()=>q(),useSaveManagerWithSalaries:()=>({mutateAsync:m.save,isPending:false})}));
vi.mock('@/hooks/useShareholders',()=>({useShareholders:()=>q(),useBuildingShareholders:()=>q(),useCreateShareholder:()=>({mutateAsync:m.create,isPending:false}),useUpdateShareholder:()=>({mutateAsync:m.update,isPending:false}),useSyncShareholderBuildings:()=>({mutateAsync:m.sync,isPending:false})}));
vi.mock('@/components/buildings/BuildingMultiSelect',()=>({BuildingMultiSelect:()=> <button>Chọn nhà</button>}));
import ShareholderForm from '../ShareholderForm';
afterEach(()=>{cleanup();vi.clearAllMocks();m.queryError=false;});
it('tài khoản trống hiển thị đỏ và focus, không tạo hồ sơ',async()=>{
 render(<ShareholderForm open onOpenChange={vi.fn()} shareholder={null}/>);
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('authUserId'));
 expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
 expect(m.create).not.toHaveBeenCalled();
});
it('giữ draft và mã cổ đông khi tỷ lệ lỗi sau khi lưu hồ sơ; không lưu lại',async()=>{
 m.update.mockResolvedValue(undefined);m.sync.mockRejectedValue({message:'relation private_table'});
 render(<ShareholderForm open onOpenChange={vi.fn()} shareholder={{id:'s1',name:'An',auth_user_id:'u',note:null,is_active:true} as never}/>);
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await screen.findByText('s1');
 expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).not.toContain('private_table');
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(m.update).toHaveBeenCalledTimes(1);
});
it('cấu hình lỗi không hiển thị form hoặc tỷ lệ trống để lưu',()=>{
 m.queryError=true;render(<ShareholderForm open onOpenChange={vi.fn()} shareholder={null}/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải');
 expect(screen.queryByRole('button',{name:'Lưu'})).toBeNull();
});

it('shareholder full-save partial không ghi primary lại sau remount',async()=>{
 m.update.mockResolvedValue(undefined);m.sync.mockRejectedValue(new TypeError('Failed to fetch'));
 const props={open:true,onOpenChange:vi.fn(),shareholder:{id:'s1',name:'An',auth_user_id:'u',note:null,is_active:true} as never};
 const first=render(<ShareholderForm {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await screen.findByText('s1');first.unmount();
 render(<ShareholderForm {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await screen.findByRole('alert');expect(m.update).toHaveBeenCalledTimes(1);expect(props.onOpenChange).not.toHaveBeenCalled();
});
