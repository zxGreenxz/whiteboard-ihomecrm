import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

const stop = z.object({
  building:z.string().uuid().nullable(), label:z.string(), full:z.boolean(), daysLeft:z.number().nullable(),
  urgent:z.boolean(), active:z.boolean(), tasks:z.array(z.string()), start:z.number(), end:z.number(),
  late:z.boolean(), approximate:z.boolean(),
});
const plan = z.object({
  ready:z.boolean(), updating:z.boolean(), date:z.string(), revision:z.number().nullable(), updated:z.string().nullable(), reason:z.string().nullable(),
  state:z.string().nullable(), model:z.string().nullable(), off:z.boolean(), stops:z.array(stop),
  buildings:z.array(z.object({id:z.string().uuid(),name:z.string()})),
});
export function useHermesShiftPlan(staff:string|undefined){
  const { selectedOrganizationId:org }=useOrganization();
  const { data:user }=useAuth();
  return useQuery({
    queryKey:["hermes-shift-test",org,user?.id,staff],
    enabled:Boolean(org && staff && user?.id),refetchInterval:4000,refetchOnWindowFocus:true,
    queryFn:async()=>{
      // TEST-only schema has a separate lifecycle from the generated production client.
      const db=supabase as unknown as {rpc(name:"hermes_shift_read_test_v1",args:{p_org:string;p_staff:string}):Promise<{data:unknown;error:unknown}>};
      if(!org||!staff)throw new Error("Chưa chọn quản lý hoặc công ty.");
      const {data,error}=await db.rpc("hermes_shift_read_test_v1",{p_org:org,p_staff:staff});
      if(error)throw error;
      return plan.nullable().parse(data);
    },
  });
}
