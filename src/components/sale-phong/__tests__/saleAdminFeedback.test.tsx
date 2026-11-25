// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({org:'org-1' as string|null,orgLoading:false,tokens:{} as Record<string,unknown>,settings:{} as Record<string,unknown>,hotlines:{} as Record<string,unknown>,create:vi.fn(),label:vi.fn(),revoke:vi.fn(),remove:vi.fn(),save:vi.fn(),retry:vi.fn(),rooms:{} as Record<string,unknown>,sheetSave:vi.fn()}));
vi.mock('@tanstack/react-query', async original => ({ ...(await original<typeof import('@tanstack/react-query')>()), useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: 'actor-a' } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { __superadmin: true }, isError: false }) }));
vi.mock('@/hooks/useSaleRoomInventory', async () => {
  const { sheetInventoryFixture } = await import('./sheetInventoryFixture');
  return { useSaleRoomInventory: () => ({ ...m.rooms, data: m.rooms.data === undefined ? undefined : sheetInventoryFixture(m.rooms.data as import('@/pages/phong-trong/sampleData').Building[]) }) };
});
vi.mock('@/hooks/usePublicRoomTokens',()=>{const mutation=(fn:typeof m.create)=>({mutateAsync:fn,mutate:(value:unknown,options?:{onSuccess?:(value:unknown)=>unknown;onError?:(error:unknown)=>unknown})=>{void fn(value).then(options?.onSuccess,options?.onError??(()=>{}));},isPending:false});return {usePublicRoomTokens:()=>m.tokens,useCreatePublicRoomToken:()=>(mutation(m.create)),useUpdateTokenLabel:()=>(mutation(m.label)),useSetTokenRevoked:()=>(mutation(m.revoke)),useDeletePublicRoomToken:()=>(mutation(m.remove))};});
vi.mock('@/hooks/usePublicRoomSettings',()=>({usePublicRoomSettings:()=>m.settings,useUpsertPublicRoomSettings:()=>({mutateAsync:m.save,mutate:(value:unknown)=>{void m.save(value).catch(()=>{});},isPending:false}),PUBLIC_ROOM_SETTINGS_DEFAULTS:{soon_days:30,show_rented:true,hotline_id:null,sale_policy:null}}));
vi.mock('@/hooks/useHotlines',()=>({useHotlines:()=>m.hotlines,useCreateHotline:()=>({mutateAsync:vi.fn(),isPending:false}),useUpdateHotline:()=>({mutateAsync:vi.fn(),isPending:false})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:m.org,isLoading:m.orgLoading})}));
vi.mock('@/hooks/useMyAvailableRooms',()=>({useMyAvailableRooms:()=>m.rooms}));
vi.mock('@/hooks/useSaveRoomListSheet',async original=>({...(await original<typeof import('@/hooks/useSaveRoomListSheet')>()),useSaveRoomListSheet:()=>({mutateAsync:m.sheetSave,isPending:false})}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {MemoryRouter} from 'react-router-dom';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import DisplaySettingsTab from '../DisplaySettingsTab';
import MobileDisplaySettings from '../mobile/MobileDisplaySettings';
import ShareTokensTab from '../ShareTokensTab';
import MobileShareTokens from '../mobile/MobileShareTokens';
const token={token:'room-a',owner_id:'actor-a',organization_id:null,label:'Sale A',revoked:false,created_at:'2026-09-30T00:00:00Z'};
const query=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:m.retry,dataUpdatedAt:Date.now()});
const failure=(data:unknown)=>({...query(data),status:'error',isError:true,error:{code:'42501',message:'SQL_PRIVATE_DIAGNOSTIC'}});
beforeEach(()=>{vi.clearAllMocks(); sessionStorage.clear();m.org='org-1';m.orgLoading=false;m.tokens=query([token]);m.settings=query({soon_days:30,show_rented:true,hotline_id:null});m.hotlines=query([]);m.rooms=query([]);m.save.mockResolvedValue({});const unknown=new FinancialWorkflowError('Chưa xác nhận được yêu cầu; kiểm tra link room-a trước khi thực hiện tiếp.','unknown',[]);m.create.mockRejectedValue(unknown);m.remove.mockRejectedValue(unknown);m.label.mockRejectedValue(unknown);m.revoke.mockRejectedValue(unknown);});afterEach(cleanup);
// Mobile: số ngày/hotline/chính sách chung nằm trong sheet sau nút bánh răng trên app-bar.
let gear:{onClick:()=>void}|null=null;
const settings=(mobile:boolean)=><MemoryRouter>{mobile?<MobileDisplaySettings onHeaderAction={value=>{gear=value;}}/>:<DisplaySettingsTab/>}</MemoryRouter>;
const openGear=(mobile:boolean)=>{if(mobile)act(()=>gear?.onClick());};
const saveButton=(mobile:boolean)=>mobile?within(screen.getByRole('dialog')).getByRole('button',{name:'Lưu cài đặt'}):screen.getByRole('button',{name:'Lưu cài đặt'});
function links(mobile:boolean){let header:{onClick:()=>void}|null=null;const node=mobile?<MobileShareTokens onHeaderAction={value=>{header=value;}}/>:<ShareTokensTab/>;return {node,create:()=>{if(mobile)header?.onClick();else fireEvent.click(screen.getByRole('button',{name:'Tạo link mới'}));}};}
it.each([false,true])('token read failure is retryable and not empty mobile=%s',async mobile=>{m.tokens=failure(undefined);render(links(mobile).node);expect(screen.getByText('Chưa tải được link chia sẻ.')).toBeTruthy();expect(screen.queryByText(/Chưa có link chia sẻ nào/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(m.retry).toHaveBeenCalledOnce());expect(document.body.textContent).not.toContain('SQL_PRIVATE');});
it.each([false,true])('unknown create keeps label/dialog and blocks repeat mobile=%s',async mobile=>{const view=links(mobile);render(view.node);act(()=>view.create());const dialog=await screen.findByRole('dialog');const input=within(dialog).getByRole('textbox');fireEvent.change(input,{target:{value:'Draft Sale'}});fireEvent.click(within(dialog).getByRole('button',{name:'Tạo link'}));await waitFor(()=>expect(m.create).toHaveBeenCalledWith('Draft Sale'));expect(input).toHaveProperty('value','Draft Sale');await waitFor(()=>expect(within(dialog).getByRole('alert').textContent).toContain('room-a'));expect(within(dialog).getByRole('button',{name:'Tạo link'})).toHaveProperty('disabled',true);expect(screen.getByRole('dialog')).toBe(dialog);});
it.each([false,true])('unknown delete keeps confirmation and token mobile=%s',async mobile=>{render(links(mobile).node);fireEvent.click(screen.getByTitle('Xoá'));const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');fireEvent.click(within(dialog).getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(m.remove).toHaveBeenCalledWith('room-a'));await waitFor(()=>expect(within(dialog).getByRole('alert').textContent).toContain('room-a'));expect(screen.getByRole(mobile?'dialog':'alertdialog')).toBe(dialog);expect(within(dialog).getByRole('button',{name:'Xoá'})).toHaveProperty('disabled',true);});
it.each([false,true])('settings source error never offers default save mobile=%s',mobile=>{m.settings=failure(undefined);render(settings(mobile));expect(screen.getByText('Chưa tải được cài đặt hiển thị.')).toBeTruthy();expect(screen.queryByRole('button',{name:'Lưu cài đặt'})).toBeNull();expect(m.save).not.toHaveBeenCalled();});
it.each([false,true])('hotline source error blocks settings save mobile=%s',mobile=>{m.hotlines=failure(undefined);render(settings(mobile));expect(screen.getByText('Chưa tải được cài đặt hiển thị.')).toBeTruthy();expect(screen.queryByRole('button',{name:'Lưu cài đặt'})).toBeNull();});
it.each([false,true])('stale settings blocks save and retains draft mobile=%s',mobile=>{const view=render(settings(mobile));openGear(mobile);const input=screen.getByLabelText('Số ngày báo "sắp trống"');fireEvent.change(input,{target:{value:'41'}});m.settings={...query({soon_days:30,show_rented:true,hotline_id:null}),status:'error',isError:true,error:new TypeError('Failed to fetch')};view.rerender(settings(mobile));expect(input).toHaveProperty('value','41');expect(saveButton(mobile)).toHaveProperty('disabled',true);expect(screen.getByText(/Chưa cập nhật được cài đặt hiển thị/)).toBeTruthy();});
it.each([false,true])('successful refetch does not overwrite edited draft mobile=%s',mobile=>{const view=render(settings(mobile));openGear(mobile);const input=screen.getByLabelText('Số ngày báo "sắp trống"');fireEvent.change(input,{target:{value:'41'}});m.settings=query({soon_days:25,show_rented:false,hotline_id:null});view.rerender(settings(mobile));expect(input).toHaveProperty('value','41');});
for(const mobile of [false,true])it.each(['','-1','1.5','366','abc'])('invalid day %j remains red and focused mobile='+mobile,async raw=>{render(settings(mobile));openGear(mobile);const input=screen.getByLabelText('Số ngày báo "sắp trống"');fireEvent.change(input,{target:{value:raw}});fireEvent.click(saveButton(mobile));await waitFor(()=>expect(document.activeElement).toBe(input));expect(input).toHaveProperty('value',raw);expect(input.getAttribute('aria-invalid')).toBe('true');expect(screen.getByRole('alert').textContent).toContain('0 đến 365');expect(m.save).not.toHaveBeenCalled();});
it.each([false,true])('settings write rejection retains raw draft and inline safe error mobile=%s',async mobile=>{m.save.mockRejectedValue({code:'42501',message:'SQL_PRIVATE_DIAGNOSTIC'});render(settings(mobile));openGear(mobile);const input=screen.getByLabelText('Số ngày báo "sắp trống"');fireEvent.change(input,{target:{value:'41'}});fireEvent.click(saveButton(mobile));await waitFor(()=>expect(m.save).toHaveBeenCalledOnce());await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());expect(input).toHaveProperty('value','41');expect(document.body.textContent).not.toContain('SQL_PRIVATE');});

// Sale phòng đợt 1 (20261124171545): lỗi tạo link nêu lý do thật của máy chủ; hộp thu hồi / xoá cảnh báo link nguồn
// /phongtrong và link hoạt động cuối của công ty; chưa chốt công ty thì không cho tạo.
it.each([false,true])('server create rejection says it was not created and why, never field-check text mobile=%s',async mobile=>{
  m.create.mockRejectedValue({code:'42501',message:'public_room_token_permission',hint:'SQL_PRIVATE_DIAGNOSTIC'});
  const view=links(mobile);render(view.node);act(()=>view.create());const dialog=await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button',{name:'Tạo link'}));
  const alert=await within(dialog).findByRole('alert');
  expect(alert.textContent).toContain('Không tạo được link');expect(alert.textContent).toContain('Quản lý link chia sẻ');
  expect(alert.textContent).not.toContain('Kiểm tra các trường');expect(document.body.textContent).not.toContain('SQL_PRIVATE');
  // Lỗi đã biết là bị từ chối hẳn: không khoá nút như khi chưa rõ kết quả.
  expect(within(dialog).getByRole('button',{name:'Tạo link'})).toHaveProperty('disabled',false);
});
it.each([false,true])('legacy 23502 organization error is explained, not shown as a form error mobile=%s',async mobile=>{
  m.create.mockRejectedValue({code:'23502',message:'public_room_share_tokens : không suy được organization_id cho dòng này.'});
  const view=links(mobile);render(view.node);act(()=>view.create());const dialog=await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button',{name:'Tạo link'}));
  const alert=await within(dialog).findByRole('alert');
  expect(alert.textContent).toContain('Không tạo được link');expect(alert.textContent).toContain('thuộc công ty nào');
  expect(alert.textContent).not.toContain('Kiểm tra các trường');
});
it.each([false,true])('super admin outside the selected company is told so, not to reload mobile=%s',async mobile=>{
  m.create.mockRejectedValue({code:'42501',message:'public_room_token_not_member'});
  const view=links(mobile);render(view.node);act(()=>view.create());const dialog=await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button',{name:'Tạo link'}));
  const alert=await within(dialog).findByRole('alert');
  expect(alert.textContent).toContain('không phải thành viên của công ty đang chọn');expect(alert.textContent).not.toMatch(/không còn|Tải lại trang/);
});
it.each([false,true])('organization still loading: create stays disabled without the choose-company hint mobile=%s',mobile=>{
  m.org=null;m.orgLoading=true;let header:unknown='unset';
  render(mobile?<MobileShareTokens onHeaderAction={value=>{header=value;}}/>:<ShareTokensTab/>);
  expect(screen.queryByText('Chọn công ty ở đầu trang để tạo link mới.')).toBeNull();
  if(mobile)expect(header).toBeNull();else expect(screen.getByRole('button',{name:'Tạo link mới'})).toHaveProperty('disabled',true);
});
it.each([false,true])('no selected organization disables create mobile=%s',mobile=>{
  m.org=null;let header:unknown='unset';
  render(mobile?<MobileShareTokens onHeaderAction={value=>{header=value;}}/>:<ShareTokensTab/>);
  expect(screen.getByText('Chọn công ty ở đầu trang để tạo link mới.')).toBeTruthy();
  if(mobile)expect(header).toBeNull();else expect(screen.getByRole('button',{name:'Tạo link mới'})).toHaveProperty('disabled',true);
  expect(m.create).not.toHaveBeenCalled();
});
it.each([false,true])('revoking the /phongtrong source link warns and does nothing until confirmed mobile=%s',async mobile=>{
  m.tokens=query([{...token,token:'demo',organization_id:'org-1'},{...token,token:'room-b',organization_id:'org-1'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  const note=within(dialog).getByRole('note');
  expect(note.textContent).toContain('/phongtrong');expect(note.textContent).not.toContain('cuối cùng');
  // demo là link sớm nhất (cùng giờ tạo, mã nhỏ hơn) ⇒ bot đổi nguồn sang link kế tiếp; Hermes: câu chung.
  expect(note.textContent).toContain('Bot Zalo đang lấy danh sách phòng của bạn qua link này');expect(note.textContent).toContain('«Sale A»');
  expect(note.textContent).toContain('Hermes');
  expect(m.revoke).not.toHaveBeenCalled();
});
it.each([false,true])('removing the last active link of the company warns about the Zalo bot and Hermes mobile=%s',async mobile=>{
  m.tokens=query([{...token,organization_id:'org-1'},{...token,token:'room-old',organization_id:'org-1',revoked:true},{...token,token:'room-other',organization_id:'org-2'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Xoá')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  const note=within(dialog).getByRole('note').textContent;
  expect(note).toContain('link còn hoạt động cuối cùng');expect(note).toContain('Bot Zalo');expect(note).toContain('Hermes');
  expect(m.remove).not.toHaveBeenCalled();
});
it.each([false,true])('a later link only carries the Hermes note; the bot keeps using the earliest link mobile=%s',async mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',created_at:'2026-10-02T00:00:00Z'},{...token,token:'room-b',organization_id:'org-1',created_at:'2026-10-01T00:00:00Z'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  const note=within(dialog).getByRole('note').textContent;
  expect(note).toContain('Hermes');expect(note).not.toContain('Bot Zalo');
});
it.each([false,true])('deleting an already revoked link has no bot or Hermes warning mobile=%s',async mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',revoked:true}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Xoá')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  expect(within(dialog).queryByRole('note')).toBeNull();
});
