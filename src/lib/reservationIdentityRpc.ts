import {FinancialPendingError,FinancialPendingStorageError} from './financialPending';
import { friendlyError } from "./friendlyError";
import { voucherOutcomeUnknown, voucherFailureMessage } from "./voucherFeedback";
import {z} from 'zod';
import type {Json} from '@/integrations/supabase/types';
/** Tên khách gợi nhớ khi cọc chưa có khách trong danh bạ (migration 20261010114500). */
export const CUSTOMER_HINT_MAX=120;
const uuid=z.string().uuid(),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),key=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const receiptSchema=z.object({amount:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),accountId:uuid.nullable().optional(),voucherDate:date,name:z.string().trim().min(1).optional(),description:z.string().nullable().optional(),attachments:z.array(z.string().url().startsWith('https://')).optional()}).strict();
export type ReservationReceiptInput=z.infer<typeof receiptSchema>;
export interface CreateRoomReservationInput {roomId:string;customerId?:string|null;customerHint?:string|null;holdUntil?:string|null;intendedMoveInOn?:string|null;topupDueOn?:string|null;depositTarget?:number|null;notes?:string|null;receipt?:ReservationReceiptInput;existingVoucherIds?:string[];idempotencyKey:string}
export interface UpdateRoomReservationInput {reservationId:string;expectedRevision:number;idempotencyKey:string;action:'UPDATE'|'TOPUP'|'CANCEL';changes?:{holdUntil?:string|null;intendedMoveInOn?:string|null;topupDueOn?:string|null;depositTarget?:number|null;notes?:string|null};receipt?:ReservationReceiptInput}
export interface RoomReservationFilters {roomId?:string;customerId?:string;status?:'HOLD'|'CONVERTED'|'CANCELLED';limit?:number}
const receiptResultSchema=z.object({source_voucher_id:uuid,source_item_id:uuid,amount:z.number().nonnegative(),received:z.boolean(),approval_status:z.string().nullable(),code:z.string().nullable(),released:z.boolean()});
export const roomReservationSchema=z.object({id:uuid,organization_id:uuid,building_id:uuid,room_id:uuid,customer_id:uuid.nullable(),customer_name:z.string(),customer_phone:z.string().nullable(),customer_hint:z.string().nullable().default(null),building_name:z.string(),room_name:z.string(),status:z.enum(['HOLD','CONVERTED','CANCELLED']),claim_status:z.enum(['LIVE','CONSUMED','CANCELLED']),revision:z.number().int().positive(),hold_until:date.nullable(),intended_move_in_on:date.nullable(),topup_due_on:date.nullable(),deposit_target:z.number().nonnegative().nullable(),notes:z.string().nullable(),converted_contract_id:uuid.nullable(),overdue:z.boolean(),received_amount:z.number().nonnegative(),source_voucher_ids:z.array(uuid),receipts:z.array(receiptResultSchema),created_at:z.string(),updated_at:z.string(),history:z.array(z.object({revision:z.number().int().positive(),action:z.string(),changed_by:uuid,changed_at:z.string()}))});
export type RoomReservation=z.infer<typeof roomReservationSchema>;
export const roomReservationListSchema=z.object({server_today:date,reservations:z.array(roomReservationSchema)});
export type RoomReservationList=z.infer<typeof roomReservationListSchema>;
export type ReservationRpcName='create_room_reservation_v1'|'update_room_reservation_v1'|'list_room_reservations_v1'|'assign_room_reservation_customer_v1';
export type ReservationRpcInvoker=(name:ReservationRpcName,args:Record<string,Json>)=>PromiseLike<{data:unknown;error:{code?:string;message?:string}|null}>;
export function buildReservationReceiptPayload(input:ReservationReceiptInput):Json {const r=receiptSchema.parse(input);return{amount:r.amount,account_id:r.accountId??null,voucher_date:r.voucherDate,name:r.name??null,description:r.description??null,attachments:r.attachments??[]};}
export function buildCreateRoomReservationArgs(organizationId:string,input:CreateRoomReservationInput){
  const v=z.object({roomId:uuid,customerId:uuid.nullable().optional(),customerHint:z.string().trim().max(CUSTOMER_HINT_MAX,'Tên khách gợi nhớ tối đa '+CUSTOMER_HINT_MAX+' ký tự').nullable().optional(),holdUntil:date.nullable().optional(),intendedMoveInOn:date.nullable().optional(),topupDueOn:date.nullable().optional(),depositTarget:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),notes:z.string().nullable().optional(),receipt:receiptSchema.optional(),existingVoucherIds:z.array(uuid).optional(),idempotencyKey:key}).strict().parse(input);
  const hint=v.customerHint||null;
  if(!!v.customerId===!!hint)throw new Error('Chọn khách trong danh bạ hoặc gõ tên khách gợi nhớ');
  if(hint&&!v.receipt&&!v.existingVoucherIds?.length)throw new Error('Tên khách gợi nhớ chỉ dùng cho phiếu cọc có tiền');
  if(!v.receipt&&!v.existingVoucherIds?.length&&!v.holdUntil)throw new Error('Giữ chỗ chưa nhận tiền phải chọn hạn giữ chỗ');
  const p_payload:Record<string,Json>={room_id:v.roomId,...(v.customerId?{customer_id:v.customerId}:{customer_hint:hint}),hold_until:v.holdUntil??null,intended_move_in_on:v.intendedMoveInOn??null,topup_due_on:v.topupDueOn??null,deposit_target:v.depositTarget??null,notes:v.notes??null,existing_voucher_ids:v.existingVoucherIds??[]};if(v.receipt)p_payload.receipt=buildReservationReceiptPayload(v.receipt);
  return{p_organization_id:uuid.parse(organizationId),p_idempotency_key:v.idempotencyKey,p_payload};
}
export function buildUpdateRoomReservationArgs(organizationId:string,input:UpdateRoomReservationInput){
  const v=z.object({reservationId:uuid,expectedRevision:z.number().int().positive(),idempotencyKey:key,action:z.enum(['UPDATE','TOPUP','CANCEL']),changes:z.object({holdUntil:date.nullable().optional(),intendedMoveInOn:date.nullable().optional(),topupDueOn:date.nullable().optional(),depositTarget:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),notes:z.string().nullable().optional()}).strict().optional(),receipt:receiptSchema.optional()}).strict().parse(input);
  if((v.action==='TOPUP')!==!!v.receipt||(v.action!=='UPDATE'&&v.changes&&Object.keys(v.changes).length))throw new Error('Thao tác giữ chỗ không khớp dữ liệu');
  const changes:Record<string,Json>={};for(const [k,value]of Object.entries(v.changes??{})){const names:Record<keyof NonNullable<typeof v.changes>,string>={holdUntil:'hold_until',intendedMoveInOn:'intended_move_in_on',topupDueOn:'topup_due_on',depositTarget:'deposit_target',notes:'notes'};changes[names[k as keyof NonNullable<typeof v.changes>]]=value??null;}
  return{p_organization_id:uuid.parse(organizationId),p_reservation_id:v.reservationId,p_expected_revision:v.expectedRevision,p_idempotency_key:v.idempotencyKey,p_action:v.action,p_changes:changes,p_receipt:v.receipt?buildReservationReceiptPayload(v.receipt):null};
}
async function invoke(rpc:ReservationRpcInvoker,name:ReservationRpcName,args:Record<string,Json>){const r=await rpc(name,args);if(r.error)throw r.error;return r.data;}
export async function createRoomReservation(rpc:ReservationRpcInvoker,organizationId:string,input:CreateRoomReservationInput):Promise<RoomReservation>{const data=await invoke(rpc,'create_room_reservation_v1',buildCreateRoomReservationArgs(organizationId,input));const parsed=roomReservationSchema.safeParse(data);if(!parsed.success)throw new TypeError('Chưa xác nhận được hồ sơ giữ chỗ đã lưu');return parsed.data;}
export async function updateRoomReservation(rpc:ReservationRpcInvoker,organizationId:string,input:UpdateRoomReservationInput):Promise<RoomReservation>{const data=await invoke(rpc,'update_room_reservation_v1',buildUpdateRoomReservationArgs(organizationId,input));const parsed=roomReservationSchema.safeParse(data);if(!parsed.success)throw new TypeError('Chưa xác nhận được hồ sơ giữ chỗ đã lưu');return parsed.data;}
export interface AssignRoomReservationCustomerInput {reservationId:string;expectedRevision:number;customerId:string;idempotencyKey:string}
export async function assignRoomReservationCustomer(rpc:ReservationRpcInvoker,organizationId:string,input:AssignRoomReservationCustomerInput):Promise<RoomReservation>{const v=z.object({reservationId:uuid,expectedRevision:z.number().int().positive(),customerId:uuid,idempotencyKey:key}).strict().parse(input);const data=await invoke(rpc,'assign_room_reservation_customer_v1',{p_organization_id:uuid.parse(organizationId),p_reservation_id:v.reservationId,p_expected_revision:v.expectedRevision,p_customer_id:v.customerId,p_idempotency_key:v.idempotencyKey});const parsed=roomReservationSchema.safeParse(data);if(!parsed.success)throw new TypeError('Chưa xác nhận được hồ sơ giữ chỗ đã lưu');return parsed.data;}
export async function listRoomReservations(rpc:ReservationRpcInvoker,organizationId:string,filters:RoomReservationFilters={}):Promise<RoomReservationList>{return roomReservationListSchema.parse(await invoke(rpc,'list_room_reservations_v1',{p_organization_id:uuid.parse(organizationId),p_room_id:filters.roomId?uuid.parse(filters.roomId):null,p_customer_id:filters.customerId?uuid.parse(filters.customerId):null,p_status:filters.status??null,p_limit:z.number().int().min(1).max(200).parse(filters.limit??100)}));}
// Reasons verified in 20260928025848_room_reservation_workflow.sql.
const reservationReasons = [
 'Không tìm thấy phòng trong tổ chức', 'Phải chọn khách cụ thể trong tổ chức', 'Phòng đã có khách giữ chỗ tiếp theo',
 'Phòng đang có khách: cần báo trả rõ ràng và ngày dự kiến vào từ ngày báo trả trở đi', 'Phòng chưa sẵn sàng để giữ chỗ',
 'Giữ chỗ chưa nhận tiền phải chọn hạn giữ chỗ', 'Giữ chỗ đã được xử lý', 'Giữ chỗ chưa nhận tiền phải giữ hạn do người dùng chọn',
 'Cọc còn hiệu lực. Xử lý phiếu nguồn bằng luồng hiện tại trước khi hủy giữ chỗ.',
 // 20261010114500: tên khách gợi nhớ + gắn khách.
 'Chọn khách trong danh bạ hoặc gõ tên gợi nhớ, không cả hai', 'Tên khách gợi nhớ tối đa 120 ký tự',
 'Tên khách gợi nhớ chỉ dùng cho phiếu cọc có tiền. Giữ phòng không thu tiền thì dùng Lock tạm.',
 'Giữ chỗ mới có tên khách gợi nhớ, chưa gắn khách trong danh bạ. Gắn khách ở Quản lý cọc trước khi ký.',
 'Giữ chỗ đã gắn khách trong danh bạ', 'Giữ chỗ đã thay đổi',
];
export function reservationErrorMessage(error: unknown): string {
 if(error instanceof FinancialPendingError||error instanceof FinancialPendingStorageError)return voucherFailureMessage(error,'lưu giữ chỗ/cọc');
 const e = error as {code?: string; message?: string};
 if (voucherOutcomeUnknown(error)) return 'Chưa xác nhận được kết quả lưu giữ chỗ/cọc. Tải lại Quản lý cọc và đối chiếu trước khi thực hiện lại.';
 if (e?.code === 'PT409' || e?.code === '40001') return 'Hồ sơ giữ chỗ đã thay đổi. Tải lại trước khi tiếp tục.';
 return friendlyError(error, 'Chưa lưu được giữ chỗ/cọc', {operation:'lưu giữ chỗ/cọc', financial:true,
  rules:reservationReasons.map(message => ({message, description:message}))}).description;
}
