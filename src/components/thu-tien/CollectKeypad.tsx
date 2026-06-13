import { Delete } from 'lucide-react';
import { fmtFull, fmtShort } from '@/lib/collect';
import { DEFAULT_ROUNDING_THRESHOLD } from '@/lib/collectPlan';

interface Props {
  remaining: number;
  /**
   * Số khách trả theo NGHÌN đồng (chuỗi) khi user TỰ nhập;
   * `null` = trạng thái mặc định "điền sẵn đúng số còn phải thu" (đồng nguyên).
   */
  entered: string | null;
  onEntered: (s: string | null) => void;
  onConfirm: () => void;
  confirming?: boolean;
  /** Giữ phần dư thành "nợ khách" (trừ kỳ sau) thay vì thối lại. */
  keepAsCredit: boolean;
  onKeepAsCreditChange: (v: boolean) => void;
  /** Hoá đơn có hợp đồng → cho phép "Nợ khách". */
  canCredit: boolean;
  /** Tên sổ "…Thối" để hiển thị; '' nếu chưa có. */
  changeAccountName?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * Bàn phím thu tiền (nghìn đồng) cho sheet gọn.
 * Mặc định điền sẵn ĐÚNG số còn phải thu (pristine) → nút xanh "Thu đủ".
 * Bấm phím số đầu tiên tự xoá số điền sẵn rồi nhập số mới.
 * Trả thiếu → "Còn nợ X"; trả dư → ô tiền thối / nợ khách.
 */
export function CollectKeypad({
  remaining,
  entered,
  onEntered,
  onConfirm,
  confirming,
  keepAsCredit,
  onKeepAsCreditChange,
  canCredit,
  changeAccountName,
}: Props) {
  const pristine = entered === null;
  const enteredVal = pristine
    ? Math.max(0, Math.round(remaining))
    : (parseInt(entered, 10) || 0) * 1000;

  const overpay = Math.max(0, enteredVal - remaining);
  const shortfall = Math.max(0, remaining - enteredVal);
  // Thiếu < ngưỡng làm tròn → DB tự làm tròn coi như thu đủ.
  const willRound = shortfall > 0 && shortfall < DEFAULT_ROUNDING_THRESHOLD;
  const isFull = enteredVal > 0 && overpay === 0 && (shortfall === 0 || willRound);
  const isUnder = shortfall >= DEFAULT_ROUNDING_THRESHOLD;
  const credit = keepAsCredit && canCredit;

  // Bấm phím số: pristine → bắt đầu chuỗi mới (tự xoá số điền sẵn).
  const press = (d: string) => {
    const base = pristine ? '' : entered;
    onEntered((base + d).replace(/^0+(?=\d)/, '').slice(0, 7));
  };
  const back = () => onEntered(pristine ? '' : entered!.slice(0, -1));
  const presetK = (vDong: number) => onEntered(Math.round(vDong / 1000).toString());

  return (
    <div className="keypad">
      <div className="kp-display">
        <span className="kp-cur">Khách trả</span>
        <span className="kp-amt">{fmtFull(enteredVal)}</span>
      </div>

      {isUnder && (
        <p className="kp-warn under">
          Còn nợ <b>{fmtFull(shortfall)}</b>
        </p>
      )}
      {willRound && (
        <p className="kp-warn round">
          Thiếu {fmtFull(shortfall)} — làm tròn, coi như thu đủ.
        </p>
      )}
      {overpay > 0 && (
        <div className="pf-change kp-change">
          <div className="pf-change-row">
            <span>{credit ? 'Giữ nợ khách' : 'Tiền thối'}</span>
            <b>{fmtFull(overpay)}</b>
          </div>
          {canCredit && (
            <label className="pf-credit">
              <input
                type="checkbox"
                checked={keepAsCredit}
                onChange={(e) => onKeepAsCreditChange(e.target.checked)}
              />
              <span>Nợ khách (trừ kỳ sau) thay vì thối lại</span>
            </label>
          )}
          <p className="pf-hint">
            {credit
              ? `Thu đủ ${fmtFull(remaining)} cho hoá đơn, giữ ${fmtFull(overpay)} làm credit trừ kỳ sau.`
              : `Thối lại khách ${fmtFull(overpay)}${changeAccountName ? ` · ghi sổ "${changeAccountName}"` : ''}.`}
          </p>
        </div>
      )}

      <div className="kp-presets">
        <span className="kp-preset due" onClick={() => onEntered(null)}>
          Còn lại {fmtShort(remaining)}
        </span>
        <span className="kp-preset" onClick={() => presetK(500_000)}>500k</span>
        <span className="kp-preset" onClick={() => presetK(1_000_000)}>1tr</span>
        <span className="kp-preset" onClick={() => presetK(2_000_000)}>2tr</span>
        <span className="kp-preset" onClick={() => onEntered('')}>Xóa</span>
      </div>
      <div className="kp-keys">
        {KEYS.map((d) => (
          <button key={d} type="button" className="kp-key" onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button type="button" className="kp-key" onClick={() => press('000')}>000</button>
        <button type="button" className="kp-key" onClick={() => press('0')}>0</button>
        <button type="button" className="kp-key" onClick={back}>
          <Delete />
        </button>
      </div>
      <button
        type="button"
        className={'kp-confirm' + (isFull ? ' full' : '')}
        disabled={enteredVal <= 0 || confirming}
        onClick={onConfirm}
      >
        {confirming
          ? 'Đang ghi…'
          : isFull
            ? `Thu đủ ${fmtShort(enteredVal)}`
            : `Xác nhận thu ${fmtShort(enteredVal)}`}
        {overpay > 0 && (
          <small>
            {credit ? 'nợ khách ' : 'thối '}
            {fmtShort(overpay)}
          </small>
        )}
      </button>
    </div>
  );
}

export default CollectKeypad;
