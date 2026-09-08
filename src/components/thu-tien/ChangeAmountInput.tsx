interface Props { value: number; onChange: (value: number) => void; disabled?: boolean }

/** Editable in đồng (unlike the quick-collection keypad, which enters nghìn). */
export function ChangeAmountInput({ value, onChange, disabled }: Props) {
  return <label className="flex items-center gap-1">
    <input type="text" inputMode="numeric" aria-label="Tiền thối thực tế"
      className="w-32 min-w-0 rounded border border-amber-300 bg-white px-2 py-1 text-right font-semibold focus:outline-amber-600"
      value={value.toLocaleString('vi-VN')} disabled={disabled}
      onFocus={event => event.target.select()}
      onChange={event => onChange(Number(event.target.value.replace(/\D/g, '').slice(0, 12)) || 0)} />
    <span>đ</span>
  </label>;
}
