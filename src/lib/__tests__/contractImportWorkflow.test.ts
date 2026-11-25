// @vitest-environment jsdom
// Đợt 7 (cách D): nhập hợp đồng Excel. Máy chủ giả giữ ràng buộc production `contracts_one_active_per_room_uq` (mỗi phòng một
// hợp đồng hiệu lực ⇒ 23505) và `contract_customers_unique` (hợp đồng, khách ⇒ 23505).
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'user-1'})}));
import {importContractBatch,readContractImportPending,type ContractImportSteps} from '../contractImportWorkflow';
import type {ContractImportRow} from '../contractExcelHelpers';
const scope={userId:'user-1',organizationId:'org-1',buildingId:'building-1'};
const row=(source_row:number,price=5000000):ContractImportRow=>({source_row,room_name:`P${source_row}`,customer_name:'Khách bí mật',customer_phone:'0900000000',signed_date:'2026-09-01',start_date:'2026-10-01',end_date:'2027-10-01',rent_price:price,payment_cycle:'MONTHLY',deposit:5000000,notes:'Ghi chú bí mật'});
const NETWORK=()=>new TypeError('Failed to fetch');
type Contract={id:string;room:string;tenant:string;price:number};
/** Máy chủ giả: hợp đồng theo phòng (một hợp đồng hiệu lực mỗi phòng) và liên kết (hợp đồng, khách) duy nhất. */
function server(){
 const contracts:Contract[]=[];const links=new Set<string>();let seq=0;
 const steps={
  customer:vi.fn(async(_row:ContractImportRow,priorId?:string)=>({id:priorId??'customer-1',created:false})),
  contract:vi.fn(async(input:ContractImportRow,customerId:string)=>{
   if(contracts.some(item=>item.room===input.room_name))throw {code:'23505',message:'duplicate key value violates unique constraint "contracts_one_active_per_room_uq"'};
   const created={id:`contract-${++seq}`,room:input.room_name,tenant:customerId,price:input.rent_price};contracts.push(created);return {id:created.id,roomId:`room-${input.room_name}`};
  }),
  link:vi.fn(async(contractId:string,customerId:string)=>{const id=`${contractId}|${customerId}`;if(links.has(id))throw {code:'23505',message:'contract_customers_unique'};links.add(id);}),
  occupy:vi.fn(async()=>undefined),
  verify:vi.fn(async()=>true),
  verifyCustomer:vi.fn(async()=>true),
  findActiveContract:vi.fn(async(input:ContractImportRow)=>{const found=contracts.find(item=>item.room===input.room_name);return found?{id:found.id,roomId:`room-${found.room}`,tenantId:found.tenant,matches:found.price===input.rent_price}:null;}),
 } satisfies ContractImportSteps;
 return {steps,contracts,links};
}
/** Dấu vân tay của dòng như bản trước lưu trong ảnh chụp (sha256 các trường của dòng). */
const fp=async(input:ContractImportRow)=>Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([input.room_name,input.customer_name,input.customer_phone,input.customer_id_number??null,input.signed_date,input.start_date,input.end_date,input.rent_price,input.payment_cycle,input.deposit,input.notes??null])))),byte=>byte.toString(16).padStart(2,'0')).join('');
const pendingKeys=()=>Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:v1:'));
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId',scope.organizationId);});afterEach(()=>vi.unstubAllGlobals());

