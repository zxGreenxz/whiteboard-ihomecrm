import {useQuery} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';
export interface CustomerContractLink {
 id:string;is_representative:boolean;notes:string|null;
 contract:{id:string;contract_number:string|null;status:string;start_date:string;end_date:string;rent_price:number;deleted_at:string|null;room:{id:string;name:string;building:{id:string;name:string}|null}|null}|null;
}
export function useCustomerDetailContracts(id:string){return useQuery({
 queryKey:['customer-contracts',id],enabled:!!id,meta:{feedback:'inline'},queryFn:async()=>{
 const {data,error}=await supabase.from('contract_customers').select(`id,is_representative,notes,
 contract:contracts!contract_customers_contract_id_fkey(id,contract_number,status,start_date,end_date,rent_price,deleted_at,
 room:rooms!contracts_room_id_fkey(id,name,building:buildings!rooms_building_id_fkey(id,name)))`).eq('customer_id',id).order('created_at',{ascending:false});
 if(error)throw error;
 if(!Array.isArray(data)||data.some(row=>!validLink(row)))throw new TypeError('Invalid customer contracts response');
 return (data as unknown as CustomerContractLink[]).filter(link=>link.contract&&!link.contract.deleted_at);
 }});}

function validLink(value:unknown):boolean{
 if(!value||typeof value!=='object')return false;const link=value as Record<string,unknown>;
 if(typeof link.id!=='string'||!link.id||typeof link.is_representative!=='boolean'||!(link.notes===null||typeof link.notes==='string'))return false;
 if(link.contract===null)return true;if(!link.contract||typeof link.contract!=='object')return false;
 const contract=link.contract as Record<string,unknown>;
 if(typeof contract.id!=='string'||!contract.id||typeof contract.status!=='string'||typeof contract.start_date!=='string'||typeof contract.end_date!=='string'||typeof contract.rent_price!=='number'||!Number.isFinite(contract.rent_price)||!(contract.deleted_at===null||typeof contract.deleted_at==='string'))return false;
 if(!(contract.contract_number===null||typeof contract.contract_number==='string'))return false;
 if(contract.room===null)return true;if(!contract.room||typeof contract.room!=='object')return false;const room=contract.room as Record<string,unknown>;
 if(typeof room.id!=='string'||typeof room.name!=='string')return false;
 if(room.building===null)return true;if(!room.building||typeof room.building!=='object')return false;const building=room.building as Record<string,unknown>;
 return typeof building.id==='string'&&typeof building.name==='string';
}
