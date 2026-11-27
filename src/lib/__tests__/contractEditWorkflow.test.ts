// @vitest-environment jsdom
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {runContractEdit,loadContractEditJob,contractEditValveStore,CONTRACT_EDIT_NAMESPACE,type ContractEditRequest,type ContractEditSnapshot,type ContractEditPorts} from '../contractEditWorkflow';
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
const request:ContractEditRequest={contractId:'c1',expectedCustomers:[{customer_id:'old',is_representative:true,notes:null}],updates:{rent_price:200},fieldsFingerprint:'new-form',customers:[{customer_id:'customer1',is_representative:true,notes:null}],services:[{service_id:'s1',unit_price:50,initial_reading:null}]};
let actual:ContractEditSnapshot;let ports:ContractEditPorts;
beforeEach(()=>{localStorage.clear();actual={contract:{id:'c1',organization_id:'o1',rent_price:100},customers:[{customer_id:'old',is_representative:true,notes:null}],services:[]};ports={read:vi.fn(async()=>structuredClone(actual)),update:vi.fn(async input=>{Object.assign(actual.contract,input.updates);return actual.contract;}),customers:vi.fn(async(input)=>{input.onPhase?.('deleting');actual.customers=[];input.onPhase?.('deleted');input.onPhase?.('inserting');actual.customers=input.customers;input.onPhase?.('done');}),services:vi.fn(async(input)=>{input.onPhase?.('deleting');actual.services=[];input.onPhase?.('deleted');input.onPhase?.('inserting');actual.services=input.services;input.onPhase?.('done');})};});
it('lưu marker trước writer, exact core và relations xong mới xóa snapshot',async()=>{const update=ports.update;ports.update=vi.fn(async input=>{expect(await loadContractEditJob('c1')).toMatchObject({contractId:'c1',corePhase:'sending'});return update(input);});await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(await loadContractEditJob('c1')).toBeNull();expect(ports.customers).toHaveBeenCalledWith(expect.objectContaining({organizationId:'o1'}));});
// Đợt 7 (cách A): đọc lại chưa khớp giá trị đích thì gửi lại ĐÚNG giá trị đã lưu trong dấu, không phải nội dung form mới.
it('core receipt null không bắt đầu quan hệ; lần sau đọc chưa khớp thì gửi lại đúng giá trị đã lưu trong dấu, không dùng nội dung form mới',async()=>{ports.update=vi.fn(async()=>null);await expect(runContractEdit(request,ports)).rejects.toThrow(/đối chiếu/);expect(ports.customers).not.toHaveBeenCalled();expect(await loadContractEditJob('c1')).toMatchObject({corePhase:'sending'});await expect(runContractEdit({...request,updates:{rent_price:999}},ports)).rejects.toThrow(/đối chiếu/);expect(ports.update).toHaveBeenCalledTimes(2);expect(ports.update).toHaveBeenLastCalledWith(expect.objectContaining({updates:{rent_price:200}}));expect(ports.customers).not.toHaveBeenCalled();});
it('unknown core đã thực sự lưu được xác nhận bằng readback trước khi tiếp tục các phần còn thiếu',async()=>{ports.update=vi.fn(async input=>{Object.assign(actual.contract,input.updates);throw new TypeError('Failed to fetch');});await expect(runContractEdit(request,ports)).rejects.toThrow();expect(await loadContractEditJob('c1')).toMatchObject({corePhase:'sending'});await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(ports.update).toHaveBeenCalledOnce();expect(ports.customers).toHaveBeenCalledOnce();});
it('known insert rejection sau delete giữ phase/ID, reload đọc empty mới insert không delete lại',async()=>{ports.customers=vi.fn(async input=>{input.onPhase?.('deleting');actual.customers=[];input.onPhase?.('deleted');input.onPhase?.('inserting');throw {code:'23514',message:'bad row'};});await expect(runContractEdit(request,ports)).rejects.toThrow();expect(await loadContractEditJob('c1')).toMatchObject({customersPhase:'deleted',corePhase:'done'});ports.customers=vi.fn(async input=>{expect(input.skipDelete).toBe(true);actual.customers=input.customers;input.onPhase?.('done');});await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(ports.update).toHaveBeenCalledOnce();});
it('unknown insert + authoritative empty không được đoán rollback để insert lại',async()=>{ports.customers=vi.fn(async input=>{input.onPhase?.('deleting');actual.customers=[];input.onPhase?.('deleted');input.onPhase?.('inserting');throw new TypeError('Failed to fetch');});await expect(runContractEdit(request,ports)).rejects.toThrow();await expect(runContractEdit(request,ports)).rejects.toThrow(/đối chiếu/);expect(ports.customers).toHaveBeenCalledOnce();expect(ports.services).not.toHaveBeenCalled();});
// Đợt 7 (cách A): lệnh xoá chưa rõ mà đọc lại đã rỗng ⇒ phần xoá đã xong; chỉ chèn đúng danh sách trong dấu, không xoá lần hai.
it('unknown delete + authoritative empty: không xoá lần hai, chỉ chèn đúng danh sách đích trong dấu',async()=>{ports.customers=vi.fn().mockImplementationOnce(async input=>{input.onPhase?.('deleting');actual.customers=[];throw new TypeError('Failed to fetch');}).mockImplementation(async input=>{expect(input.skipDelete).toBe(true);expect(input.expectedCustomers).toEqual([]);actual.customers=input.customers;input.onPhase?.('done');});await expect(runContractEdit(request,ports)).rejects.toThrow();await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(ports.customers).toHaveBeenCalledTimes(2);expect(actual.customers).toEqual(request.customers);});
it('unknown insert thực sự xong: desired relations được read-confirm rồi chỉ tiếp tục services',async()=>{ports.customers=vi.fn(async input=>{input.onPhase?.('deleting');actual.customers=[];input.onPhase?.('deleted');input.onPhase?.('inserting');actual.customers=input.customers;throw new TypeError('Failed to fetch');});await expect(runContractEdit(request,ports)).rejects.toThrow();await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(ports.customers).toHaveBeenCalledOnce();expect(ports.services).toHaveBeenCalledOnce();});
it('read failure giữ snapshot/ID, không writer mới sau reload',async()=>{ports.update=vi.fn(async()=>null);await expect(runContractEdit(request,ports)).rejects.toThrow();ports.read=vi.fn().mockRejectedValue({code:'42501'});await expect(runContractEdit(request,ports)).rejects.toThrow(/c1/);expect(ports.update).toHaveBeenCalledOnce();expect(ports.customers).not.toHaveBeenCalled();});
it('storage không ghi được chặn trước writer',async()=>{vi.spyOn(Storage.prototype,'setItem').mockImplementationOnce(()=>{throw new Error('quota');});await expect(runContractEdit(request,ports)).rejects.toThrow();expect(ports.update).not.toHaveBeenCalled();});
it('double click chặn update thứ hai trong khi writer đầu đang pending',async()=>{let finish:()=>void=()=>{};ports.update=vi.fn(async input=>{await new Promise<void>(resolve=>{finish=resolve;});Object.assign(actual.contract,input.updates);return actual.contract;});const first=runContractEdit(request,ports);await vi.waitFor(()=>expect(ports.update).toHaveBeenCalledOnce());await expect(runContractEdit(request,ports)).rejects.toThrow(/đang/);finish();await first;expect(ports.update).toHaveBeenCalledOnce();});
it('known deleted phase nhưng relation có row khác không ghi đè thay đổi concurrent',async()=>{ports.customers=vi.fn(async input=>{input.onPhase?.('deleting');actual.customers=[];input.onPhase?.('deleted');input.onPhase?.('inserting');throw {code:'23514'};});await expect(runContractEdit(request,ports)).rejects.toThrow();actual.customers=[{customer_id:'concurrent',is_representative:true}];await expect(runContractEdit(request,ports)).rejects.toThrow();expect(ports.customers).toHaveBeenCalledOnce();});

