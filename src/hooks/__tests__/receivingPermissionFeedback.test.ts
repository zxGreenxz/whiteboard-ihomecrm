import {expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({retry:vi.fn(),error:{message:'Failed to fetch'}}));
vi.mock('@/hooks/useIsCompanyOwner',()=>({useIsCompanyOwner:()=>({data:undefined,isLoading:false,isError:true,error:h.error,refetch:h.retry})}));
vi.mock('@/hooks/useIsAdmin',()=>({useIsSuperAdmin:()=>({data:false,isLoading:false,isError:false,error:null,refetch:h.retry})}));
import {useCanManageReceivingCashbooks} from '../useCanManageReceivingCashbooks';
it('distinguishes an unread permission from a confirmed denial',async()=>{
 const result=useCanManageReceivingCashbooks();
 expect(result.allowed).toBe(false);
 expect(result.error).toBe(h.error);
 await result.refetch(); expect(h.retry).toHaveBeenCalledTimes(2);
});
