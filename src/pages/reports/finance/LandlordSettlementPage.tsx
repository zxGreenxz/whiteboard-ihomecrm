// =============================================================================
// Quyết toán vận hành — toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
//
// Chủ nhà sở hữu toà, iHome vận hành và nhận % lợi nhuận tháng (lỗ thì phần % không tính) và/hoặc
// tiền cố định mỗi tháng (vẫn nhận đủ khi lỗ — chủ chốt 23/10/2026) theo thoả thuận. Mỗi tháng: ai
// đang giữ tiền (sổ chủ nhà / sổ quản lý) ⇒
// quyết toán chủ nhà trả quản lý hay quản lý trả lại chủ nhà, cộng dồn các tháng.
// Chỉ chủ công ty / super admin vào được — server chặn bằng 42501; route chỉ cần
// đăng nhập, giống trang Báo cáo Lợi Nhuận (gate bên trong trang).
// Công thức ở database; trang này chỉ hiển thị. Giao diện v3 (23/10/2026): khung chung với link chủ nhà
// (src/components/landlord-settlement/SettlementScreen.tsx), các nút quản trị nằm ở đầu trang.
// =============================================================================
import { useState } from 'react';
import { Building2, Check, ChevronDown, Handshake, Link2, Lock, Plus, Settings2, Unlock, Wallet } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import EmptyState from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { OperationConfigDialog } from '@/components/landlord-settlement/OperationConfigDialog';
import { SettlementOverviewCard } from '@/components/landlord-settlement/SettlementOverviewCard';
import { HeroButton } from '@/components/landlord-settlement/SettlementHero';
import { SettlementScreen } from '@/components/landlord-settlement/SettlementScreen';
import { ShareLinkDialog } from '@/components/landlord-settlement/ShareLinkDialog';
import {
  CloseMonthDialog,
  PaymentDialog,
  ReopenMonthDialog,
  VoidPaymentDialog,
} from '@/components/landlord-settlement/SettlementActionDialogs';
import {
  useLandlordOperations,
  useLandlordSettlementMonth,
  useLandlordSettlementOverview,
} from '@/hooks/useLandlordSettlement';
import usePersistedState from '@/hooks/usePersistedState';
import { cn } from '@/lib/utils';
import {
  monthKey,
  monthLabel,
  monthToDate,
  monthsDescending,
  type DepositHolder,
  type LandlordOperation,
  type SettlementPayment,
} from '@/lib/landlordSettlement';

