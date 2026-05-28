import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInvoiceStatistics, type InvoiceStatisticsFilters } from '@/hooks/useInvoices';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMyContext } from '@/hooks/useMyContext';
import {
  DollarSign,
  Home,
  Zap,
  Droplet,
  Wrench,
  RefreshCcw,
  Banknote,
  TrendingDown,
} from 'lucide-react';

interface InvoiceStatsSummaryProps {
  filters?: InvoiceStatisticsFilters;
}

// Toàn bộ số tiền hiển thị theo đơn vị K (1.000đ = 1K).
const formatK = (n: number) => `${Math.round((n || 0) / 1000).toLocaleString('vi-VN')}K`;

interface StatCard {
  label: string;
  value: number;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  valueColor: string;
}

interface PlainCard {
  label: string;
  value: number;
}

const InvoiceStatsSummary = ({ filters }: InvoiceStatsSummaryProps) => {
  const isMobile = useIsMobile();
  const { data: stats, isLoading } = useInvoiceStatistics(filters);
  const { data: ctx } = useMyContext();
  // Staff (không phải owner/super admin) chỉ thấy row 2 + row 3.
  const hideAggregateRow = ctx?.isStaff === true;

  const s = {
    total_amount: stats?.total_amount ?? 0,
    rent_amount: stats?.rent_amount ?? 0,
    electric_amount: stats?.electric_amount ?? 0,
    water_amount: stats?.water_amount ?? 0,
    pdv_amount: stats?.pdv_amount ?? 0,
    total_collected: stats?.total_collected ?? 0,
    total_refunded: stats?.total_refunded ?? 0,
    total_paid: stats?.total_paid ?? 0,
    total_remaining: stats?.total_remaining ?? 0,
    payment_tm: stats?.payment_tm ?? 0,
    payment_tk: stats?.payment_tk ?? 0,
    payment_tt: stats?.payment_tt ?? 0,
    change_amount: stats?.change_amount ?? 0,
    deposit_collected: stats?.deposit_collected ?? 0,
  };

  if (isMobile) {
    return <MobileStats s={s} isLoading={isLoading} hideAggregateRow={hideAggregateRow} />;
  }

  return <DesktopStats s={s} isLoading={isLoading} hideAggregateRow={hideAggregateRow} />;
};

type StatValues = {
  total_amount: number;
  rent_amount: number;
  electric_amount: number;
  water_amount: number;
  pdv_amount: number;
  total_collected: number;
  total_refunded: number;
  total_paid: number;
  total_remaining: number;
  payment_tm: number;
  payment_tk: number;
  payment_tt: number;
  change_amount: number;
  deposit_collected: number;
};

// =============================================
// Mobile layout — 2 cột
// =============================================

