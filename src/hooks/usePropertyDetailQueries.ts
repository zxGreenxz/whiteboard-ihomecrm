import {useQuery} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';

function rows<T>(data:unknown):T[]{
 if(!Array.isArray(data)||data.some(row=>!row||typeof row!=='object'))throw new TypeError('Invalid property detail response');
 return data as T[];
}
export type RoomDetailContract = {
  id: string;
  contract_number: string | null;
  start_date: string;
  end_date: string;
  status: string;
  rent_price: number;
  tenant: { id: string; full_name: string; phone: string } | null;
};

export type RoomDetailInvoice = {
  id: string;
  invoice_number: string | null;
  due_date: string;
  total_amount: number;
  status: string;
  contract: {
    tenant: { full_name: string } | null;
  } | null;
};

export type RoomDetailTenant = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  status: string;
};

export type RoomDetailAsset = {
  id: string;
  name: string;
  asset_code: string | null;
  category: string | null;
  quantity: number;
  condition: string | null;
  value: number | null;
};

export type BuildingDetailContract = {
  id: string;
  contract_number: string | null;
  start_date: string;
  end_date: string;
  status: string;
  rent_price: number;
  tenant: { id: string; full_name: string; phone: string } | null;
  room: { id: string; name: string } | null;
};

export type BuildingDetailInvoice = {
  id: string;
  invoice_number: string | null;
  due_date: string;
  total_amount: number;
  status: string;
  contract: {
    tenant: { full_name: string } | null;
    room: { name: string } | null;
  } | null;
};


export function useRoomDetailContracts(id:string){return useQuery({
 queryKey:['room-detail-contracts',id],enabled:!!id,meta:{feedback:'inline'},queryFn:async()=>{
 const {data,error}=await supabase.from('contracts').select('id,contract_number,start_date,end_date,status,rent_price,tenant:tenants(id,full_name,phone)').eq('room_id',id).is('deleted_at',null).order('created_at',{ascending:false});
 if(error)throw error;return rows<RoomDetailContract>(data);
 }});}
export function useRoomDetailTenants(id:string){return useQuery({
 queryKey:['room-detail-tenants',id],enabled:!!id,meta:{feedback:'inline'},queryFn:async()=>{
 const {data,error}=await supabase.from('contracts').select('tenant:tenants(id,full_name,phone,email,status)').eq('room_id',id).in('status',['ACTIVE']).is('deleted_at',null);
 if(error)throw error;return rows<{tenant:RoomDetailTenant|null}>(data).flatMap(row=>row.tenant?[row.tenant]:[]);
 }});}
export function useRoomDetailInvoices(id:string){return useQuery({
 queryKey:['room-detail-invoices',id],enabled:!!id,meta:{feedback:'inline'},queryFn:async()=>{
 const {data,error}=await supabase.from('invoices').select('id,invoice_number,due_date,total_amount,status,contract:contracts!inner(room_id,tenant:tenants(full_name))').eq('contract.room_id',id).is('deleted_at',null).order('created_at',{ascending:false}).limit(50);
 if(error)throw error;return rows<RoomDetailInvoice>(data);
 }});}
export function useRoomDetailAssets(id:string){return useQuery({
 queryKey:['room-detail-assets',id],enabled:!!id,meta:{feedback:'inline'},queryFn:async()=>{
 const {data,error}=await supabase.from('assets').select('id,name,code,condition,quantity,purchase_price,category_id').eq('room_id',id).is('deleted_at',null).order('name',{ascending:true});
 if(error)throw error;return rows<{id:string;name:string;code:string|null;condition:string|null;quantity:number|null;purchase_price:number|null}>(data).map((a):RoomDetailAsset=>({id:a.id,name:a.name,asset_code:a.code,category:null,quantity:a.quantity??1,condition:a.condition,value:a.purchase_price}));
 }});}
export function useBuildingDetailContracts(id:string){return useQuery({
 queryKey:['building-detail-contracts',id],enabled:!!id,meta:{feedback:'inline'},queryFn:async()=>{
 const {data,error}=await supabase.from('contracts').select('id,contract_number,start_date,end_date,status,rent_price,tenant:tenants(id,full_name,phone),room:rooms!contracts_room_id_fkey(id,name,building_id)').eq('room.building_id',id).is('deleted_at',null).order('created_at',{ascending:false}).limit(50);
 if(error)throw error;return rows<BuildingDetailContract & {room:{building_id?:string}|null}>(data).filter(row=>row.room?.building_id===id);
 }});}
export function useBuildingDetailInvoices(id:string,roomIds:readonly string[]|undefined){return useQuery({
 queryKey:['building-detail-invoices',id,roomIds],enabled:!!id&&roomIds!==undefined,meta:{feedback:'inline'},queryFn:async()=>{
 if(!roomIds)throw new TypeError('Room source not loaded');if(!roomIds.length)return [] as BuildingDetailInvoice[];
 const {data,error}=await supabase.from('invoices').select('id,invoice_number,due_date,total_amount,status,contract:contracts(tenant:tenants(full_name),room:rooms!contracts_room_id_fkey(name))').in('contract.room_id',[...roomIds]).is('deleted_at',null).order('created_at',{ascending:false}).limit(50);
 if(error)throw error;return rows<BuildingDetailInvoice>(data);
 }});}
