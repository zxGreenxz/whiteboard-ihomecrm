// =============================================================================
// Quyết toán vận hành — toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
//
// Chủ nhà sở hữu toà, iHome vận hành và nhận % lợi nhuận tháng (lỗ thì phần % không tính) và/hoặc
// tiền cố định mỗi tháng (vẫn nhận đủ khi lỗ — chủ chốt 23/10/2026) theo thoả thuận. Mỗi tháng: ai
// đang giữ tiền (sổ chủ nhà / sổ quản lý) ⇒
// quyết toán chủ nhà trả quản lý hay quản lý trả lại chủ nhà, cộng dồn các tháng.
// Chỉ chủ công ty / super admin vào được — server chặn bằng 42501; route chỉ cần
// đăng nhập, giống trang Báo cáo Lợi Nhuận (gate bên trong trang).
// Công thức ở database; trang này chỉ hiển thị.
// =============================================================================
import { useState } from 'react';
import { Building2, Handshake, Link2, Lock, Plus, Settings2, Unlock, Wallet } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import EmptyState from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { OperationConfigDialog } from '@/components/landlord-settlement/OperationConfigDialog';
import { SettlementOverviewCard } from '@/components/landlord-settlement/SettlementOverviewCard';
import { SettlementStatementCard } from '@/components/landlord-settlement/SettlementStatementCard';
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
import {
  monthLabel,
  monthToDate,
  monthsDescending,
  type SettlementPayment,
} from '@/lib/landlordSettlement';

export default function LandlordSettlementPage() {
  const ops = useLandlordOperations();
  const [savedBuilding, setSavedBuilding] = usePersistedState<string | null>('flt:quyet-toan-van-hanh:toa', null);
  const [savedMonth, setSavedMonth] = usePersistedState<string | null>('flt:quyet-toan-van-hanh:thang', null);
  const [config, setConfig] = useState<{ buildingId: string | null } | null>(null);
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

  return (
    <MainLayout title="Quyết toán vận hành" subtitle="Toà vận hành cho chủ nhà — ai giữ tiền, ai trả ai từng tháng" icon={Handshake}>
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-full sm:w-56">
                <p className="mb-1 text-xs text-muted-foreground">Toà</p>
                <SearchableSelect
                  value={buildingId ?? undefined}
                  onValueChange={(v) => setSavedBuilding(v)}
                  options={operations.map((o) => ({
                    value: o.building_id,
                    label: o.is_active ? o.building_name : `${o.building_name} (ngừng)`,
                  }))}
                  placeholder="Chọn toà"
                />
              </div>
              <div className="w-full sm:w-44">
                <p className="mb-1 text-xs text-muted-foreground">Tháng</p>
                <SearchableSelect
                  value={month ?? undefined}
                  onValueChange={(v) => setSavedMonth(v)}
                  options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
                  placeholder={overview.isLoading ? 'Đang tải…' : 'Chưa tới tháng áp dụng'}
                />
              </div>
              <div className="flex flex-wrap gap-2 sm:ml-auto">
                {monthQ.data?.status === 'CLOSED' ? (
                  <Button type="button" variant="outline" onClick={() => setReopenOpen(true)}>
                    <Unlock className="mr-1.5 h-4 w-4" />Mở chốt
                  </Button>
                ) : (
                  <Button type="button" onClick={() => setCloseOpen(true)} disabled={!monthQ.data?.can_close}
                    title={monthQ.data && !monthQ.data.can_close ? 'Chưa chốt được — xem lý do trong bảng tháng' : undefined}>
                    <Lock className="mr-1.5 h-4 w-4" />Chốt tháng
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => setPayOpen(true)} disabled={!buildingId}>
                  <Wallet className="mr-1.5 h-4 w-4" />Ghi nhận thanh toán
                </Button>
                <Button type="button" variant="outline" onClick={() => setShareOpen(true)} disabled={!buildingId}>
                  <Link2 className="mr-1.5 h-4 w-4" />Link cho chủ nhà
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfig({ buildingId })} disabled={!buildingId}>
                  <Settings2 className="mr-1.5 h-4 w-4" />Cài đặt toà
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfig({ buildingId: null })}>
                  <Plus className="mr-1.5 h-4 w-4" />Thêm toà
                </Button>
              </div>
            </div>

            {operation && !operation.is_active && (
              <p className="rounded-md border border-amber-400 p-2 text-sm">Toà đang <b>ngừng áp dụng</b> vận hành cho chủ nhà — xem được số cũ, không chốt tháng mới.</p>
            )}

            <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              {/* Chưa tới tháng áp dụng thì không có tháng nào để hỏi — query tháng cố ý không chạy. */}
              <QueryRegion label="quyết toán tháng" queries={month ? [overview, monthQ] : [overview]} skeleton="detail">
                {monthQ.data
                  ? <SettlementStatementCard month={monthQ.data} mode="admin" />
                  : <EmptyState icon={Handshake} title="Chưa tới tháng áp dụng"
                      description={overview.data
                        ? `Thoả thuận của toà này bắt đầu từ ${monthLabel(overview.data.effective_from).toLowerCase()}.`
                        : 'Thoả thuận của toà này chưa tới tháng bắt đầu.'} />}
              </QueryRegion>
              <QueryRegion label="tổng quyết toán" queries={[overview]} skeleton="table">
                {overview.data && (
                  <SettlementOverviewCard
                    overview={overview.data}
                    mode="admin"
                    selectedMonth={month}
                    onSelectMonth={(m) => setSavedMonth(m)}
                    onVoidPayment={setVoidTarget}
                  />
                )}
              </QueryRegion>
            </div>
          </div>
        )}
      </QueryRegion>

      {config && ops.data && (
        <OperationConfigDialog
          open={!!config}
          onOpenChange={(open) => { if (!open) setConfig(null); }}
          candidates={ops.data.candidate_buildings}
          initialBuildingId={config.buildingId}
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
