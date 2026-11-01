// =============================================================================
// /qt/:token — quyết toán vận hành CHỈ ĐỌC cho chủ nhà (không cần đăng nhập).
//
// Chủ chốt 21/10/2026: "chủ nhà cũng coi từng tháng toàn bộ trên trang này".
// Token do chủ công ty tạo ở màn Quyết toán vận hành, thu hồi được. Server trả
// NULL cho link sai hoặc đã thu hồi (không phân biệt), và bỏ id nội bộ khỏi gói.
// Giao diện v3 (23/10/2026): khung chung với màn quản trị; chủ nhà xác nhận đã xem số liệu tháng đã chốt
// ở tab Bàn giao (thao tác ghi DUY NHẤT của link, gắn với lần chốt đang hiện).
// =============================================================================
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { LinkIcon, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonBar } from '@/components/loading/LoadingState';
import { SettlementScreen } from '@/components/landlord-settlement/SettlementScreen';
import { useLandlordSettlementPublic } from '@/hooks/useLandlordSettlement';
import {
  landlordErrorMessage,
  monthKey,
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
  // đang đổi tháng thì gói hiện là của tháng trước (placeholder) — nút tháng theo tháng vừa chọn
  const selected = month ?? (data ? monthKey(data.month.period_month) : null);

  const errorBlock = (
    <div role="alert" className="rounded-md border border-destructive/40 bg-background p-4 text-sm">
      <p className="font-medium text-destructive">Chưa tải được quyết toán.</p>
      <p className="mt-1 text-muted-foreground">{landlordErrorMessage(q.error, 'Chưa tải được quyết toán')}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void q.refetch()}>
        <RefreshCw className="mr-1 h-3.5 w-3.5" />Tải lại
      </Button>
    </div>
  );

  let emptyBody: ReactNode;
  if (q.isLoading) {
    emptyBody = (
      <div className="space-y-3" aria-busy="true">
        <SkeletonBar className="h-11 w-full" />
        <SkeletonBar className="h-40 w-full" />
        <SkeletonBar className="h-64 w-full" />
      </div>
    );
  } else if (q.isError && !data) {
    emptyBody = errorBlock;
  } else if (q.isSuccess && !data) {
    emptyBody = (
      <div className="rounded-md border bg-background p-6 text-center">
        <LinkIcon className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">Link không còn hiệu lực</p>
        <p className="mt-1 text-sm text-muted-foreground">Link sai hoặc đã được thu hồi. Liên hệ bên quản lý để nhận link mới.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <SettlementScreen
        mode="public"
        buildingName={data?.overview.building_name ?? null}
        landlordName={data?.overview.landlord_name ?? null}
        month={data?.month ?? null}
        overview={data?.overview ?? null}
        months={months}
        selectedMonth={selected}
        onSelectMonth={setMonth}
        // nạp lại hỏng mà vẫn còn số cũ: báo + nút tải lại, giữ số đang xem
        notice={q.isError && data ? errorBlock : undefined}
        emptyBody={emptyBody}
        loading={q.isLoading}
        isFetching={q.isFetching && !q.isLoading}
        busy={q.isPlaceholderData}
        token={token}
      />
    </div>
  );
}
