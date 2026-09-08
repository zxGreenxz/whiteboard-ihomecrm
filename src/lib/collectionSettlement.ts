/** Money retained by this collection; rounding is metadata, never cash received. */
export const COLLECTION_ROUNDING_THRESHOLD = 10_000;

export interface CollectionSettlementInput {
  gross: number;
  cash: number;
  remaining: number;
  action: 'REJECT' | 'REFUND' | 'CREDIT';
  actualChange?: number;
  allowRounding: boolean;
  roundingThreshold?: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

export function collectionSettlement(input: CollectionSettlementInput) {
  const overpay = Math.max(cents(input.gross - input.remaining), 0);
  const explicit = input.actualChange !== undefined;
  if (explicit && ((input.action !== 'REFUND' && !(input.action === 'REJECT' && input.actualChange === 0)) || !Number.isFinite(input.actualChange)
    || input.actualChange! < 0 || Math.abs(cents(input.actualChange!) - input.actualChange!) > 1e-6)) {
    throw new Error('Tiền thối thực tế không hợp lệ hoặc đang giữ credit');
  }
  let change = 0;
  let credit = 0;
  if (input.action === 'REFUND') {
    change = input.actualChange ?? overpay;
    if (change < overpay) throw new Error('Tiền thối ít hơn phần dư; hãy thối đủ hoặc chọn giữ nợ khách');
    if (change > input.cash) throw new Error('Phần thu dư phải nằm trong dòng tiền mặt TM');
    if (change <= 0) throw new Error('Chỉ chọn thối lại hoặc giữ credit khi thực sự có tiền dư');
  } else if (input.action === 'CREDIT') {
    if (overpay <= 0) throw new Error('Chỉ chọn thối lại hoặc giữ credit khi thực sự có tiền dư');
    credit = overpay;
  } else if (overpay > 0) {
    throw new Error('Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit');
  }
  const retained = cents(input.gross - change);
  const applied = Math.min(cents(retained - credit), input.remaining);
  if (applied <= 0) throw new Error('Hóa đơn không còn số tiền có thể thu');
  const shortage = Math.max(cents(input.remaining - applied), 0);
  const rounding = input.allowRounding && shortage > 0
    && shortage < (input.roundingThreshold ?? COLLECTION_ROUNDING_THRESHOLD) ? shortage : 0;
  return { change, credit, retained, applied, shortage, rounding };
}
