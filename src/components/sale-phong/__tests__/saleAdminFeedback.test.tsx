// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({org:'org-1' as string|null,orgLoading:false,tokens:{} as Record<string,unknown>,settings:{} as Record<string,unknown>,create:vi.fn(),label:vi.fn(),revoke:vi.fn(),remove:vi.fn(),save:vi.fn(),retry:vi.fn(),rooms:{} as Record<string,unknown>,sheetSave:vi.fn(),botTokens:[] as string[]}));
vi.mock('@tanstack/react-query', async original => ({ ...(await original<typeof import('@tanstack/react-query')>()), useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: 'actor-a' } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { __superadmin: true }, isError: false }) }));
vi.mock('@/hooks/useSaleRoomInventory', async () => {
  const { sheetInventoryFixture } = await import('./sheetInventoryFixture');
  // Đợt 2 Sale phòng: người sửa (actor-a) KHÔNG đứng tên chung các toà (owner-b) mà vẫn sửa được cài đặt chung nhờ quyền.
  return { useSaleRoomInventory: () => ({ ...m.rooms, data: m.rooms.data === undefined ? undefined : { ...sheetInventoryFixture(m.rooms.data as import('@/pages/phong-trong/sampleData').Building[]), settingsOwnerId: 'owner-b' } }) };
});
vi.mock('@/hooks/usePublicRoomTokens',()=>{const mutation=(fn:typeof m.create)=>({mutateAsync:fn,mutate:(value:unknown,options?:{onSuccess?:(value:unknown)=>unknown;onError?:(error:unknown)=>unknown})=>{void fn(value).then(options?.onSuccess,options?.onError??(()=>{}));},isPending:false});return {usePublicRoomTokens:()=>m.tokens,useCreatePublicRoomToken:()=>(mutation(m.create)),useUpdateTokenLabel:()=>(mutation(m.label)),useSetTokenRevoked:()=>(mutation(m.revoke)),useDeletePublicRoomToken:()=>(mutation(m.remove)),useBotShareTokens:()=>({data:m.botTokens})};});
vi.mock('@/hooks/usePublicRoomSettings',()=>({usePublicRoomSettings:()=>m.settings,useUpsertPublicRoomSettings:()=>({mutateAsync:m.save,mutate:(value:unknown)=>{void m.save(value).catch(()=>{});},isPending:false}),PUBLIC_ROOM_SETTINGS_DEFAULTS:{soon_days:30,show_rented:true,hotline_id:null,sale_policy:null}}));
// Hotline in được lên trang đi kèm cài đặt chung (của người đứng tên chung) — không còn đọc danh sách hotline riêng của người sửa.
vi.mock('@/hooks/useHotlines',()=>({useCreateHotline:()=>({mutateAsync:vi.fn(),isPending:false}),useUpdateHotline:()=>({mutateAsync:vi.fn(),isPending:false})}));
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
const T1='2026-11-25T01:00:00+00:00';
type Hotline={id:string;name:string|null;phone_number:string;is_active:boolean|null;created_at:string|null};
/** usePublicRoomSettings().data: cài đặt chung của công ty (người đứng tên chung owner-b) kèm hotline của người đó. */
const company=(values:Record<string,unknown>,hotlines:Hotline[]=[])=>({settings:{soon_days:30,show_rented:true,hotline_id:null,sale_policy:null,...values},ownerId:'owner-b',exists:true,updatedAt:T1,canManage:true,hotlines});
const query=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:m.retry,dataUpdatedAt:Date.now()});
const failure=(data:unknown)=>({...query(data),status:'error',isError:true,error:{code:'42501',message:'SQL_PRIVATE_DIAGNOSTIC'}});
beforeEach(()=>{vi.clearAllMocks(); sessionStorage.clear();m.botTokens=[];m.org='org-1';m.orgLoading=false;m.tokens=query([token]);m.settings=query(company({}));m.rooms=query([]);m.save.mockResolvedValue({});const unknown=new FinancialWorkflowError('Chưa xác nhận được yêu cầu; kiểm tra link room-a trước khi thực hiện tiếp.','unknown',[]);m.create.mockRejectedValue(unknown);m.remove.mockRejectedValue(unknown);m.label.mockRejectedValue(unknown);m.revoke.mockRejectedValue(unknown);});afterEach(cleanup);
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
// Hotline đi cùng lần đọc cài đặt chung: lỗi đọc đó (ở trên) chặn cả hotline; đọc được thì hiện hotline của người đứng tên chung.
it.each([false,true])('owner hotlines ride on the company settings and a non-owner save carries the CAS key mobile=%s',async mobile=>{
  m.settings=query(company({hotline_id:'h-owner'},[{id:'h-owner',name:'Hotline chủ toà',phone_number:'0911 222 333',is_active:true,created_at:'2026-11-01T00:00:00+00:00'}]));
  render(settings(mobile));openGear(mobile);
  if(mobile)expect(within(screen.getByRole('dialog')).getByRole('button',{name:/Hotline chủ toà/}).getAttribute('aria-pressed')).toBe('true');
  else expect(screen.getByLabelText('Hotline chung cho tất cả nhà')).toHaveProperty('value','0911 222 333');
  fireEvent.change(screen.getByLabelText('Số ngày báo "sắp trống"'),{target:{value:'41'}});fireEvent.click(saveButton(mobile));
  await waitFor(()=>expect(m.save).toHaveBeenCalledOnce());
  expect(m.save).toHaveBeenCalledWith(expect.objectContaining({soon_days:41,hotline_id:'h-owner',expectedUpdatedAt:T1}));
});
it.each([false,true])('stale settings blocks save and retains draft mobile=%s',mobile=>{const view=render(settings(mobile));openGear(mobile);const input=screen.getByLabelText('Số ngày báo "sắp trống"');fireEvent.change(input,{target:{value:'41'}});m.settings={...query(company({})),status:'error',isError:true,error:new TypeError('Failed to fetch')};view.rerender(settings(mobile));expect(input).toHaveProperty('value','41');expect(saveButton(mobile)).toHaveProperty('disabled',true);expect(screen.getByText(/Chưa cập nhật được cài đặt hiển thị/)).toBeTruthy();});
it.each([false,true])('successful refetch does not overwrite edited draft mobile=%s',mobile=>{const view=render(settings(mobile));openGear(mobile);const input=screen.getByLabelText('Số ngày báo "sắp trống"');fireEvent.change(input,{target:{value:'41'}});m.settings=query(company({soon_days:25,show_rented:false}));view.rerender(settings(mobile));expect(input).toHaveProperty('value','41');});
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
  // Đợt 2: bot Zalo và Hermes đọc theo công ty — công ty còn link room-b thì không cảnh báo bot/Hermes.
  expect(note.textContent).not.toMatch(/Bot Zalo|Hermes/);
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
it.each([false,true])('another active company link (even created by someone else) means no bot or Hermes warning mobile=%s',async mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',created_at:'2026-10-02T00:00:00Z'},{...token,token:'room-b',owner_id:'actor-b',owner_name:'Chị B',organization_id:'org-1',created_at:'2026-10-01T00:00:00Z'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  expect(within(dialog).queryByRole('note')).toBeNull();
});
it.each([false,true])('the last active link is counted across creators: revoking someone else\'s last link warns mobile=%s',async mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',revoked:true},{...token,token:'room-b',owner_id:'actor-b',owner_name:'Chị B',organization_id:'org-1'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  const note=within(dialog).getByRole('note').textContent;
  expect(note).toContain('link còn hoạt động cuối cùng của công ty');expect(note).toContain('Bot Zalo');expect(note).toContain('Hermes');
  expect(m.revoke).not.toHaveBeenCalled();
});
it.each([false,true])('deleting an already revoked link has no bot or Hermes warning mobile=%s',async mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',revoked:true}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Xoá')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  expect(within(dialog).queryByRole('note')).toBeNull();
});

