import { expect, type Page, type TestInfo } from '@playwright/test';
import { z } from 'zod';
import { readRpcAllowlist, uiPreferenceFakeBody } from './read-rpc-allowlist';
import { METER_TEST_URL, type MeterLiveFixture } from './meter-capture-live-fixture';

const startedSchema=z.object({capture:z.object({id:z.string().uuid(),clientId:z.string().uuid(),orgId:z.string().uuid(),meterId:z.string().uuid(),sha256:z.string()}),uploadPath:z.string()});
type Started=z.infer<typeof startedSchema>;
type Evidence={id:string;previousValue:string|null;evidenceFrames:Array<{timestampSeconds:number;imageUrl:string}>};

/** The browser uses real application functions, IndexedDB, JWT and Storage.
 * The only fulfilled fake is unrelated UI preference persistence; gateway and
 * media responses are forwarded unchanged after validating the fixture scope. */
export async function installMeterLiveBrowser(page:Page,fixture:MeterLiveFixture,created:{clientIds:string[];captureIds:string[]},appOrigin:string){
 const blocked:string[]=[],errors:string[]=[],writes:string[]=[];
 // useUnrecordedMeters reads this list when /meter-readings opens and refetches.
 // The legacy VOLATILE wrapper and its delegated function only SELECT (verified
 // on TEST and in 20260528000002 / 20250130000004); this does not allow a writer.
 const readers=new Set([...readRpcAllowlist('dashboard'),'get_meter_reading_stats','get_meters_without_readings_v2']);
 const state={sha:'',size:0,started:null as Started|null,confirmation:null as Record<string,unknown>|null};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  const block=()=>{blocked.push(`${method} ${url.host}${url.pathname}`);return route.abort('blockedbyclient');};
  if(url.origin===appOrigin||(['fonts.googleapis.com','fonts.gstatic.com'].includes(url.host)&&method==='GET'))return route.continue();
  if(url.origin!==METER_TEST_URL)return block();
  if(['GET','HEAD','OPTIONS'].includes(method)||url.pathname==='/auth/v1/token')return route.continue();
  const preference=uiPreferenceFakeBody(request,fixture.organizationId);
  if(preference)return route.fulfill({status:200,contentType:'application/json',body:preference});
  const rpcName=url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
  if(rpcName&&readers.has(rpcName))return route.continue();
  if(url.pathname==='/functions/v1/meter-capture-worker'&&method==='POST'){
   const body=z.object({action:z.string(),organizationId:z.string(),rpcAction:z.string().optional(),payload:z.record(z.unknown()).optional(),captureId:z.string().optional()}).parse(request.postDataJSON());
   if(body.organizationId!==fixture.organizationId)return block();
   if(body.action==='finalize'&&created.captureIds.includes(body.captureId??'')){writes.push('finalize');return route.continue();}
   if(body.action!=='rpc')return block();
   const payload=body.payload??{};
   if(body.rpcAction==='catalog'||(body.rpcAction==='listCaptures'&&payload.month===fixture.readingDate.slice(0,7)))return route.continue();
   if(body.rpcAction==='resolveQr'&&payload.qrText===fixture.qrText)return route.continue();
   if(body.rpcAction==='getCapture'){
    if(typeof payload.captureId==='string'&&created.captureIds.includes(payload.captureId))return route.continue();
    if(state.sha&&z.string().uuid().safeParse(payload.clientId).success){
     const clientId=String(payload.clientId);
     if(!created.clientIds.length)created.clientIds.push(clientId);
     if(created.clientIds.includes(clientId))return route.continue();
    }return block();
   }
   if(body.rpcAction==='evidence'&&typeof payload.captureId==='string'&&created.captureIds.includes(payload.captureId))return route.continue();
   if(body.rpcAction==='startCapture'){
    if(payload.meterId!==fixture.meterId||![null,undefined,fixture.contractId].includes(payload.contractId as string|null|undefined)
     ||payload.qrText!==fixture.qrText||payload.purpose!=='MONTHLY'||payload.readingDate!==fixture.readingDate
     ||payload.month!==fixture.readingDate.slice(0,7)||payload.sha256!==state.sha||payload.sizeBytes!==state.size
     ||payload.mimeType!=='video/mp4'||!created.clientIds.includes(String(payload.clientId)))return block();
    const response=await route.fetch({maxRedirects:0});
    if(response.ok()){
     const started=startedSchema.parse(await response.json());
     expect(started.capture).toMatchObject({orgId:fixture.organizationId,meterId:fixture.meterId,sha256:state.sha,clientId:payload.clientId});
     expect(started.uploadPath.startsWith(`${fixture.organizationId}/meter-captures/${started.capture.id}/`)).toBe(true);
     state.started=started;if(!created.captureIds.includes(started.capture.id))created.captureIds.push(started.capture.id);writes.push('startCapture');
    }return route.fulfill({response});
   }
   if(body.rpcAction==='confirmCapture'&&payload.captureId===state.started?.capture.id&&payload.value===fixture.currentValue
    &&Object.hasOwn(payload,'expectedPreviousValue')&&Number(payload.expectedPreviousValue)===Number(fixture.previousValue)
    &&Number.isInteger(payload.expectedVersion)&&!payload.supersedesCaptureId){
    state.confirmation=payload;writes.push('confirmCapture');return route.continue();
   }return block();
  }
  const storageRoot='/storage/v1/object/meter-capture-media/';
  if(method==='POST'&&state.started&&url.pathname===storageRoot+state.started.uploadPath&&await request.headerValue('x-upsert')!=='true'){
   writes.push('storageUpload');return route.continue();
  }
  const signRoot=`/storage/v1/object/sign/meter-capture-media/${fixture.organizationId}/meter-captures/`;
  if(method==='POST'&&url.pathname.startsWith(signRoot)&&created.captureIds.includes(url.pathname.slice(signRoot.length).split('/')[0]))return route.continue();
  if(method==='POST'&&url.pathname==='/storage/v1/object/sign/meter-capture-media'){
   const input=z.object({paths:z.array(z.string()).min(1).max(16)}).safeParse(request.postDataJSON());
   const prefix=`${fixture.organizationId}/meter-captures/`;
   if(input.success&&input.data.paths.every(path=>path.startsWith(prefix)&&created.captureIds.includes(path.slice(prefix.length).split('/')[0])))return route.continue();
  }
  return block();
 });
 const dialog=()=>page.getByRole('dialog',{name:'Ghi điện bằng QR, ảnh / clip'});
 const article=(purpose:'MONTHLY'|'MOVE_OUT')=>dialog().locator('article').filter({hasText:fixture.meterCode}).filter({hasText:purpose==='MONTHLY'?'Kỳ tháng':'Thanh lý'});
 const review=async(purpose:'MONTHLY'|'MOVE_OUT',capture:Evidence)=>{
  await dialog().getByRole('tab',{name:/Đối chiếu/}).click();
  await dialog().getByRole('button',{name:'Tải lại kết quả'}).click();
  const row=article(purpose);await expect(row).toHaveCount(1);await row.getByRole('button',{name:'Xem / xác nhận',exact:true}).click();
  const image=row.getByAltText('Ảnh đối chiếu đồng hồ nội bộ');await expect(image).toBeVisible();await image.scrollIntoViewIfNeeded();
  await expect.poll(()=>image.evaluate(node=>(node as HTMLImageElement).complete&&(node as HTMLImageElement).naturalWidth>0)).toBe(true);
  const frames=row.getByRole('button',{name:/^Ảnh tại /});expect(await frames.count()).toBeGreaterThanOrEqual(2);
  const different=capture.evidenceFrames.findIndex(frame=>frame.timestampSeconds!==capture.evidenceFrames[0].timestampSeconds);
  const index=different>=0&&different<6?different:0;await frames.nth(index).click();
  await row.getByRole('button',{name:/^Xem clip tại /}).click();
  const video=row.getByLabel('Clip đối chiếu đồng hồ');await expect(video).toBeVisible();
  await expect.poll(()=>video.evaluate(node=>(node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(()=>video.evaluate(node=>(node as HTMLVideoElement).currentTime)).toBeCloseTo(capture.evidenceFrames[index].timestampSeconds,1);
  await row.getByRole('button',{name:'Xem ảnh chốt',exact:true}).click();return row;
 };
 return {blocked,errors,writes,
  upload:async(clip:Buffer,sha:string)=>{
   state.sha=sha;state.size=clip.length;
   await page.getByRole('button',{name:'Chụp đồng hồ / QR'}).click();
   await dialog().getByLabel('Kỳ chốt',{exact:true}).fill(fixture.readingDate.slice(0,7));
   await dialog().getByLabel('Tòa',{exact:true}).selectOption(fixture.buildingId);
   await dialog().getByLabel('Ngày chốt',{exact:true}).fill(fixture.readingDate);
   await dialog().getByLabel('Mục đích',{exact:true}).selectOption('MONTHLY');
   const chooser=page.waitForEvent('filechooser');await dialog().getByRole('button',{name:'Tải ảnh/clip',exact:true}).click();
   await (await chooser).setFiles({name:'meter-monthly-synthetic.mp4',mimeType:'video/mp4',buffer:clip});
   const meter=dialog().getByLabel('Đồng hồ xác định từ QR',{exact:true});await expect(meter).toHaveValue(fixture.meterId,{timeout:45_000});await expect(meter).toBeDisabled();
   await dialog().getByRole('checkbox',{name:'Đã kiểm tra đúng tòa/phòng, serial và một đồng hồ xuyên suốt ảnh/clip.'}).check();
   await dialog().getByRole('button',{name:'Giữ ảnh/clip và gửi đọc số'}).click();
   await expect(dialog().getByText('Đã giữ ảnh/clip trên máy. Bạn có thể chụp đồng hồ tiếp theo.')).toBeVisible();
   await expect.poll(()=>state.started?.capture.id,{timeout:90_000}).toBeTruthy();
   if(!state.started)throw new Error('UI did not persist a real upload reservation');return state.started;
  },
  confirm:async(capture:Evidence,info:TestInfo)=>{
   const row=await review('MONTHLY',capture);
   await expect(row).toContainText('Chỉ số trước đã lưu: 100 kWh');
   await row.getByLabel('Chỉ số xác nhận (kWh)',{exact:true}).fill(fixture.currentValue);
   await row.getByLabel(/Lý do xác nhận thủ công|Ghi chú đối chiếu/).fill('E2E synthetic: verified exact rendered digits and register');
   await expect(row.getByRole('button',{name:'Xác nhận chốt chỉ số',exact:true})).toBeDisabled();
   await row.getByRole('checkbox',{name:/Tôi đã đối chiếu ảnh\/clip/}).check();
   await info.attach('monthly-qr-review-ui',{body:await row.screenshot(),contentType:'image/png'});
   await row.getByRole('button',{name:'Xác nhận chốt chỉ số',exact:true}).click();
   await expect(row).toContainText(`Chỉ số đã chốt: ${fixture.currentValue} kWh`,{timeout:60_000});
   if(!state.confirmation)throw new Error('Browser did not submit confirmation through the real gateway');return state.confirmation;
  },
  showZeroMoveOut:async(capture:Evidence,info:TestInfo)=>{
   const row=await review('MOVE_OUT',capture);await expect(row).toContainText('Chênh lệch: 0 kWh');
   await expect(row).toContainText(`Chỉ số đã chốt: ${fixture.currentValue} kWh`);
   await info.attach('zero-kwh-move-out-ui',{body:await row.screenshot(),contentType:'image/png'});
  },
 };
}
