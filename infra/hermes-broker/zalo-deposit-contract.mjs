import { domainExact, domainId } from './domain-contract.mjs';
import { REQUEST_ID_PROPERTY } from './request-id-contract.mjs';

export const ZALO_DEPOSIT_KEY = 'deposits.zalo_confirmed_receipt';
export const ZALO_DEPOSIT_GRANTS = Object.freeze([ZALO_DEPOSIT_KEY, 'deposits.create', 'income_expenses.create', 'sale_phong.lock_room']);
const uuid = { type: 'string', format: 'uuid' };
const date = { type: 'string', format: 'date' };
const maxAmount = 9_999_999_999_999;
const amount = { type: 'integer', minimum: 1, maximum: maxAmount };
const properties = {
  requestId: REQUEST_ID_PROPERTY, roomId: uuid, payerName: { type: 'string', minLength: 1, maxLength: 120 },
  payments: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false,
    required: ['amount', 'reference'], properties: { amount, reference: { type: ['string', 'null'], maxLength: 80 } } } },
  voucherDate: date, accountId: uuid, intendedMoveInOn: { ...date, type: ['string', 'null'] },
  depositTarget: { ...amount, type: ['integer', 'null'] },
};
export const ZALO_DEPOSIT_TOOL = Object.freeze({
  name: 'crm_sale_zalo_deposit',
  description: 'Giữ phòng và lập một phiếu thu cọc từ ảnh trong Zalo riêng. Tra đúng phòng và sổ quỹ CRM. Mỗi giao dịch khác nhau là một dòng payments, một ngày và một sổ cho cả phiếu. Trả bản xem trước cùng câu xác nhận cần gửi cho người dùng. Sau khi người dùng tự gửi câu đó, gọi lại đúng toàn bộ input và requestId để ghi hoặc tra lại kết quả.',
  inputSchema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
});
const validMoney = v => Number.isSafeInteger(v) && v > 0 && v <= maxAmount;
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
const label = (v, max) => typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
const invalid = () => { throw new TypeError('invalid_zalo_deposit'); };

export function zaloDepositInput(input) {
  if (!domainExact(input, Object.keys(properties)) || !domainId(input.requestId) || !domainId(input.roomId) ||
      !domainId(input.accountId) || !label(input.payerName, 120) || !validDate(input.voucherDate) ||
      !(input.intendedMoveInOn === null || validDate(input.intendedMoveInOn)) ||
      !(input.depositTarget === null || validMoney(input.depositTarget)) ||
      !Array.isArray(input.payments) || input.payments.length < 1 || input.payments.length > 10) invalid();
  const seen = new Set();
  let sum = 0;
  for (const payment of input.payments) {
    if (!domainExact(payment, ['amount', 'reference']) || !validMoney(payment.amount)) invalid();
    if (payment.reference === null) {
      if (input.payments.length !== 1) invalid();
    } else {
      if (!label(payment.reference, 80)) invalid();
      const ref = payment.reference.trim().toUpperCase();
      if (seen.has(ref)) invalid();
      seen.add(ref);
    }
    sum += payment.amount;
  }
  if (!validMoney(sum)) invalid();
  return structuredClone(input);
}

export function zaloDepositResult(value, identity, input) {
  const keys = ['organizationId', 'requestId', 'buildingId', 'roomId', 'outcome'];
  if (value?.organizationId !== identity.row.organizationId || value.requestId !== input.requestId ||
      value.roomId !== input.roomId || !domainId(value.buildingId) ||
      !ZALO_DEPOSIT_GRANTS.every(k => identity.scopesByPermission?.[k]?.buildingIds?.includes(value.buildingId))) invalid();
  if (value.outcome === 'confirmation_required') {
    if (!domainExact(value, [...keys, 'room', 'building', 'account', 'confirmation', 'expiresAt']) ||
        ![value.room, value.building, value.account].every(v => label(v, 240)) ||
        !label(value.confirmation, 1600) || !/^Xác nhận cọc [0-9A-F]{12} · /u.test(value.confirmation) || !Number.isFinite(Date.parse(value.expiresAt))) invalid();
    return { ...value, payerName: input.payerName, payments: input.payments, voucherDate: input.voucherDate,
      total: input.payments.reduce((n, p) => n + p.amount, 0), intendedMoveInOn: input.intendedMoveInOn, depositTarget: input.depositTarget };
  }
  if (value.outcome !== 'applied' || !domainExact(value, [...keys, 'voucherId', 'voucherCode', 'reservationId', 'approvalStatus']) ||
      !domainId(value.voucherId) || !domainId(value.reservationId) || !label(value.voucherCode, 100) || !label(value.approvalStatus, 40)) invalid();
  return { ...value };
}
