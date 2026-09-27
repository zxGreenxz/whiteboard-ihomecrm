import {test,expect} from '@playwright/test';
import {login} from './auth';

// The deprecated reject hook has no mounted UI consumer. This is a contracts
// integration smoke, never evidence of clicking a nonexistent reject flow.
test.beforeAll(() => {
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:4188');
  expect(process.env.FLEET_HEADED).toBeUndefined();
});
for(const role of ['chunha','quanly','ketoan'] as const) {
  test(`TEST contracts read smoke: ${role}`,async({page})=>{
    const hosts=new Set<string>(),errors:string[]=[];
    page.on('request',r=>{const host=new URL(r.url()).hostname;if(host.endsWith('.supabase.co'))hosts.add(host);});
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await login(page,role);
    await page.goto('/contracts');
    await expect(page.getByRole('heading',{name:'Hợp đồng thuê',exact:true})).toBeVisible();
    await expect.poll(()=>[...hosts].sort()).toEqual(['hzulujxgonszuleqticb.supabase.co']);
    expect(errors).toEqual([]);
  });
}