it('known core rejection zero-write giải phóng intent cũ để sửa trường rồi gửi lại',async()=>{ports.update=vi.fn().mockRejectedValueOnce({code:'23514',message:'invalid amount'}).mockImplementation(async input=>{Object.assign(actual.contract,input.updates);return actual.contract;});await expect(runContractEdit(request,ports)).rejects.toBeDefined();expect(await loadContractEditJob('c1')).toBeNull();await expect(runContractEdit({...request,updates:{rent_price:300}},ports)).resolves.toMatchObject({contractId:'c1'});expect(actual.contract.rent_price).toBe(300);});
it('known read denial sau relation đã xong không đổi phase thành rejected để delete lại',async()=>{let fail=false;const read=ports.read;ports.read=vi.fn(async id=>{if(fail)throw {code:'42501'};return read(id);});ports.customers=vi.fn(async input=>{actual.customers=input.customers;input.onPhase?.('done');fail=true;});await expect(runContractEdit(request,ports)).rejects.toThrow();expect(await loadContractEditJob('c1')).toMatchObject({customersPhase:'done'});fail=false;await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(ports.customers).toHaveBeenCalledOnce();});

// Đợt 7: đích là «không còn dịch vụ» và đọc lại thấy đúng rỗng: đó là giá trị đích, phần dịch vụ xong (cách A), không khoá.
it('unknown delete mà đích là rỗng và đọc lại thấy rỗng: phần dịch vụ đã đúng đích, hoàn tất và gỡ dấu, không xoá lần hai',async()=>{ports.services=vi.fn(async input=>{input.onPhase?.('deleting');actual.services=[];throw new TypeError('Failed to fetch');});actual.services=[{service_id:'old',unit_price:10}];const intent={...request,services:[]};await expect(runContractEdit(intent,ports)).rejects.toThrow();await expect(runContractEdit(intent,ports)).resolves.toMatchObject({contractId:'c1'});expect(await loadContractEditJob('c1')).toBeNull();expect(ports.services).toHaveBeenCalledOnce();});
it('atomic membership receives original baseline and safely recovers an unknown successful write',async()=>{const original=structuredClone(actual.customers);ports.customers=vi.fn(async input=>{expect(input.expectedCustomers).toEqual(original);input.onPhase?.('reconciling');actual.customers=input.customers;throw new TypeError('Failed to fetch');});await expect(runContractEdit(request,ports)).rejects.toThrow();expect(await loadContractEditJob('c1')).toMatchObject({customersPhase:'reconciling'});await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});expect(ports.customers).toHaveBeenCalledOnce();});
it('unknown atomic write with unchanged baseline retries CAS, concurrent members are never adopted',async()=>{ports.customers=vi.fn(async input=>{input.onPhase?.('reconciling');throw new TypeError('Failed to fetch');});await expect(runContractEdit(request,ports)).rejects.toThrow();actual.customers=[{customer_id:'concurrent',is_representative:true}];await expect(runContractEdit(request,ports)).rejects.toThrow();expect(ports.customers).toHaveBeenCalledOnce();});
it('stale form membership is rejected before any writer even when the save-time read includes the concurrent member',async()=>{const expectedCustomers=structuredClone(actual.customers);actual.customers.push({customer_id:'concurrent',is_representative:false,notes:null});await expect(runContractEdit({...request,expectedCustomers},ports)).rejects.toThrow(/khách hàng.*thay đổi|thay đổi.*khách hàng/i);expect(ports.update).not.toHaveBeenCalled();expect(ports.customers).not.toHaveBeenCalled();expect(await loadContractEditJob('c1')).toBeNull();});

