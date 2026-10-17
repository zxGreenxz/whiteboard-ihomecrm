import {test,expect,type Page} from '@playwright/test';
import {credentials,type UserKey} from './auth';
const ORG='dddd0000-0000-4000-8000-000000000001';
const HOST='tryymsxyyckgbrmmvozx.supabase.co';
const READ_RPC=new Set([
 'is_company_owner_self_v1','read_income_expense_details_v1',
 'ie_form_buildings','ie_form_rooms','get_finance_v2_client_flags_v1','list_my_cashbook_access_v2',
 'get_dashboard_summary','revenue_by_month','get_contract_stats','get_my_context','get_my_assignments','is_admin','is_super_admin',
 'get_my_permissions','get_my_permissions_v2','list_my_copilot_organizations_v1','business_performance_organizations_v1','my_org_ids',
 'get_notification_org_config_v1','get_my_notification_preferences_v1','list_cashbook_visibility_v2','list_due_contract_move_out_notices_v1',
 'list_contract_exit_cases_v1','list_contract_meter_followups_v1','get_contract_move_out_notice_v1','read_contract_meter_boundary_set_v1',
 'read_contract_transfer_links_v1','list_contract_drafts','list_room_reservations_v1','get_income_expense_layer_stats','get_invoice_statistics_v2',
 'get_receiving_cashbooks_v1','get_my_cashbook_access_v2','list_cashbooks_for_expense_v2','get_income_expense_stats','get_pending_approvals_count',
 'list_active_memberships_v1','list_organization_members_v2','read_authorization_catalog_v1','get_finance_v2_routes_v1'
]);
const diagnostics = new WeakMap<Page,{runtime:string[];console:string[]}>();
test.beforeEach(async({page})=>{
 const captured={runtime:[] as string[],console:[] as string[]};diagnostics.set(page,captured);
 page.on('pageerror',error=>captured.runtime.push(error.message));
 page.on('console',message=>{if(message.type()==='error')captured.console.push(message.text().replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]'));});
});
test.afterEach(async({page},info)=>{
 const captured=diagnostics.get(page)!;
 await info.attach('console-errors',{body:JSON.stringify(captured),contentType:'application/json'});
 expect(captured.runtime,'Không có lỗi JavaScript không được xử lý').toEqual([]);
 expect(captured.console.filter(line=>/Uncaught|ReferenceError|is not a function/i.test(line)),'Không có lỗi hiển thị trong console').toEqual([]);
});
async function setup(page:Page,who:UserKey){
 const user=credentials(who);const blocked:string[]=[];
 await page.addInitScript(org=>localStorage.setItem('ihomecrm.selectedOrganizationId',org),ORG);
 await page.addInitScript(()=>{
  const events:unknown[]=[];(window as unknown as {feedbackFocusEvents:unknown[]}).feedbackFocusEvents=events;
  document.addEventListener('focusin',event=>{const node=event.target as HTMLElement;events.push({at:performance.now(),tag:node.tagName,name:node.getAttribute('name'),text:node.textContent?.slice(0,40)});if(events.length>100)events.shift();});
  new MutationObserver(records=>{for(const record of records)if(record.target instanceof HTMLFieldSetElement)events.push({at:performance.now(),fieldsetDisabled:record.target.disabled});}).observe(document,{subtree:true,attributes:true,attributeFilter:['disabled']});
 });
 await page.context().route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(['GET','HEAD','OPTIONS'].includes(method))return route.continue();
  if(url.hostname===HOST){
   if(url.pathname==='/auth/v1/token'){
    const grant=url.searchParams.get('grant_type');
    if(grant==='refresh_token'||grant==='password'&&request.postDataJSON().email===user.email)return route.continue();
   }
   const rpc=url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
   if(rpc&&READ_RPC.has(rpc)){
    const body=request.postDataJSON();
    if(![body?.p_organization_id,body?.p_org].some(id=>id&&id!==ORG))return route.continue();
   }
  }
  blocked.push(`${method} ${url.pathname}`); console.log('Blocked by fixture:',method,url.pathname);
  return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'42501',message:'E2E read-only guard'})});
 });
 await page.goto('/login');
 if(process.env.FLEET_EXPECT_SHA)await expect(page.locator('meta[name="build-sha"]')).toHaveAttribute('content',process.env.FLEET_EXPECT_SHA);
 await page.getByRole('textbox',{name:'Tài Khoản'}).fill(user.email);
 await page.getByRole('textbox',{name:'Mật khẩu'}).fill(user.pass);
 await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
 await page.waitForURL(url=>!url.pathname.startsWith('/login'));
 return {blocked};
}
for(const mobile of [false,true]){
 test(`DEMO form thu chi thiếu dữ liệu: ${mobile?'điện thoại':'máy tính'}`,async({page},info)=>{
  await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});
  const audit=await setup(page,'chunha');
  await page.goto('/income-expense');
  await page.getByRole('button',{name:mobile?'Phiếu':/Thêm phiếu/,exact:mobile}).first().click();
  if(mobile)await page.getByRole('button',{name:'Phiếu thu Ghi nhận một khoản thu',exact:true}).click();
  const menu=page.getByRole('menuitem',{name:/Thêm phiếu lẻ/});
  if(await menu.isVisible())await menu.click();
  const form=page.getByRole('dialog').filter({has:page.getByText(/THÊM PHIẾU THU\/CHI|Thêm phiếu thu\/chi/i)}).last();
  await expect(form).toBeVisible();
  await expect(form.getByRole('button',{name:/^Lưu$/})).toBeEnabled();
  await form.getByRole('button',{name:/^Lưu$/}).click();
  const building=form.getByRole('combobox',{name:/Tòa nhà/});
  await expect(building).toHaveAttribute('aria-invalid','true');
  await expect(building).toBeFocused();
  await expect(form.getByText(/^Chọn (tòa|toà) nhà cho phiếu\.$/)).toBeVisible();
  await expect(form.getByText('Chọn sổ quỹ ghi nhận phiếu.',{exact:true})).toBeVisible();
  await expect(form).not.toContainText('chọn căn hộ');
  await form.screenshot({path:info.outputPath('voucher-required-fields.png')});
  await info.attach('blocked-writers',{body:JSON.stringify(audit.blocked),contentType:'application/json'});
  expect(audit.blocked.filter(path=>/create_income|create_voucher|record_|submit_/.test(path))).toEqual([]);
 });
}

