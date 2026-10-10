import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';
import {getSessionUser} from '@/lib/authSession';
import {notifyActionError} from '@/lib/actionFeedback';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {validPublicRoomSettings,unconfirmedPublicRoomReceipt} from '@/lib/publicRoomFeedback';
import {toast} from 'sonner';
/** sale_policy: chính sách sale chung in ở khối đầu ảnh "DANH SÁCH PHÒNG TRỐNG" (NULL = không in). */
export interface PublicRoomSettings{soon_days:number;show_rented:boolean;hotline_id:string|null;sale_policy:string|null}
export const PUBLIC_ROOM_SETTINGS_DEFAULTS:PublicRoomSettings={soon_days:30,show_rented:true,hotline_id:null,sale_policy:null};
const KEY=['public-room-settings'] as const;
export function usePublicRoomSettings(){return useQuery({queryKey:KEY,meta:{errorDisplay:"inline"},queryFn:async():Promise<PublicRoomSettings>=>{
 const {data,error}=await supabase.from('public_room_settings').select('soon_days, show_rented, hotline_id, sale_policy').maybeSingle();if(error)throw error;
 if(data===null)return PUBLIC_ROOM_SETTINGS_DEFAULTS;if(!validPublicRoomSettings(data))throw new TypeError('Invalid public room settings');return {soon_days:data.soon_days,show_rented:data.show_rented,hotline_id:data.hotline_id,sale_policy:data.sale_policy??null};
}});}
export function useUpsertPublicRoomSettings(options:{inlineError?:boolean}={}){const qc=useQueryClient();return useMutation({mutationFn:async(values:PublicRoomSettings)=>{
 if(!validPublicRoomSettings(values))throw new FinancialWorkflowError('Cài đặt chưa hợp lệ: số ngày sắp trống là số nguyên 0–365, chính sách sale tối đa 2000 ký tự.','failure',[]);
 const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};
 return persistentFinancialWorkflow('public-room-admin',{scope:'actor'}).run('settings','lưu cài đặt hiển thị',async progress=>{
  const patch={owner_id:user.id,...values,updated_at:new Date().toISOString()};
  const {data,error}=await supabase.from('public_room_settings').upsert(patch,{onConflict:'owner_id'}).select('*').single();if(error)throw error;
  if(data&&typeof data.owner_id==='string'&&data.owner_id)progress.completed.push({id:data.owner_id,label:'Cài đặt tài khoản cần đối chiếu'});
  if(!validPublicRoomSettings(data)||data.owner_id!==user.id||data.soon_days!==values.soon_days||data.show_rented!==values.show_rented||data.hotline_id!==values.hotline_id||(data.sale_policy??null)!==(values.sale_policy??null)||data.updated_at!==patch.updated_at)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:()=>{qc.invalidateQueries({queryKey:KEY});toast.success('Đã lưu cài đặt hiển thị');},onError:error=>{if(!options.inlineError)notifyActionError(error,'Chưa lưu được cài đặt hiển thị.');}});}
