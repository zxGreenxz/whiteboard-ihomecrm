import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));vi.mock('@tanstack/react-query',()=>({useMutation:(v:unknown)=>v,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
import {useCreateMaterial,useUpdateMaterial} from '../useMaterials';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
beforeEach(()=>vi.resetAllMocks());
it.each([[useCreateMaterial,{name:'Đèn',unit:'cái'},null],[useUpdateMaterial,{id:'m1',updates:{name:'Đèn'}},{id:'wrong'}]])('material create/update require matching positive ID before success',async(hook,input,data)=>{const q:Record<string,unknown>={};for(const m of ['insert','update','eq','select'])q[m]=()=>q;q.single=async()=>({data,error:null});io.from.mockReturnValue(q);await expect((hook() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>}).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);});
