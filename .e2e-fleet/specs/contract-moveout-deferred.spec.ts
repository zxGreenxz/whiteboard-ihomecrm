import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { login } from './auth';

test('TEST owner records actual return without entering settlement money',async({page},info)=>{
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
  expect(process.env.LIFECYCLE_FIXTURE_FILE).toBeTruthy();
  const fixture=JSON.parse(readFileSync(process.env.LIFECYCLE_FIXTURE_FILE!,'utf8')) as {target:string;contract:string};
  expect(fixture.target).toBe('hzulujxgonszuleqticb');
  const errors:string[]=[];
  const networkFailures: {path:string;status?:number;error?:string}[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('Failed to load resource'))errors.push(message.text());});
  page.on('requestfailed',request=>networkFailures.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
  page.on('response',response=>{if(response.status()>=400)networkFailures.push({path:new URL(response.url()).pathname,status:response.status()});});
  await page.route('https://tryymsxyyckgbrmmvozx.supabase.co/**',route=>route.abort('blockedbyclient'));
  await page.setViewportSize({width:1440,height:1000});
  try {
  await login(page,'chunha');
  await page.goto(`/contracts/${fixture.contract}`);
  await page.getByRole('button',{name:'Thanh lý',exact:true}).click();
  const dialog=page.getByRole('dialog');
  const submit=dialog.getByRole('button',{name:'Trả phòng, quyết toán sau'});
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Trả phòng trước hạn',{exact:true}).check();
  await expect(dialog.getByLabel(/Chưa đủ chỉ số, bổ sung sau/)).toBeChecked();
  await expect(submit).toBeEnabled();
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/rpc/confirm_contract_return_v1')&&response.request().method()==='POST');
  await submit.click();
  const response=await responsePromise;
  expect(response.status()).toBe(200);
  const request=response.request().postDataJSON() as Record<string,unknown>;
  expect(request.p_initial_kind).toBe('EARLY_RETURN');
  expect(request.p_settlement_mode).toBe('DEFERRED');
  expect(request.p_settlement==null).toBe(true);
  const returned=await response.json() as {state:string;initial_kind:string};
  expect(returned).toMatchObject({state:'PENDING',initial_kind:'EARLY_RETURN'});
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Đã trả phòng · Chờ quyết toán',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Đã trả phòng · Chờ quyết toán',exact:true})).toBeVisible();
  await expect(page.getByText('Chỉ số lúc trả phòng · Chờ bổ sung',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  } finally {
    await info.attach('workflow-errors.json',{body:JSON.stringify({errors,networkFailures}),contentType:'application/json'});
  }
});
