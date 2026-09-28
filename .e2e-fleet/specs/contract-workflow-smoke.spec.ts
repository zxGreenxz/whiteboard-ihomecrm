import { test, expect } from '@playwright/test';
import { login } from './auth';

// This new-UI smoke must use the isolated TEST backend, never the default PROD URL.
test.beforeEach(async ({ page }) => {
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
  await page.route('https://tryymsxyyckgbrmmvozx.supabase.co/**', route => route.abort('blockedbyclient'));
});

for (const [role, mobile] of [['chunha', false], ['quanly', true], ['ketoan', false]] as const) {
  test(`${role}: new contract workflow renders ${mobile ? 'mobile' : 'desktop'} without app errors`, async ({ page }) => {
    const errors: string[]=[];
    let observedTestBackend=false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if(message.type()==='error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
    });
    page.on('request', request => { if(request.url().startsWith('https://hzulujxgonszuleqticb.supabase.co/')) observedTestBackend=true; });
    await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:1000});
    await login(page,role);
    await page.goto('/contracts');
    const workspace=page.getByRole('region',{name:'Hợp đồng nháp',exact:true});
    await expect(workspace).toBeVisible();
    await workspace.getByRole('button',{name:/Hợp đồng nháp/}).click();
    await expect(workspace.getByText('Đang tải bản nháp…')).toHaveCount(0);
    await expect(page.getByText('Không tải được hồ sơ chờ quyết toán.')).toHaveCount(0);
    if(role==='chunha'){
      await workspace.getByRole('button',{name:'Soạn nháp',exact:true}).click();
      const dialog=page.getByRole('dialog');
      await expect(dialog.getByRole('heading',{name:'Soạn hợp đồng nháp'})).toBeVisible();
      await expect(dialog.getByText(/Lưu hoặc xuất nháp chưa giữ phòng/)).toBeVisible();
      await expect(dialog.getByRole('button',{name:'Lưu nháp',exact:true})).toBeEnabled();
      await dialog.getByRole('button',{name:'Đóng',exact:true}).click();
      await expect(dialog).toHaveCount(0);
    }
    expect(observedTestBackend).toBe(true);
    expect(errors).toEqual([]);
  });
}
