import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import { isCivilDate } from '@/lib/contractMoveOutNotice';
import { classifyDbError } from '@/lib/contracts/errors';

const civilDate = z.string().refine(value => isCivilDate(value) && value >= '0001-01-01', 'Ngày dự kiến không hợp lệ');
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const roomTurnoverStateSchema = z.object({
  id:z.string().uuid(),organization_id:z.string().uuid(),room_id:z.string().uuid(),version,
  epoch:z.number().int().positive(),source_contract_id:z.string().uuid().nullable(),status:z.enum(['PENDING','READY']),
  expected_ready_on:civilDate.nullable(),responsible_user_id:z.string().uuid().nullable(),
  reason:z.string(),updated_at:z.string().datetime({offset:true}),
});
export type RoomTurnoverState = z.infer<typeof roomTurnoverStateSchema>;
const historySchema = z.object({
  id:z.string().uuid(),epoch:z.number().int().positive(),actor_id:z.string().uuid(),
  created_at:z.string().datetime({offset:true}),previous_state:roomTurnoverStateSchema.nullable(),
  new_state:roomTurnoverStateSchema,reason:z.string(),
});
const snapshotSchema = z.object({
  today:civilDate,can_start_new_cycle:z.boolean(),turnover:roomTurnoverStateSchema.nullable(),history:z.array(historySchema),
});
export type RoomTurnoverSnapshot = z.infer<typeof snapshotSchema>;
export const parseRoomTurnoverSnapshot = (value:unknown):RoomTurnoverSnapshot => snapshotSchema.parse(value);
const queueSchema = z.object({today:civilDate,total:version,items:z.array(z.object({
  room_id:z.string().uuid(),room_name:z.string(),building_id:z.string().uuid(),building_name:z.string(),
  version,epoch:z.number().int().positive(),source_contract_id:z.string().uuid().nullable(),
  expected_ready_on:civilDate.nullable(),responsible_user_id:z.string().uuid().nullable(),status:z.literal('PENDING'),
}))});
export type RoomTurnoverQueue = z.infer<typeof queueSchema>;
export const parseRoomTurnoverQueue = (value:unknown):RoomTurnoverQueue => queueSchema.parse(value);

export const roomTurnoverFormSchema = z.object({
  status:z.enum(['PENDING','READY']),expectedReadyOn:z.union([civilDate,z.literal('')]),
  responsibleUserId:z.union([z.string().uuid(),z.literal('')]),reason:z.string().trim().min(1,'Vui lòng nhập lý do / ghi chú').max(2000,'Lý do tối đa 2.000 ký tự'),
});
export type RoomTurnoverFormData = z.infer<typeof roomTurnoverFormSchema>;
export interface SaveRoomTurnoverInput {
  organizationId:string;roomId:string;expectedVersion:number;status:'PENDING'|'READY';
  expectedReadyOn:string|null;responsibleUserId:string|null;sourceContractId:string|null;reason:string;startNewCycle:boolean;
}
export function buildRoomTurnoverArgs(input:SaveRoomTurnoverInput) {
  z.string().uuid().parse(input.organizationId);z.string().uuid().parse(input.roomId);
  version.parse(input.expectedVersion);
  const form = roomTurnoverFormSchema.parse({...input,expectedReadyOn:input.expectedReadyOn??'',responsibleUserId:input.responsibleUserId??''});
  const source = z.string().uuid().nullable().parse(input.sourceContractId);
  const payload = {
    status:form.status,expected_ready_on:form.expectedReadyOn||null,responsible_user_id:form.responsibleUserId||null,
    source_contract_id:source,reason:form.reason,start_new_cycle:input.startNewCycle,
  } satisfies Json;
  return {p_organization_id:input.organizationId,p_room_id:input.roomId,p_expected_version:input.expectedVersion,p_payload:payload};
}
export type RoomTurnoverRpcArgs = ReturnType<typeof buildRoomTurnoverArgs>;
export type RoomTurnoverRpcInvoker = (name:'save_room_turnover_v1',args:RoomTurnoverRpcArgs)=>PromiseLike<{data:unknown;error:unknown|null}>;
export async function saveRoomTurnover(rpc:RoomTurnoverRpcInvoker,input:SaveRoomTurnoverInput) {
  const result = await rpc('save_room_turnover_v1',buildRoomTurnoverArgs(input));
  if(result.error) throw result.error;
  const snapshot = parseRoomTurnoverSnapshot(result.data);
  if(!snapshot.turnover || snapshot.turnover.room_id!==input.roomId || snapshot.turnover.organization_id!==input.organizationId) {
    throw new Error('Kết quả dọn/sửa không khớp phòng');
  }
  return snapshot;
}

export function turnoverReadiness(state:Pick<RoomTurnoverState,'status'|'expected_ready_on'>|null,today:string):
  {kind:'unknown'|'ready'|'planned'|'confirm-date';expectedReadyOn:string|null} {
  civilDate.parse(today);
  if(!state) return {kind:'unknown',expectedReadyOn:null};
  if(state.status==='READY') return {kind:'ready',expectedReadyOn:null};
  if(!state.expected_ready_on || state.expected_ready_on<=today) return {kind:'confirm-date',expectedReadyOn:null};
  civilDate.parse(state.expected_ready_on);
  return {kind:'planned',expectedReadyOn:state.expected_ready_on};
}
export function turnoverErrorMessage(error:unknown):string {
  switch(classifyDbError(error)) {
    case 'permission':return 'Bạn không có quyền theo dõi dọn/sửa cho phòng này hoặc phiên đăng nhập đã hết hạn.';
    case 'conflict':return 'Thông tin phòng hoặc việc dọn/sửa đã thay đổi. Vui lòng tải lại trước khi sửa.';
    case 'validation':return 'Ngày, người phụ trách hoặc lý do chưa hợp lệ. Vui lòng kiểm tra lại.';
    case 'concurrency':return 'Phòng đang được cập nhật. Vui lòng thử lại sau.';
    default:return 'Chưa lưu được việc dọn/sửa. Vui lòng thử lại hoặc liên hệ hỗ trợ.';
  }
}
