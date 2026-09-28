import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';

const pageSchema=z.object({items:z.array(z.object({id:z.string().uuid(),contract_id:z.string().uuid(),
  contract_number:z.string().nullable(),building_name:z.string(),room_name:z.string(),effective_on:z.string(),
  state:z.enum(['MISSING','REVIEW'])})),total:z.number().int().nonnegative(),limit:z.number().int(),offset:z.number().int()});
export function useContractMeterFollowups(buildingIds:string[],page:number){
  const {selectedOrganizationId}=useOrganization();
  return useQuery({queryKey:['contract-meter-followups',selectedOrganizationId,[...buildingIds].sort(),page],
    enabled:!!selectedOrganizationId,refetchInterval:60_000,retry:false,
    queryFn:async()=>{
      if(!selectedOrganizationId)throw new Error('Chưa chọn tổ chức');
      const {data,error}=await supabase.rpc('list_contract_meter_followups_v1',{
        p_organization_id:selectedOrganizationId,p_building_ids:buildingIds,p_limit:10,p_offset:page*10});
      if(error)throw error;return pageSchema.parse(data);
    }});
}
