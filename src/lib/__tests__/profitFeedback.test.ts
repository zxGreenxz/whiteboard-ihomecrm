import { describe,it,expect } from 'vitest';
import { validateProfitPerson, validateSalaryRules, validateShareRows, profitActionErrorMessage, readProfitActionResult } from '../profitFeedback';
describe('phản hồi lợi nhuận',()=>{
 it('không bỏ qua quy tắc hoặc tỷ lệ nhập dở',()=>{
  expect(validateProfitPerson('', '')).toHaveProperty('authUserId');
  expect(validateSalaryRules([{building_ids:[],form:'FIXED',amount:1,percent:0}])).toHaveProperty('rules.0.building_ids');
  expect(validateShareRows([{building_id:'',percent:10},{building_id:'b',percent:101}])).toEqual({'rows.0.building_id':expect.any(String),'rows.1.percent':expect.any(String)});
 });
 it('chỉ ánh xạ business đã xác minh, không lộ lỗi kỹ thuật',()=>{
  expect(profitActionErrorMessage({message:'PROFIT_SOURCE_CONFLICT current snapshots do not match expected hash'},'chốt lợi nhuận')).toContain('thay đổi');
  expect(profitActionErrorMessage({message:'relation private_table does not exist'},'chốt lợi nhuận')).not.toContain('private_table');
 });
 it('kết quả rỗng hoặc sai số lượng không thành công',()=>{
  expect(()=>readProfitActionResult(null,2)).toThrow();
  expect(()=>readProfitActionResult({affected_buildings:0,run_id:'r'},2)).toThrow();
  expect(readProfitActionResult({affected_buildings:2,run_id:'r',idempotent_replay:false},2)).toMatchObject({affected_buildings:2});
 });
});
