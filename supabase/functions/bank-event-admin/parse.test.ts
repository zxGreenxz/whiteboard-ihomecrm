import assert from 'node:assert/strict';
import {BankSummary,summarizeBankPayload} from '../_shared/bank-events-parse.ts';
// Mọi tin dưới đây là MẪU TỰ BỊA: tên, số tài khoản, số tiền đều giả.

const sms=(sender:string,body:string)=>({event:'sms.received',sender,body});
const notif=(packageName:string,appName:string,title:string,body:string)=>({event:'notification.received',packageName,appName,title,body});
const email=(from:string,subject:string,body:string)=>({event:'email.received',from,subject,body});
const expected=(o:Partial<BankSummary>):BankSummary=>({direction:null,amount:null,balance:null,account:null,description:null,bank:null,transactedAt:null,...o});
const check=(payload:Record<string,unknown>,want:Partial<BankSummary>)=>assert.deepEqual(summarizeBankPayload(payload),expected(want));

// --- SMS ---
Deno.test('SMS Vietcombank: SD TK… +tiền, SD, Ref; TK 0011004xxx789 chỉ có 3 số cuối nên account null',()=>check(
 sms('Vietcombank','SD TK 0011004xxx789 +500,000VND luc 09-10-2026 10:20:30. SD 12,345,678VND. Ref MBVCB.1234567890.NGUYEN VAN A chuyen tien phong 101'),
 {direction:'in',amount:500000,balance:12345678,account:null,description:'MBVCB.1234567890.NGUYEN VAN A chuyen tien phong 101',bank:'Vietcombank',transactedAt:'2026-10-09T10:20:30+07:00'}));

Deno.test('SMS Techcombank nhiều dòng: So tien GD:+…, So du:…, ND',()=>check(
 sms('TECHCOMBANK','TK 1903xxxx5847\nSo tien GD:+2,000,000\nSo du:15,000,000\nND: NGUYEN VAN A chuyen tien coc phong 305\n09/10/2026 08:30'),
 {direction:'in',amount:2000000,balance:15000000,account:'••5847',description:'NGUYEN VAN A chuyen tien coc phong 305',bank:'Techcombank',transactedAt:'2026-10-09T08:30:00+07:00'}));

Deno.test('SMS MB phân cách | với GD:/SD:/ND: và ngày dd/mm/yy hh:mm',()=>check(
 sms('MBBANK','TK 0xxx5847|GD: +3,500,000VND 09/10/26 07:45|SD: 10,000,000VND|ND: NGUYEN VAN B tien phong 202 thang 10'),
 {direction:'in',amount:3500000,balance:10000000,account:'••5847',description:'NGUYEN VAN B tien phong 202 thang 10',bank:'MB',transactedAt:'2026-10-09T07:45:00+07:00'}));

Deno.test('SMS ACB: "+ 2,000,000" dấu tách rời, giờ trước ngày, GD: là nội dung',()=>check(
 sms('ACB','ACB: TK 12345678(VND) + 2,000,000 luc 10:20 09/10/2026. So du 7,000,000. GD: NGUYEN VAN A CK tien phong'),
 {direction:'in',amount:2000000,balance:7000000,account:'••5678',description:'NGUYEN VAN A CK tien phong',bank:'ACB',transactedAt:'2026-10-09T10:20:00+07:00'}));

Deno.test('SMS BIDV: TK dính số, "vao hh:mm dd/mm/yyyy", trường ngăn bằng ;',()=>check(
 sms('BIDV','TK12010000xxx5847 tai BIDV +500,000VND vao 10:20 09/10/2026; So du: 3,500,000VND; ND: NGUYEN VAN C chuyen tien dien nuoc'),
 {direction:'in',amount:500000,balance:3500000,account:'••5847',description:'NGUYEN VAN C chuyen tien dien nuoc',bank:'BIDV',transactedAt:'2026-10-09T10:20:00+07:00'}));

Deno.test('SMS VietinBank tiền ra: GD:-…, SDC:',()=>check(
 sms('VietinBank','VietinBank:09/10/2026 10:20|TK:1080xxxx5847|GD:-1,000,000VND|SDC:2,500,000VND|ND:THANH TOAN HOA DON DIEN THANG 9'),
 {direction:'out',amount:1000000,balance:2500000,account:'••5847',description:'THANH TOAN HOA DON DIEN THANG 9',bank:'VietinBank',transactedAt:'2026-10-09T10:20:00+07:00'}));

