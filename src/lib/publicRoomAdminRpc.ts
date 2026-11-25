import {supabase} from '@/integrations/supabase/client';

/**
 * RPC trang Sale theo công ty (migration 20261125034429_sale_phong_theo_cong_ty.sql, đợt 2 Sale phòng).
 *
 * Facade kiểu TẠM: types.ts chỉ sinh lại từ catalog production sau khi migration áp qua lane (giai đoạn B), nên chữ ký
 * ở đây khai tay theo migration và mọi lời gọi đi qua MỘT phép ép kiểu trên `supabase.rpc` (khuôn
 * src/lib/network-center/supabaseRepository.ts). Sinh lại types.ts thì đổi sang `supabase.rpc('<tên>', …)` có kiểu và
 * bỏ facade này.
 */
export type RpcReply=PromiseLike<{data:unknown;error:{code?:string;message?:string;details?:string;hint?:string}|null}>;

export type GetSettingsArgs={p_organization_id:string};
export type SaveSettingsArgs={p_organization_id:string;p_expected_updated_at:string|null;p_soon_days:number;p_show_rented:boolean;
 p_hotline_id:string|null;p_sale_policy:string|null};
export type ListTokensArgs={p_organization_id:string};
export type ManageTokenArgs={p_organization_id:string;p_token:string;p_action:'rename'|'revoke'|'restore'|'delete';p_label?:string|null};
export type MyRoomsArgs={p_organization_id:string};

type PublicRoomAdminCalls={
 get_public_room_settings_v1:GetSettingsArgs;
 save_public_room_settings_v1:SaveSettingsArgs;
 list_public_room_tokens_v1:ListTokensArgs;
 manage_public_room_token_v1:ManageTokenArgs;
 get_my_available_rooms:MyRoomsArgs;
};
type Invoke=<N extends keyof PublicRoomAdminCalls>(name:N,args:PublicRoomAdminCalls[N])=>RpcReply;
/** Một phép ép kiểu duy nhất; giữ `this` của client (gọi qua biểu thức thành viên trong ngoặc, không `bind`). */
const invoke:Invoke=(name,args)=>(supabase.rpc as unknown as (n:string,a:object)=>RpcReply)(name,args);

export const rpcGetPublicRoomSettings=(args:GetSettingsArgs):RpcReply=>invoke('get_public_room_settings_v1',args);
export const rpcSavePublicRoomSettings=(args:SaveSettingsArgs):RpcReply=>invoke('save_public_room_settings_v1',args);
export const rpcListPublicRoomTokens=(args:ListTokensArgs):RpcReply=>invoke('list_public_room_tokens_v1',args);
export const rpcManagePublicRoomToken=(args:ManageTokenArgs):RpcReply=>invoke('manage_public_room_token_v1',args);
export const rpcGetMyAvailableRooms=(args:MyRoomsArgs):RpcReply=>invoke('get_my_available_rooms',args);
