import { afterEach, beforeEach, expect, it, vi } from 'vitest';

interface QueryToastOptions {
 description: string;
 action?: {label: string; onClick: () => void};
}
const io=vi.hoisted(()=>({
 loadCount:0, failImport:false, importError:new Error('Failed to fetch query labels'),
 toastError:vi.fn<(title:string,options:QueryToastOptions)=>void>(),
 report:vi.fn<(error:Error)=>void>(),
}));
vi.mock('sonner',()=>({toast:{error:io.toastError}}));
vi.mock('@/components/errors/boundaryReporter',()=>({reportBoundaryError:io.report}));
beforeEach(()=>{
 vi.resetModules();io.loadCount=0;io.failImport=false;io.toastError.mockReset();io.report.mockReset();
 vi.doMock('@/lib/queryFeedback',async()=>{
  io.loadCount++;
  if(io.failImport)throw io.importError;
  return vi.importActual<typeof import('@/lib/queryFeedback')>('@/lib/queryFeedback');
 });
});
afterEach(async()=>{await vi.dynamicImportSettled();vi.doUnmock('@/lib/queryFeedback');});

it('does not load query labels when the provider initializes',async()=>{
 await import('../QueryProvider');await vi.dynamicImportSettled();
 expect(io.loadCount).toBe(0);expect(io.toastError).not.toHaveBeenCalled();
});
it.each([{silent:true},{errorDisplay:'inline'},{feedback:'inline'}])('does not load labels or toast for a silent/inline query: %j',async meta=>{
 const {xuLyLoiQuery}=await import('../QueryProvider');
 xuLyLoiQuery(new Error('read failed'),{queryKey:['rooms','private-org-uuid'],meta},{bo:new Map()});
 await vi.dynamicImportSettled();expect(io.loadCount).toBe(0);expect(io.toastError).not.toHaveBeenCalled();expect(io.report).toHaveBeenCalledOnce();
});
it('deduplicates before loading labels and emits one named toast without exposing the query key or UUID',async()=>{
 const {xuLyLoiQuery}=await import('../QueryProvider');const bo=new Map<string,number>();
 for(let i=0;i<5;i++)xuLyLoiQuery({code:'42501',message:'raw SQL RLS'},{queryKey:['rooms','private-org-uuid']},{bo,now:()=>1000});
 expect(io.toastError).not.toHaveBeenCalled();await vi.dynamicImportSettled();
 await vi.waitFor(()=>expect(io.toastError).toHaveBeenCalledOnce());expect(io.loadCount).toBe(1);expect(io.report).toHaveBeenCalledTimes(5);
 expect(io.toastError).toHaveBeenCalledWith('Chưa tải được danh sách phòng.',expect.objectContaining({description:expect.stringMatching(/quyền/i)}));
 const call=io.toastError.mock.calls[0];if(!call)throw new Error('Expected query toast');expect(JSON.stringify(call)).not.toMatch(/rooms|private-org-uuid|raw SQL/);
});
it('failed label chunk still emits one safe fallback with the original permission feedback and a working retry',async()=>{
 const {xuLyLoiQuery}=await import('../QueryProvider');io.failImport=true;const fetch=vi.fn<()=>Promise<unknown>>().mockResolvedValue([]);
 const bo=new Map<string,number>();for(let i=0;i<3;i++)xuLyLoiQuery({code:'42501',message:'raw SQL RLS'},{queryKey:['rooms','private-org-uuid'],fetch},{bo,now:()=>1000});
 await vi.dynamicImportSettled();await vi.waitFor(()=>expect(io.toastError).toHaveBeenCalledOnce());expect(io.loadCount).toBe(1);
 expect(io.toastError).toHaveBeenCalledWith('Chưa tải được dữ liệu của mục đang mở.',expect.objectContaining({description:expect.stringMatching(/quyền/i),action:expect.objectContaining({label:'Tải lại'})}));
 expect(io.report).toHaveBeenCalledTimes(4);expect(io.report).toHaveBeenLastCalledWith(expect.objectContaining({cause:io.importError}));
 const call=io.toastError.mock.calls[0];if(!call?.[1].action)throw new Error('Expected retry action');expect(JSON.stringify(call)).not.toMatch(/rooms|private-org-uuid|raw SQL|Failed to fetch query labels/);
 call[1].action.onClick();await Promise.resolve();expect(fetch).toHaveBeenCalledOnce();
});
it('a broken toast sink cannot reject the asynchronous query error handler',async()=>{
 const {xuLyLoiQuery}=await import('../QueryProvider');io.toastError.mockImplementation(()=>{throw new Error('toast sink failed');});
 expect(()=>xuLyLoiQuery(new Error('read failed'),{queryKey:['rooms']},{bo:new Map()})).not.toThrow();
 await vi.dynamicImportSettled();await vi.waitFor(()=>expect(io.toastError).toHaveBeenCalledOnce());
});