// Đợt 2: danh sách là mọi link của công ty, ghi rõ người tạo; thao tác link báo lý do thật của máy chủ.
it.each([false,true])('company links show who created them mobile=%s',mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',owner_id:'actor-b',owner_name:'Chị B'},{...token,token:'room-b',organization_id:'org-1',owner_name:null}]);
  render(links(mobile).node);
  if(mobile)expect(screen.getByText(/· Chị B$/)).toBeTruthy();
  else{expect(screen.getByRole('columnheader',{name:'Người tạo'})).toBeTruthy();expect(screen.getByRole('cell',{name:'Chị B'})).toBeTruthy();expect(screen.getByRole('cell',{name:'—'})).toBeTruthy();}
});
it.each([false,true].flatMap(mobile=>[
  {mobile,error:{code:'42501',message:'public_room_token_permission',hint:'SQL_PRIVATE_DIAGNOSTIC'},reason:'Quản lý link chia sẻ'},
  {mobile,error:{code:'P0002',message:'public_room_token_not_found',hint:'SQL_PRIVATE_DIAGNOSTIC'},reason:'Không thấy link này trong công ty đang chọn'},
  {mobile,error:{code:'42501',message:'public_room_token_permission_org',hint:'SQL_PRIVATE_DIAGNOSTIC'},reason:'phạm vi TOÀN CÔNG TY'},
  {mobile,error:{code:'22023',message:'public_room_token_invalid',hint:'SQL_PRIVATE_DIAGNOSTIC'},reason:'Thao tác link không hợp lệ'},
]))('server revoke rejection says it was not done and why, keeps the dialog usable mobile=$mobile $error.message',async({mobile,error,reason})=>{
  m.tokens=query([{...token,organization_id:'org-1'},{...token,token:'room-b',organization_id:'org-1'}]);m.revoke.mockRejectedValue(error);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  fireEvent.click(within(dialog).getByRole('button',{name:'Thu hồi'}));
  await waitFor(()=>expect(m.revoke).toHaveBeenCalledWith({token:'room-a',revoked:true}));
  const alert=await within(dialog).findByRole('alert');
  expect(alert.textContent).toContain('Không thao tác được link');expect(alert.textContent).toContain(reason);
  expect(document.body.textContent).not.toContain('SQL_PRIVATE');
  // Bị từ chối hẳn: không khoá như khi chưa rõ kết quả.
  expect(within(dialog).getByRole('button',{name:'Thu hồi'})).toHaveProperty('disabled',false);
});

