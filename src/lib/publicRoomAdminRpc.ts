import {supabase} from '@/integrations/supabase/client';

/**
 * RPC trang Sale theo công ty (migration 20261125034429_sale_phong_theo_cong_ty.sql, đợt 2 Sale phòng).
 *
 * Lớp bọc kiểu TẠM: types.ts chỉ sinh lại từ catalog production sau khi migration áp qua lane (giai đoạn B), nên
 * chữ ký ở đây khai tay theo migration. Mỗi hàm gọi `.rpc('<tên>'` viết thẳng để bề mặt RPC
 * (scripts/generate-rpc-surface.mjs) và các cửa kiểm tên RPC vẫn thấy call site. Sinh lại types.ts thì gỡ lớp này.
 */
export type RpcReply=PromiseLike<{data:unknown;error:{code?:string;message?:string;details?:string;hint?:string}|null}>;
type Caller<N extends string,A>={rpc:(name:N,args:A)=>RpcReply};

export type GetSettingsArgs={p_organization_id:string};
export type SaveSettingsArgs={p_organization_id:string;p_expected_updated_at:string|null;p_soon_days:number;p_show_rented:boolean;
 p_hotline_id:string|null;p_sale_policy:string|null};
export type ListTokensArgs={p_organization_id:string};
export type ManageTokenArgs={p_organization_id:string;p_token:string;p_action:'rename'|'revoke'|'restore'|'delete';p_label?:string|null};
export type MyRoomsArgs={p_organization_id:string};

export const rpcGetPublicRoomSettings=(args:GetSettingsArgs):RpcReply=>
 (supabase as unknown as Caller<'get_public_room_settings_v1',GetSettingsArgs>).rpc('get_public_room_settings_v1',args);
export const rpcSavePublicRoomSettings=(args:SaveSettingsArgs):RpcReply=>
 (supabase as unknown as Caller<'save_public_room_settings_v1',SaveSettingsArgs>).rpc('save_public_room_settings_v1',args);
export const rpcListPublicRoomTokens=(args:ListTokensArgs):RpcReply=>
 (supabase as unknown as Caller<'list_public_room_tokens_v1',ListTokensArgs>).rpc('list_public_room_tokens_v1',args);
export const rpcManagePublicRoomToken=(args:ManageTokenArgs):RpcReply=>
 (supabase as unknown as Caller<'manage_public_room_token_v1',ManageTokenArgs>).rpc('manage_public_room_token_v1',args);
export const rpcGetMyAvailableRooms=(args:MyRoomsArgs):RpcReply=>
 (supabase as unknown as Caller<'get_my_available_rooms',MyRoomsArgs>).rpc('get_my_available_rooms',args);
