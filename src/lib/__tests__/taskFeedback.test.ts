import { describe, expect, it, vi } from 'vitest';
import { dayAttendanceView, saveJobAndMaterials } from '../taskFeedback';

describe('kết quả công việc/ngày công', () => {
  it('chờ duyệt không trở thành đã nghỉ, lỗi tải không trở thành chưa có công', () => {
    expect(dayAttendanceView('pending_leave', false)).toBe('pending');
    expect(dayAttendanceView('leave_approved', false)).toBe('approved');
    expect(dayAttendanceView(undefined, true)).toBe('unavailable');
    expect(dayAttendanceView('ticked', true)).toBe('unavailable');
  });
  it('giữ ID đã tạo khi vật tư lỗi và không tạo lại công việc', async () => {
    const create = vi.fn(async () => ({ id: 'job-1' }));
    const saveMaterials = vi.fn(async () => { throw new Error('line write failed'); });
    const result = await saveJobAndMaterials(create, saveMaterials);
    expect(result).toMatchObject({ status: 'partial', jobId: 'job-1' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(saveMaterials).toHaveBeenCalledWith('job-1');
  });
  it('không khẳng định chưa tạo khi máy chủ không trả lời', async () => {
    const result = await saveJobAndMaterials(async () => { throw new Error('timeout'); });
    expect(result).toMatchObject({ status: 'unknown', jobId: null });
  });
});
