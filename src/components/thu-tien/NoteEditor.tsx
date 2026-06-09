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
    <>
      <div className="note-chips">
        {QUICK_NOTES.map((q) => (
          <span
            key={q}
            className={'note-chip' + (parts.includes(q) ? ' on' : '')}
            onClick={() => toggleQuick(q)}
          >
            {q}
          </span>
        ))}
      </div>
      <textarea
        className="note-input"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="Ghi chú khi thu (vd: thiếu 500k, hẹn mai bù)…"
      />
    </>
  );
}

export default NoteEditor;
