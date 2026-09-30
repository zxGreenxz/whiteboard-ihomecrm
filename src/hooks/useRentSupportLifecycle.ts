import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {applyRentSupportReconciliation,previewRentSupportReconciliation,readRentSupportLifecycle,readRentSupportReconciliationContext,requestRentSupportLifecycle} from '@/lib/rentSupportLifecycle';
export const RENT_SUPPORT_LIFECYCLE_KEY='rent-support-lifecycle';
export function useRentSupportLifecycle(organizationId:string,contractId:string,enabled=true) {
 return useQuery({queryKey:[RENT_SUPPORT_LIFECYCLE_KEY,organizationId,contractId],enabled:enabled&&!!organizationId&&!!contractId,queryFn:()=>readRentSupportLifecycle(organizationId,contractId)});
}
export function useRentSupportReconciliationContext(organizationId:string,contractId:string,voucherId:string,enabled:boolean) {
 return useQuery({queryKey:[RENT_SUPPORT_LIFECYCLE_KEY,'reconciliation-context',organizationId,contractId,voucherId],enabled,queryFn:()=>readRentSupportReconciliationContext(organizationId,contractId,voucherId)});
}
export function useRentSupportLifecycleActions(organizationId:string) {
 const cache=useQueryClient();
 const invalidate=()=>Promise.all(['contract-rent-support',RENT_SUPPORT_LIFECYCLE_KEY,'income-expenses','invoices','contract-payout-operation'].map(key=>cache.invalidateQueries({queryKey:[key]})));
 return {
 request:useMutation({mutationFn:(i:Parameters<typeof requestRentSupportLifecycle>[1])=>requestRentSupportLifecycle(organizationId,i),onSuccess:invalidate}),
 preview:useMutation({mutationFn:(i:Parameters<typeof previewRentSupportReconciliation>[1])=>previewRentSupportReconciliation(organizationId,i)}),
 apply:useMutation({mutationFn:(i:Parameters<typeof applyRentSupportReconciliation>[1])=>applyRentSupportReconciliation(organizationId,i),onSuccess:invalidate}),
 };
}