Deno.test('SMS TPBank: PS:+…, hai dòng số dư lấy dòng đầu, SO GD không phải số tiền',()=>check(
 sms('TPBank','(TPBank): 09/10/26;10:20\nTK: xxxx5847\nPS:+500,000VND\nSD: 3,000,000VND\nSD KHA DUNG: 3,000,000VND\nND: NGUYEN VAN A CK tien phong 101\nSO GD: 123456789'),
 {direction:'in',amount:500000,balance:3000000,account:'••5847',description:'NGUYEN VAN A CK tien phong 101',bank:'TPBank',transactedAt:'2026-10-09T10:20:00+07:00'}));

Deno.test('SMS Agribank: nội dung trong ngoặc; "10h20p 09/10" thiếu năm nên transactedAt null',()=>check(
 sms('Agribank','Agribank: 10h20p 09/10 TK 1500xxxx5847: +2,000,000VND (NGUYEN VAN A CK tien phong). SD: 5,123,000VND.'),
 {direction:'in',amount:2000000,balance:5123000,account:'••5847',description:'NGUYEN VAN A CK tien phong',bank:'Agribank',transactedAt:null}));

Deno.test('SMS VPBank tiền ra: -350,000VND, "luc hh:mm dd/mm/yyyy"',()=>check(
 sms('VPBank','TK 12345xxx5847 tai VPBank -350,000VND luc 08:15 09/10/2026. So du 1,650,000VND. ND: THANH TOAN QR CUA HANG ABC'),
 {direction:'out',amount:350000,balance:1650000,account:'••5847',description:'THANH TOAN QR CUA HANG ABC',bank:'VPBank',transactedAt:'2026-10-09T08:15:00+07:00'}));

Deno.test('SMS Sacombank định dạng dấu chấm: PS: -1.500.000 VND, So du kha dung',()=>check(
 sms('Sacombank','Sacombank 09/10/2026 10:20\nTK: 0201xxxx5847\nPS: -1.500.000 VND\nSo du kha dung: 8.500.000 VND\nND: CHUYEN TIEN THUE NHA THANG 10'),
 {direction:'out',amount:1500000,balance:8500000,account:'••5847',description:'CHUYEN TIEN THUE NHA THANG 10',bank:'Sacombank',transactedAt:'2026-10-09T10:20:00+07:00'}));

Deno.test('SMS HDBank: số không phân cách (1234567), nhãn GD không có dấu hai chấm',()=>check(
 sms('HDBank','HDBank: TK xxxx5847 GD -1234567VND luc 09/10/2026 15:00. SD 765433VND. ND: RUT TIEN MAT TAI ATM'),
 {direction:'out',amount:1234567,balance:765433,account:'••5847',description:'RUT TIEN MAT TAI ATM',bank:'HDBank',transactedAt:'2026-10-09T15:00:00+07:00'}));

Deno.test('SMS Eximbank: 14,000,000.00 VNĐ, Phát sinh:, Số dư cuối:, giờ:phút:giây trước ngày',()=>check(
 sms('Eximbank','Eximbank: TK xxxx5847 Phát sinh: +14,000,000.00 VNĐ lúc 16:45:00 09/10/2026. Số dư cuối: 15,250,000.00 VNĐ. Nội dung giao dịch: NGUYEN VAN A CHUYEN TIEN COC'),
 {direction:'in',amount:14000000,balance:15250000,account:'••5847',description:'NGUYEN VAN A CHUYEN TIEN COC',bank:'Eximbank',transactedAt:'2026-10-09T16:45:00+07:00'}));

Deno.test('SMS SHB: mã GD/số GD/FT/MBVCB dài không bị nhầm thành số tiền',()=>check(
 sms('SHB','SHB: TK 1012xxxx5847. Ma GD 202610091234567. So GD: 88776655. So tien: +700,000 VND luc 11:11:11 09/10/2026. SD: 900,000 VND. ND: FT26282123456789 NGUYEN VAN A CK MBVCB.11223344556 phong 303'),
 {direction:'in',amount:700000,balance:900000,account:'••5847',description:'FT26282123456789 NGUYEN VAN A CK MBVCB.11223344556 phong 303',bank:'SHB',transactedAt:'2026-10-09T11:11:11+07:00'}));

