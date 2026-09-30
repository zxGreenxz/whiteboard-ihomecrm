// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
const m=vi.hoisted(()=>({save:vi.fn(),invite:vi.fn(),catalogError:false,listError:false,retry:vi.fn()}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:ReactNode})=><div>{children}</div>}));
vi.mock('@/components/authorization/MemberAuthorizationDialog',()=>({MemberAuthorizationDialog:()=>null,LOAI_TV:{STAFF:'Nhân viên',OWNER:'Chủ sở hữu',PARTNER:'Đối tác',SHAREHOLDER:'Cổ đông'}}));
vi.mock('@/components/authorization/PermissionPicker',()=>({PermissionPicker:()=>null}));
vi.mock('@/hooks/useOrganizationAuthorization',()=>{
 const query=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()});
 return {useOrganizationMembers:()=>({...query(m.listError?undefined:{members:[]}),isError:m.listError,status:m.listError?'error':'success',error:m.listError?{code:'42501',message:'private diagnostic'}:null,refetch:m.retry}),useOrganizationRoles:()=>({...query(m.listError?undefined:[]),isError:m.listError,status:m.listError?'error':'success',error:m.listError?{code:'42501',message:'private diagnostic'}:null,refetch:m.retry}),useAuthorizationCatalog:()=>({...query(m.catalogError?undefined:{scopes:[],permissions:[]}),isError:m.catalogError,status:m.catalogError?'error':'success',error:m.catalogError?new Error('SQLSTATE'):null}),useUpsertOrganizationRole:()=>({mutateAsync:m.save,isPending:false}),useInviteMember:()=>({mutateAsync:m.invite,isPending:false}),authorizationErrorMessage:()=> 'Chưa xác nhận được kết quả lưu. Giữ nội dung và kiểm tra danh sách.'};
});
import RolesPage from './RolesPage';
import MembersPage from './MembersPage';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.catalogError=false;m.listError=false;m.save.mockResolvedValue({});m.invite.mockResolvedValue({});});
it('vai trò trống focus tên; lỗi máy chủ giữ draft',async()=>{
 render(<RolesPage/>);fireEvent.click(screen.getByRole('button',{name:'Tạo vai trò'}));
 const dialog=within(screen.getByRole('dialog'));fireEvent.click(dialog.getByRole('button',{name:'Tạo vai trò'}));
 const name=dialog.getByLabelText('Tên vai trò');await waitFor(()=>expect(name.getAttribute('aria-invalid')).toBe('true'));expect(document.activeElement).toBe(name);
 fireEvent.change(name,{target:{value:'Vai trò A'}});m.save.mockRejectedValueOnce(new Error('SQLSTATE denied'));fireEvent.click(dialog.getByRole('button',{name:'Tạo vai trò'}));
 await dialog.findByText(/Chưa xác nhận được kết quả lưu/);expect((name as HTMLInputElement).value).toBe('Vai trò A');expect(screen.getByRole('dialog')).toBeTruthy();
});
it('lời mời thiếu email focus đúng ô',async()=>{
 render(<MembersPage/>);fireEvent.click(screen.getByRole('button',{name:'Mời thành viên'}));
 const dialog=within(screen.getByRole('dialog'));fireEvent.click(dialog.getByRole('button',{name:'Tạo lời mời'}));const email=dialog.getByLabelText('Email');
 await waitFor(()=>expect(email.getAttribute('aria-invalid')).toBe('true'));expect(document.activeElement).toBe(email);expect(m.invite).not.toHaveBeenCalled();
});
it('danh mục quyền lỗi chặn form thay vì mặc định rỗng',async()=>{
 m.catalogError=true;render(<RolesPage/>);fireEvent.click(screen.getByRole('button',{name:'Tạo vai trò'}));
 const dialog=within(screen.getByRole('dialog'));expect(dialog.getByRole('alert').textContent).toContain('Danh mục quyền');expect(dialog.queryByLabelText('Tên vai trò')).toBeNull();expect(dialog.queryByText('SQLSTATE')).toBeNull();
});

it.each([RolesPage,MembersPage])('lỗi danh sách có retry và không dựng bảng trống',async Page=>{m.listError=true;render(<Page/>);expect(screen.getByRole('alert')).toBeTruthy();expect(screen.queryByText('private diagnostic')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(m.retry).toHaveBeenCalled());});
