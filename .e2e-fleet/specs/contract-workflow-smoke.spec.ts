import { test, expect } from '@playwright/test';
import { credentials, type UserKey } from './auth';

// Authenticate without mounting the home page's unrelated legacy scheduler.
async function openContracts(page: import('@playwright/test').Page, role: UserKey) {
  const account = credentials(role);
  const authPage = await page.context().newPage();
  type Session = { access_token: string; refresh_token: string; expires_in: number; user: { email: string } };
  let resolveSession!: (session: Session) => void;
  let rejectSession!: (error: unknown) => void;
  const authenticated = new Promise<Session>((resolve, reject) => { resolveSession = resolve; rejectSession = reject; });
  await authPage.route('https://hzulujxgonszuleqticb.supabase.co/auth/v1/token*', async route => {
    try {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON().email).toBe(account.email);
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.ok()).toBe(true);
      resolveSession(await response.json());
    } catch (error) { rejectSession(error); }
    finally { await route.abort('aborted'); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await authPage.goto('/login');
    await authPage.getByRole('textbox', { name: 'Tài Khoản' }).fill(account.email);
    await authPage.getByRole('textbox', { name: 'Mật khẩu' }).fill(account.pass);
    await authPage.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    const session = await Promise.race([authenticated, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TEST auth timed out')), 45_000);
    })]);
    await page.addInitScript(value => localStorage.setItem('sb-hzulujxgonszuleqticb-auth-token', JSON.stringify({
      ...value, expires_at: Math.floor(Date.now() / 1000) + value.expires_in,
    })), session);
  } finally { clearTimeout(timer); await authPage.close(); }
  await page.addInitScript(() => localStorage.setItem('ihomecrm.selectedOrganizationId', 'dddd0000-0000-4000-8000-000000000001'));
  await page.goto('/contracts');
}

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
    await openContracts(page,role);
    if(!mobile) await page.getByRole('tablist',{name:'Các mục hợp đồng'}).getByRole('tab',{name:/Hợp đồng nháp/}).click();
    const workspace=page.getByRole('region',{name:'Hợp đồng nháp',exact:true});
    await expect(workspace).toBeVisible();
    if(mobile) await workspace.getByRole('button',{name:/Hợp đồng nháp/}).click();
    await expect(workspace.getByText('Đang tải bản nháp…')).toHaveCount(0);
    await expect(page.getByText('Không tải được hồ sơ chờ quyết toán.')).toHaveCount(0);
    if(role==='chunha'){
      await workspace.getByRole('button',{name:'Soạn nháp',exact:true}).click();
      const dialog=page.getByRole('dialog');
      await expect(dialog.getByRole('heading',{name:'Tạo hợp đồng mới'})).toBeVisible();
      await expect(dialog.getByRole('heading',{name:'Xem trước hoá đơn cọc + tháng đầu'})).toBeVisible();
      await expect(dialog.getByRole('button',{name:'Lưu nháp',exact:true})).toBeEnabled();
      await dialog.getByRole('button',{name:'Hủy',exact:true}).click();
      await expect(dialog).toHaveCount(0);
    }
    expect(observedTestBackend).toBe(true);
    expect(errors).toEqual([]);
  });
}
