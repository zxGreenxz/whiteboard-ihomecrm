// Màn "Tổ chức" — chỗ mà trước đây KHÔNG có ở đâu cả.
//
// Đây chính là khoảng trống chủ sở hữu nêu ra: "không thấy phần cài đặt công ty
// ở đâu". Hồ sơ tổ chức, số lượng phạm vi, lời mời đang chờ, và nhật ký phân
// quyền (có chuỗi hash chống sửa) đều nằm ở đây.

import { useEffect, useState } from 'react';
import {
  Building2,
  CalendarClock,
  Check,
  Landmark,
  Loader2,
  Mail,
  ScrollText,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  useOrganizationProfile,
  useRevokeInvitation,
  useUpdateOrganizationProfile,
  type AuthorizationAuditEvent,
} from '@/hooks/useOrganizationAuthorization';
import { LOAI_TV } from '@/components/authorization/MemberAuthorizationDialog';

const NHAN_SU_KIEN: Record<string, string> = {
  MEMBER_AUTHORIZATION_UPDATED: 'Sửa phân quyền thành viên',
  ROLE_CREATED: 'Tạo vai trò',
  ROLE_UPDATED: 'Sửa vai trò',
  MEMBER_INVITED: 'Mời thành viên',
  INVITATION_ACCEPTED: 'Chấp nhận lời mời',
  INVITATION_REVOKED: 'Thu hồi lời mời',
  ORGANIZATION_UPDATED: 'Sửa thông tin tổ chức',
};

