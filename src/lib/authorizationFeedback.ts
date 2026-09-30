import { hasUnconfirmedResponse } from './operationOutcome';
export class AuthorizationReceiptError extends Error {
  constructor() { super('Chưa xác nhận được kết quả thay đổi. Giữ nội dung đang sửa và đọc lại trạng thái thành viên, vai trò hoặc lời mời trước khi thực hiện tiếp.'); }
}
export function authorizationOutcomeUnknown(error: unknown): boolean {
  return error instanceof AuthorizationReceiptError || hasUnconfirmedResponse(error);
}
const record=(data:unknown):Record<string,unknown>=>data && typeof data==='object' && !Array.isArray(data)?data as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string' && value.trim().length>0;
const count=(value:unknown)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0;
/** Receipts match the published organization RPC contract, not SQLSTATE guesses. */
export function authorizationReceipt<T>(data:T, kind:'member'|'role'|'invite'|'revoke'|'profile', expected:{id?:string|null;version?:number|null;name?:string}={}):T {
  const row=record(data);
  const valid=kind==='member'
    ? row.membershipId===expected.id && row.version===(expected.version??-1)+1 && count(row.permissionsAfter) && Array.isArray(row.gained) && Array.isArray(row.lost)
    : kind==='role'
      ? text(row.roleId) && (!expected.id || row.roleId===expected.id) && row.created===!expected.id && row.version===(expected.id?(expected.version??-1)+1:1) && count(row.affectedMembers)
      : kind==='invite'
        ? text(row.invitationId) && text(row.token) && typeof row.expiresAt==='string' && Number.isFinite(Date.parse(row.expiresAt))
        : kind==='revoke'
          ? row.invitationId===expected.id && row.status==='REVOKED'
          : text(row.organizationId) && row.name===expected.name?.trim();
  if (!valid) throw new AuthorizationReceiptError();
  return data;
}
