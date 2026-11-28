import { describe, expect, it } from 'vitest';
import { describeExpensePolicy } from '../buildingExpensePolicy';
import type { SpendSwitchRow } from '@/hooks/useSpendEngine';

const sw: SpendSwitchRow = {switch_id:'s', building_id:null, building_name:null, fee_category:'internet',
  period_from:'2026-10-01',period_to:'2026-12-01',note:null,enabled_at:'2026-10-01'};
const input = {buildingId:'a',month:'2026-11',fee:'internet' as const,mode:'CAM_KET',route:'CANONICAL',
  price:500000,disabled:false,switches:[sw]};
describe('quy tắc hiển thị cho phiếu một khoản trong một tháng', () => {
  it.each(['2026-10','2026-11','2026-12'])('phạm vi mọi tòa bao gồm cả hai tháng biên %s',month=>{
    expect(describeExpensePolicy({...input,month})).toMatchObject({label:'Duyệt trong hạn mức tháng',note:expect.stringContaining('Chưa ký')});
  });
  it.each(['2026-09','2027-01'])('ngoài kỳ %s dùng giá có hiệu lực',month=>{
    expect(describeExpensePolicy({...input,month})).toMatchObject({label:'Duyệt đúng giá',amount:500000});
  });
  it('bỏ phạm vi của tòa khác, vẫn nhận phạm vi còn hiệu lực chồng lên',()=>{
    const other={...sw,building_id:'b'};
    expect(describeExpensePolicy({...input,switches:[other]}).label).toBe('Duyệt đúng giá');
    expect(describeExpensePolicy({...input,switches:[other,{...sw,period_to:null}],month:'2027-01'}).label).toBe('Duyệt trong hạn mức tháng');
  });
  it.each(['LEGACY','SHADOW','FROZEN'])('công tắc đã lưu nhưng route %s không áp quy tắc',route=>{
    expect(describeExpensePolicy({...input,route,price:null}).label).toBe('Tự duyệt khi chưa công bố giá');
  });
  it('kiểu từng phiếu tự nó không thay luật giá của cửa đóng phí',()=>{
    expect(describeExpensePolicy({...input,mode:'TUNG_PHIEU'}).label).toBe('Duyệt đúng giá');
  });
  it('trần điện nước dùng đúng hạng mục và giữ quy trình ngưỡng khi chưa bật',()=>{
    const en={...input,fee:'dien' as const,mode:'TRAN',switches:[{...sw,fee_category:'dien' as const}]};
    expect(describeExpensePolicy(en).label).toBe('Duyệt theo trần điện nước');
    expect(describeExpensePolicy({...en, disabled:true}).label).toBe('Duyệt theo trần điện nước');
    expect(describeExpensePolicy({...en,switches:[]}).label).toBe('Theo ngưỡng và trần điện nước');
  });
  it('hạng mục tắt và trạng thái bộ máy lạ có nhãn riêng',()=>{
    expect(describeExpensePolicy({...input,disabled:true}).label).toBe('Ẩn trên lưới đóng phí');
    expect(describeExpensePolicy({...input,route:'UNKNOWN'}).label).toBe('Chưa xác định cách duyệt');
  });
});
