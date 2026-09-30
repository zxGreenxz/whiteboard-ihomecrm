import {describe,expect,it} from 'vitest';
import {feeFailureMessage,parseGeneratedFeeReceipt} from '../feeFeedback';
describe('fee receipts',()=>{
 it.each([null,{}, {period:'2026-09',created:2,posted:2,totalAmount:300,voucherIds:['one']}])('rejects incomplete receipts rather than claiming zero or complete success',data=>expect(()=>parseGeneratedFeeReceipt(data)).toThrow(TypeError));
 it('preserves an actual no-op and each completed voucher ID',()=>{
  expect(parseGeneratedFeeReceipt({period:'2026-09',created:0,posted:0,totalAmount:0,voucherIds:[]})).toMatchObject({created:0});
  expect(parseGeneratedFeeReceipt({period:'2026-09',created:2,posted:1,totalAmount:300,voucherIds:['one','two']})).toMatchObject({created:2,posted:1,voucherIds:['one','two']});
 });
 it('keeps a verified book reason and never asks to repeat an unknown write',()=>{
  expect(feeFailureMessage({code:'42501',message:'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này'},'tạo phiếu')).toBe('Chọn sổ quỹ bạn có quyền ghi chi.');
  expect(feeFailureMessage(new TypeError('Failed to fetch'),'tạo phiếu')).toContain('kiểm tra trạng thái');
 });
});
