interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Lưu khi rời ô (vd persist invoices.notes ở chế độ xem). */
  onBlur?: () => void;
}

export function NoteEditor({ value, onChange, onBlur }: Props) {
  return (
    <textarea
      className="note-input"
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder="Ghi chú khi thu (vd: thiếu 500k, hẹn mai bù)…"
    />
  );
}

export default NoteEditor;
