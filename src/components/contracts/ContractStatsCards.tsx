import { FileText, Clock, AlertTriangle, FileX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ContractStats, ContractStatFilter } from '@/types/contract';

interface ContractStatsCardsProps {
  stats: ContractStats;
  activeFilter: ContractStatFilter;
  onFilterChange: (filter: ContractStatFilter) => void;
}

const STAT_CARDS: {
  key: ContractStatFilter;
  label: string;
  icon: React.ElementType;
  iconColor: string;
  bgColor: string;
  textColor: string;
  statKey: keyof ContractStats;
}[] = [
  {
    key: 'ALL',
    label: 'Tất cả',
    icon: FileText,
    iconColor: 'text-green-600',
    bgColor: 'bg-green-50',
    textColor: 'text-green-600',
    statKey: 'total',
  },
  {
    key: 'EXPIRING',
    label: 'Sắp hết hạn',
    icon: Clock,
    iconColor: 'text-orange-500',
    bgColor: 'bg-orange-50',
    textColor: 'text-orange-500',
    statKey: 'expiring',
  },
  {
    key: 'EXPIRED',
    label: 'Quá hạn',
    icon: AlertTriangle,
    iconColor: 'text-red-500',
    bgColor: 'bg-red-50',
    textColor: 'text-red-500',
    statKey: 'expired',
  },
  {
    key: 'TERMINATED',
    label: 'Đã thanh lý',
    icon: FileX,
    iconColor: 'text-gray-500',
    bgColor: 'bg-gray-50',
    textColor: 'text-gray-500',
    statKey: 'terminated',
  },
];

export default function ContractStatsCards({
  stats,
  activeFilter,
  onFilterChange,
}: ContractStatsCardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {STAT_CARDS.map((card) => {
        const Icon = card.icon;
        const isActive = activeFilter === card.key;
        return (
          <button
            key={card.key}
            type="button"
            onClick={() => onFilterChange(card.key)}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-4 text-left transition-colors',
              isActive
                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                : 'border-gray-200 bg-white hover:border-gray-300'
            )}
          >
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-full', card.bgColor)}>
              <Icon className={cn('h-5 w-5', card.iconColor)} />
            </div>
            <div>
              <p className={cn('text-2xl font-bold', card.textColor)}>{stats[card.statKey]}</p>
              <p className="text-xs text-muted-foreground">{card.label}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