Deno.test('ngày giờ không hợp lệ (25:61 31/02) → transactedAt null, phần còn lại vẫn tách',()=>check(
 sms('ACB','ACB: TK 12345678(VND) + 1,000,000 luc 25:61 31/02/2026. So du 2,000,000. GD: NGUYEN VAN A CK'),
 {direction:'in',amount:1000000,balance:2000000,account:'••5678',description:'NGUYEN VAN A CK',bank:'ACB',transactedAt:null}));

Deno.test('"So du TK <số TK đầy đủ> giam …": số TK không bị lấy làm số dư, chiều lấy từ "giam"',()=>check(
 sms('Vietcombank','So du TK 0123456789 giam 50,000 VND luc 10:20 09/10/2026. SD: 1,000,000 VND. ND: PHI SMS BANKING'),
 {direction:'out',amount:50000,balance:1000000,account:'••6789',description:'PHI SMS BANKING',bank:'Vietcombank',transactedAt:'2026-10-09T10:20:00+07:00'}));

// --- Thông báo app ---
Deno.test('App Vietcombank: tiêu đề "Biến động số dư", Số dư TK VCB … +1.200.000 VND',()=>check(
 notif('com.VCB','VCB Digibank','Biến động số dư','Số dư TK VCB 0011xxxx5847 +1.200.000 VND lúc 09-10-2026 19:05:00. Số dư 3.450.000 VND. Ref 5123IBT1aW7Q9XYZ.NGUYEN VAN A tra tien phong'),
 {direction:'in',amount:1200000,balance:3450000,account:'••5847',description:'5123IBT1aW7Q9XYZ.NGUYEN VAN A tra tien phong',bank:'Vietcombank',transactedAt:'2026-10-09T19:05:00+07:00'}));

Deno.test('App Techcombank tiền ra: Số tiền: -250,000 VND, Nội dung:, ngày ở dòng cuối',()=>check(
 notif('vn.com.techcombank.bb.app','Techcombank','Biến động số dư','Tài khoản 1903xxxx5847\nSố tiền: -250,000 VND\nSố dư: 4,750,000 VND\nNội dung: THANH TOAN HOA DON NUOC\n09/10/2026 08:00'),
 {direction:'out',amount:250000,balance:4750000,account:'••5847',description:'THANH TOAN HOA DON NUOC',bank:'Techcombank',transactedAt:'2026-10-09T08:00:00+07:00'}));

Deno.test('App MB tiền ra',()=>check(
 notif('com.mbmobile','MB Bank','Thông báo biến động số dư','TK 0xxx5847|GD: -120,000VND 09/10/26 12:30|SD: 880,000VND|ND: THANH TOAN QR CUA HANG XYZ'),
 {direction:'out',amount:120000,balance:880000,account:'••5847',description:'THANH TOAN QR CUA HANG XYZ',bank:'MB',transactedAt:'2026-10-09T12:30:00+07:00'}));

Deno.test('App BIDV: không dấu +/-, chiều lấy từ từ khoá "tăng"',()=>check(
 notif('com.vnpay.bidv','BIDV SmartBanking','BIDV','Tài khoản 12010000xxx5847 tăng 1.000.000 VND vào 21:05 09/10/2026. Số dư: 2.000.000 VND. Nội dung: NGUYEN VAN C chuyen khoan'),
 {direction:'in',amount:1000000,balance:2000000,account:'••5847',description:'NGUYEN VAN C chuyen khoan',bank:'BIDV',transactedAt:'2026-10-09T21:05:00+07:00'}));

Deno.test('App Cake: thiếu tài khoản, đơn vị "đ", tiêu đề "Biến động số dư" không bị coi là nhãn số dư',()=>check(
 notif('xyz.be.cake','Cake','Biến động số dư','+200.000đ vào tài khoản. Nội dung: NGUYEN VAN D gui tien. Số dư: 1.200.000đ'),
 {direction:'in',amount:200000,balance:1200000,account:null,description:'NGUYEN VAN D gui tien',bank:'Cake',transactedAt:null}));

Deno.test('App VPBank: số dư âm',()=>check(
 notif('com.vnpay.vpbankonline','VPBank NEO','VPBank','TK 12345xxx5847 | -2,000,000 VND | 09/10/2026 13:30 | SD: -500,000 VND | ND: RUT TIEN ATM'),
 {direction:'out',amount:2000000,balance:-500000,account:'••5847',description:'RUT TIEN ATM',bank:'VPBank',transactedAt:'2026-10-09T13:30:00+07:00'}));

