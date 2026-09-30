import {useEffect,useState} from 'react';
import {getSessionUser} from '@/lib/authSession';
import {financialPending} from '@/lib/financialPending';
import {supabase} from '@/integrations/supabase/client';
/** Read-only notice; it never releases the pending guard. */
export function useBuildingSavePending(key:string,organizationId:string|null,open:boolean,namespace='building-form-save'){
 const [notice,setNotice]=useState<{ids:readonly string[];buildingId?:string}|null>(null);
 useEffect(()=>{let active=true;if(!open||!organizationId)return;
  void (async()=>{
   const user=await getSessionUser();if(!user)return;
   const pending=financialPending.read({namespace,userId:user.id,organizationId,businessKey:key});
   if(!pending){if(active)setNotice(null);return;}
   if(active)setNotice({ids:pending.completedIds});
   if(!pending.completedIds.length)return;
   const {data,error}=await supabase.from('buildings').select('id,organization_id').in('id',[...pending.completedIds]).eq('organization_id',organizationId).is('deleted_at',null);
   if(error||!Array.isArray(data))return;
   const matches=data.filter(row=>pending.completedIds.includes(row.id)&&row.organization_id===organizationId);
   if(active&&matches.length===1)setNotice({ids:pending.completedIds,buildingId:matches[0]!.id});
  })().catch(()=>{ /* The submitting guard still blocks writes when storage or identity cannot be verified. */ });
  return()=>{active=false;};
 },[key,organizationId,open,namespace]);
 return notice;
}