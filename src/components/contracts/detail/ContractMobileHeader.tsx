import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import {
  getContractDisplayStatus,
  CONTRACT_STATUS_CONFIG,
  type ContractWithRelations,
} from '@/types/contract';
import { getRepresentativeName } from '@/lib/contractCustomerHelpers';

/** Header gọn của trang chi tiết HĐ trên mobile: Quay lại + mã HĐ + trạng thái
 *  + khách + phòng/toà + kỳ hạn. */
export function ContractMobileHeader({
  contract,
  onBack,
}: {
  contract: ContractWithRelations;
  onBack: () => void;
}) {
  const ds = getContractDisplayStatus(contract);
  const cfg = CONTRACT_STATUS_CONFIG[ds];
  const room = contract.room?.name ?? '—';
  const building = contract.room?.building?.name ?? '—';
  return (
    <div className="mb-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mb-2 h-9 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4 mr-1.5" />
        Quay lại
      </Button>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-base font-bold text-zinc-900 truncate">
            {contract.contract_number || contract.id.slice(0, 8)}
          </div>
          <div className="text-sm font-medium text-zinc-700 truncate mt-0.5">
            P.{room} · {building}
          </div>
          <div className="text-[13px] text-muted-foreground truncate">
            {getRepresentativeName(contract)}
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 ${cfg.color}`}>
          {cfg.label}
        </Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {format(new Date(contract.start_date), 'dd/MM/yyyy', { locale: vi })} →{' '}
        {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
      </div>
    </div>
  );
}
