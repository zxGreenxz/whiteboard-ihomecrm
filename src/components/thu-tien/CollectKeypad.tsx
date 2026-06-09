import { Delete } from 'lucide-react';
import { fmtFull, fmtShort } from '@/lib/collect';

interface Props {
  remaining: number;
  /** Số đang nhập theo NGHÌN đồng (chuỗi). */
  entered: string;
  onEntered: (s: string) => void;
  onConfirm: () => void;
  confirming?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Bàn phím nhập tiền theo nghìn đồng + preset. Dùng chung cho 2 mode sheet. */
export function CollectKeypad({ remaining, entered, onEntered, onConfirm, confirming }: Props) {
  const enteredVal = (parseInt(entered, 10) || 0) * 1000;
  const press = (d: string) => onEntered((entered + d).replace(/^0+(?=\d)/, '').slice(0, 7));
  const back = () => onEntered(entered.slice(0, -1));
  const preset = (vDong: number) => onEntered(Math.round(vDong / 1000).toString());

  return (
    <div className="keypad">
      <div className="kp-display">
        <span className="kp-cur">Thu thêm</span>
        <span className="kp-amt">{fmtFull(enteredVal)}</span>
      </div>
      <div className="kp-presets">
        <span className="kp-preset due" onClick={() => preset(remaining)}>
          Còn lại {fmtShort(remaining)}
        </span>
        <span className="kp-preset" onClick={() => preset(500_000)}>500k</span>
        <span className="kp-preset" onClick={() => preset(1_000_000)}>1tr</span>
        <span className="kp-preset" onClick={() => preset(2_000_000)}>2tr</span>
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
        className="kp-confirm"
        disabled={enteredVal <= 0 || confirming}
        onClick={onConfirm}
      >
        Xác nhận thu {enteredVal > 0 ? fmtShort(enteredVal) : ''}
      </button>
    </div>
  );
}

export default CollectKeypad;
