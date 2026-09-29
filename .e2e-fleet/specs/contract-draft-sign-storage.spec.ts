import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import PizZip from 'pizzip';
import {test,expect,type Download,type Page} from '@playwright/test';
import {credentials} from './auth';

async function openContracts(page:Page){
 const account=credentials('chunha');const authPage=await page.context().newPage();
 type Session={access_token:string;refresh_token:string;expires_in:number;user:{email:string}};
 let resolveSession!:(session:Session)=>void;let rejectSession!:(error:unknown)=>void;
 const authenticated=new Promise<Session>((resolve,reject)=>{resolveSession=resolve;rejectSession=reject;});
 await authPage.route('https://hzulujxgonszuleqticb.supabase.co/auth/v1/token*',async route=>{
  try{const request=route.request();expect(request.method()).toBe('POST');expect(request.postDataJSON().email).toBe(account.email);
   const response=await route.fetch({maxRedirects:0});expect(response.ok()).toBe(true);const session:Session=await response.json();resolveSession(session);}
  catch(error){rejectSession(error);}finally{await route.abort('aborted');}
 });
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await authPage.goto('/login');await authPage.getByRole('textbox',{name:'Tài Khoản'}).fill(account.email);
  await authPage.getByRole('textbox',{name:'Mật khẩu'}).fill(account.pass);await authPage.getByRole('button',{name:'Đăng nhập',exact:true}).click();
  const session=await Promise.race([authenticated,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST auth timed out')),45_000);})]);
  await page.addInitScript(value=>localStorage.setItem('sb-hzulujxgonszuleqticb-auth-token',JSON.stringify({...value,expires_at:Math.floor(Date.now()/1000)+value.expires_in})),session);
 }finally{clearTimeout(timer);await authPage.close();}
 await page.addInitScript(()=>localStorage.setItem('ihomecrm.selectedOrganizationId','dddd0000-0000-4000-8000-000000000001'));
 await page.goto('/contracts');
}

test('TEST owner exports saved draft bytes then signs once and reloads the exact official DOCX',async({page},info)=>{
 test.setTimeout(150_000);
 expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
 expect(process.env.LIFECYCLE_FIXTURE_FILE).toBeTruthy();
 const fixture=JSON.parse(readFileSync(process.env.LIFECYCLE_FIXTURE_FILE!,'utf8')) as {target:string;draft:string;customerName:string;artifactDirectory:string};
 expect(fixture.target).toBe('hzulujxgonszuleqticb');
 const errors:string[]=[];const failedNetwork:{path:string;status?:number;error?:string}[]=[];
 const checks:string[]=[];let registerCalls=0;let prodRequests=0;
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('Failed to load resource'))errors.push(message.text());});
 page.on('requestfailed',request=>failedNetwork.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
 page.on('response',response=>{if(response.status()>=400)failedNetwork.push({path:new URL(response.url()).pathname,status:response.status()});});
 page.on('request',request=>{if(request.url().endsWith('/rpc/register_contract_draft_document'))registerCalls++;});
  await page.route('https://tryymsxyyckgbrmmvozx.supabase.co/**',route=>{prodRequests++;return route.abort('blockedbyclient');});
  // Keep this browser on its loaded code while teammates edit the dev worktree.
  // Supabase realtime and every real TEST HTTP/storage request remain connected.
  await page.routeWebSocket(url=>url.hostname==='127.0.0.1'&&url.port==='5197',socket=>socket.onMessage(()=>undefined));
 await page.setViewportSize({width:1440,height:1000});
 const documentBytes=async(download:Download,label:string)=>{
  const path=`${fixture.artifactDirectory}/${label}.docx`;await download.saveAs(path);const bytes=readFileSync(path);const xml=new PizZip(bytes).file('word/document.xml')!.asText();return {bytes,xml,hash:createHash('sha256').update(bytes).digest('hex')};
 };
 try{
  await openContracts(page);
  await page.getByRole('tablist',{name:'Các mục hợp đồng'}).getByRole('tab',{name:/Hợp đồng nháp/}).click();
  const workspace=page.getByRole('region',{name:'Hợp đồng nháp',exact:true});await expect(workspace).toBeVisible();
  const row=workspace.locator('div.p-4.flex').filter({hasText:fixture.customerName});await expect(row).toHaveCount(1);
  await row.getByRole('button',{name:'Sửa nháp',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:/Tạo hợp đồng mới/});await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Mẫu hợp đồng',{exact:true}).locator('..').getByRole('combobox')).toContainText('Owned actual signing DOCX');
  // The official form now previews an invoice by default. Explicitly remove
  // its RENT row so this owned zero-money fixture still tests no invoice writes.
  await expect(dialog.locator('button[title="Xoá dòng"]:visible')).toHaveCount(1);
  await dialog.locator('button[title="Xoá dòng"]:visible').click();
  await expect(dialog.locator('p:visible').filter({hasText:'Chưa có dữ liệu — hãy nhập tiền thuê'})).toBeVisible();
  const registeredPromise=page.waitForResponse(response=>response.url().endsWith('/rpc/register_contract_draft_document'));
  const draftDownloadPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:'Lưu và xuất nháp .docx',exact:true}).click();
  const[registered,draftDownload]=await Promise.all([registeredPromise,draftDownloadPromise]);expect(registered.status()).toBe(200);const document=await registered.json() as {draft_id:string;revision:number;document_sha256:string};expect(document.draft_id).toBe(fixture.draft);
  const draftBytes=await documentBytes(draftDownload,'actual-draft');expect(draftBytes.hash).toBe(document.document_sha256);expect(draftBytes.xml).toContain('BẢN NHÁP');expect(draftBytes.xml).toContain(fixture.customerName);checks.push('real template authenticated download, DOCX render, private storage upload/register and browser download share exact SHA');
  const repeatedPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:'Lưu và xuất nháp .docx',exact:true}).click();const repeated=await documentBytes(await repeatedPromise,'repeated-draft');expect(repeated.hash).toBe(draftBytes.hash);expect(registerCalls).toBe(1);checks.push('same saved revision re-export downloads immutable exact artifact; no duplicate registration');
  await dialog.getByRole('button',{name:'Lưu',exact:true}).click();
  const choice=page.getByRole('dialog',{name:'Bạn muốn lưu hợp đồng thế nào?'});await expect(choice).toBeVisible();
  await choice.getByRole('button',{name:'Xác nhận ký',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Xác nhận đã ký và nhận phòng ngay'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Phòng chưa có đồng hồ đang hoạt động.',{exact:true})).toBeVisible();
  await dialog.getByLabel(/Khách đã ký đúng tài liệu nháp/).check();await dialog.getByLabel('Phòng đã sẵn sàng và được bàn giao cho khách mới.',{exact:true}).check();
  await expect(dialog.getByText(/Dùng khoản cọc đã nhận 0 đ cùng lựa chọn/)).toBeVisible();
  const signButton=dialog.getByRole('button',{name:'Xác nhận đã ký và nhận phòng',exact:true});await expect(signButton).toBeEnabled();
  const signPromise=page.waitForResponse(response=>response.url().endsWith('/rpc/sign_and_checkin_contract_draft_v1'));await signButton.click();const signResponse=await signPromise;expect(signResponse.status()).toBe(200);
  const signed=await signResponse.json() as {id:string;contract_id:string;contract_number:string;official_document_sha256:string|null};expect(signed.contract_number).toBeTruthy();
  const input=signResponse.request().postDataJSON() as Record<string,unknown>;expect(input.p_creation_options).toMatchObject({deposit_receipts:[],existing_deposit_voucher_ids:[],invoice_template_id:null});expect(input.p_creation_options).not.toHaveProperty('first_invoice');expect(input.p_boundary).toMatchObject({state:'VERIFIED',readings:[]});
  const retry=await page.request.post(signResponse.url(),{headers:await signResponse.request().allHeaders(),data:input});expect(retry.status()).toBe(200);expect(await retry.json()).toMatchObject({id:signed.id,contract_id:signed.contract_id,contract_number:signed.contract_number});checks.push('actual server sign no hold/deposit0/no first invoice; same request retry returns same official contract');
  await expect(dialog).toHaveCount(0); // onSigned closes the shared form and confirmation.
  await page.reload();await page.getByRole('tablist',{name:'Các mục hợp đồng'}).getByRole('tab',{name:/Hợp đồng nháp/}).click();
  await expect(row.getByText(`Đã ký từ nháp · ${fixture.customerName}`,{exact:true})).toBeVisible();await expect(row.getByRole('button',{name:'Sửa nháp',exact:true})).toHaveCount(0);
  await row.getByRole('button',{name:'Xem hợp đồng đã ký',exact:true}).click();dialog=page.getByRole('dialog',{name:'Xác nhận đã ký và nhận phòng ngay'});await expect(dialog.getByText(`Đã ghi nhận ký và nhận phòng · ${signed.contract_number}`,{exact:true})).toBeVisible();
  const officialDownloadPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:/^(Tạo lại bản tải|Tải hợp đồng đã ký)$/}).click();const official=await documentBytes(await officialDownloadPromise,'actual-official');expect(official.xml).toContain(signed.contract_number);expect(official.xml).toContain(fixture.customerName);expect(official.xml).not.toContain('BẢN NHÁP');checks.push('official DOCX rendered from pinned original template and exact saved terms, assigned same contract number');
  await dialog.getByRole('button',{name:'Đóng',exact:true}).click();await page.reload();await page.getByRole('tablist',{name:'Các mục hợp đồng'}).getByRole('tab',{name:/Hợp đồng nháp/}).click();await row.getByRole('button',{name:'Xem hợp đồng đã ký',exact:true}).click();dialog=page.getByRole('dialog',{name:'Xác nhận đã ký và nhận phòng ngay'});
  const againPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:'Tải hợp đồng đã ký',exact:true}).click();const again=await documentBytes(await againPromise,'reloaded-official');expect(again.hash).toBe(official.hash);checks.push('reload shows SIGNED source and downloads exact stored official bytes/number');
  expect(prodRequests).toBe(0);expect(errors).toEqual([]);
  writeFileSync(`${fixture.artifactDirectory}/draft-sign-ui.json`,JSON.stringify({status:'PASS',checks,draftSha256:draftBytes.hash,officialSha256:official.hash,contractId:signed.contract_id,contractNumber:signed.contract_number,registerCalls,prodRequests,errors,failedNetwork},null,2));
 }finally{const dialogs=await page.getByRole('dialog').allTextContents().catch(()=>[]);writeFileSync(`${fixture.artifactDirectory}/draft-sign-debug.json`,JSON.stringify({checks,errors,failedNetwork,prodRequests,dialogs},null,2));await info.attach('draft-sign-errors.json',{body:JSON.stringify({checks,errors,failedNetwork,prodRequests}),contentType:'application/json'});}
});