for(const variant of ['local','server'] as const){
for(const mobile of [false,true]){
 test(`DEMO ${variant==='local'?'lỗi biên kỳ đầu':'biên bằng nhau hợp lệ và lỗi máy chủ 22023'} hợp đồng: ${mobile?'điện thoại':'máy tính'}`,async({page},info)=>{
  await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});
  const audit=await setup(page,'chunha');
  const roomId='e2e00000-0000-4000-8000-000000000111';
  await page.route(`https://${HOST}/rest/v1/rooms?*`,async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   const params=new URL(route.request().url()).searchParams;
   if(Number(params.get('offset')??0)>0)return route.fulfill({status:200,contentType:'application/json',body:'[]'});
   const buildingId=params.get('building_id')?.replace(/^eq\./,'')??ORG;
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{id:roomId,building_id:buildingId,name:'Phòng kiểm thử thông báo',status:'AVAILABLE',price:3000000,rent_price:3000000,organization_id:ORG}])});
  });
  await page.route(`https://${HOST}/rest/v1/customers?*`,async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   if(Number(new URL(route.request().url()).searchParams.get('offset')??0)>0)return route.fulfill({status:200,contentType:'application/json',body:'[]'});
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{id:'e2e00000-0000-4000-8000-000000000112',full_name:'Khách kiểm thử thông báo',phone:'0900000112',id_number:'000000000112',organization_id:ORG}])});
  });
  let mockedWrites=0;
  if(variant==='server')await page.route(`https://${HOST}/rest/v1/rpc/create_contract_v2`,async route=>{
   mockedWrites++;await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'22023',message:'Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng',details:null,hint:null})});
  });
  await page.goto('/contracts');
  if(mobile)await page.getByRole('button',{name:'Tạo',exact:true}).click();
  else await page.locator('button.bg-green-500').first().click();
  const form=page.getByRole('dialog',{name:/Tạo hợp đồng mới/});
  await expect(form).toBeVisible();
  await form.getByRole('combobox').first().click();
  await page.getByRole('option').first().click();
  await form.getByRole('combobox',{name:/Phòng/}).click();
  await page.getByRole('option',{name:/Phòng kiểm thử thông báo/}).click();
  await form.getByRole('button',{name:/Thêm khách hàng/}).click();
  const customers=page.getByRole('dialog',{name:'Chọn khách hàng'});
  await customers.getByRole('checkbox').first().click();
  await customers.getByRole('button',{name:/Xác nhận/}).click();
  const setDate=async(name:string,value:string)=>{await form.locator(`input[name="${name}"]`).fill(value);await form.locator(`input[name="${name}"]`).press('Tab');};
  await setDate('signed_date','10/10/2026');await setDate('start_date','10/10/2026');await setDate('end_date','10/11/2026');
  await setDate('start_billing_date',variant==='local'?'09/10/2026':'10/10/2026');
  await expect(form.locator('input[name="end_billing_date"]')).not.toHaveValue('');
  await setDate('end_billing_date',variant==='local'?'11/11/2026':'10/11/2026');
  await expect(form.locator('input[name="start_billing_date"]')).toHaveValue(variant==='local'?'09/10/2026':'10/10/2026');
  await expect(form.locator('input[name="end_billing_date"]')).toHaveValue(variant==='local'?'11/11/2026':'10/11/2026');
  await form.getByRole('button',{name:'Sửa tiền cọc',exact:true}).click();
  await form.locator('input[name="total_deposit"]').fill('0');
  await form.locator('input[name="total_deposit"]').press('Tab');
  await expect(form.getByRole('button',{name:'Lưu',exact:true})).toBeEnabled();
  await form.getByRole('button',{name:'Lưu',exact:true}).click();
  await page.getByRole('dialog',{name:'Bạn muốn lưu hợp đồng thế nào?'}).getByRole('button',{name:'Xác nhận ký',exact:true}).click();
  if(variant==='server') {
    try { await expect.poll(()=>mockedWrites).toBe(1); }
    catch(error) { await info.attach('contract-form-feedback',{body:await form.innerText(),contentType:'text/plain'}); throw error; }
  }
  const first=form.locator('input[name="start_billing_date"]'),last=form.locator('input[name="end_billing_date"]');
  await expect(first).toHaveAttribute('aria-invalid','true');await expect(last).toHaveAttribute('aria-invalid','true');
  try { await expect(first).toBeFocused(); }
  catch(error) {
    await info.attach('focus-state',{body:JSON.stringify(await first.evaluate(node=>({disabled:node.matches(':disabled'),fieldsetDisabled:node.closest('fieldset')?.disabled,activeName:document.activeElement?.getAttribute('name'),activeTag:document.activeElement?.tagName,activeText:document.activeElement?.textContent?.slice(0,80),hiddenAncestor:!!node.closest('[inert],[aria-hidden="true"]'),events:(window as unknown as {feedbackFocusEvents:unknown[]}).feedbackFocusEvents}))),contentType:'application/json'});
    throw error;
  }
  await expect(form.getByText('Ngày bắt đầu tính tiền không được trước 10/10/2026 (ngày bắt đầu hợp đồng).',{exact:true})).toBeVisible();
  await expect(form.getByText('Ngày kết thúc tính tiền không được sau 10/11/2026 (ngày kết thúc hợp đồng).',{exact:true})).toBeVisible();
  await form.screenshot({path:info.outputPath('contract-billing-boundaries.png')});
  expect(mockedWrites).toBe(variant==='server'?1:0);
  expect(audit.blocked.filter(path=>/create_contract|confirm_contract|record_|submit_/.test(path))).toEqual([]);
 });
}

}

for(const who of ['chunha','ketoan','quanly','quanly2'] as const){
 test(`DEMO lỗi tải thống kê và quyền: ${who}`,async({page},info)=>{
  let reads=0;
  await page.route(`https://${HOST}/rest/v1/rpc/get_contract_stats`,async route=>{
   reads++;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'42501',message:'permission denied table SQL_INTERNAL_TEST'})});
  });
  const audit=await setup(page,who);
  await page.goto('/contracts');
  await expect(page.getByText(/Chưa tải được.*thống kê hợp đồng|Không (có|đủ) quyền|không có quyền|không được phép/i).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('SQL_INTERNAL_TEST');
  if(reads>0){
   const region=page.getByRole('alert').filter({hasText:/thống kê hợp đồng/i}).first();
   await expect(region).toBeVisible();
   await expect(region.getByRole('button',{name:/Tải lại|Thử lại/i})).toBeVisible();
  }
  await info.attach('blocked-writers',{body:JSON.stringify(audit.blocked),contentType:'application/json'});
  expect(audit.blocked.filter(path=>/create_contract|confirm_contract|record_|submit_/.test(path))).toEqual([]);
 });
}