export default function OrganizationPage() {
  const { data, isLoading, error } = useOrganizationProfile();
  const luuTen = useUpdateOrganizationProfile();
  const thuHoi = useRevokeInvitation();
  const [ten, setTen] = useState('');

  useEffect(() => {
    if (data?.name) setTen(data.name);
  }, [data?.name]);

  if (isLoading) {
    return (
      <MainLayout title="Tổ chức" icon={Landmark}>
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      </MainLayout>
    );
  }

  if (error || !data) {
    return (
      <MainLayout title="Tổ chức" icon={Landmark}>
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm">
            {(error as { message?: string })?.message ??
              'Bạn không có quyền xem thông tin tổ chức.'}
          </CardContent>
        </Card>
      </MainLayout>
    );
  }

  const c = data.counts;
  const loiMoiChoDuyet = data.invitations.filter((i) => i.status === 'PENDING' && !i.isExpired);

  return (
    <MainLayout
      title="Tổ chức"
      subtitle="Hồ sơ công ty, phạm vi phân quyền và nhật ký thay đổi"
      icon={Landmark}
    >
      <div className="space-y-4">
        {/* Hồ sơ */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              Hồ sơ tổ chức
              {data.isDemo && <Badge variant="outline">Bản demo</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="ten">Tên tổ chức</Label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="ten"
                    value={ten}
                    disabled={!data.canEdit}
                    onChange={(e) => setTen(e.target.value)}
                  />
                  {data.canEdit && ten.trim() !== data.name && (
                    <Button
                      onClick={() => luuTen.mutate(ten.trim())}
                      disabled={!ten.trim() || luuTen.isPending}
                    >
                      {luuTen.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
                {!data.canEdit && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Cần quyền "Sửa cài đặt chung" để đổi tên.
                  </p>
                )}
              </div>
              <div>
                <Label>Mã định danh</Label>
                <Input className="mt-1.5 font-mono text-xs" value={data.slug} readOnly disabled />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Mã kỹ thuật, không đổi được — nhiều nơi trong hệ thống tham chiếu tới nó.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Số liệu */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ODem icon={Users} nhan="Thành viên" so={c.members} phu={`${c.owners} chủ sở hữu`} />
          <ODem icon={ShieldCheck} nhan="Mẫu vai trò" so={c.roles} />
          <ODem
            icon={Building2}
            nhan="Phạm vi địa điểm"
            so={c.buildings + c.areas}
            phu={`${c.buildings} toà · ${c.areas} khu vực`}
          />
          <ODem icon={Wallet} nhan="Sổ quỹ" so={c.cashbooks} phu={`${c.activeOverrides} ngoại lệ đang bật`} />
        </div>

        {/* Lời mời */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4" />
              Lời mời
              {loiMoiChoDuyet.length > 0 && (
                <Badge variant="secondary">{loiMoiChoDuyet.length} đang chờ</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data.invitations.length ? (
              <p className="text-sm text-muted-foreground">
                Chưa có lời mời nào trong 90 ngày qua.
              </p>
            ) : (
              <div className="space-y-1.5">
                {data.invitations.map((i) => (
                  <div
                    key={i.invitationId}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{i.email}</span>
                    <Badge variant="outline" className="font-normal">
                      {LOAI_TV[i.memberType] ?? i.memberType}
                    </Badge>
                    {i.roleName && (
                      <Badge variant="secondary" className="font-normal">
                        {i.roleName}
                      </Badge>
                    )}
                    <TrangThaiLoiMoi status={i.status} isExpired={i.isExpired} />
                    {i.status === 'PENDING' && !i.isExpired && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => thuHoi.mutate(i.invitationId)}
                        disabled={thuHoi.isPending}
                      >
                        <X className="mr-1 h-3.5 w-3.5" />
                        Thu hồi
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Nhật ký */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="h-4 w-4" />
              Nhật ký phân quyền
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              50 thay đổi gần nhất. Mỗi dòng được móc xích bằng mã băm — sửa hoặc xoá một dòng sẽ
              làm gãy chuỗi và bị phát hiện.
            </p>
          </CardHeader>
          <CardContent>
            {!data.auditTrail.length ? (
              <p className="text-sm text-muted-foreground">
                Chưa có thay đổi phân quyền nào được ghi nhận.
              </p>
            ) : (
              <ScrollArea className="h-72">
                <div className="space-y-1.5 pr-3">
                  {data.auditTrail.map((e) => (
                    <DongNhatKy key={e.eventId} e={e} />
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}

function ODem({
  icon: Icon,
  nhan,
  so,
  phu,
}: {
  icon: React.ElementType;
  nhan: string;
  so: number;
  phu?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {nhan}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{so}</p>
        {phu && <p className="mt-0.5 text-xs text-muted-foreground">{phu}</p>}
      </CardContent>
    </Card>
  );
}

function TrangThaiLoiMoi({ status, isExpired }: { status: string; isExpired: boolean }) {
  if (isExpired)
    return (
      <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
        <CalendarClock className="h-3 w-3" />
        hết hạn
      </Badge>
    );
  const map: Record<string, { nhan: string; cls: string }> = {
    PENDING: { nhan: 'đang chờ', cls: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200' },
    ACCEPTED: { nhan: 'đã vào', cls: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' },
    REVOKED: { nhan: 'đã thu hồi', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
    EXPIRED: { nhan: 'hết hạn', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  };
  const m = map[status] ?? { nhan: status, cls: '' };
  return <Badge className={cn('border-0 font-normal', m.cls)}>{m.nhan}</Badge>;
}

function DongNhatKy({ e }: { e: AuthorizationAuditEvent }) {
  const nguoi = e.actorName || e.actorEmail || 'hệ thống';
  const st = e.newState as { permissions?: number; gained?: string[]; lost?: string[] } | null;
  return (
    <div className="rounded-md border p-2.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">{NHAN_SU_KIEN[e.eventType] ?? e.eventType}</span>
        <span className="text-xs text-muted-foreground">
          {nguoi} · {new Date(e.occurredAt).toLocaleString('vi-VN')}
        </span>
      </div>
      {e.reason && <p className="mt-1 text-xs text-muted-foreground">Lý do: {e.reason}</p>}
      {(st?.gained?.length || st?.lost?.length) && (
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
          {!!st?.lost?.length && (
            <span className="text-destructive">−{st.lost.length} quyền</span>
          )}
          {!!st?.gained?.length && (
            <span className="text-emerald-600">+{st.gained.length} quyền</span>
          )}
        </div>
      )}
    </div>
  );
}
