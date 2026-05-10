import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInvoiceStatistics, type InvoiceStatisticsFilters } from '@/hooks/useInvoices';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  DollarSign,
  Home,
  Receipt,
  CreditCard,
  RefreshCcw,
  Banknote,
  TrendingDown,
} from 'lucide-react';

interface InvoiceStatsSummaryProps {
  filters?: InvoiceStatisticsFilters;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

const formatCompact = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'tỷ';
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'tr';
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return n.toLocaleString('vi-VN');
};

interface StatCard {
  label: string;
  value: string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  valueColor: string;
}

interface PlainCard {
  label: string;
  value: string;
}

const InvoiceStatsSummary = ({ filters }: InvoiceStatsSummaryProps) => {
  const isMobile = useIsMobile();
  const { data: stats, isLoading } = useInvoiceStatistics(filters);

  // TODO: API only returns total_paid, total_remaining, total_count
  // The following values need backend support: total_amount, rent_amount, service_amount, total_collected, total_refunded
  const totalPaid = stats?.total_paid ?? 0;
  const totalRemaining = stats?.total_remaining ?? 0;

  if (isMobile) {
    return <MobileStats totalPaid={totalPaid} isLoading={isLoading} />;
  }

  return <DesktopStats totalPaid={totalPaid} totalRemaining={totalRemaining} isLoading={isLoading} />;
};

// =============================================
// Mobile layout — 6 cards (2 cột × 3 hàng)
// =============================================

interface MobileStatsProps {
  totalPaid: number;
  isLoading: boolean;
}

const MobileStats = ({ totalPaid, isLoading }: MobileStatsProps) => {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 px-3 pt-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[78px] rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <section className="grid grid-cols-2 gap-2 px-3 pt-3">
      {/* Tổng (xanh lá) — TODO: cần total_amount từ API */}
      <ColoredMobileCard
        label="Tổng"
        value={0}
        Icon={DollarSign}
        iconColor="text-green-500"
        valueColor="text-green-600"
      />

      {/* Đã Thu (xanh dương) — data thật */}
      <ColoredMobileCard
        label="Đã Thu"
        value={totalPaid}
        Icon={Banknote}
        iconColor="text-blue-500"
        valueColor="text-blue-600"
      />

      {/* 4 placeholder: trắng-đen, không icon — chờ user định nghĩa */}
      <PlainMobileCard label="TM" value={0} />
      <PlainMobileCard label="TK" value={0} />
      <PlainMobileCard label="TT" value={0} />
      <PlainMobileCard label="Tiền Thối" value={0} />
    </section>
  );
};

interface ColoredMobileCardProps {
  label: string;
  value: number;
  Icon: React.ElementType;
  iconColor: string;
  valueColor: string;
}

const ColoredMobileCard = ({ label, value, Icon, iconColor, valueColor }: ColoredMobileCardProps) => (
  <div className="bg-white border border-zinc-200 rounded-xl p-3 min-h-[78px] flex flex-col gap-1">
    <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <Icon className={`h-3 w-3 ${iconColor}`} />
      {label}
    </div>
    <span className={`text-xl font-bold tabular-nums ${valueColor}`}>{formatCompact(value)}</span>
  </div>
);

const PlainMobileCard = ({ label, value }: { label: string; value: number }) => (
  <div className="bg-white border border-zinc-200 rounded-xl p-3 min-h-[78px] flex flex-col gap-1">
    <div className="text-[11px] font-medium tracking-wide text-zinc-900 uppercase">{label}</div>
    <span className="text-xl font-bold text-zinc-900 tabular-nums">{formatCompact(value)}</span>
  </div>
);

// =============================================
// Desktop layout — 7 card cũ + 4 card placeholder mới (4-3-4)
// =============================================

interface DesktopStatsProps {
  totalPaid: number;
  totalRemaining: number;
  isLoading: boolean;
}

const DesktopStats = ({ totalPaid, totalRemaining, isLoading }: DesktopStatsProps) => {
  const row1: StatCard[] = [
    {
      label: 'Tổng tiền',
      value: formatCurrency(0), // TODO: needs total_amount from API
      icon: DollarSign,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100',
      valueColor: 'text-green-600',
    },
    {
      label: 'Tiền nhà',
      value: formatCurrency(0), // TODO: needs rent_amount from API
      icon: Home,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      valueColor: 'text-blue-600',
    },
    {
      label: 'Tiền dịch vụ',
      value: formatCurrency(0), // TODO: needs service_amount from API
      icon: Receipt,
      iconColor: 'text-purple-600',
      iconBg: 'bg-purple-100',
      valueColor: 'text-purple-600',
    },
    {
      label: 'Tổng tiền thu',
      value: formatCurrency(0), // TODO: needs total_collected from API
      icon: CreditCard,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100',
      valueColor: 'text-green-600',
    },
  ];

  const row2: StatCard[] = [
    {
      label: 'Tổng tiền hoàn',
      value: formatCurrency(0), // TODO: needs total_refunded from API
      icon: RefreshCcw,
      iconColor: 'text-red-600',
      iconBg: 'bg-red-100',
      valueColor: 'text-red-600',
    },
    {
      label: 'Đã thu',
      value: formatCurrency(totalPaid),
      icon: Banknote,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      valueColor: 'text-blue-600',
    },
    {
      label: 'Phải thu',
      value: formatCurrency(totalRemaining),
      icon: TrendingDown,
      iconColor: 'text-orange-600',
      iconBg: 'bg-orange-100',
      valueColor: 'text-orange-600',
    },
  ];

  // 4 placeholder mới — TBD: data source sẽ định nghĩa sau
  const row3: PlainCard[] = [
    { label: 'TM', value: formatCurrency(0) },
    { label: 'TK', value: formatCurrency(0) },
    { label: 'TT', value: formatCurrency(0) },
    { label: 'Tiền Thối', value: formatCurrency(0) },
  ];

  const renderCard = (card: StatCard) => (
    <Card key={card.label} className="shadow-sm">
      <CardContent className="flex items-center gap-3 p-3">
        <div className={`h-11 w-11 rounded-full ${card.iconBg} flex items-center justify-center shrink-0`}>
          <card.icon className={`h-5 w-5 ${card.iconColor}`} />
        </div>
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-6 w-24 mb-1" />
          ) : (
            <p className={`text-lg font-bold ${card.valueColor} truncate`}>{card.value}</p>
          )}
          <p className="text-xs text-muted-foreground">{card.label}</p>
        </div>
      </CardContent>
    </Card>
  );

  const renderPlainCard = (card: PlainCard) => (
    <Card key={card.label} className="shadow-sm">
      <CardContent className="flex items-center gap-3 p-3">
        <div className="h-11 w-11 rounded-full bg-zinc-100 flex items-center justify-center shrink-0" />
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-6 w-24 mb-1" />
          ) : (
            <p className="text-lg font-bold text-zinc-900 truncate">{card.value}</p>
          )}
          <p className="text-xs text-zinc-900">{card.label}</p>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-3 mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{row1.map(renderCard)}</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">{row2.map(renderCard)}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{row3.map(renderPlainCard)}</div>
    </div>
  );
};

export default InvoiceStatsSummary;
