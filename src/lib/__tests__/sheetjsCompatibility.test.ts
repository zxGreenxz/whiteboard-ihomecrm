// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import * as XLSX from 'xlsx';
import {parseExcelFile,parseMeterReadingExcel} from '@/lib/excelHelpers';
import {parseCustomerExcel} from '@/lib/customerExcelHelpers';
import {parseContractExcel} from '@/lib/contractExcelHelpers';

vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{throw Error('Excel parsing must not query Supabase');}}}));
function fixture(name:string,format:'xlsx'|'xls'){
 const bytes=readFileSync(resolve('src/lib/__tests__/fixtures/sheetjs-0.18.5',`${name}.${format}`));
 return new File([new Uint8Array(bytes)],`${name}.${format}`);
}

describe('SheetJS security update and legacy customer files',()=>{
 it('uses a release beyond both Prototype Pollution and ReDoS affected ranges',()=>{
  const [major,minor,patch]=XLSX.version.split('.').map(Number);
  expect([major,minor,patch].every(Number.isInteger)).toBe(true);
  expect(major>0 || (major===0 && (minor>20 || (minor===20 && patch>=2)))).toBe(true);
 });
 for(const format of ['xlsx','xls'] as const){
  it(`preserves VND amounts, discount sign, Unicode and phone text from legacy ${format}`,async()=>{
   const rows=await parseExcelFile(fixture('finance',format),{'Khách hàng':'name','SĐT':'phone','Tiền phòng':'rent','Giảm trừ':'discount','Kỳ hóa đơn':'period'});
   expect(rows).toEqual([{name:'Khách kiểm thử',phone:'0000000000',rent:4400000,discount:-300000,period:'10/2026'}]);
  });
  it(`parses resident headers and retains validation row numbers from legacy ${format}`,async()=>{
   const result=await parseCustomerExcel(fixture('customers',format));
   expect(result.validRows).toHaveLength(1);
   expect(result.validRows[0]).toMatchObject({full_name:'Khách kiểm thử',phone:'0000000000',date_of_birth:'1995-09-20',id_number:'001234567890',gender:'FEMALE'});
   expect(result.errors).toEqual([{row:3,message:'Họ tên không được để trống'}]);
   expect(result.warnings).toEqual([]);
  });
  it(`recognizes the resident template header on row 4 of legacy ${format}`,async()=>{
   const result=await parseCustomerExcel(fixture('customerTemplate',format));
   expect(result.errors).toEqual([]);expect(result.validRows).toHaveLength(1);
   expect(result.validRows[0]).toMatchObject({full_name:'Khách kiểm thử',phone:'0000000000',id_number:'001234567890'});
  });
  it(`keeps contract dates, cycle, rent and deposit from legacy ${format}`,async()=>{
   const result=await parseContractExcel(fixture('contracts',format),'synthetic-building');
   expect(result.errors).toEqual([]);
   expect(result.success).toEqual([{source_row:2,room_name:'303',customer_name:'Khách kiểm thử',customer_phone:'0000000000',customer_id_number:'001234567890',signed_date:'2026-09-20',start_date:'2026-09-20',end_date:'2027-09-19',rent_price:4400000,payment_cycle:'MONTHLY',deposit:4400000,notes:'Hỗ trợ khách theo lịch'}]);
  });
  it(`keeps numeric meter readings and Vietnamese notes from legacy ${format}`,async()=>{
   expect(await parseMeterReadingExcel(fixture('meters',format))).toEqual([{meter_code:'ĐIỆN-303',reading_date:'30/09/2026',current_reading:6937,notes:'Chốt tháng 9'}]);
  });
 }
 it('rejects a truncated ZIP rather than treating it as imported data',async()=>{
  const file=new File([new Uint8Array([0x50,0x4b,0x03,0x04,0,0])],'broken.xlsx');
  await expect(parseExcelFile(file,{'Tiền phòng':'rent'})).rejects.toThrow('Không thể đọc file Excel');
 });
 it('writes real workbook bytes and reads back VND values, formula and formatted dates',()=>{
  const ws=XLSX.utils.aoa_to_sheet([['Tiền phòng','Giảm trừ','Còn phải thu'],[4400000,-300000,{t:'n',f:'A2+B2',v:4100000}],['30/09/2026','001234567890','Khách kiểm thử']]);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Hoa hồng');
  const bytes=XLSX.write(wb,{bookType:'xlsx',type:'array'});
  const saved=XLSX.read(bytes,{type:'array',cellFormula:true});
  const sheet=saved.Sheets['Hoa hồng'];
  expect(XLSX.utils.sheet_to_json(sheet,{header:1})).toEqual([['Tiền phòng','Giảm trừ','Còn phải thu'],[4400000,-300000,4100000],['30/09/2026','001234567890','Khách kiểm thử']]);
  expect(sheet.C2.f).toBe('A2+B2');
 });
});
