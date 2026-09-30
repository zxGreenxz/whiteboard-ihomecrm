import {it,expect,vi} from 'vitest';
import {salaryJobFeedback,readSalaryWriteReceipt,loadHolidayPreset} from '../salarySettingsFeedback';
it('tác vụ bỏ qua hoặc lỗi một phần không báo đã chạy tất cả',()=>{
 expect(salaryJobFeedback({ok:true,ran:[{job:'tier',skipped:true}]}).kind).toBe('info');
 expect(salaryJobFeedback({ok:true,ran:[{job:'digest',pushes:3,sent:1},{job:'push_drain',ok:false,error:'private'}]}).kind).toBe('warning');
 expect(salaryJobFeedback({ok:true,ran:[{job:'digest',pushes:3,sent:1}]}).message).not.toContain('đã nhận');
 expect(()=>salaryJobFeedback({ok:true})).toThrow();
});
it('khoản lương cần biên nhận thật',()=>{
 expect(()=>readSalaryWriteReceipt(null,'item_id')).toThrow();
 expect(readSalaryWriteReceipt({item_id:'i1',lap_lai:true},'item_id')).toEqual({id:'i1',replayed:true});
});
it('lễ nạp một phần giữ các ngày đã lưu và báo đúng số, không tự gửi lại',async()=>{
 const add=vi.fn().mockResolvedValueOnce({id:'h1'}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
 const result=await loadHolidayPreset([{d:'2026-01-01',n:'A'},{d:'2026-02-01',n:'B'}],[],add);
 expect(result.completed.map(x=>x.date)).toEqual(['2026-01-01']);expect(result.failed).toHaveLength(1);expect(result.unknown).toBe(true);expect(add).toHaveBeenCalledTimes(2);
});

it('tác vụ thiếu số xác nhận không thành success và số 0 là không có thay đổi',()=>{expect(()=>salaryJobFeedback({ok:true,ran:[{job:'tier',result:{}}]})).toThrow();expect(salaryJobFeedback({ok:true,ran:[{job:'tier',result:{expired_sessions:0}}]}).kind).toBe('info');expect(()=>salaryJobFeedback({ok:true,ran:[{job:'push_drain',batches:-1,settled:-1,outcomes:{}}]})).toThrow();expect(salaryJobFeedback({ok:true,ran:[{job:'push_drain',batches:2,settled:1,outcomes:{SENT:2}}]}).kind).toBe('warning');});