const MobileStats = ({
  s,
  isLoading,
  hideAggregateRow,
}: {
  s: StatValues;
  isLoading: boolean;
  hideAggregateRow: boolean;
}) => {
  if (isLoading) {
    const skeletonCount = hideAggregateRow ? 7 : 12;
    return (
      <div className="grid grid-cols-2 gap-2 px-3 pt-3">
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <Skeleton key={i} className="h-[78px] rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <section className="grid grid-cols-2 gap-2 px-3 pt-3">
      {!hideAggregateRow && (
        <>
          <ColoredMobileCard label="Tổng" value={s.total_amount} Icon={DollarSign} iconColor="text-green-500" valueColor="text-green-600" />
          <ColoredMobileCard label="Tiền nhà" value={s.rent_amount} Icon={Home} iconColor="text-blue-500" valueColor="text-blue-600" />
          <ColoredMobileCard label="Điện" value={s.electric_amount} Icon={Zap} iconColor="text-amber-500" valueColor="text-amber-600" />
          <ColoredMobileCard label="Nước" value={s.water_amount} Icon={Droplet} iconColor="text-sky-500" valueColor="text-sky-600" />
          <ColoredMobileCard label="PDV" value={s.pdv_amount} Icon={Wrench} iconColor="text-purple-500" valueColor="text-purple-600" />
        </>
      )}
      <ColoredMobileCard label="Đã Thu" value={s.total_paid} Icon={Banknote} iconColor="text-blue-500" valueColor="text-blue-600" />
      <ColoredMobileCard label="Phải thu" value={s.total_remaining} Icon={TrendingDown} iconColor="text-orange-500" valueColor="text-orange-600" />
      <ColoredMobileCard label="Tiền Hoàn" value={s.total_refunded} Icon={RefreshCcw} iconColor="text-red-500" valueColor="text-red-600" />
      <PlainMobileCard label="TM" value={s.payment_tm} />
      <PlainMobileCard label="TK" value={s.payment_tk} />
      <PlainMobileCard label="TT" value={s.payment_tt} />
      <PlainMobileCard label="Tiền Thối" value={s.change_amount} />
      <PlainMobileCard label="Cọc đã thu" value={s.deposit_collected} />
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
    <span className={`text-xl font-bold tabular-nums ${valueColor}`}>{formatK(value)}</span>
  </div>
);

const PlainMobileCard = ({ label, value }: { label: string; value: number }) => (
  <div className="bg-white border border-zinc-200 rounded-xl p-3 min-h-[78px] flex flex-col gap-1">
    <div className="text-[11px] font-medium tracking-wide text-zinc-900 uppercase">{label}</div>
    <span className="text-xl font-bold text-zinc-900 tabular-nums">{formatK(value)}</span>
  </div>
);

// =============================================
// Desktop layout
// =============================================

const DesktopStats = ({
  s,
  isLoading,
  hideAggregateRow,
}: {
  s: StatValues;
  isLoading: boolean;
  hideAggregateRow: boolean;
}) => {
  // Hàng 1 (5 cột): Tổng tiền | Tiền nhà | Điện | Nước | PDV
  const row1: StatCard[] = [
    {
      label: 'Tổng tiền',
      value: s.total_amount,
      icon: DollarSign,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100',
      valueColor: 'text-green-600',
    },
    {
      label: 'Tiền nhà',
      value: s.rent_amount,
      icon: Home,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      valueColor: 'text-blue-600',
    },
    {
      label: 'Tiền điện',
      value: s.electric_amount,
      icon: Zap,
      iconColor: 'text-amber-600',
      iconBg: 'bg-amber-100',
      valueColor: 'text-amber-600',
    },
    {
      label: 'Tiền nước',
      value: s.water_amount,
      icon: Droplet,
      iconColor: 'text-sky-600',
      iconBg: 'bg-sky-100',
      valueColor: 'text-sky-600',
    },
    {
      label: 'PDV',
      value: s.pdv_amount,
      icon: Wrench,
      iconColor: 'text-purple-600',
      iconBg: 'bg-purple-100',
      valueColor: 'text-purple-600',
    },
  ];

  // Hàng 2 (3 cột): Đã thu | Phải thu | Tiền Hoàn
  // (Bỏ "Tổng tiền thu" vì = "Đã thu" khi không có overpayment.)
  const row2: StatCard[] = [
    {
      label: 'Đã thu',
      value: s.total_paid,
      icon: Banknote,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      valueColor: 'text-blue-600',
    },
    {
      label: 'Phải thu',
      value: s.total_remaining,
      icon: TrendingDown,
      iconColor: 'text-orange-600',
      iconBg: 'bg-orange-100',
      valueColor: 'text-orange-600',
    },
    {
      label: 'Tiền Hoàn',
      value: s.total_refunded,
      icon: RefreshCcw,
      iconColor: 'text-red-600',
      iconBg: 'bg-red-100',
      valueColor: 'text-red-600',
    },
  ];

  // Hàng 3 (5 cột): TM | TK | TT | Tiền Thối | Cọc đã thu
  const row3: PlainCard[] = [
    { label: 'TM', value: s.payment_tm },
    { label: 'TK', value: s.payment_tk },
    { label: 'TT', value: s.payment_tt },
    { label: 'Tiền Thối', value: s.change_amount },
    { label: 'Cọc đã thu', value: s.deposit_collected },
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
            <p className={`text-lg font-bold ${card.valueColor} truncate`}>{formatK(card.value)}</p>
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
            <p className="text-lg font-bold text-zinc-900 truncate">{formatK(card.value)}</p>
          )}
          <p className="text-xs text-zinc-900">{card.label}</p>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-3 mb-6">
      {!hideAggregateRow && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">{row1.map(renderCard)}</div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">{row2.map(renderCard)}</div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">{row3.map(renderPlainCard)}</div>
    </div>
  );
};

export default InvoiceStatsSummary;
