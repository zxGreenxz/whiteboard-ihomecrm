// =============================================================================
// /qt/:token — quyết toán vận hành CHỈ ĐỌC cho chủ nhà (không cần đăng nhập).
//
// Chủ chốt 21/10/2026: "chủ nhà cũng coi từng tháng toàn bộ trên trang này".
// Token do chủ công ty tạo ở màn Quyết toán vận hành, thu hồi được. Server trả
// NULL cho link sai hoặc đã thu hồi (không phân biệt), và bỏ id nội bộ khỏi gói.
// =============================================================================
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Handshake, LinkIcon, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonBar } from '@/components/loading/LoadingState';
import { SettlementOverviewCard } from '@/components/landlord-settlement/SettlementOverviewCard';
import { SettlementStatementCard } from '@/components/landlord-settlement/SettlementStatementCard';
import { useLandlordSettlementPublic } from '@/hooks/useLandlordSettlement';
import {
  landlordErrorMessage,
  monthKey,
  monthLabel,
  monthToDate,
  monthsDescending,
} from '@/lib/landlordSettlement';

export default function LandlordSettlementPublicPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [month, setMonth] = useState<string | null>(null);
  const q = useLandlordSettlementPublic(token, month ? monthToDate(month) : null);
  const data = q.data ?? null;

  useEffect(() => {
    document.title = data ? `Quyết toán ${data.overview.building_name}` : 'Quyết toán vận hành';
  }, [data]);

  const months = data ? monthsDescending(data.overview.effective_from, data.overview.current_month) : [];
  const selected = data ? monthKey(data.month.period_month) : null;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <Handshake className="h-5 w-5 text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Quyết toán vận hành</p>
            {data && <p className="truncate text-xs text-muted-foreground">{data.overview.building_name} · Chủ nhà: {data.overview.landlord_name}</p>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {q.isLoading && (
          <div className="space-y-3" aria-busy="true">
            <SkeletonBar className="h-9 w-48" />
            <SkeletonBar className="h-40 w-full" />
            <SkeletonBar className="h-64 w-full" />
          </div>
        )}

        {q.isError && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-background p-4 text-sm">
            <p className="font-medium text-destructive">Chưa tải được quyết toán.</p>
            <p className="mt-1 text-muted-foreground">{landlordErrorMessage(q.error, 'Chưa tải được quyết toán')}</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void q.refetch()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />Tải lại
            </Button>
          </div>
        )}

        {q.isSuccess && !data && (
          <div className="rounded-md border bg-background p-6 text-center">
            <LinkIcon className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Link không còn hiệu lực</p>
            <p className="mt-1 text-sm text-muted-foreground">Link sai hoặc đã được thu hồi. Liên hệ bên quản lý để nhận link mới.</p>
          </div>
        )}

        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="qt-month" className="text-sm text-muted-foreground">Tháng</label>
              <select
                id="qt-month"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={selected ?? ''}
                onChange={(e) => setMonth(e.target.value || null)}
              >
                {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
              {q.isFetching && <span className="text-xs text-muted-foreground">Đang cập nhật…</span>}
            </div>
            <SettlementStatementCard month={data.month} mode="public" />
            <SettlementOverviewCard overview={data.overview} selectedMonth={selected} onSelectMonth={setMonth} />
            <p className="pb-6 text-center text-xs text-muted-foreground">
              Số liệu lấy trực tiếp từ sổ sách của bên quản lý. Tháng "tạm tính" còn thay đổi cho tới khi được chốt.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
