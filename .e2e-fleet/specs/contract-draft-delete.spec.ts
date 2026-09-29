import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {credentials} from './auth';

test('TEST draft deletion follows role rights, refreshes count and cannot reopen it',async({page})=>{
  test.setTimeout(90_000);
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
  const fixture=JSON.parse(readFileSync(process.env.LIFECYCLE_FIXTURE_FILE!,'utf8')) as {target:string;draft:string;name:string;role:'chunha'|'quanly';canDelete:boolean};
  expect(fixture.target).toBe('hzulujxgonszuleqticb');
  const errors:string[]=[];let deletes=0;let prodRequests=0;
  await page.context().route('https://tryymsxyyckgbrmmvozx.supabase.co/**',route=>{prodRequests++;return route.abort();});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('Failed to load resource')) errors.push(message.text());});
  page.on('request',request=>{if(request.url().endsWith('/rpc/delete_contract_draft_v1'))deletes++;});
  const account=credentials(fixture.role);
  const login=await page.request.post('https://hzulujxgonszuleqticb.supabase.co/auth/v1/token?grant_type=password',{
    headers:{apikey:process.env.TEST_PUBLIC_KEY!},data:{email:account.email,password:account.pass},
  });
  expect(login.ok()).toBe(true);
  const session=await login.json() as {expires_in:number};
  await page.addInitScript(value=>{
    localStorage.setItem('sb-hzulujxgonszuleqticb-auth-token',JSON.stringify({...value,expires_at:Math.floor(Date.now()/1000)+value.expires_in}));
    localStorage.setItem('ihomecrm.selectedOrganizationId','dddd0000-0000-4000-8000-000000000001');
  },session);
  await page.goto('/contracts');
  const tab=page.getByRole('tablist',{name:'Các mục hợp đồng'}).getByRole('tab',{name:/Hợp đồng nháp/});
  await tab.click();
  const row=page.getByRole('region',{name:'Hợp đồng nháp',exact:true}).locator('div.p-4.flex').filter({hasText:fixture.name});
  await expect(row).toHaveCount(1);
  if(!fixture.canDelete){await expect(row.getByRole('button',{name:'Xóa nháp',exact:true})).toHaveCount(0);expect(deletes).toBe(0);expect(prodRequests).toBe(0);expect(errors).toEqual([]);return;}
  const before=Number((await tab.innerText()).match(/\d+/)?.[0]);expect(before).toBeGreaterThan(0);
  await row.getByRole('button',{name:'Xóa nháp',exact:true}).click();
  const dialog=page.getByRole('alertdialog');await expect(dialog).toContainText(fixture.name);
  await dialog.getByRole('button',{name:'Hủy',exact:true}).click();expect(deletes).toBe(0);await expect(row).toHaveCount(1);
  await row.getByRole('button',{name:'Xóa nháp',exact:true}).click();
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/rpc/delete_contract_draft_v1'));
  await dialog.getByRole('button',{name:'Xóa nháp',exact:true}).click();
  const response=await responsePromise;expect(response.status()).toBe(200);expect(await response.json()).toEqual({draft_id:fixture.draft,deleted:true});
  await expect(row).toHaveCount(0);await expect(dialog).toHaveCount(0);
  await expect.poll(async()=>Number((await tab.innerText()).match(/\d+/)?.[0] ?? 0)).toBe(before-1);
  await page.reload();await tab.click();await expect(row).toHaveCount(0);
  expect(deletes).toBe(1);expect(prodRequests).toBe(0);expect(errors).toEqual([]);
});
