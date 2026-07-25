// Màn "Thành viên" — thay hoàn toàn trang Phân quyền nhân viên cũ.
//
// Khác biệt cốt lõi so với trang cũ: nguồn dữ liệu là mô hình tổ chức
// (organization_memberships + role_bindings + member_permission_overrides),
// không còn staff_assignments. Trang cũ ghi được nhưng KHÔNG còn tác dụng kể từ
// cutover 25/07 — hai trigger đồng bộ đã tắt.

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Landmark,
  Loader2,
  Mail,
  Search,
  Settings2,
  ShieldCheck,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  useAuthorizationCatalog,
  useInviteMember,
  useOrganizationMembers,
  useOrganizationRoles,
  type MemberType,
  type OrganizationMember,
} from '@/hooks/useOrganizationAuthorization';
import {
  LOAI_TV,
  MemberAuthorizationDialog,
} from '@/components/authorization/MemberAuthorizationDialog';
import { ScopePicker, tenNgan } from '@/components/authorization/ScopePicker';

const MAU_LOAI: Record<string, string> = {
  OWNER: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  STAFF: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  SHAREHOLDER: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  PARTNER: 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
  SERVICE: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
};

export default function MembersPage() {
  const { data, isLoading, error } = useOrganizationMembers();
  const [tim, setTim] = useState('');
  const [dangSua, setDangSua] = useState<string | null>(null);
  const [moMoi, setMoMoi] = useState(false);

  const loc = useMemo(() => {
    const members = data?.members ?? [];
    const q = tim.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        (m.fullName ?? '').toLowerCase().includes(q) ||
        (m.email ?? '').toLowerCase().includes(q) ||
        m.roles.some((r) => r.roleName.toLowerCase().includes(q)),
    );
  }, [data?.members, tim]);

  return (
    <MainLayout
      title="Thành viên"
      subtitle="Ai đang ở trong tổ chức, mang vai trò gì, ở phạm vi nào"
      icon={Users}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={tim}
              onChange={(e) => setTim(e.target.value)}
              placeholder="Tìm theo tên, email hoặc vai trò…"
              className="pl-8"
            />
          </div>
          <Button onClick={() => setMoMoi(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Mời thành viên
          </Button>
        </div>

        {error && (
          <Card className="border-destructive/40">
            <CardContent className="flex gap-3 p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">Không xem được danh sách thành viên.</p>
                <p className="mt-1 text-muted-foreground">
                  {(error as { message?: string })?.message ??
                    'Bạn cần quyền "Vào trang phân quyền" trong tổ chức này.'}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {loc.map((m) => (
              <TheThanhVien key={m.membershipId} m={m} onSua={() => setDangSua(m.membershipId)} />
            ))}
            {!loc.length && !error && (
              <p className="col-span-full rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                {tim ? `Không có ai khớp “${tim}”.` : 'Tổ chức chưa có thành viên nào.'}
              </p>
            )}
          </div>
        )}
      </div>

      <MemberAuthorizationDialog
        membershipId={dangSua}
        open={!!dangSua}
        onOpenChange={(v) => !v && setDangSua(null)}
      />
      <HopThoaiMoi open={moMoi} onOpenChange={setMoMoi} />
    </MainLayout>
  );
}

/**
 * Gộp các bản ghi vai trò trùng tên thành MỘT dòng.
 *
 * Dữ liệu di trú từ hệ cũ tạo một bản ghi cho MỖI toà: chủ sở hữu đang có 18
 * bản ghi "Super Admin" giống hệt nhau. Liệt kê thẳng ra là 18 dòng vô nghĩa,
 * lấp mất thông tin thật (người này mang mấy vai trò). Gộp ở đây chỉ là hiển
 * thị — dữ liệu được chuẩn hoá thật khi lưu lần đầu ở hộp thoại phân quyền.
 */
function gopVaiTro(m: OrganizationMember) {
  const gop = new Map<string, { roleName: string; ten: string[]; toanTC: boolean }>();
  for (const r of m.roles) {
    const g = gop.get(r.roleId) ?? { roleName: r.roleName, ten: [], toanTC: false };
    for (const s of r.scopes) {
      if (s.scopeType === 'ORGANIZATION') g.toanTC = true;
      else if (!g.ten.includes(tenNgan(s.label))) g.ten.push(tenNgan(s.label));
    }
    gop.set(r.roleId, g);
  }
  return [...gop.values()];
}

function TheThanhVien({ m, onSua }: { m: OrganizationMember; onSua: () => void }) {
  const ten = m.fullName || m.email || 'Không tên';
  return (
    <Card className={cn(m.status !== 'ACTIVE' && 'opacity-70')}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{ten}</span>
              <Badge className={cn('border-0 font-normal', MAU_LOAI[m.memberType])}>
                {LOAI_TV[m.memberType] ?? m.memberType}
              </Badge>
              {m.isSelf && (
                <Badge variant="outline" className="font-normal">
                  bạn
                </Badge>
              )}
              {m.status !== 'ACTIVE' && (
                <Badge variant="destructive" className="font-normal">
                  {m.status === 'SUSPENDED' ? 'tạm dừng' : m.status.toLowerCase()}
                </Badge>
              )}
            </div>
            {m.email && <p className="truncate text-xs text-muted-foreground">{m.email}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={onSua}>
            <Settings2 className="mr-1.5 h-4 w-4" />
            Phân quyền
          </Button>
        </div>

        <div className="space-y-1.5">
          {gopVaiTro(m).map((r) => (
            <div key={r.roleName} className="flex flex-wrap items-center gap-1.5 text-sm">
              <Badge variant="secondary" className="gap-1 font-normal">
                <ShieldCheck className="h-3 w-3" />
                {r.roleName}
              </Badge>
              {r.toanTC ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Landmark className="h-3 w-3" />
                  toàn tổ chức
                </span>
              ) : r.ten.length ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {r.ten.slice(0, 3).join(' · ')}
                  {r.ten.length > 3 && ` +${r.ten.length - 3} nơi`}
                </span>
              ) : (
                // Bản ghi vai trò KHÔNG kèm phạm vi nào thì không cấp được gì —
                // bộ đánh giá đòi có cạnh phạm vi mới tính. Nói rõ thay vì để
                // trống, vì nhìn thoáng qua sẽ tưởng người này có quyền.
                <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  chưa gán phạm vi — không có tác dụng
                </span>
              )}
            </div>
          ))}
          {!m.roles.length && (
            <p className="text-xs text-muted-foreground">Chưa gán vai trò nào.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{m.permissionCount} quyền</span>
          {m.overrideAllow > 0 && <span className="text-emerald-600">+{m.overrideAllow} riêng</span>}
          {m.overrideDeny > 0 && <span className="text-destructive">−{m.overrideDeny} bị cấm</span>}
          {m.cashbooksHeld > 0 && (
            <span className="inline-flex items-center gap-1">
              <Wallet className="h-3 w-3" />
              giữ {m.cashbooksHeld} sổ
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── Hộp thoại mời ─────────────────────────── */

function HopThoaiMoi({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: roles = [] } = useOrganizationRoles(open);
  const { data: catalog } = useAuthorizationCatalog(open);
  const moi = useInviteMember();

  const [email, setEmail] = useState('');
  const [loai, setLoai] = useState<MemberType>('STAFF');
  const [roleId, setRoleId] = useState<string>('');
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [ketQua, setKetQua] = useState<{ link: string; expiresAt: string } | null>(null);

  const dong = () => {
    onOpenChange(false);
    setTimeout(() => {
      setEmail('');
      setRoleId('');
      setScopeIds([]);
      setKetQua(null);
    }, 200);
  };

  const gui = async () => {
    const r = await moi.mutateAsync({
      email: email.trim(),
      memberType: loai,
      roleId: roleId || null,
      scopeIds,
    });
    if (r?.token) {
      setKetQua({
        link: `${window.location.origin}/invite/${r.token}`,
        expiresAt: r.expiresAt,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : dong())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mời thành viên</DialogTitle>
          <DialogDescription>
            Người được mời tự đăng nhập bằng đúng email này rồi mở đường dẫn để vào tổ chức.
          </DialogDescription>
        </DialogHeader>

        {ketQua ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <p className="font-medium">Hệ thống chưa gửi email tự động.</p>
              <p className="mt-1 text-muted-foreground">
                Hãy sao chép đường dẫn dưới đây và gửi cho họ. Đường dẫn chỉ hiện{' '}
                <strong>một lần duy nhất</strong> — đóng hộp thoại là không xem lại được.
              </p>
            </div>
            <div className="flex gap-2">
              <Input readOnly value={ketQua.link} className="font-mono text-xs" />
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(ketQua.link);
                  toast.success('Đã sao chép đường dẫn.');
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Hết hạn: {new Date(ketQua.expiresAt).toLocaleString('vi-VN')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                className="mt-1.5"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nguoimoi@congty.com"
              />
            </div>
            <div>
              <Label>Loại thành viên</Label>
              <Select value={loai} onValueChange={(v) => setLoai(v as MemberType)}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['STAFF', 'PARTNER', 'SHAREHOLDER', 'OWNER'] as MemberType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {LOAI_TV[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {loai === 'OWNER' && (
                <p className="mt-1.5 flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Chủ sở hữu có toàn quyền, kể cả sửa phân quyền người khác.
                </p>
              )}
            </div>
            <div>
              <Label>Vai trò khi vào (tuỳ chọn)</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Chưa gán — cấp sau" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.roleId} value={r.roleId}>
                      {r.name} · {r.allowKeys.length} quyền
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {roleId && (
              <div>
                <Label>Áp vai trò ở đâu</Label>
                <ScopePicker
                  className="mt-1.5"
                  scopes={catalog?.scopes ?? []}
                  value={scopeIds}
                  onChange={setScopeIds}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {ketQua ? (
            <Button onClick={dong}>Xong</Button>
          ) : (
            <>
              <Button variant="outline" onClick={dong}>
                Huỷ
              </Button>
              <Button
                onClick={gui}
                disabled={!email.trim() || moi.isPending || (!!roleId && !scopeIds.length)}
              >
                {moi.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="mr-2 h-4 w-4" />
                )}
                Tạo lời mời
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
