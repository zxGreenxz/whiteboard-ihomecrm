// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rows:[] as unknown[][]}));
vi.mock('xlsx',()=>({read:()=>({SheetNames:['Data'],Sheets:{Data:{A1:{v:mocks.rows[0]?.[0]}}}}),utils:{sheet_to_json:()=>mocks.rows}}));
import {parseContractExcel} from '../contractExcelHelpers';
afterEach(()=>vi.unstubAllGlobals());
it.each([0,3])('preserves real Excel row numbers through blank and rejected rows with header %s',async header=>{
 const headers=['Phòng (*)','Tên KH (*)','SĐT (*)','Ngày ký (*)','Ngày BĐ (*)','Ngày KT (*)','Tiền thuê (*)','Chu kỳ TT (*) [1 tháng/3 tháng/6 tháng/12 tháng]','Tiền cọc (*)'];
 const good=['101','Khách A','0900000000','2026-09-01','2026-10-01','2027-10-01',5000000,'1 tháng',5000000];
 mocks.rows=[...(header?[['MẪU NHẬP HỢP ĐỒNG'],[],[]]:[]),headers,[],['','Khách thiếu phòng'],good];
 class Reader {onload:((event:unknown)=>void)|null=null;readAsArrayBuffer(){this.onload?.({target:{result:new ArrayBuffer(0)}})}}
 vi.stubGlobal('FileReader',Reader);
 const result=await parseContractExcel(new File(['data'],'contracts.xlsx'),'building-1');
 expect(result.errors[0].row).toBe(header+3);expect(result.success).toHaveLength(1);expect(result.success[0]).toHaveProperty('source_row',header+4);
});
