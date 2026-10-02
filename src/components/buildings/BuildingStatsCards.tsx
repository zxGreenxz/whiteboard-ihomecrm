import { Building2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InlineSkeleton } from '@/components/loading/LoadingState';

interface BuildingStatsCardsProps {
  total: number;
  active: number;
  inactive: number;
  /** Chưa có số: khung thẻ hiện, ô số là vạch xám — không in 0 (chủ chốt 02/10/2026). */
  loading?: boolean;
}

const STAT_CARDS = [
  {
    key: 'total' as const,
    label: 'Tất cả toà nhà',
    icon: Building2,
    iconColor: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
  },
  {
    key: 'active' as const,
    label: 'Đang hoạt động',
    icon: CheckCircle2,
    iconColor: 'text-green-600',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
  },
  {
    key: 'inactive' as const,
    label: 'Ngừng hoạt động',
    icon: XCircle,
    iconColor: 'text-red-600',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
  },
];

export default function BuildingStatsCards({ total, active, inactive, loading }: BuildingStatsCardsProps) {
  const values = { total, active, inactive };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {STAT_CARDS.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.key}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-4 bg-white',
              card.borderColor
            )}
          >
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', card.bgColor)}>
              <Icon className={cn('h-5 w-5', card.iconColor)} />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {loading ? <InlineSkeleton label={`số ${card.label.toLowerCase()}`} width="2.5rem" /> : values[card.key]}
              </p>
              <p className="text-xs text-muted-foreground">{card.label}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
