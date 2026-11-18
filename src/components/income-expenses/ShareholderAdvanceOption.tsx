// Mục "Tạm Ứng" (tạm ứng lợi nhuận cổ đông) trong ô chọn hạng mục của form Thu chi ĐẦY ĐỦ, phiếu CHI tạo mới.
//
// Hạng mục "Tạm Ứng" là hạng mục hệ thống (ẩn khỏi mọi ô chọn lập tay, người giữ sổ còn không đọc được dòng
// đó) nên KHÔNG đi qua danh mục: mục này đọc thẳng lựa chọn của máy chủ (R3 shareholder_profit_advance_options_v1)
// và CHỈ hiện khi máy chủ nói người đang đăng nhập lập được (`can_create`: sổ tổng chạy thật, đang giữ ít nhất
// một sổ quỹ, có người nhận được cấp quyền tạm ứng). R3 không mang số tiền nào của cổ đông.
// Form lô, tạo nhanh và Báo chi nhanh không gắn component này nên không bao giờ thấy mục Tạm Ứng.

import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShareholderAdvanceOptions } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import type { AdvanceOptions } from '@/lib/profitLedger/positionReaders';
import { advanceTypeName } from '@/lib/profitLedger/positionView';
import { normalizeLoose } from '@/lib/textMatch';

export interface ShareholderAdvanceOptionProps {
  organizationId: string | null;
  /** Chữ đang gõ ở ô tìm hạng mục: không khớp thì ẩn mục này như mọi hạng mục khác. */
  query: string;
  onPick: (options: AdvanceOptions) => void;
}

export function ShareholderAdvanceOption({ organizationId, query, onPick }: ShareholderAdvanceOptionProps) {
  const optionsQuery = useShareholderAdvanceOptions(organizationId);
  if (optionsQuery.isError) {
    // Không biết người này có lập được phiếu Tạm Ứng hay không: nói rõ, cho tải lại — không im lặng coi như "không".
    return (
      <p className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground" role="status" data-testid="shareholder-advance-option-error">
        Chưa kiểm tra được hạng mục Tạm Ứng (tạm ứng cổ đông).
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => { void optionsQuery.refetch(); }}>Tải lại</Button>
      </p>
    );
  }
  const options = optionsQuery.data;
  if (!options?.can_create) return null;
  const name = advanceTypeName(options);
  const needle = normalizeLoose(query);
  if (needle && !normalizeLoose(`${name} tạm ứng cổ đông lợi nhuận`).includes(needle)) return null;
  return (
    <div role="group" aria-label="Tạm ứng cổ đông" className="space-y-2" data-testid="shareholder-advance-option">
      <p className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tạm ứng cổ đông</p>
      <button
        type="button"
        onClick={() => onPick(options)}
        className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent"
      >
        <HandCoins className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block text-xs text-muted-foreground">
            Phiếu riêng một hạng mục: chi từ sổ quỹ bạn đang giữ cho cổ đông được cấp quyền tạm ứng, chờ chủ duyệt.
          </span>
        </span>
      </button>
    </div>
  );
}

export default ShareholderAdvanceOption;
