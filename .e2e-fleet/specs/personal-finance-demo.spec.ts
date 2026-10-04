/** Offline product demo: fixture data only. No authentication or live accounting calls. */
import {expect, test, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../public/demos/personal-finance/', import.meta.url));
let server:Server,base:string;
const errors=new WeakMap<Page,string[]>();
test.describe.configure({mode:'default'});
test.use({viewport:{width:390,height:844},storageState:{cookies:[],origins:[]}});
test.beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  const file=(req.url||'').split('?')[0].split('/').pop()||'index.html';
  if(!['index.html','flow.html','app.js','model.js','styles.css'].includes(file)){res.writeHead(404);res.end();return;}
  try{const data=await readFile(root+file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(data);}catch{res.writeHead(404);res.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('No local demo address');
 base=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));});
test.beforeEach(async({page})=>{
 const list:string[]=[];errors.set(page,list);page.on('pageerror',err=>list.push(err.message));page.on('console',message=>{if(message.type()==='error')list.push(message.text());});
 // Fonts are cosmetic and may be unavailable in CI; no external app traffic is permitted.
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='fonts.googleapis.com'){await route.fulfill({status:200,contentType:'text/css',body:''});return;}
  if(url.origin!==base||route.request().method()!=='GET'){list.push(`Forbidden demo request ${route.request().method()} ${url.origin}`);await route.abort();return;}
  await route.continue();
 });
 await page.goto(base+'/index.html');
});
test.afterEach(async({page})=>{expect(errors.get(page)).toEqual([]);});
async function nav(page:Page,label:string){await page.getByRole('navigation',{name:'Điều hướng trên điện thoại'}).getByRole('button',{name:label,exact:true}).click();}
async function openManual(page:Page){await page.getByRole('button',{name:'Ghi thu chi',exact:true}).filter({visible:true}).click();await page.getByRole('button',{name:'Nhập tay',exact:true}).click();}
async function stateOf(page:Page){return page.evaluate(()=>JSON.parse(localStorage.getItem('ihome:personal-finance-demo:v1')||'null'));}
test('create custom category while preserving draft; save, reload, edit and delete',async({page})=>{
 await openManual(page);
 await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('150k');
 await page.getByRole('textbox',{name:'Ghi chú',exact:true}).fill('Quà cho ba mẹ');
 await page.getByRole('button',{name:'🍜 Ăn uống',exact:true}).click();
 await page.getByRole('button',{name:'Thêm danh mục',exact:true}).click();
 await page.getByRole('textbox',{name:'Tên danh mục'}).fill('Chăm sóc ba mẹ');
 await page.getByRole('button',{name:'Biểu tượng 🎁',exact:true}).click();
 await page.getByRole('button',{name:'Tạo danh mục',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Số tiền',exact:true})).toHaveValue('150k');
 await expect(page.getByRole('textbox',{name:'Ghi chú',exact:true})).toHaveValue('Quà cho ba mẹ');
 await expect(page.getByRole('button',{name:'🎁 Chăm sóc ba mẹ',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Lưu giao dịch',exact:true}).click();
 let s=await stateOf(page);expect(s.transactions.find((t:{note:string})=>t.note==='Quà cho ba mẹ').amount).toBe(150000);
 await page.reload();await nav(page,'Giao dịch');
 await page.getByRole('button',{name:'Xem Quà cho ba mẹ',exact:true}).click();
 await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('175k');
 await page.getByRole('button',{name:'Lưu thay đổi',exact:true}).click();
 s=await stateOf(page);expect(s.transactions.find((t:{note:string})=>t.note==='Quà cho ba mẹ').amount).toBe(175000);
 await page.getByRole('button',{name:'Xem Quà cho ba mẹ',exact:true}).click();await page.getByRole('button',{name:'Xóa giao dịch',exact:true}).click();await page.getByRole('button',{name:'Xác nhận',exact:true}).click();
 s=await stateOf(page);expect(s.transactions.some((t:{note:string})=>t.note==='Quà cho ba mẹ')).toBe(false);
});
test('voice stop directly creates a draft and does not book until save',async({page})=>{
 const expense=await page.getByTestId('month-expense').textContent();
 await page.getByRole('button',{name:'Ghi thu chi',exact:true}).filter({visible:true}).click();
 await page.getByRole('button',{name:'Thử giọng nói mẫu',exact:true}).click();
 await page.getByRole('button',{name:'Dừng và tự gửi giọng nói mẫu',exact:true}).click();
 await expect(page.getByText('Xem lại trước khi lưu')).toBeVisible();
 expect(await stateOf(page)).toBeNull();
 await page.getByRole('button',{name:'Lưu 1 khoản',exact:true}).click();
 expect(await page.getByTestId('month-expense').textContent()).not.toEqual(expense);
 expect((await stateOf(page)).transactions[0].amount).toBe(55000);
});
test('home exposes four working input actions with mobile touch targets',async({page},testInfo)=>{
 const launcher=page.getByRole('group',{name:'Công cụ nhập nhanh',exact:true});
 const photo={name:'quick-photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV0AAAAASUVORK5CYII=','base64')};
 for(const width of [320,390,452]){
  await page.setViewportSize({width,height:884});
  await expect(launcher.getByRole('button')).toHaveCount(4);
  for(const label of ['Ảnh kèm nội dung','Chụp bill','Chọn ảnh','Ghi âm']){
   const control=launcher.getByRole('button',{name:label,exact:true});await expect(control).toBeVisible();
   const box=await control.boundingBox();expect(box!.width).toBeGreaterThanOrEqual(44);expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 await page.screenshot({path:testInfo.outputPath('four-input-actions-452.png'),animations:'disabled'});
 for(const [label,input] of [['Ảnh kèm nội dung','receipt-file'],['Chụp bill','camera-file'],['Chọn ảnh','gallery-file']]){
  const choosing=page.waitForEvent('filechooser');await launcher.getByRole('button',{name:label,exact:true}).click();const chooser=await choosing;
  expect(await chooser.element().getAttribute('id')).toBe(input);
  expect(await chooser.element().getAttribute('capture')).toBe(input==='camera-file'?'environment':null);
  await chooser.setFiles(photo);await expect(page.getByAltText('Ảnh bạn chọn')).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Nội dung thu chi'})).toBeVisible();
  await page.getByRole('button',{name:'Đóng',exact:true}).click();
 }
 await launcher.getByRole('button',{name:'Ghi âm',exact:true}).click();
 await page.getByRole('button',{name:'Dừng và tự gửi giọng nói mẫu',exact:true}).click();
 await expect(page.getByText('Xem lại trước khi lưu')).toBeVisible();expect(await stateOf(page)).toBeNull();
 await page.getByRole('button',{name:'Đóng',exact:true}).click();
 await page.getByRole('button',{name:'Hôm nay bạn chi gì?',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung thu chi'})).toBeVisible();
});
test('quick input handles multiple entries and images with a caption',async({page})=>{
 await page.getByRole('button',{name:'Ghi thu chi',exact:true}).filter({visible:true}).click();
 await page.locator('#receipt-file').setInputFiles({name:'demo-receipt.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV0AAAAASUVORK5CYII=','base64')});
 await expect(page.getByAltText('Ảnh bạn chọn')).toBeVisible();
 await page.getByRole('button',{name:'Gửi',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Thêm nội dung và số tiền cho ảnh');
 await page.getByRole('textbox',{name:'Nội dung thu chi'}).fill('Ăn trưa 65k, cà phê 35k');
 await page.getByRole('button',{name:'Gửi',exact:true}).click();
 await page.getByRole('button',{name:'Lưu 2 khoản',exact:true}).click();
 const s=await stateOf(page);expect(s.transactions.slice(0,2).map((t:{amount:number})=>t.amount)).toEqual([65000,35000]);
});
test('destination switch keeps image and text; company drafts stay outside the personal wallet',async({page},testInfo)=>{
 const initialBalance=await page.getByTestId('total-balance').textContent();
 const initialExpense=await page.getByTestId('month-expense').textContent();
 await expect(page.getByText('DEMO',{exact:true})).toHaveCount(0);
 await page.getByRole('group',{name:'Gửi thu chi vào',exact:true}).getByRole('button',{name:'Công ty',exact:true}).click();
 await page.getByRole('button',{name:'Hôm nay bạn chi gì?',exact:true}).click();
 const dialog=page.getByRole('dialog'),picker=dialog.getByRole('group',{name:'Gửi thu chi vào',exact:true});
 await expect(picker.getByRole('button',{name:'Công ty',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(dialog.getByText(/DEMO|Chi hai khoản|Nhận lương|Thử hóa đơn mẫu/)).toHaveCount(0);
 for(const width of [320,390,452]){
  await page.setViewportSize({width,height:884});
  const composerBox=await dialog.locator('.quick-composer').boundingBox(),pickerBox=await picker.boundingBox();
  expect(pickerBox!.y).toBeGreaterThan(composerBox!.y+composerBox!.height);
  for(const label of ['Cá nhân','Công ty']){const box=await picker.getByRole('button',{name:label,exact:true}).boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);}
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 }
 await page.screenshot({path:testInfo.outputPath('destination-company-452.png'),animations:'disabled'});
 await dialog.locator('#receipt-file').setInputFiles({name:'receipt.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV0AAAAASUVORK5CYII=','base64')});
 await page.getByRole('textbox',{name:'Nội dung thu chi'}).fill('Văn phòng phẩm 150k');
 await picker.getByRole('button',{name:'Cá nhân',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung thu chi'})).toHaveValue('Văn phòng phẩm 150k');
 await expect(page.getByAltText('Ảnh bạn chọn')).toBeVisible();
 await picker.getByRole('button',{name:'Công ty',exact:true}).press('Space');
 await page.getByRole('button',{name:'Gửi',exact:true}).click();
 await expect(dialog.locator('.draft-label')).toHaveText('Công ty · Chi');
 // Changing the next send destination must not reroute a draft already awaiting review.
 await picker.getByRole('button',{name:'Cá nhân',exact:true}).click();
 await expect(dialog.locator('.draft-label')).toHaveText('Công ty · Chi');
 await page.getByRole('button',{name:'Lưu 1 khoản công ty',exact:true}).click();
 await expect(page.getByTestId('total-balance')).toHaveText(initialBalance!);
 await expect(page.getByTestId('month-expense')).toHaveText(initialExpense!);
 await page.reload();
 const s=await stateOf(page);expect(s.companyTransactions[0]).toMatchObject({amount:150000,note:'Văn phòng phẩm 150k'});
 expect(s.transactions.some((t:{id:string})=>t.id===s.companyTransactions[0].id)).toBe(false);
});
test('manual destination changes preserve fields and existing personal entries keep their destination',async({page})=>{
 await openManual(page);
 await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('200k');
 await page.getByRole('textbox',{name:'Ghi chú',exact:true}).fill('Mua giấy công ty');
 await page.getByRole('dialog').getByRole('button',{name:'Công ty',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Số tiền',exact:true})).toHaveValue('200k');
 await expect(page.getByRole('textbox',{name:'Ghi chú',exact:true})).toHaveValue('Mua giấy công ty');
 await page.getByRole('button',{name:'Lưu khoản công ty',exact:true}).click();
 const s=await stateOf(page);expect(s.companyTransactions[0]).toMatchObject({amount:200000,note:'Mua giấy công ty'});
 await nav(page,'Giao dịch');await page.locator('.txn').first().click();
 await expect(page.getByRole('dialog').getByRole('group',{name:'Gửi thu chi vào',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Lưu thay đổi',exact:true})).toBeVisible();
});
test('internal transfer preserves total balance and income/expense totals',async({page})=>{
 const before=await page.getByTestId('total-balance').textContent(),expense=await page.getByTestId('month-expense').textContent();
 await nav(page,'Giao dịch');await page.getByRole('button',{name:'Chuyển tiền giữa ví',exact:true}).click();
 await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('100k');
 await page.getByRole('combobox',{name:'Ví chuyển',exact:true}).selectOption('bank');await page.getByRole('combobox',{name:'Ví nhận',exact:true}).selectOption('bank');
 await page.getByRole('button',{name:'Chuyển tiền',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Ví nhận cần khác');
 await page.getByRole('combobox',{name:'Ví nhận',exact:true}).selectOption('cash');await page.getByRole('button',{name:'Chuyển tiền',exact:true}).click();
 await nav(page,'Tổng quan');await expect(page.getByTestId('total-balance')).toHaveText(before!);await expect(page.getByTestId('month-expense')).toHaveText(expense!);
 expect((await stateOf(page)).transactions[0]).toMatchObject({type:'transfer',amount:100000,wallet:'bank',toWallet:'cash'});
});
test('budget changes, goal contribution and report drill-down are interactive',async({page})=>{
 await nav(page,'Ngân sách');await page.getByRole('button',{name:'Sửa ngân sách Mua sắm',exact:true}).click();
 await page.getByRole('textbox',{name:'Giới hạn mỗi tháng'}).fill('500k');await page.getByRole('button',{name:'Lưu ngân sách',exact:true}).click();await expect(page.getByText('Vượt 390.000 ₫ · 178% đã dùng')).toBeVisible();
 await page.getByRole('button',{name:'Mục tiêu tiết kiệm',exact:true}).click();await page.getByRole('button',{name:'Bỏ thêm vào quỹ',exact:true}).click();
 await page.getByRole('textbox',{name:'Số tiền tiết kiệm'}).fill('1tr');await page.getByRole('button',{name:'Lưu',exact:true}).click();expect((await stateOf(page)).goals[0].saved).toBe(6000000);
 await nav(page,'Báo cáo');await page.getByRole('button',{name:/Mua sắm.*890.000/}).click();
 await expect(page.getByRole('button',{name:'Xem Giày chạy bộ',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Xem Tiền thuê nhà tháng 10',exact:true})).toHaveCount(0);
});
test('invalid amount and duplicate category stay editable; empty month is clear',async({page})=>{
 await openManual(page);await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('-100');await page.getByRole('button',{name:'Lưu giao dịch',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Nhập số tiền lớn hơn 0');
 await page.getByRole('button',{name:'🍜 Ăn uống',exact:true}).click();await page.getByRole('button',{name:'Thêm danh mục',exact:true}).click();await page.getByRole('textbox',{name:'Tên danh mục'}).fill(' ăn uống ');await page.getByRole('button',{name:'Tạo danh mục',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Danh mục này đã có');
 await page.getByRole('button',{name:'Đóng',exact:true}).click();await page.getByRole('button',{name:'Tháng sau',exact:true}).click();await expect(page.getByText('Tháng này còn trống', {exact:true})).toBeVisible();
});
test('income uses income categories; category names render as text, not markup',async({page})=>{
 await openManual(page);await page.getByRole('button',{name:'+ Thu nhập',exact:true}).click();await page.getByRole('button',{name:'💼 Lương',exact:true}).click();await expect(page.getByRole('button',{name:'🍜 Ăn uống',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Thêm danh mục',exact:true}).click();await page.getByRole('textbox',{name:'Tên danh mục'}).fill('<img src=x onerror=alert(1)>');await page.getByRole('button',{name:'Tạo danh mục',exact:true}).click();await expect(page.getByRole('button',{name:'🏷️ <img src=x onerror=alert(1)>',exact:true})).toBeVisible();expect(await page.locator('img[src=x]').count()).toBe(0);
 await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('2tr');await page.getByRole('button',{name:'Lưu giao dịch',exact:true}).click();expect((await stateOf(page)).transactions[0].type).toBe('income');
});
test('wallet configuration from filter supports create, edit, hide, reload and confirmed deletion',async({page},testInfo)=>{
 await nav(page,'Giao dịch');await page.getByRole('button',{name:'Mọi ví',exact:true}).click();
 await expect(page.getByRole('button',{name:'Quản lý ví',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Thêm ví',exact:true}).click();
 await page.getByRole('textbox',{name:'Tên ví',exact:true}).fill('MoMo');
 await page.getByRole('textbox',{name:'Số dư ban đầu',exact:true}).fill('-5');
 await page.getByRole('button',{name:'Tạo ví',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Nhập tên và số dư');
 await page.getByRole('textbox',{name:'Số dư ban đầu',exact:true}).fill('250k');
 await page.getByRole('combobox',{name:'Loại ví',exact:true}).selectOption('ewallet');
 await page.getByRole('radio',{name:'Biểu tượng 📱',exact:true}).check();
 await page.getByRole('button',{name:'Tạo ví',exact:true}).click();
 await page.getByRole('button',{name:'Sửa ví MoMo',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Số dư ban đầu',exact:true})).toHaveValue('250000');
 await expect(page.getByRole('radio',{name:'Biểu tượng 📱',exact:true})).toBeChecked();
 await page.getByRole('textbox',{name:'Tên ví',exact:true}).fill('Tiền mặt');
 await page.getByRole('button',{name:'Lưu thay đổi',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Tên ví này đã có');
 await page.getByRole('textbox',{name:'Tên ví',exact:true}).fill('Ví điện thoại');
 await page.getByRole('textbox',{name:'Số dư ban đầu',exact:true}).fill('300k');
 await page.getByRole('checkbox',{name:/Hiển thị trên Tổng quan/}).uncheck();
 for(const width of [320,390,452]){
  await page.setViewportSize({width,height:884});
  expect(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 }
 await page.getByRole('button',{name:'Lưu thay đổi',exact:true}).click();
 await expect(page.getByText('Ví điện tử · Đang ẩn',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Sửa ví Ví điện thoại',exact:true}).click();
 await page.screenshot({path:testInfo.outputPath('wallet-configuration-452.png'),animations:'disabled'});
 await page.reload();const stored=await stateOf(page),w=stored.wallets.find((w:{name:string})=>w.name==='Ví điện thoại');
 expect(w).toMatchObject({opening:300000,kind:'ewallet',emoji:'📱',hidden:true});
 await expect(page.locator('.wallet-mini').filter({hasText:'Ví điện thoại'})).toHaveCount(0);
 await page.getByRole('button',{name:'Quản lý ví',exact:true}).click();
 await page.getByRole('button',{name:'Sửa ví Ví điện thoại',exact:true}).click();
 await page.getByRole('button',{name:'Xóa ví',exact:true}).click();
 await page.getByRole('button',{name:'Giữ lại',exact:true}).click();expect((await stateOf(page)).wallets.some((v:{id:string})=>v.id===w.id)).toBe(true);
 await page.getByRole('button',{name:'Xóa ví',exact:true}).click();
 await page.getByRole('button',{name:'Xóa ví',exact:true}).click();
 expect((await stateOf(page)).wallets.some((v:{id:string})=>v.id===w.id)).toBe(false);
 await page.getByRole('button',{name:'Đóng',exact:true}).click();
 await expect(page.getByTestId('total-balance')).toContainText('48.012.000');
});
test('used wallets keep transaction links and totals when renamed or hidden',async({page})=>{
 const expense=await page.getByTestId('month-expense').textContent();
 await page.getByRole('button',{name:'Quản lý ví',exact:true}).click();
 await page.getByRole('button',{name:'Sửa ví Tài khoản ngân hàng',exact:true}).click();
 await expect(page.getByRole('button',{name:'Xóa ví',exact:true})).toBeDisabled();
 await expect(page.getByText(/Ví đã có giao dịch/)).toBeVisible();
 await page.getByRole('textbox',{name:'Tên ví',exact:true}).fill('Ngân hàng riêng');
 await page.getByRole('textbox',{name:'Số dư ban đầu',exact:true}).fill('13tr');
 await page.getByRole('checkbox',{name:/Hiển thị trên Tổng quan/}).uncheck();
 await page.getByRole('button',{name:'Lưu thay đổi',exact:true}).click();
 await page.getByRole('button',{name:'Sửa ví Ví tiết kiệm',exact:true}).click();
 await expect(page.getByRole('button',{name:'Xóa ví',exact:true})).toBeDisabled();
 await expect(page.getByText(/Ví đang dùng cho mục tiêu tiết kiệm/)).toBeVisible();
 await page.getByRole('button',{name:'Đóng',exact:true}).click();
 await expect(page.getByTestId('total-balance')).toContainText('49.012.000');
 await expect(page.getByTestId('month-expense')).toHaveText(expense!);
 await expect(page.locator('.wallet-mini').filter({hasText:'Ngân hàng riêng'})).toHaveCount(0);
 await nav(page,'Giao dịch');await page.getByRole('button',{name:'Xem Đi chợ cho tuần mới',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Ví thanh toán',exact:true})).toHaveValue('bank');
 await expect(page.getByRole('combobox',{name:'Ví thanh toán',exact:true})).toContainText('Ngân hàng riêng');
 expect((await stateOf(page)).transactions.find((t:{id:string})=>t.id==='t2').wallet).toBe('bank');
});
test('category management supports rename, hide, reload and deleting an unused custom category',async({page},testInfo)=>{
 await nav(page,'Ngân sách');await expect(page.getByRole('heading',{name:'Ngân sách',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Quản lý danh mục',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Quản lý danh mục',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Thêm danh mục',exact:true}).click();
 await page.getByRole('textbox',{name:'Tên danh mục',exact:true}).fill('Giải lao');
 await page.getByRole('button',{name:'Biểu tượng ☕',exact:true}).click();
 await page.getByRole('button',{name:'Tạo danh mục',exact:true}).click();
 const created=(await stateOf(page)).categories.find((c:{name:string})=>c.name==='Giải lao');
 await page.getByRole('button',{name:'Sửa danh mục Giải lao',exact:true}).click();
 await page.getByRole('textbox',{name:'Tên danh mục',exact:true}).fill('Thư giãn');
 await page.getByRole('checkbox',{name:/Hiển thị khi chọn danh mục/}).uncheck();
 await page.getByRole('button',{name:'Lưu danh mục',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sửa danh mục Thư giãn',exact:true})).toContainText('Đang ẩn');
 await page.reload();await nav(page,'Ngân sách');await page.getByRole('button',{name:'Quản lý danh mục',exact:true}).click();
 expect((await stateOf(page)).categories.find((c:{id:string})=>c.id===created.id)).toMatchObject({name:'Thư giãn',emoji:'☕',hidden:true,type:'expense'});
 await page.screenshot({path:testInfo.outputPath('category-management.png'),animations:'disabled'});
 await page.getByRole('button',{name:'Sửa danh mục Thư giãn',exact:true}).click();
 await page.getByRole('button',{name:'Xóa danh mục',exact:true}).click();
 await page.getByRole('button',{name:'Giữ lại',exact:true}).click();
 await page.getByRole('button',{name:'Xóa danh mục',exact:true}).click();
 await page.getByRole('button',{name:'Xóa danh mục',exact:true}).click();
 expect((await stateOf(page)).categories.some((c:{id:string})=>c.id===created.id)).toBe(false);
});
test('add category within a budget preserves amount; renaming and hiding retain its budget link',async({page})=>{
 await nav(page,'Ngân sách');await page.getByRole('button',{name:'Thêm',exact:true}).click();
 await page.getByRole('textbox',{name:'Giới hạn mỗi tháng',exact:true}).fill('650k');
 await page.getByRole('button',{name:'Thêm danh mục',exact:true}).click();
 await page.getByRole('textbox',{name:'Tên danh mục',exact:true}).fill('Sở thích');
 await page.getByRole('button',{name:'Tạo danh mục',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Giới hạn mỗi tháng',exact:true})).toHaveValue('650k');
 const categoryId=await page.getByRole('combobox',{name:'Danh mục ngân sách',exact:true}).inputValue();
 await page.getByRole('button',{name:'Lưu ngân sách',exact:true}).click();
 await page.getByRole('button',{name:'Quản lý danh mục',exact:true}).click();
 await page.getByRole('button',{name:'Sửa danh mục Sở thích',exact:true}).click();
 await expect(page.getByRole('button',{name:'Xóa danh mục',exact:true})).toBeDisabled();
 await expect(page.getByText(/Danh mục đang có giao dịch hoặc ngân sách/)).toBeVisible();
 await page.getByRole('textbox',{name:'Tên danh mục',exact:true}).fill('Sở thích cá nhân');
 await page.getByRole('checkbox',{name:/Hiển thị khi chọn danh mục/}).uncheck();
 await page.getByRole('button',{name:'Lưu danh mục',exact:true}).click();
 await page.getByRole('button',{name:'Đóng',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sửa ngân sách Sở thích cá nhân',exact:true})).toBeVisible();
 expect((await stateOf(page)).budgets.find((b:{category:string})=>b.category===categoryId).amount).toBe(650000);
 await page.getByRole('button',{name:'Thêm',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Danh mục ngân sách',exact:true})).not.toContainText('Sở thích cá nhân');
});
test('monthly category budgets combine personal wallets and exclude transfers and company entries',async({page},testInfo)=>{
 for(const [wallet,amount] of [['bank','10k'],['cash','20k']]){
  await openManual(page);await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill(amount);
  await page.getByRole('combobox',{name:'Ví thanh toán',exact:true}).selectOption(wallet);
  await page.getByRole('button',{name:'Lưu giao dịch',exact:true}).click();
 }
 await nav(page,'Ngân sách');
 const food=page.locator('.budget-item').filter({hasText:'Ăn uống'});
 await expect(food).toContainText('270.000');await expect(page.getByText('Tất cả ví cá nhân',{exact:true})).toBeVisible();
 const before=await food.textContent();
 await nav(page,'Giao dịch');await page.getByRole('button',{name:'Chuyển tiền giữa ví',exact:true}).click();
 await page.getByRole('textbox',{name:'Số tiền',exact:true}).fill('50k');await page.getByRole('button',{name:'Chuyển tiền',exact:true}).click();
 await page.getByRole('button',{name:'Ghi thu chi',exact:true}).filter({visible:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Công ty',exact:true}).click();
 await page.getByRole('textbox',{name:'Nội dung thu chi',exact:true}).fill('Cà phê 100k');
 await page.getByRole('button',{name:'Gửi',exact:true}).click();await page.getByRole('button',{name:'Lưu 1 khoản công ty',exact:true}).click();
 await nav(page,'Ngân sách');await expect(food).toHaveText(before!);
 await page.getByRole('button',{name:'Tháng trước',exact:true}).click();
 await expect(food).toContainText('2.200.000');await expect(food).toContainText('3.000.000');
 await expect(page.getByText(/Đã chi 13.800.000/)).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('budget-scope.png'),animations:'disabled'});
});
test('mobile and desktop fit the viewport; flow report and screenshots',async({page},testInfo)=>{
 for(const width of [320,390,430,1280]){
  await page.setViewportSize({width,height:900});await page.goto(base+'/index.html');
  await expect(page.getByText('Tháng này của bạn',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Chi tiêu rõ ràng. An tâm mỗi ngày.',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Ghi một câu, xong một khoản',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Gõ, nói hoặc thêm ảnh hóa đơn.',{exact:true})).toHaveCount(0);
  await expect(page.locator('.quick-card .destination-caption')).toBeHidden();
  const monthPicker=page.locator('.balance-card .month-picker');
  await expect(monthPicker).toContainText('10.2026');
  await monthPicker.getByRole('button',{name:'Tháng trước',exact:true}).click();
  await expect(monthPicker).toContainText('9.2026');
  await expect(page.getByTestId('month-expense')).toContainText('13.800.000');
  const monthBox=await monthPicker.boundingBox(),eyeBox=await page.getByRole('button',{name:'Ẩn số dư',exact:true}).boundingBox();
  expect(monthBox!.x+monthBox!.width).toBeLessThanOrEqual(eyeBox!.x);
  expect(Math.abs(monthBox!.y-eyeBox!.y)).toBeLessThan(1);
  // The decorative circle intentionally extends beyond the card and is clipped.
  const cardBox=await page.locator('.balance-card').boundingBox();
  expect(monthBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(eyeBox!.x+eyeBox!.width).toBeLessThanOrEqual(cardBox!.x+cardBox!.width);
  await monthPicker.getByRole('button',{name:'Tháng sau',exact:true}).click();
  for(const s of ['home','transactions','plans','reports']){
   await page.locator(`[data-action=nav][data-screen=${s}]`).filter({visible:true}).first().click();
   await expect(page.locator('.topbar')).toHaveCount(0);
   await expect(page.locator('#main > .heading')).toHaveCount(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${s} at ${width}px`).toBe(true);
   if(s==='transactions'){
    await expect(page.locator('.transaction-tools .search .icon')).toHaveCount(0);
    const search=await page.getByRole('searchbox',{name:'Tìm giao dịch'}).boundingBox(),picker=await page.locator('.transaction-tools .month-picker').boundingBox();
    expect(picker!.x).toBeGreaterThanOrEqual(search!.x+search!.width);
    await page.getByRole('searchbox',{name:'Tìm giao dịch'}).fill('Cà phê');
    await page.getByRole('button',{name:'Tháng trước',exact:true}).click();
    await expect(page.getByRole('searchbox',{name:'Tìm giao dịch'})).toHaveValue('Cà phê');
    await expect(page.locator('.transaction-tools .month-picker')).toContainText('9.2026');
    await page.getByRole('button',{name:'Tháng sau',exact:true}).click();
   }
   if(s==='plans'){
    await expect(page.locator('.compact-card-header .month-picker')).toContainText('10.2026');
    await expect(page.getByRole('heading',{name:'Ngân sách',exact:true})).toBeVisible();
   }
   if(s==='reports'){
    await expect(page.getByRole('heading',{name:'Tiền đã đi đâu?',exact:true})).toHaveCount(0);
    await expect(page.locator('.section-heading .month-picker')).toContainText('10.2026');
   }
   if(width===390)await page.screenshot({path:testInfo.outputPath(`${s}-compact-390.png`),animations:'disabled'});
  }
  await page.locator('[data-action=nav][data-screen=home]').filter({visible:true}).first().click();await page.screenshot({path:testInfo.outputPath(`home-${width}.png`),fullPage:true,animations:'disabled'});
  await page.locator('[data-action=nav][data-screen=plans]').filter({visible:true}).first().click();await page.getByRole('button',{name:'Quản lý danh mục',exact:true}).click();expect(await page.evaluate(()=>document.querySelector('dialog')!.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`categories-${width}.png`)});await page.getByRole('button',{name:'Đóng',exact:true}).click();
  await page.goto(base+'/flow.html');await expect(page.getByRole('heading',{name:'B. Ghi nhanh bằng chữ, giọng nói hoặc ảnh'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
