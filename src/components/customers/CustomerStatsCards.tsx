import { Users, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CustomerStats, StatFilterType } from '@/types/customer';

interface CustomerStatsCardsProps {
  stats: CustomerStats;
  activeFilter: StatFilterType;
  onFilterChange: (filter: StatFilterType) => void;
}

const STAT_CARDS: {
  key: StatFilterType;
  label: string;
  icon: React.ElementType;
  iconColor: string;
  bgColor: string;
  statKey: keyof CustomerStats;
}[] = [
  {
    key: 'ALL',
    label: 'Tất cả',
    icon: Users,
    iconColor: 'text-green-600',
    bgColor: 'bg-green-50',
    statKey: 'total',
  },
  {
    key: 'FOREIGN',
    label: 'Khách nước ngoài',
    icon: Globe,
    iconColor: 'text-red-500',
    bgColor: 'bg-red-50',
    statKey: 'foreign',
  },
];

export default function CustomerStatsCards({
  stats,
  activeFilter,
  onFilterChange,
}: CustomerStatsCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
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
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', card.bgColor)}>
              <Icon className={cn('h-5 w-5', card.iconColor)} />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats[card.statKey]}</p>
              <p className="text-xs text-muted-foreground">{card.label}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