Deno.test('App Timo: "-1.000.000" không đơn vị',()=>check(
 notif('vn.timo.app','Timo','Biến động số dư','TK xxxx5847: -1.000.000 lúc 20:00 09/10/2026. SD: 4.000.000. ND: CHUYEN TIEN NHA'),
 {direction:'out',amount:1000000,balance:4000000,account:'••5847',description:'CHUYEN TIEN NHA',bank:'Timo',transactedAt:'2026-10-09T20:00:00+07:00'}));

Deno.test('App lạ: nhận ngân hàng theo appName; "Noi dung:" cắt trước ", SD:"',()=>check(
 notif('com.example.bankapp','OCB OMNI','Biến động số dư','OCB: TK xxxx5847 +500,000 VND, Noi dung: NGUYEN VAN A CK, SD: 1,500,000 VND'),
 {direction:'in',amount:500000,balance:1500000,account:'••5847',description:'NGUYEN VAN A CK',bank:'OCB',transactedAt:null}));

Deno.test('App SeABank: "Giao dịch: +500,000VND", Mô tả:, không có số dư',()=>check(
 notif('vn.com.seabank.mb1','SeAMobile','Biến động số dư','Giao dịch: +500,000VND\nTài khoản: 0011004xxx789\nThời gian: 09-10-2026 06:00:00\nMô tả: NGUYEN VAN E CK tien dien'),
 {direction:'in',amount:500000,balance:null,account:null,description:'NGUYEN VAN E CK tien dien',bank:'SeABank',transactedAt:'2026-10-09T06:00:00+07:00'}));

Deno.test('App: nội dung không nhãn ở dòng sau dòng số dư; dừng ở dòng trống',()=>check(
 notif('vn.com.techcombank.bb.app','Techcombank','Biến động số dư','TK 1903xxxx5847\nSố tiền: +2,000,000 VND\nSố dư: 15,000,000 VND\nNGUYEN VAN A chuyen tien\n\nBấm để xem chi tiết'),
 {direction:'in',amount:2000000,balance:15000000,account:'••5847',description:'NGUYEN VAN A chuyen tien',bank:'Techcombank',transactedAt:null}));

// --- Email ---
const footer='Thông tin trong email này chỉ dành cho người nhận và được gửi tự động, vui lòng không trả lời. '.repeat(40);
Deno.test('Email ACB: nội dung là dòng ngay sau dòng số tiền; chân trang quảng cáo dài bị bỏ qua',()=>{
 const body=['Kính gửi Quý khách NGUYEN VAN A,','ACB xin thông báo tài khoản của Quý khách vừa phát sinh giao dịch như sau:',
  'Tài khoản: xxxx5847','Ghi có +14,000,000 VND','NGUYEN VAN A CHUYEN TIEN PHONG 101 FT26076123456789','17/03/2026 14:09:11','Số dư: 20,500,000 VND','',
  'Cảm ơn Quý khách đã sử dụng dịch vụ của ACB.','ƯU ĐÃI THÁNG 10: Hoàn tiền đến 500.000đ khi thanh toán bằng thẻ ACB Visa. Chi tiết tại acb.com.vn',
  'Hotline: 1900 5454 86 | Địa chỉ: 442 Nguyễn Thị Minh Khai, Quận 3, TP.HCM',footer].join('\n');
 assert.ok(body.length>3000);
 check(email('"ACB" <mailalert@acb.com.vn>','ACB - Thông báo giao dịch tài khoản',body),
  {direction:'in',amount:14000000,balance:20500000,account:'••5847',description:'NGUYEN VAN A CHUYEN TIEN PHONG 101 FT26076123456789',bank:'ACB',transactedAt:'2026-03-17T14:09:11+07:00'});
});

Deno.test('Email dạng bảng (Techcombank): Số tiền 1.234.567,00 không dấu, chiều lấy từ "Loại giao dịch: Ghi nợ"',()=>{
 const body=['Kính gửi Quý khách,','Techcombank trân trọng thông báo tài khoản của Quý khách đã thay đổi như sau:',
  'Số tài khoản: 1903xxxx5847','Loại giao dịch: Ghi nợ','Số tiền: 1.234.567,00 VND','Số dư khả dụng: 8.765.433,00 VND',
  'Thời gian: 09/10/2026 08:15:00','Nội dung: THANH TOAN TIEN DIEN THANG 9 MA KH PE0123456789','Trân trọng,','Techcombank',
  'Để được hỗ trợ, vui lòng liên hệ 1800 588 822.'].join('\n');
 check(email('Techcombank <alert@techcombank.com.vn>','Thông báo biến động số dư tài khoản',body),
  {direction:'out',amount:1234567,balance:8765433,account:'••5847',description:'THANH TOAN TIEN DIEN THANG 9 MA KH PE0123456789',bank:'Techcombank',transactedAt:'2026-10-09T08:15:00+07:00'});
});

