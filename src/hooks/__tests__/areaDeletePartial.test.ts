// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: io.from } }));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { AreaDeletePartialError, useDeleteArea } from '../useAreas';
it('giữ ID khu khi đã xóa mềm nhưng gỡ membership thất bại', async () => {
 localStorage.clear();
 const chain=(data:unknown,error:unknown=null)=>{const q:Record<string,unknown>={then:(r:(v:unknown)=>void)=>r({data,error})};for(const m of ['update','eq','select','single','delete'])q[m]=vi.fn(()=>q);return q;};
 const area=chain({id:'area-1'});const before=chain([{area_id:'area-1',building_id:'b1'}]);const member=chain(null,new Error('offline'));
 io.from.mockReturnValueOnce(before).mockReturnValueOnce(area).mockReturnValue(member);
 const hook = useDeleteArea() as unknown as { mutationFn: (id: string) => Promise<void> };
 const failure = await hook.mutationFn('area-1').catch(error => error);
 expect(failure).toBeInstanceOf(AreaDeletePartialError);expect(failure).toMatchObject({areaId:'area-1',completed:expect.arrayContaining([{id:'area-1',label:'Khu vực đã xoá mềm'}])});
 await expect((useDeleteArea() as unknown as typeof hook).mutationFn('area-1')).rejects.toThrow();expect(area.update).toHaveBeenCalledTimes(1);
});
