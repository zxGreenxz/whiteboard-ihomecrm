// Màn "Mẫu vai trò" — gói quyền dùng lại được.
//
// Vai trò KHÔNG chứa phạm vi. Phạm vi được gắn lúc gán vai trò cho người
// (role_bindings + role_binding_scopes), nên cùng một vai trò "Quản Lý Tòa" có
// thể áp cho toà A với người này và toà B với người kia. Đây là điểm khác lớn
// nhất so với "mẫu phân quyền" của hệ cũ — mẫu cũ chỉ là bản sao chép một lần,
// sửa mẫu không ảnh hưởng ai; vai trò mới thì sửa là ảnh hưởng NGAY tất cả
// người đang mang nó, nên màn này luôn hiện số người bị ảnh hưởng trước khi lưu.

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, Loader2, Lock, Plus, ShieldCheck, Users } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  useAuthorizationCatalog,
  useOrganizationRoles,
  useUpsertOrganizationRole,
  type OrganizationRole,
} from '@/hooks/useOrganizationAuthorization';
import { PermissionPicker } from '@/components/authorization/PermissionPicker';

export default function RolesPage() {
  const { data: roles = [], isLoading, error } = useOrganizationRoles();
  const [sua, setSua] = useState<{ role: OrganizationRole | null; nhanBan?: boolean } | null>(null);

  return (
    <MainLayout
      title="Mẫu vai trò"
      subtitle="Gói quyền dùng lại — gán cho người ở màn Thành viên"
      icon={ShieldCheck}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Sửa vai trò là <strong>ảnh hưởng ngay</strong> mọi người đang mang nó.
          </p>
          <Button onClick={() => setSua({ role: null })}>
            <Plus className="mr-2 h-4 w-4" />
            Tạo vai trò
          </Button>
        </div>

        {error && (
          <Card className="border-destructive/40">
            <CardContent className="flex gap-3 p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <p>{(error as { message?: string })?.message ?? 'Không xem được danh sách vai trò.'}</p>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {roles.map((r) => (
              <Card key={r.roleId}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate font-medium">
                        {r.isSystem && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        {r.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.isSystem ? 'Vai trò hệ thống — chỉ đọc' : 'Vai trò tự tạo'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="secondary" className="tabular-nums">
                      {r.allowKeys.length} quyền
                    </Badge>
                    {r.denyKeys.length > 0 && (
                      <Badge variant="destructive" className="tabular-nums">
                        {r.denyKeys.length} cấm
                      </Badge>
                    )}
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="h-3 w-3" />
                      {r.memberCount} người
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setSua({ role: r })}
                    >
                      {r.isSystem ? 'Xem quyền' : 'Sửa'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSua({ role: r, nhanBan: true })}
                      title="Nhân bản thành vai trò mới"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {sua && (
        <HopThoaiVaiTro
          role={sua.role}
          nhanBan={sua.nhanBan}
          open
          onOpenChange={(v) => !v && setSua(null)}
        />
      )}
    </MainLayout>
  );
}

function HopThoaiVaiTro({
  role,
  nhanBan,
  open,
  onOpenChange,
}: {
  role: OrganizationRole | null;
  nhanBan?: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: catalog } = useAuthorizationCatalog(open);
  const luu = useUpsertOrganizationRole();

  const taoMoi = !role || nhanBan;
  const chiDoc = !!role && role.isSystem && !nhanBan;

  const [ten, setTen] = useState('');
  const [allow, setAllow] = useState<Set<string>>(new Set());

  useEffect(() => {
    setTen(role ? (nhanBan ? `${role.name} (bản sao)` : role.name) : '');
    setAllow(new Set(role?.allowKeys ?? []));
  }, [role, nhanBan]);

  const availableKeys = useMemo(
    () => new Set((catalog?.permissions ?? []).map((p) => p.key)),
    [catalog],
  );

  const doi =
    ten !== (role && !nhanBan ? role.name : nhanBan ? `${role?.name} (bản sao)` : '') ||
    allow.size !== (role?.allowKeys.length ?? 0) ||
    [...allow].some((k) => !role?.allowKeys.includes(k));

  const gui = async () => {
    await luu.mutateAsync({
      roleId: taoMoi ? null : role!.roleId,
      name: ten.trim(),
      permissions: [...allow].map((k) => ({ permission_key: k, effect: 'ALLOW' as const })),
      expectedVersion: taoMoi ? null : role!.version,
      reason: taoMoi ? 'tạo vai trò mới' : 'cập nhật quyền của vai trò',
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {chiDoc ? 'Quyền của vai trò' : taoMoi ? 'Tạo vai trò mới' : 'Sửa vai trò'}
          </DialogTitle>
          <DialogDescription>
            {chiDoc
              ? 'Vai trò hệ thống không sửa được. Nhấn nút nhân bản ở thẻ để tạo bản sao rồi chỉnh.'
              : 'Chọn những việc người mang vai trò này được làm. Phạm vi (toà nào, sổ nào) chọn riêng lúc gán cho từng người.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto">
          <div>
            <Label htmlFor="ten">Tên vai trò</Label>
            <Input
              id="ten"
              className="mt-1.5"
              value={ten}
              disabled={chiDoc}
              onChange={(e) => setTen(e.target.value)}
              placeholder="Vd: Kế toán khu B"
            />
          </div>

          {!taoMoi && role && role.memberCount > 0 && !chiDoc && (
            <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                <strong>{role.memberCount} người</strong> đang mang vai trò này. Lưu là quyền của họ
                đổi ngay lập tức.
              </span>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>Quyền</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                đang bật {allow.size}
              </span>
            </div>
            <PermissionPicker
              height="h-[380px]"
              disabled={chiDoc}
              availableKeys={availableKeys}
              value={allow}
              onToggle={(k, bat) =>
                setAllow((s) => {
                  const n = new Set(s);
                  if (bat) n.add(k);
                  else n.delete(k);
                  return n;
                })
              }
              onToggleMany={(keys, bat) =>
                setAllow((s) => {
                  const n = new Set(s);
                  keys.forEach((k) => {
                    if (bat) n.add(k);
                    else n.delete(k);
                  });
                  return n;
                })
              }
            />
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center">
          <span
            className={cn(
              'mr-auto text-xs',
              allow.size === 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
            )}
          >
            {allow.size === 0
              ? 'Vai trò không có quyền nào — người mang nó sẽ không mở được màn hình nào.'
              : `${allow.size} quyền`}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {chiDoc ? 'Đóng' : 'Huỷ'}
          </Button>
          {!chiDoc && (
            <Button onClick={gui} disabled={!ten.trim() || !doi || luu.isPending}>
              {luu.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {taoMoi ? 'Tạo vai trò' : 'Lưu thay đổi'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