Deno.test('Email bảng mỗi ô một dòng (nhãn không dấu hai chấm, giá trị ở dòng dưới)',()=>check(
 email('BIDV <thongbao@bidv.com.vn>','BIDV - Biến động số dư','Số tài khoản\n12010000xxx5847\nSố tiền\n+5.000.000 VND\nSố dư\n9.000.000 VND\nNội dung\nNGUYEN VAN F CHUYEN TIEN'),
 {direction:'in',amount:5000000,balance:9000000,account:'••5847',description:'NGUYEN VAN F CHUYEN TIEN',bank:'BIDV',transactedAt:null}));

Deno.test('Email biên lai: "Người nhận/Tài khoản nhận" không đảo chiều Ghi nợ, không lấy TK bên nhận; ngày ISO',()=>{
 const lines=['Tài khoản nguồn: 0011xxxx5847','Loại giao dịch: Ghi nợ','Người nhận: NGUYEN VAN B','Tài khoản nhận: 9999xxxx1234',
  'Số tiền: 500,000 VND','Nội dung: NGUYEN VAN A tra tien dien','Thời gian: 2026-10-09 21:30:15'];
 const from='Vietcombank <VCBDigibank@info.vietcombank.com.vn>';
 const want={direction:'out' as const,amount:500000,account:'••5847',description:'NGUYEN VAN A tra tien dien',bank:'Vietcombank',transactedAt:'2026-10-09T21:30:15+07:00'};
 check(email(from,'Biên lai chuyển tiền',lines.join('\n')),want);
 check(email(from,'Biên lai chuyển tiền',lines.slice(1).join('\n')),{...want,account:null});
});

// --- Chuẩn hoá ---
Deno.test('NFD + khoảng trắng/xuống dòng thừa cho cùng kết quả NFC',()=>{
 const body='Tài khoản   1903xxxx5847\n  Số tiền:   +3.000.000 VNĐ  \n\nSố dư:  5.000.000 VNĐ\nNội dung:   Nguyễn Văn A   chuyển   tiền phòng 101 ';
 const want={direction:'in' as const,amount:3000000,balance:5000000,account:'••5847',description:'Nguyễn Văn A chuyển tiền phòng 101',bank:'Techcombank',transactedAt:null};
 check(notif('vn.com.techcombank.bb.app','Techcombank','Biến động số dư',body),want);
 const decomposed=summarizeBankPayload(notif('vn.com.techcombank.bb.app','Techcombank','Biến động số dư'.normalize('NFD'),body.normalize('NFD')));
 assert.deepEqual(decomposed,expected(want));
 assert.equal(decomposed?.description,decomposed?.description?.normalize('NFC'));
});

Deno.test('nội dung tối đa 300 ký tự, không lấy nguyên body',()=>{
 const out=summarizeBankPayload(sms('MBBANK','TK 0xxx5847|GD: +100,000VND|SD: 200,000VND|ND: '+'NGUYEN VAN A CHUYEN TIEN PHONG 101 '.repeat(20)));
 assert.equal(out?.amount,100000);
 const length=Array.from(out?.description??'').length;
 assert.ok(length<=300&&length>=290,String(length)); // cắt ở 300 rồi bỏ khoảng trắng cuối
 assert.ok(out?.description?.startsWith('NGUYEN VAN A CHUYEN TIEN PHONG 101'));
});

Deno.test('giao dịch thật nhưng ND có câu OTP: mô tả cắt trước câu OTP, không chứa mã',()=>{
 const out=summarizeBankPayload(sms('MBBANK','TK 0xxx5847|GD: -150,000VND 09/10/26 12:00|SD: 850,000VND|ND: THANH TOAN DON HANG 8899. Ma OTP 112233 khong chia se'));
 assert.equal(out?.amount,150000);assert.equal(out?.direction,'out');
 assert.equal(out?.description,'THANH TOAN DON HANG 8899');
 assert.ok(!out?.description?.includes('112233'));assert.ok(!/otp/i.test(out?.description??''));
});