// ── Đợt 7 (plan sửa khoá vĩnh viễn): kho dấu riêng của sửa hợp đồng, cách A + hộp cảnh báo chung ─────────────────────
describe('đợt 7: sửa hợp đồng không còn khoá vĩnh viễn',()=>{
 const key='ihome:contract-edit-pending:v1:u1:c1';
 const seed=(over:Record<string,unknown>={})=>localStorage.setItem(key,JSON.stringify({version:1,actorId:'u1',attemptId:'legacy-attempt',contractId:'c1',organizationId:'o1',fieldsFingerprint:'old-form',updates:{rent_price:200},before:{rent_price:100},corePhase:'sending',customersPhase:'not-started',servicesPhase:'not-started',customers:request.customers,services:request.services,baseline:{customers:[{customer_id:'old',is_representative:true,notes:null}],services:[]},startedAt:new Date(Date.now()-10*60_000).toISOString(),...over}));
 const valve=()=>({report:vi.fn()});
 it('lệnh không tới máy chủ: lần sau đọc chưa khớp ⇒ gửi lại đúng giá trị trong dấu, hoàn tất, gỡ dấu',async()=>{
  const update=ports.update;ports.update=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(update);
  await expect(runContractEdit(request,ports)).rejects.toThrow(/đối chiếu/);
  expect(await loadContractEditJob('c1')).toMatchObject({corePhase:'sending'});
  await expect(runContractEdit({...request,updates:{rent_price:777}},ports)).resolves.toMatchObject({contractId:'c1',fieldsFingerprint:'new-form'});
  expect(ports.update).toHaveBeenCalledTimes(2);expect(ports.update).toHaveBeenLastCalledWith(expect.objectContaining({updates:{rent_price:200}}));
  expect(actual.contract.rent_price).toBe(200);expect(ports.customers).toHaveBeenCalledOnce();expect(ports.services).toHaveBeenCalledOnce();
  expect(await loadContractEditJob('c1')).toBeNull();
 });
 it('tới nhưng mất phản hồi: đọc lại khớp đích ⇒ không gửi lần hai, làm tiếp phần còn lại',async()=>{
  ports.update=vi.fn(async input=>{Object.assign(actual.contract,input.updates);throw new TypeError('Failed to fetch');});
  await expect(runContractEdit(request,ports)).rejects.toThrow();
  await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});
  expect(ports.update).toHaveBeenCalledOnce();expect(await loadContractEditJob('c1')).toBeNull();
 });
 it('dấu gieo sẵn pha «đang gửi», các trường còn như lúc tạo dấu: gửi lại đúng giá trị trong dấu rồi hoàn tất',async()=>{
  seed();
  await expect(runContractEdit({...request,updates:{rent_price:555},fieldsFingerprint:'form-now'},ports)).resolves.toMatchObject({contractId:'c1',fieldsFingerprint:'old-form'});
  expect(ports.update).toHaveBeenCalledOnce();expect(ports.update).toHaveBeenCalledWith(expect.objectContaining({updates:{rent_price:200}}));
  expect(await loadContractEditJob('c1')).toBeNull();
 });
 it('dấu cũ gieo sẵn của bản trước (không biết các trường lúc tạo dấu), chưa khớp đích: không gửi lại mù, giữ dấu, báo hộp cảnh báo',async()=>{
  seed({before:undefined,activeAt:undefined});const deps={valve:valve()};
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow(/thay đổi ở nơi khác/);
  expect(ports.update).not.toHaveBeenCalled();expect(deps.valve.report).toHaveBeenCalledOnce();expect(await loadContractEditJob('c1')).not.toBeNull();
 });
 it('pha «đang gửi» mà người khác đã đổi đúng trường đó (khác cả đích lẫn lúc tạo dấu): không ghi đè, giữ dấu, báo hộp cảnh báo',async()=>{
  const update=ports.update;ports.update=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(update);
  const deps={valve:valve()};
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow();
  actual.contract.rent_price=150;
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow(/thay đổi ở nơi khác/);
  expect(ports.update).toHaveBeenCalledOnce();expect(actual.contract.rent_price).toBe(150);expect(deps.valve.report).toHaveBeenCalledOnce();
  expect(await loadContractEditJob('c1')).toMatchObject({corePhase:'sending',before:{rent_price:100}});
 });
 it('dấu cũ gieo sẵn đang chèn dịch vụ dở, dịch vụ đã rỗng: chèn lại đúng danh sách trong dấu (không xoá lần hai)',async()=>{
  actual.contract.rent_price=200;actual.customers=structuredClone(request.customers);
  seed({corePhase:'done',customersPhase:'done',servicesPhase:'inserting',baseline:{customers:[{customer_id:'old',is_representative:true,notes:null}],services:[{service_id:'old',unit_price:10,initial_reading:null}]}});
  ports.services=vi.fn(async input=>{expect(input.skipDelete).toBe(true);actual.services=input.services;input.onPhase?.('done');});
  await expect(runContractEdit(request,ports)).resolves.toMatchObject({contractId:'c1'});
  expect(ports.services).toHaveBeenCalledOnce();expect(ports.update).not.toHaveBeenCalled();expect(actual.services).toEqual(request.services);
 });
 it('chèn dịch vụ dở còn mới (lệnh cũ có thể đang chạy): chờ 2 phút kể từ lần ghi cuối rồi mới chèn lại',async()=>{
  let clock=Date.now();const deps={now:()=>new Date(clock),valve:valve()};
  ports.services=vi.fn().mockImplementationOnce(async input=>{input.onPhase?.('deleting');actual.services=[];input.onPhase?.('deleted');input.onPhase?.('inserting');throw new TypeError('Failed to fetch');}).mockImplementation(async input=>{actual.services=input.services;input.onPhase?.('done');});
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow();
  clock+=30_000;
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow(/đang chờ kết quả/);
  expect(ports.services).toHaveBeenCalledOnce();expect(deps.valve.report).toHaveBeenCalledOnce();
  clock+=3*60_000;
  await expect(runContractEdit(request,ports,deps)).resolves.toMatchObject({contractId:'c1'});
  expect(ports.services).toHaveBeenCalledTimes(2);expect(await loadContractEditJob('c1')).toBeNull();
 });
 it('gửi lại mà máy chủ từ chối rõ (hết phiên / khớp 0 dòng): gỡ dấu, không để pha «đang gửi»',async()=>{
  for(const code of ['PGRST301','PGRST116']){
   localStorage.clear();seed();ports.update=vi.fn().mockRejectedValue({code,message:'rejected'});
   await expect(runContractEdit(request,ports)).rejects.toMatchObject({code});
   expect(await loadContractEditJob('c1')).toBeNull();
  }
 });
 it('không kết luận được (người khác đã đổi khách hàng): giữ dấu, báo hộp cảnh báo chung; tự gỡ qua hộp xong thì sửa lại được',async()=>{
  seed({corePhase:'done',customersPhase:'reconciling'});actual.contract.rent_price=200;actual.customers=[{customer_id:'concurrent',is_representative:true,notes:null}];
  const deps={valve:valve()};
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow(/khách hàng|quan hệ/);
  expect(ports.customers).not.toHaveBeenCalled();expect(deps.valve.report).toHaveBeenCalledOnce();
  const notice=deps.valve.report.mock.calls[0][0];
  expect(notice.pending).toMatchObject({namespace:CONTRACT_EDIT_NAMESPACE,userId:'u1',organizationId:'o1',businessKey:'c1',attemptId:'legacy-attempt',operation:'cập nhật hợp đồng',completedIds:['c1']});
  expect(notice.store.read({namespace:CONTRACT_EDIT_NAMESPACE,userId:'u1',organizationId:'o1',businessKey:'c1'})?.attemptId).toBe('legacy-attempt');
  expect(notice.store.clearConfirmed({namespace:CONTRACT_EDIT_NAMESPACE,userId:'u1',organizationId:'o1',businessKey:'c1'},'other-attempt')).toBe(false);
  expect(contractEditValveStore.clearConfirmed({namespace:CONTRACT_EDIT_NAMESPACE,userId:'u1',organizationId:'o1',businessKey:'c1'},'legacy-attempt')).toBe(true);
  expect(await loadContractEditJob('c1')).toBeNull();
  actual.customers=[{customer_id:'concurrent',is_representative:true,notes:null}];
  await expect(runContractEdit({...request,expectedCustomers:actual.customers},ports,deps)).resolves.toMatchObject({contractId:'c1'});
 });
 it('lần gửi đầu chưa rõ kết quả không mở hộp cảnh báo (như lõi chung); lần bấm sau vẫn chưa kết luận mới mở',async()=>{
  const deps={valve:valve()};ports.update=vi.fn(async()=>null);
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow();expect(deps.valve.report).not.toHaveBeenCalled();
  ports.read=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(runContractEdit(request,ports,deps)).rejects.toThrow(/c1/);expect(deps.valve.report).toHaveBeenCalledOnce();
 });
});
