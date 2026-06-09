import { cn } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Lưu khi rời ô (vd persist invoices.notes ở chế độ xem). */
  onBlur?: () => void;
}

const QUICK_NOTES = ['Hẹn ngày mai', 'Đi vắng', 'Hẹn cuối tuần', 'Khất qua tháng', 'Đã nhắc'];

const split = (v: string): string[] => (v ? v.split(' · ').filter(Boolean) : []);

export function NoteEditor({ value, onChange, onBlur }: Props) {
  const parts = split(value);
  const toggleQuick = (q: string) => {
    const next = parts.includes(q) ? parts.filter((x) => x !== q) : [...parts, q];
    onChange(next.join(' · '));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {QUICK_NOTES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => toggleQuick(q)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs',
              parts.includes(q)
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-zinc-600 border-zinc-200',
            )}
          >
            {q}
          </button>
        ))}
      </div>
      <textarea
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="Ghi chú khi thu (vd: thiếu 500k, hẹn mai bù)…"
        className="w-full resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
      />
    </div>
  );
}

export default NoteEditor;
