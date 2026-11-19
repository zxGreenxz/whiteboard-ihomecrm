import { Loader2, RefreshCw, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsCompanyOwner } from '@/hooks/useIsCompanyOwner';
import { useCashbookReopeningState } from '@/hooks/useCashbookReopening';

interface Props {
  cashbookId: string;
  locked: boolean;
  onClick: () => void;
  compact?: boolean;
}

/** The general owner flag only avoids unnecessary requests; the server checks this book's organization. */
export default function CashbookReopenAction({ cashbookId, locked, onClick, compact = false }: Props) {
  const owner = useIsCompanyOwner();
  const state = useCashbookReopeningState(locked && !owner.isError && owner.data === true ? cashbookId : null);
  if (!locked) return null;

  const loading = owner.isLoading || (owner.data === true && state.isLoading);
  const failed = owner.isError || (owner.data === true && state.isError);
  const className = compact ? 'h-8 w-8 text-amber-700 hover:bg-amber-50' : 'w-full text-amber-800';
  if (loading) return <Button variant="ghost" size={compact ? 'icon' : 'default'} className={className} disabled aria-label="Đang kiểm tra quyền mở khóa"><Loader2 className="h-4 w-4 animate-spin" /></Button>;
  if (failed) return (
    <Button variant="ghost" size={compact ? 'icon' : 'default'} className={className}
      title="Chưa kiểm tra được quyền mở khóa. Thử lại" aria-label="Thử lại kiểm tra quyền mở khóa"
      onClick={(event) => { event.stopPropagation(); void (owner.isError ? owner.refetch() : state.refetch()); }}>
      <RefreshCw className="h-4 w-4" />{!compact && <span className="ml-2">Thử lại kiểm tra quyền mở khóa</span>}
    </Button>
  );
  if (owner.data !== true || state.data?.can_reopen !== true || !state.data.lock_date) return null;
  return (
    <Button variant="ghost" size={compact ? 'icon' : 'default'} className={className}
      title="Mở khóa sổ" aria-label="Mở khóa sổ"
      onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <Unlock className="h-4 w-4" />{!compact && <span className="ml-2">Mở khóa sổ</span>}
    </Button>
  );
}
