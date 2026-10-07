import { residenceSummaryLabel, type CustomerResidenceSummary } from '@/lib/customerResidenceHistory';

interface Props {
  summary?: CustomerResidenceSummary;
  loading?: boolean;
  error?: boolean;
  onOpen: () => void;
  onRetry: () => void;
}

export function CustomerResidenceCell({ summary, loading, error, onOpen, onRetry }: Props) {
  if (error) {
    return (
      <button
        type="button"
        className="text-sm text-destructive underline"
        onClick={event => { event.stopPropagation(); onRetry(); }}
      >
        Không tải được lưu trú · Thử lại
      </button>
    );
  }
  if (loading || !summary) {
    return <span role="status" className="text-sm text-muted-foreground">Đang tải lưu trú…</span>;
  }

  const label = residenceSummaryLabel(summary);
  return (
    <button
      type="button"
      className="text-left text-sm text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      onClick={event => { event.stopPropagation(); onOpen(); }}
      aria-label={`${label} · Xem lịch sử lưu trú`}
    >
      {label}
      {summary.incomplete && <span className="block text-xs text-muted-foreground">Lịch sử chưa đầy đủ</span>}
    </button>
  );
}
