// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
import {renderHook,act} from '@testing-library/react';
const m=vi.hoisted(()=>({rpc:vi.fn(),error:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('sonner',()=>({toast:{error:m.error}}));
vi.mock('@/components/errors/boundaryReporter',()=>({reportBoundaryError:vi.fn()}));
import {QueryProvider,queryClient} from '@/app/providers/QueryProvider';
import {useSubmitInspectionPhoto} from '../useMyDay';
beforeEach(()=>{queryClient.clear();vi.clearAllMocks();m.rpc.mockResolvedValue({data:null,error:{code:'42501',message:'private SQL detail'}});});
it('real MutationCache leaves inspection errors to the form and never emits a duplicate toast',async()=>{
 const {result}=renderHook(()=>useSubmitInspectionPhoto(),{wrapper:QueryProvider});
 await act(async()=>{try{await result.current.mutateAsync({sessionId:'s',slot:'gps',storagePath:'file',sha256:'hash',lat:null,lng:null});}catch{expect(m.error).not.toHaveBeenCalled();m.error('Chưa lưu được ảnh kiểm tra.');}});
 expect(m.error).toHaveBeenCalledTimes(1);expect(m.error).toHaveBeenCalledWith('Chưa lưu được ảnh kiểm tra.');
});
