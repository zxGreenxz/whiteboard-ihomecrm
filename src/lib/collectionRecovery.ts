import {supabase} from '@/integrations/supabase/client';
import type {PendingCollection,CollectionScope} from './pendingCollection';
export async function collectionScopeForInvoice(userId:string,invoiceId:string):Promise<CollectionScope>{
  const {data,error}=await supabase.from('invoices').select('organization_id').eq('id',invoiceId).single();
  if(error)throw error;
  if(!data?.organization_id)throw new Error('Chưa xác định được tổ chức của hoá đơn. Tải lại hoá đơn trước khi thu tiền.');
  return {userId,invoiceId,organizationId:data.organization_id};
}
/** RLS read of the same actor/org/invoice/idempotency identity that the V5 writer commits. */
export async function lookupPendingCollection(pending:PendingCollection):Promise<unknown>{
  const {data,error}=await supabase.from('invoice_payment_collections').select('id,organization_id,invoice_id,actor_id,idempotency_key,status,applied_amount')
    .eq('organization_id',pending.organizationId).eq('invoice_id',pending.invoiceId).eq('actor_id',pending.userId).eq('idempotency_key',pending.idempotencyKey).maybeSingle();
  if(error)throw error;
  return data;
}
