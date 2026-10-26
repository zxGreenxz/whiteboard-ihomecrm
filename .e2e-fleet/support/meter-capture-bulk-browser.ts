import {expect,type Page,type TestInfo} from '@playwright/test';
import {z} from 'zod';
import {meterSourceReferenceSchema} from '../../src/lib/meter-capture/types';
import {METER_TEST_URL,type MeterLiveFixture} from './meter-capture-live-fixture';

/** Only two disposable contracts may be written, through the real application gateway. */
export async function installMeterBulkBrowser(page:Page,fixture:MeterLiveFixture){
 const subjects=[fixture,{...fixture,...fixture.bulkRoom}],receipts=new Map<string,string>();
 const requests:unknown[]=[],blocked:string[]=[],observations:unknown[]=[];
 const duplicateRejections:string[]=[];
 page.on('console',message=>{if(message.type()==='error'&&message.text().startsWith('Create invoice failed for E2E-METER-'))observations.push({consoleError:message.text().slice(0,1600)});});
 await page.route(`${METER_TEST_URL}/functions/v1/meter-capture-worker`,async route=>{
  const raw:unknown=route.request().postDataJSON();
  const envelope=z.object({action:z.string(),organizationId:z.string(),rpcAction:z.string().optional(),payload:z.record(z.unknown()).optional()}).safeParse(raw);
  const deny=()=>{blocked.push('Unscoped bulk gateway request');observations.push({deniedAction:envelope.success?envelope.data.action:'invalid-envelope'});return route.abort('blockedbyclient');};
  if(!envelope.success||envelope.data.organizationId!==fixture.organizationId)return deny();
  const body=envelope.data;
  if(body.action==='rpc'){
   const p=body.payload??{};
   if(body.rpcAction==='resolveBilling'&&subjects.some(s=>s.contractId===p.contractId)&&p.month===fixture.readingDate.slice(0,7)&&p.purpose==='MONTHLY')return route.continue();
   if(body.rpcAction==='documentReceipt'&&p.kind==='invoice'&&typeof p.idempotencyKey==='string'&&/^meter-invoice-[a-f0-9]{64}$/.test(p.idempotencyKey))return route.continue();
   if(body.rpcAction==='documentEvidence'&&p.kind==='INVOICE'&&[...receipts.values()].includes(String(p.documentId)))return route.continue();
   return route.fallback();
  }
  if(body.action!=='invoice')return route.fallback();
  const parsed=z.object({sources:z.array(meterSourceReferenceSchema).length(1),arguments:z.object({p_contract_id:z.string(),p_room_id:z.string(),p_building_id:z.string(),p_billing_month:z.string(),p_idempotency_key:z.string(),p_applied_credit:z.number(),p_prepaid_amount:z.number()}).passthrough()}).safeParse(raw);
  if(!parsed.success)return deny();
  const args=parsed.data.arguments,source=parsed.data.sources[0],subject=subjects.find(s=>s.contractId===args.p_contract_id);
  if(!subject||args.p_room_id!==subject.roomId||args.p_building_id!==fixture.buildingId||args.p_billing_month!==fixture.readingDate.slice(0,7)
   ||args.p_applied_credit!==0||args.p_prepaid_amount!==0||source.contractId!==subject.contractId||source.meterId!==subject.meterId
   ||source.purpose!=='MONTHLY'||Number(source.previousReading)!==100||Number(source.currentReading)!==Number(subject.currentValue))return deny();
  let response;
  try{response=await route.fetch({timeout:90_000,maxRedirects:0,maxRetries:0});}
  catch{await route.abort('failed');throw new Error('Bulk TEST gateway transport failed; outcome unknown; no automatic replay');}
  const resultBody:unknown=await response.json();
  observations.push({action:'invoice',status:response.status(),result:response.ok()?'created':resultBody});
  if(response.status()===409&&z.object({error:z.literal('23505')}).safeParse(resultBody).success)duplicateRejections.push(subject.contractId);
  if(response.ok()){
   const result=z.object({invoice_id:z.string().uuid()}).parse(resultBody);
   receipts.set(subject.contractId,result.invoice_id);requests.push(raw);
  }
  return route.fulfill({response});
 });
 const dialog=()=>page.getByRole('dialog',{name:'Tạo nhanh hoá đơn — Mode Excel'});
 const load=async()=>{
  await page.goto('/invoices');
  await page.getByRole('button').filter({has:page.locator('svg.lucide-table')}).click();
  await dialog().getByRole('combobox').click();await page.getByRole('option',{name:fixture.marker,exact:true}).click();
  await dialog().locator('input[type="month"]').fill(fixture.readingDate.slice(0,7));
  await dialog().getByRole('button',{name:'Tải dữ liệu',exact:true}).click();
  for(const subject of subjects){
   const row=dialog().getByRole('row').filter({has:page.getByText(subject.marker,{exact:true})});
   await expect(row).toHaveCount(1,{timeout:60_000});await expect(row).not.toContainText('Nguồn chỉ số cần đối chiếu');
  }
  await expect(dialog().getByRole('button',{name:'Tạo 2 hoá đơn',exact:true})).toBeEnabled({timeout:60_000});
 };
 return {receipts,requests,blocked,observations,
  create:async(info:TestInfo)=>{await load();await info.attach('bulk-two-rooms-ready',{body:await dialog().screenshot(),contentType:'image/png'});
   await dialog().getByRole('button',{name:'Tạo 2 hoá đơn',exact:true}).click();await expect.poll(()=>receipts.size,{timeout:180_000}).toBe(2);
   await expect(dialog()).not.toBeVisible({timeout:60_000});},
  retry:async(info:TestInfo)=>{await load();await dialog().getByRole('button',{name:'Tạo 2 hoá đơn',exact:true}).click();
   await expect.poll(()=>duplicateRejections.slice().sort(),{timeout:180_000}).toEqual(subjects.map(s=>s.contractId).sort());
   await expect(dialog().getByRole('alert').filter({hasText:'Thông tin này đã được sử dụng.'})).toHaveCount(2);
   await info.attach('bulk-duplicate-rejected',{body:await dialog().screenshot(),contentType:'image/png'});
   await dialog().getByRole('button',{name:'Huỷ',exact:true}).click();},
 };
}
