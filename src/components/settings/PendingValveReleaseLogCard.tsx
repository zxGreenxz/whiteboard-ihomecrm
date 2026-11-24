import { Loader2, Unlock } from 'lucide-react';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useIsCompanyOwner } from '@/hooks/useIsCompanyOwner';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { usePendingValveReleaseLog, type PendingValveReleaseLogRow } from '@/hooks/usePendingValveReleaseLog';
import { formatPendingTime } from '@/lib/financialPending';
import { userAgentLabel } from '@/lib/userAgentLabel';

const NGUON_CONG_TY: Record<PendingValveReleaseLogRow['organizationSource'], string | null> = {
  pending: null,
  context: 'Công ty theo màn đang mở lúc gỡ',
  sole_membership: 'Công ty duy nhất của người gỡ',
};

/**
 * Mục «Nhật ký tự gỡ khoá» ở trang Cài đặt › Tổ chức (đợt 1b): mỗi lần một người tự xác nhận «Đã kiểm tra, cho làm
 * tiếp» để gỡ một yêu cầu chưa rõ kết quả. Chỉ đọc, công ty đang chọn, mới nhất trước.
 *
 * Chỉ superadmin và chủ công ty thấy mục này. Cờ hiển thị (`useIsSuperAdmin`, `useIsCompanyOwner`) chỉ quyết có hỏi
 * máy chủ hay không; hàng rào thật là hàm đọc, trả `allowed: false` cho người không đủ quyền ở công ty này, và khi đó
 * mục không hiện.
 */
export default function PendingValveReleaseLogCard() {
  const { selectedOrganizationId } = useOrganization();
  const superAdmin = useIsSuperAdmin();
  const companyOwner = useIsCompanyOwner();
  const mayRead = superAdmin.data === true || companyOwner.data === true;
  const log = usePendingValveReleaseLog(selectedOrganizationId, mayRead);
  if (!selectedOrganizationId || !mayRead) return null;
  if (log.data?.pages[0]?.allowed === false) return null;

  const rows = log.data?.pages.flatMap((page) => page.rows) ?? [];
  return (
    <Card data-testid="pending-valve-release-log">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Unlock className="h-4 w-4" aria-hidden />
          Nhật ký tự gỡ khoá
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Mỗi lần một người tự xác nhận «Đã kiểm tra, cho làm tiếp» để gỡ một yêu cầu chưa rõ kết quả (thường do
          rớt mạng). Mới nhất trước. Nhật ký chỉ thêm, không sửa hay xoá được.
        </p>
      </CardHeader>
      <CardContent>
        <QueryRegion label="nhật ký tự gỡ khoá" queries={[log]} skeleton="lines" rows={3}>
          {!rows.length ? (
            <p className="text-sm text-muted-foreground">Chưa có lần tự gỡ khoá nào được ghi nhận.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((row) => <DongGoKhoa key={row.id} row={row} />)}
            </ul>
          )}
          {log.hasNextPage && (
            <Button
              type="button" variant="outline" size="sm" className="mt-3 w-full sm:w-auto"
              onClick={() => { void log.fetchNextPage(); }} disabled={log.isFetchingNextPage}
            >
              {log.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Xem thêm
            </Button>
          )}
          {log.isFetchNextPageError && (
            <p role="alert" className="mt-2 text-sm text-destructive">Chưa tải được trang tiếp theo. Bấm «Xem thêm» để thử lại.</p>
          )}
        </QueryRegion>
      </CardContent>
    </Card>
  );
}

function DongGoKhoa({ row }: { row: PendingValveReleaseLogRow }) {
  const nguoi = row.actorName ?? `Tài khoản ${row.actorUserId.slice(0, 8)}`;
  const thaoTac = row.operation ?? row.namespace;
  const conLai = row.recordCount - row.recordIds.length;
  const nguonCongTy = NGUON_CONG_TY[row.organizationSource];
  return (
    <li className="rounded-md border p-2.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">{thaoTac}</span>
        <span className="text-xs text-muted-foreground">{nguoi} · gỡ lúc {formatPendingTime(row.releasedAt)}</span>
      </div>
      <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Kẹt từ</dt>
        <dd>{formatPendingTime(row.stuckAt)}</dd>
        <dt className="text-muted-foreground">Mã bản ghi</dt>
        <dd className="min-w-0">
          {row.recordIds.length ? (
            <span className="break-all font-mono">{row.recordIds.join(', ')}{conLai > 0 && ` và ${conLai} mã khác`}</span>
          ) : 'Chưa có mã nào được ghi nhận'}
        </dd>
        <dt className="text-muted-foreground">Khoá nghiệp vụ</dt>
        <dd className="min-w-0 break-all font-mono">{row.namespace} · {row.businessKey}</dd>
        <dt className="text-muted-foreground">Thiết bị</dt>
        <dd className="min-w-0" title={row.device ?? undefined}>{userAgentLabel(row.device)}</dd>
        {nguonCongTy && (
          <>
            <dt className="text-muted-foreground">Ghi chú</dt>
            <dd>{nguonCongTy}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