/** Nút chọn toà trên nền tối của đầu trang. */
function BuildingPicker({ operations, value, onChange }: {
  operations: readonly LandlordOperation[];
  value: string | null;
  onChange: (buildingId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = operations.find((o) => o.building_id === value) ?? null;
  const tim = q.trim().toLocaleLowerCase('vi-VN');
  const shown = tim ? operations.filter((o) => o.building_name.toLocaleLowerCase('vi-VN').includes(tim)) : operations;
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQ(''); }}>
      <PopoverTrigger asChild>
        <HeroButton aria-label={`Chọn toà — đang xem ${current?.building_name ?? 'chưa chọn'}`} data-testid="settlement-building-picker">
          <Building2 className="h-3.5 w-3.5 text-white/55" aria-hidden />
          <span className="max-w-[160px] truncate">{current ? current.building_name : 'Chọn toà'}</span>
          <ChevronDown className="h-3.5 w-3.5 text-white/55" aria-hidden />
        </HeroButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {operations.length > 6 && (
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm toà" aria-label="Tìm toà" className="mb-1 h-8" />
        )}
        <div role="listbox" aria-label="Toà vận hành cho chủ nhà" className="max-h-72 overflow-y-auto">
          {shown.map((o) => {
            const on = o.building_id === value;
            return (
              <button key={o.building_id} type="button" role="option" aria-selected={on}
                onClick={() => { onChange(o.building_id); setOpen(false); setQ(''); }}
                className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted', on && 'font-semibold')}>
                <Check className={cn('h-3.5 w-3.5 shrink-0', on ? 'opacity-100' : 'opacity-0')} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{o.building_name}</span>
                {!o.is_active && <span className="shrink-0 text-xs text-muted-foreground">ngừng</span>}
              </button>
            );
          })}
          {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">Không có toà khớp.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ConfigTarget {
  buildingId: string | null;
  /** Nút gạt người giữ cọc: mở sẵn tháng đang xem với người giữ cọc mới. */
  termsMonth?: string;
  depositHolder?: DepositHolder;
}

export default function LandlordSettlementPage() {
  const ops = useLandlordOperations();
  const [savedBuilding, setSavedBuilding] = usePersistedState<string | null>('flt:quyet-toan-van-hanh:toa', null);
  const [savedMonth, setSavedMonth] = usePersistedState<string | null>('flt:quyet-toan-van-hanh:thang', null);
  const [config, setConfig] = useState<ConfigTarget | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<SettlementPayment | null>(null);

  const operations = ops.data?.operations ?? [];
  const buildingId = operations.some((o) => o.building_id === savedBuilding)
    ? savedBuilding
    : operations[0]?.building_id ?? null;
  const operation = operations.find((o) => o.building_id === buildingId) ?? null;

  const overview = useLandlordSettlementOverview(buildingId);
  const months = overview.data ? monthsDescending(overview.data.effective_from, overview.data.current_month) : [];
  const month = savedMonth && months.includes(savedMonth) ? savedMonth : months[0] ?? null;
  const monthQ = useLandlordSettlementMonth(buildingId, month ? monthToDate(month) : null);

  const notAllowed = ops.data && !ops.data.can_manage;
  const balance = overview.data?.totals.balance_with_open ?? 0;
  const showScreen = !!ops.data && !notAllowed && operations.length > 0;
  const m = monthQ.data ?? null;

  const actions = (
    <>
      {m?.status === 'CLOSED' ? (
        <HeroButton onClick={() => setReopenOpen(true)}>
          <Unlock className="h-3.5 w-3.5 text-white/55" aria-hidden />Mở chốt
        </HeroButton>
      ) : (
        <HeroButton primary onClick={() => setCloseOpen(true)} disabled={!m?.can_close}
          title={m && !m.can_close ? 'Chưa chốt được — xem lý do ở chip đầu trang và tab Quyết toán' : undefined}>
          <Lock className="h-3.5 w-3.5" aria-hidden />Chốt tháng
        </HeroButton>
      )}
      <HeroButton onClick={() => setPayOpen(true)} disabled={!buildingId}>
        <Wallet className="h-3.5 w-3.5 text-white/55" aria-hidden />Ghi nhận thanh toán
      </HeroButton>
      <HeroButton onClick={() => setShareOpen(true)} disabled={!buildingId}>
        <Link2 className="h-3.5 w-3.5 text-white/55" aria-hidden />Link cho chủ nhà
      </HeroButton>
      <HeroButton onClick={() => setConfig({ buildingId })} disabled={!buildingId}>
        <Settings2 className="h-3.5 w-3.5 text-white/55" aria-hidden />Cài đặt toà
      </HeroButton>
      <HeroButton onClick={() => setConfig({ buildingId: null })}>
        <Plus className="h-3.5 w-3.5 text-white/55" aria-hidden />Thêm toà
      </HeroButton>
    </>
  );

  // chưa tới tháng áp dụng: không có tháng nào để hỏi — query tháng cố ý không chạy
  const emptyBody = overview.data && months.length === 0 ? (
    <>
      <EmptyState icon={Handshake} title="Chưa tới tháng áp dụng"
        description={`Thoả thuận của toà này bắt đầu từ ${monthLabel(overview.data.effective_from).toLowerCase()}.`} />
      <SettlementOverviewCard overview={overview.data} mode="admin" selectedMonth={null} onVoidPayment={setVoidTarget} />
    </>
  ) : undefined;

  return (
    <MainLayout title={showScreen ? undefined : 'Quyết toán vận hành'}
      subtitle={showScreen ? undefined : 'Toà vận hành cho chủ nhà — ai giữ tiền, ai trả ai từng tháng'}
      icon={showScreen ? undefined : Handshake}>
      <QueryRegion label="danh sách toà vận hành" queries={[ops]} skeleton="cards">
        {notAllowed ? (
          <EmptyState icon={Lock} title="Chỉ chủ công ty hoặc quản trị hệ thống" description="Trang quyết toán vận hành chỉ mở cho chủ công ty và quản trị hệ thống." />
        ) : operations.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Chưa có toà vận hành cho chủ nhà"
            description="Cài đặt toà: tên chủ nhà, phần quản lý theo thoả thuận (% lợi nhuận và/hoặc tiền cố định mỗi tháng), tháng bắt đầu và sổ quỹ của chủ nhà."
            actionLabel="Cài đặt toà vận hành"
            onAction={() => setConfig({ buildingId: null })}
          />
        ) : (
          // đầu trang tràn hết bề ngang khung nội dung (bù padding của MainLayout)
          <div className="-mx-4 -mt-4 lg:-mx-6 lg:-mt-6">
            <SettlementScreen
              mode="admin"
              buildingName={operation?.building_name ?? null}
              landlordName={operation?.landlord_name ?? null}
              month={m}
              overview={overview.data ?? null}
              months={months}
              selectedMonth={month}
              onSelectMonth={(v) => setSavedMonth(v)}
              buildingPicker={<BuildingPicker operations={operations} value={buildingId} onChange={(v) => setSavedBuilding(v)} />}
              actions={actions}
              notice={operation && !operation.is_active ? (
                <p className="rounded-lg border border-amber-400 bg-card p-2.5 text-sm">
                  Toà đang <b>ngừng áp dụng</b> vận hành cho chủ nhà — xem được số cũ, không chốt tháng mới.
                </p>
              ) : undefined}
              emptyBody={emptyBody}
              wrapBody={(body) => (
                <QueryRegion label="quyết toán tháng" queries={month ? [overview, monthQ] : [overview]} skeleton="detail">
                  {body}
                </QueryRegion>
              )}
              stickyClassName="top-16 lg:top-0"
              loading={overview.isLoading || monthQ.isLoading}
              isFetching={monthQ.isFetching && !monthQ.isLoading}
              buildingId={buildingId ?? undefined}
              onVoidPayment={setVoidTarget}
              onRequestDepositHolder={(h) => {
                if (buildingId && m) setConfig({ buildingId, termsMonth: monthKey(m.period_month), depositHolder: h });
              }}
            />
          </div>
        )}
      </QueryRegion>

      {config && ops.data && (
        <OperationConfigDialog
          open={!!config}
          onOpenChange={(open) => { if (!open) setConfig(null); }}
          candidates={ops.data.candidate_buildings}
          initialBuildingId={config.buildingId}
          initialTermsMonth={config.termsMonth ?? null}
          initialDepositHolder={config.depositHolder ?? null}
          onSaved={(id) => setSavedBuilding(id)}
        />
      )}
      {buildingId && operation && (
        <>
          <ShareLinkDialog open={shareOpen} onOpenChange={setShareOpen} buildingId={buildingId} buildingName={operation.building_name} />
          <PaymentDialog open={payOpen} onOpenChange={setPayOpen} buildingId={buildingId} buildingName={operation.building_name}
            suggestedDirection={balance < 0 ? 'MANAGER_TO_LANDLORD' : 'LANDLORD_TO_MANAGER'} />
          <VoidPaymentDialog payment={voidTarget} onOpenChange={(open) => { if (!open) setVoidTarget(null); }} />
        </>
      )}
      {buildingId && monthQ.data && (
        <>
          <CloseMonthDialog open={closeOpen} onOpenChange={setCloseOpen} buildingId={buildingId} month={monthQ.data} />
          <ReopenMonthDialog open={reopenOpen} onOpenChange={setReopenOpen} buildingId={buildingId} month={monthQ.data} />
        </>
      )}
    </MainLayout>
  );
}
