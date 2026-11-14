// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
type QuyenGia={data:unknown;isError:boolean};
const m=vi.hoisted(()=>({save:vi.fn(),invite:vi.fn(),catalogError:false,listError:false,retry:vi.fn(),members:[] as unknown[],superAdmin:{data:false,isError:false} as QuyenGia,companyOwner:{data:false,isError:false} as QuyenGia,profile:{data:{organizationId:'org-1',isDemo:false},isError:false} as QuyenGia,profileEnabled:[] as boolean[]}));
// Trang Thành viên có thêm nút Đặt lại mật khẩu: hai cờ quyền + hồ sơ tổ chức (cờ demo) + hộp thoại giả, không client Supabase thật nào được nạp.
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/hooks/useIsAdmin',()=>({useIsSuperAdmin:()=>m.superAdmin}));
vi.mock('@/hooks/useIsOrgOwner',()=>({useIsOrgOwner:()=>m.companyOwner}));
vi.mock('@/components/account/ResetUserPasswordDialog',()=>({ResetUserPasswordDialog:({target}:{target:{userId:string;name:string}|null})=>target?<div data-testid="hop-thoai-dat-lai">{`${target.userId}|${target.name}`}</div>:null}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:ReactNode})=><div>{children}</div>}));
vi.mock('@/components/authorization/MemberAuthorizationDialog',()=>({MemberAuthorizationDialog:()=>null,LOAI_TV:{STAFF:'Nhân viên',OWNER:'Chủ sở hữu',PARTNER:'Đối tác',SHAREHOLDER:'Cổ đông'}}));
vi.mock('@/components/authorization/PermissionPicker',()=>({PermissionPicker:()=>null}));
vi.mock('@/hooks/useOrganizationAuthorization',()=>{
 const query=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()});
 return {useOrganizationProfile:(enabled=true)=>{m.profileEnabled.push(enabled);return m.profile;},useOrganizationMembers:()=>({...query(m.listError?undefined:{organizationId:'org-1',members:m.members}),isError:m.listError,status:m.listError?'error':'success',error:m.listError?{code:'42501',message:'private diagnostic'}:null,refetch:m.retry}),useOrganizationRoles:()=>({...query(m.listError?undefined:[]),isError:m.listError,status:m.listError?'error':'success',error:m.listError?{code:'42501',message:'private diagnostic'}:null,refetch:m.retry}),useAuthorizationCatalog:()=>({...query(m.catalogError?undefined:{scopes:[],permissions:[]}),isError:m.catalogError,status:m.catalogError?'error':'success',error:m.catalogError?new Error('SQLSTATE'):null}),useUpsertOrganizationRole:()=>({mutateAsync:m.save,isPending:false}),useInviteMember:()=>({mutateAsync:m.invite,isPending:false}),authorizationErrorMessage:()=> 'Chưa xác nhận được kết quả lưu. Giữ nội dung và kiểm tra danh sách.'};
});
import RolesPage from './RolesPage';
import MembersPage from './MembersPage';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.catalogError=false;m.listError=false;m.members=[];m.superAdmin={data:false,isError:false};m.companyOwner={data:false,isError:false};m.profile={data:{organizationId:'org-1',isDemo:false},isError:false};m.profileEnabled=[];m.save.mockResolvedValue({});m.invite.mockResolvedValue({});});
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

const thanhVienGia=(id:string,memberType:string,them:Record<string,unknown>={})=>({membershipId:`ms-${id}`,userId:`u-${id}`,email:`${id}@vidu.vn`,fullName:`Tên ${id}`,memberType,status:'ACTIVE',version:1,isSelf:false,roles:[],overrideAllow:0,overrideDeny:0,cashbooksHeld:0,permissionCount:0,...them});
const datThanhVienGia=()=>{m.members=[thanhVienGia('nv','STAFF'),thanhVienGia('chu','OWNER'),thanhVienGia('cd','SHAREHOLDER'),thanhVienGia('toi','STAFF',{isSelf:true}),thanhVienGia('cu','STAFF',{status:'REVOKED'})];};
const nutDatLai=(ten:string)=>screen.queryByRole('button',{name:`Đặt lại mật khẩu cho ${ten}`});
const moiNutDatLai=()=>screen.queryAllByRole('button',{name:/^Đặt lại mật khẩu/});

it('nút Đặt lại mật khẩu: đúng thành viên theo vai người xem, mở hộp thoại dùng chung với đúng người',()=>{
 datThanhVienGia();
 // Chủ công ty ở tổ chức thường: chỉ nhân viên còn hiệu lực, không phải mình.
 m.companyOwner={data:true,isError:false};
 const chu=render(<MembersPage/>);
 expect(moiNutDatLai().map(n=>n.getAttribute('aria-label'))).toEqual(['Đặt lại mật khẩu cho Tên nv']);
 expect(m.profileEnabled[m.profileEnabled.length-1]).toBe(true);
 expect(screen.queryByTestId('hop-thoai-dat-lai')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Đặt lại mật khẩu cho Tên nv'}));
 expect(screen.getByTestId('hop-thoai-dat-lai').textContent).toBe('u-nv|Tên nv');
 chu.unmount();
 // Superadmin: thêm chủ sở hữu và cổ đông; vẫn không có mình và người đã thu hồi. Không cần đọc hồ sơ tổ chức.
 m.companyOwner={data:false,isError:false};m.superAdmin={data:true,isError:false};
 const sa=render(<MembersPage/>);
 expect(moiNutDatLai()).toHaveLength(3);
 expect(nutDatLai('Tên chu')).toBeTruthy();expect(nutDatLai('Tên cd')).toBeTruthy();expect(nutDatLai('Tên toi')).toBeNull();expect(nutDatLai('Tên cu')).toBeNull();
 expect(m.profileEnabled[m.profileEnabled.length-1]).toBe(false);
 sa.unmount();
 // Cờ quyền đang tải hoặc lỗi (kể cả còn giữ dữ liệu true cũ) ⇒ ẩn hết.
 m.superAdmin={data:undefined,isError:false};m.companyOwner={data:true,isError:true};
 render(<MembersPage/>);
 expect(moiNutDatLai()).toHaveLength(0);
});

it('công ty demo: chủ công ty không thấy nút (kể cả khi hồ sơ tổ chức đang tải/lỗi), superadmin vẫn thấy',()=>{
 datThanhVienGia();
 m.companyOwner={data:true,isError:false};
 const hoSo:QuyenGia[]=[
  {data:{organizationId:'org-1',isDemo:true},isError:false}, // công ty demo
  {data:undefined,isError:false}, // đang tải
  {data:{organizationId:'org-1',isDemo:false},isError:true}, // lỗi nạp lại, còn dữ liệu cũ
  {data:{organizationId:'org-2',isDemo:false},isError:false}, // hồ sơ của tổ chức khác danh sách đang hiện
 ];
 for(const p of hoSo){m.profile=p;const v=render(<MembersPage/>);expect(moiNutDatLai(),JSON.stringify(p)).toHaveLength(0);v.unmount();}
 // Cùng công ty demo, superadmin vẫn đặt lại được.
 m.profile={data:{organizationId:'org-1',isDemo:true},isError:false};m.superAdmin={data:true,isError:false};
 render(<MembersPage/>);
 expect(moiNutDatLai()).toHaveLength(3);
 expect(nutDatLai('Tên nv')).toBeTruthy();expect(nutDatLai('Tên chu')).toBeTruthy();
});