describe('dòng chưa rõ kết quả: tra hợp đồng hiệu lực của phòng (cách D)',()=>{
 it('lệnh không tới máy chủ: không có hợp đồng của phòng ⇒ chạy lại đúng dòng đó; dòng sau không bị dừng; một hợp đồng mỗi phòng',async()=>{
  const fake=server();const create=fake.steps.contract;fake.steps.contract=vi.fn().mockRejectedValueOnce(NETWORK()).mockImplementation(create);
  const first=await importContractBatch([row(9),row(12)],scope,fake.steps,vi.fn());
  expect(first.pending).toBe(true);expect(first.errors.map(e=>e.row)).toEqual([9]);expect(first.success).toBe(1);
  expect(fake.steps.contract).toHaveBeenCalledTimes(2);
  const second=await importContractBatch([row(9),row(12)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:2,failed:0,pending:false});
  expect(fake.steps.findActiveContract).toHaveBeenCalledTimes(1);
  expect(fake.steps.contract).toHaveBeenCalledTimes(3);expect(fake.steps.contract.mock.calls[2][0].source_row).toBe(9);
  expect(fake.contracts.map(item=>item.room)).toEqual(['P12','P9']);
  expect(readContractImportPending(scope)).toBeNull();expect(pendingKeys()).toEqual([]);
 });
 it('tới nhưng mất phản hồi: phòng đã có đúng hợp đồng của khách đó ⇒ nhận là của lần trước, chỉ làm tiếp liên kết và phòng',async()=>{
  const fake=server();const create=fake.steps.contract;fake.steps.contract=vi.fn().mockImplementationOnce(async(input:ContractImportRow,customerId:string)=>{await create(input,customerId);throw NETWORK();}).mockImplementation(create);
  const first=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(first.pending).toBe(true);expect(fake.contracts).toHaveLength(1);
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:1,failed:0,pending:false,createdIds:[{row:9,id:'contract-1'}]});
  expect(fake.steps.contract).toHaveBeenCalledOnce();expect(fake.steps.link).toHaveBeenCalledWith('contract-1','customer-1');
  expect(fake.contracts).toHaveLength(1);expect(pendingKeys()).toEqual([]);
 });
 it('thấy hợp đồng của phòng mà không chứng minh được là của lần trước ⇒ báo «có thể» kèm mã, không nhập lại, không khoá',async()=>{
  const fake=server();fake.steps.contract=vi.fn().mockRejectedValueOnce(NETWORK());
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  fake.contracts.push({id:'contract-other',room:'P9',tenant:'customer-other',price:1});
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second.pending).toBe(false);expect(second.canCorrect).toBe(true);expect(second.success).toBe(0);
  expect(second.errors[0].message).toMatch(/contract-other/);expect(second.errors[0].message).toMatch(/có thể/);
  expect(fake.steps.contract).toHaveBeenCalledOnce();expect(pendingKeys()).toEqual([]);
 });
 it('dấu cũ gieo sẵn (bản trước) với dòng đang tạo hợp đồng: tra theo phòng, chưa có thì chạy tiếp dòng đó',async()=>{
  const fake=server();
  const marker='ihome:financial-pending:v1:'+['contract-excel-import','user-1','org-1','batch'].map(encodeURIComponent).join(':');
  localStorage.setItem(marker,JSON.stringify({namespace:'contract-excel-import',userId:'user-1',organizationId:'org-1',businessKey:'batch',attemptId:'legacy-attempt',requestKey:'legacy-attempt',completedIds:[],startedAt:new Date(Date.now()-10*60_000).toISOString()}));
  localStorage.setItem('ihome:contract-import-progress:v1:user-1:org-1',JSON.stringify({...scope,attemptId:'legacy-attempt',rows:[{sourceRow:9,fingerprint:await fp(row(9)),stage:'contract',customerId:'customer-1'}]}));
  expect(readContractImportPending(scope)?.canCorrect).toBe(false);
  const result=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(result).toMatchObject({success:1,failed:0,pending:false});
  expect(fake.steps.findActiveContract).toHaveBeenCalledOnce();expect(fake.steps.contract).toHaveBeenCalledOnce();
  expect(fake.contracts).toHaveLength(1);expect(pendingKeys()).toEqual([]);
 });
 it('dòng chưa rõ mà file đang nhập không còn dòng đó: chưa tra được ⇒ giữ dấu, không tạo gì thêm',async()=>{
  const fake=server();fake.steps.contract=vi.fn().mockRejectedValueOnce(NETWORK());
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  const other=await importContractBatch([row(12)],scope,fake.steps,vi.fn());
  expect(other.pending).toBe(true);expect(fake.steps.contract).toHaveBeenCalledOnce();expect(pendingKeys()).toHaveLength(1);
 });
 it('đọc hợp đồng của phòng hỏng: chưa kết luận được ⇒ giữ dấu, không tạo hợp đồng',async()=>{
  const fake=server();fake.steps.contract=vi.fn().mockRejectedValueOnce(NETWORK());
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  fake.steps.findActiveContract.mockRejectedValueOnce({code:'42501',message:'permission denied'});
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second.pending).toBe(true);expect(fake.steps.contract).toHaveBeenCalledOnce();expect(readContractImportPending(scope)).not.toBeNull();
 });
});

