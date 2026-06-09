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

/** Bàn phím nhập tiền theo nghìn đồng + preset. Dùng chung cho 2 mode drawer. */
export function CollectKeypad({ remaining, entered, onEntered, onConfirm, confirming }: Props) {
  const enteredVal = (parseInt(entered, 10) || 0) * 1000;
  const press = (d: string) => onEntered((entered + d).replace(/^0+(?=\d)/, '').slice(0, 7));
  const back = () => onEntered(entered.slice(0, -1));
  const preset = (vDong: number) => onEntered(Math.round(vDong / 1000).toString());

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between rounded-xl bg-zinc-50 px-4 py-3">
        <span className="text-sm text-zinc-500">Thu thêm</span>
        <span className="font-mono text-2xl font-bold tabular-nums text-zinc-900">
          {fmtFull(enteredVal)}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => preset(remaining)}
          className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
        >
          Còn lại {fmtShort(remaining)}
        </button>
        {[500_000, 1_000_000, 2_000_000].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => preset(v)}
            className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-600"
          >
            {fmtShort(v)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onEntered('')}
          className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-500"
        >
          Xóa
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            className="rounded-xl border border-zinc-200 bg-white py-3 text-lg font-semibold text-zinc-800 active:bg-zinc-100"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={() => press('000')}
          className="rounded-xl border border-zinc-200 bg-white py-3 text-lg font-semibold text-zinc-800 active:bg-zinc-100"
        >
          000
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          className="rounded-xl border border-zinc-200 bg-white py-3 text-lg font-semibold text-zinc-800 active:bg-zinc-100"
        >
          0
        </button>
        <button
          type="button"
          onClick={back}
          className="flex items-center justify-center rounded-xl border border-zinc-200 bg-white py-3 text-zinc-600 active:bg-zinc-100"
        >
          <Delete className="h-5 w-5" />
        </button>
      </div>

      <button
        type="button"
        disabled={enteredVal <= 0 || confirming}
        onClick={onConfirm}
        className="min-h-[48px] w-full rounded-xl bg-emerald-600 text-base font-semibold text-white disabled:opacity-40 active:bg-emerald-700"
      >
        Xác nhận thu {enteredVal > 0 ? fmtShort(enteredVal) : ''}
      </button>
    </div>
  );
}

export default CollectKeypad;
