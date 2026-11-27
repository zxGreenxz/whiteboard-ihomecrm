// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: io.from } }));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { AreaDeletePartialError, useDeleteArea } from '../useAreas';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';
// Đợt 8 (luật 5): xoá khu lặp lại được — đã xoá mềm mà gỡ khỏi tòa hỏng thì giữ mã khu, không khoá; bấm «Xoá lại» khớp 0
// dòng ở bước xoá mềm (không đổi giờ xoá), đọc lại thấy khu đã xoá rồi gỡ nốt các tòa.
it('giữ ID khu khi đã xóa mềm nhưng gỡ membership thất bại; bấm lại gỡ nốt, không xoá mềm lần hai', async () => {
 localStorage.clear();
 const chain=(data:unknown,error:unknown=null)=>{const q:Record<string,unknown>={then:(r:(v:unknown)=>void)=>r({data,error})};for(const m of ['update','eq','is','in','select','single','maybeSingle','delete'])q[m]=vi.fn(()=>q);return q;};
 const area=chain([{id:'area-1'}]);const before=chain([{area_id:'area-1',building_id:'b1'}]);const member=chain(null,new Error('offline'));
 io.from.mockReturnValueOnce(before).mockReturnValueOnce(area).mockReturnValueOnce(member);
 const hook = useDeleteArea() as unknown as { mutationFn: (id: string) => Promise<{ alreadyDeleted: boolean }> };
 const failure = await hook.mutationFn('area-1').catch(error => error);
 expect(failure).toBeInstanceOf(AreaDeletePartialError);expect(failure).toMatchObject({areaId:'area-1',softDeleted:true,completed:expect.arrayContaining([{id:'area-1',label:'Khu vực đã xoá mềm'}])});
 expect(recordWriteBlocked(failure)).toBe(false);
 expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);
 const beforeAgain=chain([{area_id:'area-1',building_id:'b1'}]);const areaAgain=chain([]);const settled=chain({id:'area-1',deleted_at:'2026-11-26T00:00:00.000Z'});const memberAgain=chain([{area_id:'area-1',building_id:'b1'}]);
 io.from.mockReturnValueOnce(beforeAgain).mockReturnValueOnce(areaAgain).mockReturnValueOnce(settled).mockReturnValueOnce(memberAgain);
 await expect((useDeleteArea() as unknown as typeof hook).mutationFn('area-1')).resolves.toEqual({alreadyDeleted:true});
 expect(areaAgain.is).toHaveBeenCalledWith('deleted_at',null);expect(memberAgain.delete).toHaveBeenCalledOnce();
});