describe('sửa theo review: dòng chưa rõ phải đúng nội dung, mã mang sang phải còn đúng',()=>{
 it('dòng chưa rõ mà file mới đổi nội dung ở cùng số dòng: chưa kết luận được ⇒ giữ dấu, không tạo hợp đồng nào',async()=>{
  const fake=server();fake.steps.contract=vi.fn().mockRejectedValueOnce(NETWORK());
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  const second=await importContractBatch([{...row(9),room_name:'P99',customer_phone:'0911111111'}],scope,fake.steps,vi.fn());
  expect(second.pending).toBe(true);expect(fake.steps.contract).toHaveBeenCalledOnce();expect(fake.steps.findActiveContract).not.toHaveBeenCalled();expect(pendingKeys()).toHaveLength(1);
 });
 it('mã khách tìm theo SĐT ở lần trước không còn đúng người: tra lại khách như dòng mới, không gắn nhầm',async()=>{
  const fake=server();fake.steps.contract=vi.fn().mockRejectedValueOnce(NETWORK()).mockImplementation(async()=>({id:'contract-x',roomId:'room-P9'}));
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  fake.steps.verifyCustomer.mockResolvedValue(false);
  fake.steps.customer.mockImplementation(async(_row,priorId)=>({id:priorId??'customer-dung',created:false}));
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(fake.steps.customer.mock.calls[1][1]).toBeUndefined();expect(fake.steps.contract.mock.calls[1][1]).toBe('customer-dung');
 });
 it('hợp đồng đã nhận mã nhưng không còn là hợp đồng hiệu lực của phòng: không liên kết, không đặt «có người ở» lại',async()=>{
  const fake=server();const link=fake.steps.link;fake.steps.link=vi.fn().mockRejectedValueOnce({code:'42501',message:'permission denied'}).mockImplementation(link);
  const first=await importContractBatch([row(9)],scope,fake.steps,vi.fn());expect(first.pending).toBe(true);
  fake.contracts.length=0;
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:0,pending:false,canCorrect:true});expect(second.errors[0].message).toMatch(/contract-1.*không còn là hợp đồng hiệu lực/);
  expect(fake.steps.link).toHaveBeenCalledOnce();expect(fake.steps.occupy).not.toHaveBeenCalled();expect(pendingKeys()).toEqual([]);
 });
 it('tạo hợp đồng bị 23505 vì phòng đã có hợp đồng của người khác: báo mã đó, kết quả rõ, không khoá',async()=>{
  const fake=server();fake.contracts.push({id:'contract-other',room:'P9',tenant:'customer-other',price:1});
  const result=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(result).toMatchObject({success:0,failed:1,pending:false,canCorrect:true});expect(result.errors[0].message).toMatch(/contract-other/);expect(pendingKeys()).toEqual([]);
 });
 it('tạo hợp đồng bị 23505 mà hợp đồng của phòng đúng là của dòng này (lần trước đã tới): nhận nó, làm tiếp, không tạo lần hai',async()=>{
  const fake=server();const create=fake.steps.contract;fake.steps.contract=vi.fn().mockImplementationOnce(async(input:ContractImportRow,customerId:string)=>{await create(input,customerId);throw NETWORK();}).mockImplementation(create);
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  // Người dùng đã tự gỡ dấu qua hộp cảnh báo và xoá ảnh chụp: lượt mới không biết gì về lần trước.
  for(const key of Object.keys(localStorage))if(key.startsWith('ihome:'))localStorage.removeItem(key);
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:1,failed:0,pending:false,createdIds:[{row:9,id:'contract-1'}]});
  expect(fake.contracts).toHaveLength(1);expect(fake.steps.link).toHaveBeenCalledWith('contract-1','customer-1');
 });
});
describe('mỗi dòng độc lập, kết quả rõ không giữ dấu',()=>{
 it('dòng bị từ chối không dừng dòng sau; lượt không có dòng chưa rõ thì không giữ dấu; lượt sau bỏ qua dòng đã nhập đúng nội dung',async()=>{
  const fake=server();const create=fake.steps.contract;fake.steps.contract=vi.fn().mockRejectedValueOnce({code:'23514',message:'check violation'}).mockImplementation(create);
  const first=await importContractBatch([row(9),row(12)],scope,fake.steps,vi.fn());
  expect(first).toMatchObject({success:1,failed:1,pending:false,canCorrect:true,createdIds:[{row:12,id:'contract-1'}]});
  expect(readContractImportPending(scope)).toBeNull();expect(pendingKeys()).toEqual([]);
  const second=await importContractBatch([row(9,6000000),row(12)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:2,failed:0,pending:false});
  expect(fake.steps.contract).toHaveBeenCalledTimes(3);expect(fake.steps.contract.mock.calls[2][0].source_row).toBe(9);
  expect(fake.contracts.map(item=>item.room)).toEqual(['P12','P9']);
  expect(localStorage.getItem('ihome:contract-import-progress:v1:user-1:org-1')).toBeNull();
 });
 it('dòng đã nhập mà file mới đổi nội dung: không tạo hợp đồng thứ hai cho phòng đó (máy chủ từ chối, báo rõ)',async()=>{
  const fake=server();
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  const second=await importContractBatch([row(9,9000000)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:0,failed:1,pending:false,canCorrect:true});
  expect(second.errors[0].message).toMatch(/contract-1/);
  expect(fake.contracts).toHaveLength(1);
 });
 it('allows correction after a confirmed zero-write rejection',async()=>{
  const fake=server();const create=fake.steps.contract;fake.steps.contract=vi.fn().mockRejectedValueOnce({code:'23514',message:'check violation'}).mockImplementation(create);
  const first=await importContractBatch([row(9)],scope,fake.steps,vi.fn());expect(first.pending).toBe(false);expect(first.canCorrect).toBe(true);expect(readContractImportPending(scope)).toBeNull();
  const second=await importContractBatch([row(9,6000000)],scope,fake.steps,vi.fn());expect(second.success).toBe(1);expect(second.pending).toBe(false);expect(fake.steps.contract).toHaveBeenCalledTimes(2);
 });
 it('liên kết bị từ chối sau khi đã tạo hợp đồng: giữ mã hợp đồng; lần sau chỉ chạy lại liên kết, không tạo hợp đồng lần hai',async()=>{
  const fake=server();const link=fake.steps.link;fake.steps.link=vi.fn().mockRejectedValueOnce({code:'42501',message:'permission denied'}).mockImplementation(link);
  const first=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(first.createdIds).toEqual([{row:9,id:'contract-1'}]);expect(first.pending).toBe(true);
  expect(readContractImportPending(scope)?.createdIds).toEqual(first.createdIds);
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:1,pending:false});
  expect(fake.steps.contract).toHaveBeenCalledOnce();expect(fake.steps.link).toHaveBeenCalledTimes(2);expect(fake.steps.occupy).toHaveBeenCalledOnce();
 });
 it('liên kết đã có (trùng khoá hợp đồng + khách) là bước đã xong ở lần trước',async()=>{
  const fake=server();const link=fake.steps.link;fake.steps.link=vi.fn().mockImplementationOnce(async(contractId:string,customerId:string)=>{await link(contractId,customerId);throw NETWORK();}).mockImplementation(link);
  await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  const second=await importContractBatch([row(9)],scope,fake.steps,vi.fn());
  expect(second).toMatchObject({success:1,pending:false});expect(fake.links.size).toBe(1);expect(fake.steps.contract).toHaveBeenCalledOnce();
 });
 it('reuses a confirmed new customer for a rejected contract instead of duplicating the customer',async()=>{
  const fake=server();fake.steps.customer.mockResolvedValueOnce({id:'customer-new',created:true}).mockImplementation(async(_row,priorId)=>({id:priorId??'unexpected-new',created:false}));
  const create=fake.steps.contract;fake.steps.contract=vi.fn().mockRejectedValueOnce({code:'23514',message:'check violation'}).mockImplementation(create);
  const first=await importContractBatch([row(9)],scope,fake.steps,vi.fn());expect(first.customerIds).toEqual([{row:9,id:'customer-new'}]);
  const second=await importContractBatch([row(9,6000000)],scope,fake.steps,vi.fn());expect(second.success).toBe(1);
  expect(fake.steps.customer.mock.calls[1][1]).toBe('customer-new');expect(fake.steps.verifyCustomer).toHaveBeenCalledWith('customer-new',expect.objectContaining({source_row:9}));
 });
 it('không lưu tên, SĐT hay ghi chú của khách vào trình duyệt',async()=>{
  const fake=server();fake.steps.contract=vi.fn().mockRejectedValue(NETWORK());
  await importContractBatch([row(9),row(12)],scope,fake.steps,vi.fn());
  expect(Object.values(localStorage).join(' ')).not.toMatch(/Khách bí mật|0900000000|Ghi chú bí mật/);
 });
});
