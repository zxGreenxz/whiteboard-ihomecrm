import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {getSessionUser} from '@/lib/authSession';
import {notifyActionError} from '@/lib/actionFeedback';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {rememberToken,unconfirmedPublicRoomReceipt} from '@/lib/publicRoomFeedback';
import {toast} from 'sonner';
export type PublicRoomToken=Database['public']['Tables']['public_room_share_tokens']['Row'];
const KEY=['public-room-tokens'] as const;
type Options={inlineError?:boolean};
function validToken(data:unknown):data is PublicRoomToken{
 if(!data||typeof data!=='object'||Array.isArray(data))return false;const r=data as Record<string,unknown>;
 return typeof r.token==='string'&&!!r.token&&typeof r.owner_id==='string'&&!!r.owner_id&&(r.label===null||typeof r.label==='string')&&typeof r.revoked==='boolean'&&typeof r.created_at==='string'&&Number.isFinite(Date.parse(r.created_at))&&(r.organization_id===null||typeof r.organization_id==='string');
}
const writeGuard=()=>persistentFinancialWorkflow('public-room-admin',{scope:'actor'});
const report=(error:unknown,options:Options,operation:string)=>{if(!options.inlineError)notifyActionError(error,`Chưa ${operation}.`);};
export function usePublicRoomTokens(){return useQuery({queryKey:KEY,meta:{errorDisplay:"inline"},queryFn:async():Promise<PublicRoomToken[]>=>{
 const {data,error}=await supabase.from('public_room_share_tokens').select('*').order('created_at',{ascending:false});if(error)throw error;
 if(!Array.isArray(data)||!data.every(validToken)||new Set(data.map(row=>row.token)).size!==data.length)throw new TypeError('Invalid public room token list');return data;
}});}
export function useCreatePublicRoomToken(options:Options={}){const qc=useQueryClient();return useMutation({mutationFn:async(label?:string|null)=>{
 const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};const expectedLabel=label?.trim()||null;
 return writeGuard().run('token-create','tạo link chia sẻ',async progress=>{
  const {data,error}=await supabase.rpc('create_public_room_token',{p_label:label??undefined});if(error)throw error;rememberToken(progress,data);
  if(!validToken(data)||data.owner_id!==user.id||data.label!==expectedLabel||data.revoked!==false)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:row=>{qc.invalidateQueries({queryKey:KEY});toast.success(`Đã tạo link chia sẻ ${row.token}`);},onError:error=>report(error,options,'tạo link chia sẻ')});}
export function useUpdateTokenLabel(options:Options={}){const qc=useQueryClient();return useMutation({mutationFn:async({token,label}:{token:string;label:string|null})=>{
 const expectedLabel=label?.trim()||null;return writeGuard().run(`token:${token}`,'đổi nhãn link',async progress=>{
  const {data,error}=await supabase.from('public_room_share_tokens').update({label:expectedLabel}).eq('token',token).select('*').single();if(error)throw error;rememberToken(progress,data);
  if(!validToken(data)||data.token!==token||data.label!==expectedLabel)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:row=>{qc.invalidateQueries({queryKey:KEY});toast.success(`Đã cập nhật nhãn link ${row.token}`);},onError:error=>report(error,options,'đổi nhãn link')});}
export function useSetTokenRevoked(options:Options={}){const qc=useQueryClient();return useMutation({mutationFn:async({token,revoked}:{token:string;revoked:boolean})=>{
 return writeGuard().run(`token:${token}`,'đổi trạng thái link',async progress=>{
  const {data,error}=await supabase.from('public_room_share_tokens').update({revoked}).eq('token',token).select('*').single();if(error)throw error;rememberToken(progress,data);
  if(!validToken(data)||data.token!==token||data.revoked!==revoked)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:row=>{qc.invalidateQueries({queryKey:KEY});toast.success(row.revoked?`Đã thu hồi link ${row.token}`:`Đã khôi phục link ${row.token}`);},onError:error=>report(error,options,'đổi trạng thái link')});}
export function useDeletePublicRoomToken(options:Options={}){const qc=useQueryClient();return useMutation({mutationFn:async(token:string)=>{
 return writeGuard().run(`token:${token}`,'xóa link chia sẻ',async progress=>{
  const {data,error}=await supabase.from('public_room_share_tokens').delete().eq('token',token).select('token');if(error)throw error;
  if(Array.isArray(data))data.forEach(row=>rememberToken(progress,row));
  if(!Array.isArray(data)||data.length>1||data.some(row=>!row||typeof row!=='object'||row.token!==token))unconfirmedPublicRoomReceipt();return {token,removed:data.length};
 });
},onSuccess:result=>{qc.invalidateQueries({queryKey:KEY});if(result.removed)toast.success(`Đã xóa link ${result.token}`);else toast.info(`Link ${result.token} không còn trong danh sách; không có thay đổi mới.`);},onError:error=>report(error,options,'xóa link chia sẻ')});}
