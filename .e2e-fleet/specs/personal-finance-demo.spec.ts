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
 await page.getByRole('button',{name:'Gửi',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Demo chưa đọc số tiền từ ảnh');
 await page.getByRole('textbox',{name:'Nội dung thu chi'}).fill('Ăn trưa 65k, cà phê 35k');
 await page.getByRole('button',{name:'Gửi',exact:true}).click();
 await page.getByRole('button',{name:'Lưu 2 khoản',exact:true}).click();
 const s=await stateOf(page);expect(s.transactions.slice(0,2).map((t:{amount:number})=>t.amount)).toEqual([65000,35000]);
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
 await nav(page,'Kế hoạch');await page.getByRole('button',{name:'Sửa ngân sách Mua sắm',exact:true}).click();
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
test('mobile and desktop fit the viewport; flow report and screenshots',async({page},testInfo)=>{
 for(const width of [320,390,430,1280]){
  await page.setViewportSize({width,height:900});await page.goto(base+'/index.html');
  for(const s of ['home','transactions','plans','reports']){
   await page.locator(`[data-action=nav][data-screen=${s}]`).filter({visible:true}).first().click();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${s} at ${width}px`).toBe(true);
  }
  await page.locator('[data-action=nav][data-screen=home]').filter({visible:true}).first().click();await page.screenshot({path:testInfo.outputPath(`home-${width}.png`),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Quản lý ví và danh mục'}).click();await page.getByRole('button',{name:/Danh mục thu chi/}).click();expect(await page.evaluate(()=>document.querySelector('dialog')!.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`categories-${width}.png`)});await page.getByRole('button',{name:'Đóng',exact:true}).click();
  await page.goto(base+'/flow.html');await expect(page.getByRole('heading',{name:'B. Ghi nhanh bằng chữ, giọng nói hoặc ảnh'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