Deno.test('nhận ngân hàng theo sender / package / appName / tên miền email / đầu body',()=>{
 const tx='TK 1903xxxx5847 +100,000 VND';
 const cases:[Record<string,unknown>,string|null][]=[
  [sms('VCB',tx),'Vietcombank'],[sms('MBBANK',tx),'MB'],[sms('8149','Agribank: '+tx),'Agribank'],[sms('Unknown',tx),null],
  [notif('com.vietinbank.ipay','iPay','Biến động số dư',tx),'VietinBank'],[notif('com.tpb.mb.gprsandroid','TPBank Mobile','',tx),'TPBank'],
  [notif('com.vnpay.Agribank3g','Agribank E-Mobile Banking','',tx),'Agribank'],[notif('com.sacombank.ewallet','Sacombank Pay','',tx),'Sacombank'],
  [notif('com.example.x','Cake by VPBank','',tx),'Cake'],[notif('com.example.x','LPBank','',tx),'LPBank'],
  [email('VIB <noreply@mail.vib.com.vn>','Thông báo giao dịch',tx),'VIB'],[email('alert@sacombank.com','GD',tx),'Sacombank'],
  [email('x@hdbank.com.vn','',tx),'HDBank'],[email('x@tpb.vn','',tx),'TPBank'],[email('x@vpbank.com.vn','',tx),'VPBank'],
  [email('x@timo.vn','',tx),'Timo'],[email('"Ngan hang" <x@unknown.example>','Shinhan Bank - Thông báo',tx),'Shinhan'],
 ];
 for(const [payload,bank] of cases)assert.equal(summarizeBankPayload(payload)?.bank,bank,JSON.stringify(payload));
});

// --- Không phải biến động → null ---
Deno.test('OTP thuần → null',()=>assert.equal(summarizeBankPayload(
 sms('Vietcombank','Ma OTP cua Quy khach la 123456, hieu luc trong 3 phut. Tuyet doi KHONG cung cap OTP cho bat ky ai.')),null));

Deno.test('mã xác thực kèm số tiền chưa giao dịch (không dấu, không số dư) → null',()=>assert.equal(summarizeBankPayload(
 sms('TPBank','Ma xac thuc giao dich cua Quy khach la 654321 de thanh toan so tien 1,500,000 VND tai CUA HANG ABC. Tuyet doi khong chia se ma nay.')),null));

Deno.test('email quảng cáo → null (kể cả số tiền có dấu +)',()=>{
 assert.equal(summarizeBankPayload(email('ACB <news@acb.com.vn>','Ưu đãi tháng 10: hoàn tiền đến 500.000đ',
  'Mở thẻ ACB Visa ngay hôm nay để nhận ưu đãi hoàn tiền đến 500.000đ và miễn phí thường niên năm đầu. Chi tiết tại acb.com.vn. Hotline 1900 5454 86.')),null);
 assert.equal(summarizeBankPayload(sms('VPBank','VPBank uu dai: nhan ngay +50.000d khi gioi thieu ban be mo tai khoan VPBank NEO. Chi tiet: vpbank.com.vn')),null);
});

Deno.test('tin ngoại tệ (USD) → null toàn bộ (chỉ nhận VND)',()=>assert.equal(summarizeBankPayload(
 sms('Vietcombank','SD TK 1234xxxx5847 -25.00 USD luc 09-10-2026 10:20:30. SD 1,000.00 USD. Ref POS CUA HANG ABC SINGAPORE')),null));

Deno.test('tin thử → null; gateway.test luôn null dù body có số tiền',()=>{
 assert.equal(summarizeBankPayload(sms('iHome','Tin nhắn thử từ iHome Gateway lúc 10:20 09/10/2026')),null);
 assert.equal(summarizeBankPayload({event:'gateway.test',sender:'VCB',body:'TK xxxx5847 +500,000VND'}),null);
 assert.equal(summarizeBankPayload({event:'gateway.heartbeat',smsEnabled:true}),null);
});

Deno.test('payload rỗng / thiếu khoá / sai kiểu → null, không ném lỗi',()=>{
 const bad:unknown[]=[{},{event:'sms.received'},{event:'sms.received',sender:123,body:['TK xxxx5847 +500,000VND']},
  {event:'notification.received',packageName:null,title:null,body:{x:1}},{event:42,body:'TK xxxx5847 +500,000VND'},
  {event:'email.received',from:7,subject:false,body:12345},null,'sms.received',[]];
 for(const p of bad)assert.equal(summarizeBankPayload(p as Record<string,unknown>),null,JSON.stringify(p));
});