// Sau review 25/11: sửa / thu hồi / xoá link NGƯỜI KHÁC cần quyền phạm vi công ty (máy chủ trả can_manage theo từng link).
it.each([false,true])('links the viewer may not manage (created by someone else, building-scope permission) have their actions disabled mobile=%s',mobile=>{
  m.tokens=query([{...token,organization_id:'org-1',can_manage:true},{...token,token:'room-b',owner_id:'actor-b',owner_name:'Chị B',organization_id:'org-1',can_manage:false},
    {...token,token:'room-c',owner_id:'actor-b',organization_id:'org-1',revoked:true,can_manage:false}]);
  render(links(mobile).node);
  const locked=screen.getAllByTitle(/Link của người khác/);
  expect(locked).toHaveLength(6); // room-b: đổi nhãn, thu hồi, xoá; room-c: đổi nhãn, khôi phục, xoá
  for(const button of locked)expect(button).toHaveProperty('disabled',true);
  for(const title of ['Đổi nhãn','Thu hồi','Xoá'])expect(screen.getByTitle(title)).toHaveProperty('disabled',false);
});
it.each([false,true])('revoking the link the Zalo bot sends warns even when the company keeps other links mobile=%s',async mobile=>{
  m.botTokens=['room-a'];
  m.tokens=query([{...token,organization_id:'org-1'},{...token,token:'room-b',organization_id:'org-1'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  const note=within(dialog).getByRole('note').textContent;
  expect(note).toContain('link bot Zalo đang gửi khách');expect(note).not.toContain('cuối cùng');
  expect(m.revoke).not.toHaveBeenCalled();
});
it.each([false,true])('a link the bot does not send has no bot warning mobile=%s',async mobile=>{
  m.botTokens=['room-b'];
  m.tokens=query([{...token,organization_id:'org-1'},{...token,token:'room-b',organization_id:'org-1'}]);
  render(links(mobile).node);fireEvent.click(screen.getAllByTitle('Thu hồi')[0]);
  const dialog=await screen.findByRole(mobile?'dialog':'alertdialog');
  expect(within(dialog).queryByRole('note')).toBeNull();
});
