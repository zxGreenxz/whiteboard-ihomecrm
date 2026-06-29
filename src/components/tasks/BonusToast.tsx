// Popup nổi "+30K Sửa vòi nước · 301/1392" hiển thị khi hoàn thành công việc có
// thưởng. Render qua Sonner `toast.custom` từ src/lib/salaryBonusNotify.ts.
// CSS (class .bonus-toast*) nằm ở cuối src/index.css.

interface BonusToastProps {
  /** Số tiền thưởng (đồng), vd 30000 */
  amount: number;
  /** Tên việc / nhãn thưởng, vd "Sửa vòi nước" */
  label: string;
  /** Mã tòa/phòng, vd "301 · 1392" (có thể rỗng với DAY_BONUS) */
  place?: string;
}

/** 30000 -> "+30K" (khớp helper SQL public.fmt_bonus_k). */
export function formatBonusK(amount: number): string {
  return `+${Math.round(amount / 1000)}K`;
}

export default function BonusToast({ amount, label, place }: BonusToastProps) {
  return (
    <div className="bonus-toast">
      <span className="bonus-toast__badge">{formatBonusK(amount)}</span>
      <div className="bonus-toast__body">
        <div className="bonus-toast__label">{label}</div>
        {place ? <div className="bonus-toast__place">{place}</div> : null}
      </div>
      <span className="bonus-toast__spark" aria-hidden>
        🎉
      </span>
    </div>
  );
}
