// Hộp thoại phân quyền một thành viên — 3 tab:
//
//   ① Vai trò & phạm vi  — cấp quyền theo GÓI, áp ở đâu (99% việc thường ngày)
//   ② Ngoại lệ           — thêm/bớt LẺ một quyền cho riêng người này, có lý do
//   ③ Quyền hiệu lực     — kết quả cuối cùng sau khi cộng trừ, để đối chiếu
//
// === HAI ĐIỀU DỄ SAI ĐÃ XỬ LÝ SẴN ===
//
// 1. GỘP BINDING THEO VAI TRÒ. Dữ liệu di trú từ hệ cũ tạo MỘT binding cho MỖI
//    toà: chủ sở hữu org thật đang có 18 binding cùng vai trò "Super Admin".
//    Hiện 18 dòng giống nhau là vô nghĩa. Ở đây gộp theo roleId và hợp nhất
//    phạm vi; vì RPC ghi theo ngữ nghĩa THAY THẾ nên lần lưu đầu tiên sẽ tự
//    chuẩn hoá 18 binding thành 1 binding 18 phạm vi — tương đương hoàn toàn.
//
// 2. KHOÁ CHỐNG GHI CHEN. `version` đọc lúc mở hộp thoại được gửi lại khi lưu.
//    Máy chủ so lệch thì trả 40001 và ta mời tải lại, thay vì âm thầm đè lên
//    thay đổi của người khác.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { findFeature, featureKey } from '@/lib/permissionPages';
import type { ActionKey } from '@/lib/permissions';
import {
  useAuthorizationCatalog,
  useMemberAuthorization,
  useOrganizationRoles,
  useSaveMemberAuthorization,
  type Effect,
  type SaveOverride,
  type SaveRoleBinding,
  type ScopeType,
} from '@/hooks/useOrganizationAuthorization';
import { PermissionPicker } from './PermissionPicker';
import { ScopePicker, ScopeSummary } from './ScopePicker';

/** Nhãn tiếng Việt của một khoá quyền, lấy từ catalog trang. */
export function nhanQuyen(key: string): { label: string; trang?: string } {
  const [mod, ...rest] = key.split('.');
  const ft = findFeature(mod, rest.join('.') as ActionKey);
  return ft ? { label: ft.label } : { label: key };
}

interface RoleRow {
  roleId: string;
  scopeIds: string[];
}
interface OverrideRow {
  permissionKey: string;
  effect: Effect;
  scopeIds: string[];
  reason: string;
}

interface Props {
  membershipId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function MemberAuthorizationDialog({ membershipId, open, onOpenChange }: Props) {
  const { data: mem, isLoading, refetch } = useMemberAuthorization(open ? membershipId : null);
  const { data: roles = [] } = useOrganizationRoles(open);
  const { data: catalog } = useAuthorizationCatalog(open);
  const luu = useSaveMemberAuthorization();

  const [tab, setTab] = useState('vaitro');
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [ovs, setOvs] = useState<OverrideRow[]>([]);
  const [lyDo, setLyDo] = useState('');
  const [themQuyen, setThemQuyen] = useState(false);
  const [ovMo, setOvMo] = useState<number | null>(null);

  const scopes = useMemo(() => catalog?.scopes ?? [], [catalog]);
  const permByKey = useMemo(
    () => new Map((catalog?.permissions ?? []).map((p) => [p.key, p])),
    [catalog],
  );
  const availableKeys = useMemo(() => new Set(permByKey.keys()), [permByKey]);
  const roleById = useMemo(() => new Map(roles.map((r) => [r.roleId, r])), [roles]);

  // Nạp lại mỗi lần mở / đổi người — gộp binding trùng vai trò (xem đầu file).
  useEffect(() => {
    if (!mem) return;
    const gop = new Map<string, Set<string>>();
    for (const b of mem.roleBindings) {
      const s = gop.get(b.roleId) ?? new Set<string>();
      b.scopeIds.forEach((id) => s.add(id));
      gop.set(b.roleId, s);
    }
    setRows([...gop].map(([roleId, s]) => ({ roleId, scopeIds: [...s] })));
    setOvs(
      mem.overrides.map((o) => ({
        permissionKey: o.permissionKey,
        effect: o.effect,
        scopeIds: o.scopeIds,
        reason: o.reason ?? '',
      })),
    );
    setLyDo('');
    setOvMo(null);
    setTab('vaitro');
  }, [mem]);

  const soBindingGoc = mem?.roleBindings.length ?? 0;
  const seGopLai = soBindingGoc > rows.length;

  /* ---------- Quyền hiệu lực tính tại chỗ (xem trước khi lưu) ---------- */
  const hieuLuc = useMemo(() => {
    const tuVaiTro = new Set<string>();
    for (const r of rows) {
      if (!r.scopeIds.length) continue;
      const role = roleById.get(r.roleId);
      if (!role) continue;
      const loai = new Set(
        r.scopeIds.map((id) => scopes.find((s) => s.scopeId === id)?.scopeType).filter(Boolean),
      ) as Set<ScopeType>;
      for (const k of role.allowKeys) {
        // Cạnh chỉ tính khi LOẠI phạm vi nằm trong scope_kinds của khoá.
        const pd = permByKey.get(k);
        if (pd && ![...loai].some((t) => pd.scopeKinds.includes(t))) continue;
        tuVaiTro.add(k);
      }
    }
    const camToanTC = new Set<string>();
    const themLe = new Set<string>();
    for (const o of ovs) {
      const toanTC = o.scopeIds.some(
        (id) => scopes.find((s) => s.scopeId === id)?.scopeType === 'ORGANIZATION',
      );
      if (o.effect === 'DENY') {
        if (toanTC) camToanTC.add(o.permissionKey);
      } else if (o.scopeIds.length) {
        themLe.add(o.permissionKey);
      }
    }
    const denyVaiTro = new Set(rows.flatMap((r) => roleById.get(r.roleId)?.denyKeys ?? []));
    const ket = new Set<string>();
    for (const k of [...tuVaiTro, ...themLe]) {
      if (camToanTC.has(k) || denyVaiTro.has(k)) continue;
      ket.add(k);
    }
    return { ket, tuVaiTro, themLe, camToanTC };
  }, [rows, ovs, roleById, scopes, permByKey]);

  const banDau = useMemo(() => new Set(mem?.effectiveKeys ?? []), [mem]);
  const themVao = useMemo(() => [...hieuLuc.ket].filter((k) => !banDau.has(k)).sort(), [hieuLuc, banDau]);
  const matDi = useMemo(() => [...banDau].filter((k) => !hieuLuc.ket.has(k)).sort(), [hieuLuc, banDau]);

  const coDoi =
    JSON.stringify(rows) !==
      JSON.stringify(
        (() => {
          const g = new Map<string, Set<string>>();
          for (const b of mem?.roleBindings ?? []) {
            const s = g.get(b.roleId) ?? new Set<string>();
            b.scopeIds.forEach((i) => s.add(i));
            g.set(b.roleId, s);
          }
          return [...g].map(([roleId, s]) => ({ roleId, scopeIds: [...s] }));
        })(),
      ) ||
    JSON.stringify(ovs) !==
      JSON.stringify(
        (mem?.overrides ?? []).map((o) => ({
          permissionKey: o.permissionKey,
          effect: o.effect,
          scopeIds: o.scopeIds,
          reason: o.reason ?? '',
        })),
      );

  const loiKiem: string[] = [];
  if (rows.some((r) => !r.scopeIds.length)) loiKiem.push('Mỗi vai trò phải chọn ít nhất một phạm vi.');
  if (rows.length !== new Set(rows.map((r) => r.roleId)).size) loiKiem.push('Có vai trò bị trùng.');
  if (ovs.some((o) => !o.scopeIds.length)) loiKiem.push('Mỗi ngoại lệ phải chọn ít nhất một phạm vi.');
  if (ovs.some((o) => !o.reason.trim())) loiKiem.push('Mỗi ngoại lệ phải ghi lý do.');
  if (!lyDo.trim() && coDoi) loiKiem.push('Hãy ghi lý do cho lần thay đổi này.');

  const guiLuu = async () => {
    if (!mem || loiKiem.length) return;
    const roleBindings: SaveRoleBinding[] = rows.map((r) => ({
      role_id: r.roleId,
      scope_ids: r.scopeIds,
    }));
    const overrides: SaveOverride[] = ovs.map((o) => ({
      permission_key: o.permissionKey,
      effect: o.effect,
      scope_mode: o.scopeIds.some(
        (id) => scopes.find((s) => s.scopeId === id)?.scopeType === 'ORGANIZATION',
      )
        ? 'ORGANIZATION'
        : 'SCOPED',
      scope_ids: o.scopeIds,
      reason: o.reason.trim(),
    }));
    try {
      await luu.mutateAsync({
        membershipId: mem.membershipId,
        expectedVersion: mem.version,
        roleBindings,
        overrides,
        reason: lyDo.trim(),
      });
      onOpenChange(false);
    } catch {
      // toast đã hiện ở hook; giữ hộp thoại để người dùng không mất thao tác.
      refetch();
    }
  };

  const ten = mem?.fullName || mem?.email || 'Thành viên';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-4xl flex-col gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Phân quyền · {ten}
            {mem && (
              <Badge variant="outline" className="font-normal">
                {LOAI_TV[mem.memberType] ?? mem.memberType}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {mem?.email}
            {mem && mem.cashbooksHeld.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <Wallet className="h-3.5 w-3.5" />
                đang giữ {mem.cashbooksHeld.length} sổ quỹ
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !mem ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        ) : mem.isSelf ? (
          <div className="p-6">
            <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">Không thể tự sửa quyền của chính mình.</p>
                <p className="mt-1 text-muted-foreground">
                  Đây là chốt chặn cố ý: nếu tự hạ quyền nhầm, bạn sẽ mất luôn khả năng sửa lại.
                  Hãy nhờ một chủ sở hữu khác thực hiện.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-6 mt-4 grid w-auto grid-cols-3">
                <TabsTrigger value="vaitro">
                  Vai trò & phạm vi
                  {rows.length > 0 && <Badge variant="secondary" className="ml-2">{rows.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="ngoaile">
                  Ngoại lệ
                  {ovs.length > 0 && <Badge variant="secondary" className="ml-2">{ovs.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="hieuluc">
                  Quyền hiệu lực
                  <Badge variant="secondary" className="ml-2">{hieuLuc.ket.size}</Badge>
                </TabsTrigger>
              </TabsList>

              {/* ─────────────── ① VAI TRÒ & PHẠM VI ─────────────── */}
              <TabsContent value="vaitro" className="mt-0 min-h-0 flex-1 overflow-auto px-6 py-4">
                <p className="mb-3 text-sm text-muted-foreground">
                  Vai trò là <strong>gói quyền</strong>; phạm vi là <strong>nơi áp gói đó</strong>.
                  Một người có thể mang nhiều vai trò ở những nơi khác nhau.
                </p>

                {seGopLai && (
                  <div className="mb-3 flex gap-2 rounded-md border bg-muted/40 p-3 text-xs">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>
                      Dữ liệu cũ đang lưu <strong>{soBindingGoc} bản ghi</strong> rời rạc cho{' '}
                      {rows.length} vai trò (mỗi toà một bản ghi). Lưu lần này sẽ gộp lại thành{' '}
                      {rows.length} — quyền giữ nguyên, chỉ gọn hơn.
                    </span>
                  </div>
                )}

                <div className="space-y-3">
                  {rows.map((r, i) => {
                    const role = roleById.get(r.roleId);
                    return (
                      <div key={i} className="rounded-lg border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Select
                            value={r.roleId}
                            onValueChange={(v) =>
                              setRows((s) => s.map((x, j) => (j === i ? { ...x, roleId: v } : x)))
                            }
                          >
                            <SelectTrigger className="w-[260px]">
                              <SelectValue placeholder="Chọn vai trò" />
                            </SelectTrigger>
                            <SelectContent>
                              {roles.map((ro) => (
                                <SelectItem
                                  key={ro.roleId}
                                  value={ro.roleId}
                                  disabled={rows.some((x, j) => j !== i && x.roleId === ro.roleId)}
                                >
                                  {ro.name} · {ro.allowKeys.length} quyền
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <ScopeSummary scopes={scopes} ids={r.scopeIds} />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="ml-auto text-muted-foreground hover:text-destructive"
                            onClick={() => setRows((s) => s.filter((_, j) => j !== i))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        {role?.denyKeys.length ? (
                          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                            Vai trò này CẤM {role.denyKeys.length} quyền — cấm luôn thắng, kể cả khi
                            vai trò khác có cho.
                          </p>
                        ) : null}
                        <Separator className="my-3" />
                        <ScopePicker
                          scopes={scopes}
                          value={r.scopeIds}
                          onChange={(v) =>
                            setRows((s) => s.map((x, j) => (j === i ? { ...x, scopeIds: v } : x)))
                          }
                        />
                      </div>
                    );
                  })}

                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={rows.length >= roles.length}
                    onClick={() => {
                      const conTrong = roles.find((ro) => !rows.some((r) => r.roleId === ro.roleId));
                      if (conTrong) setRows((s) => [...s, { roleId: conTrong.roleId, scopeIds: [] }]);
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Thêm vai trò
                  </Button>

                  {!rows.length && (
                    <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                      Chưa có vai trò nào — người này hiện <strong>không có quyền gì</strong> ngoài
                      các ngoại lệ được cấp riêng.
                    </p>
                  )}
                </div>
              </TabsContent>

              {/* ─────────────── ② NGOẠI LỆ ─────────────── */}
              <TabsContent value="ngoaile" className="mt-0 min-h-0 flex-1 overflow-auto px-6 py-4">
                <p className="mb-3 text-sm text-muted-foreground">
                  Ngoại lệ dùng khi cần <strong>thêm hoặc bớt một quyền lẻ</strong> mà không muốn đổi
                  vai trò. Mọi ngoại lệ đều phải ghi lý do và được lưu vào nhật ký.
                </p>

                {/*
                  Dòng ngoại lệ ở dạng GỌN, chỉ bung ra khi bấm Sửa.
                  Lý do: joey đang có 53 ngoại lệ (di sản của bước hoà giải quyền
                  25/07). Bung sẵn tất cả thì hộp thoại có 53 vùng cuộn, 5.476 nút
                  DOM — đã đo, không thao tác nổi. Gọn lại còn ~1 dòng mỗi cái.
                */}
                <div className="space-y-1.5">
                  {ovs.map((o, i) => {
                    const pd = permByKey.get(o.permissionKey);
                    const dangMo = ovMo === i;
                    const thua = hieuLuc.tuVaiTro.has(o.permissionKey) && o.effect === 'ALLOW';
                    return (
                      <div key={i} className={cn('rounded-lg border', dangMo && 'bg-muted/30')}>
                        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <Badge
                            variant={o.effect === 'DENY' ? 'destructive' : 'default'}
                            className="gap-1 shrink-0"
                          >
                            {o.effect === 'DENY' ? (
                              <Minus className="h-3 w-3" />
                            ) : (
                              <Plus className="h-3 w-3" />
                            )}
                            {o.effect === 'DENY' ? 'Cấm' : 'Cho'}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {nhanQuyen(o.permissionKey).label}
                          </span>
                          {!dangMo && (
                            <>
                              <ScopeSummary scopes={scopes} ids={o.scopeIds} max={2} />
                              {!o.reason.trim() && (
                                <Badge variant="outline" className="border-destructive/40 text-destructive">
                                  thiếu lý do
                                </Badge>
                              )}
                              {thua && (
                                <Badge variant="outline" className="font-normal text-muted-foreground">
                                  thừa
                                </Badge>
                              )}
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setOvMo(dangMo ? null : i)}
                          >
                            {dangMo ? 'Xong' : 'Sửa'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              setOvs((s) => s.filter((_, j) => j !== i));
                              setOvMo(null);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>

                        {dangMo && (
                          <div className="border-t px-3 pb-3 pt-2">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <code className="text-xs text-muted-foreground">{o.permissionKey}</code>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setOvs((s) =>
                                    s.map((x, j) =>
                                      j === i
                                        ? { ...x, effect: x.effect === 'DENY' ? 'ALLOW' : 'DENY' }
                                        : x,
                                    ),
                                  )
                                }
                              >
                                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                Đổi thành {o.effect === 'DENY' ? 'Cho' : 'Cấm'}
                              </Button>
                            </div>
                            {thua && (
                              <p className="mb-2 text-xs text-muted-foreground">
                                Vai trò đã cho quyền này rồi — ngoại lệ CHO ở đây không thêm gì.
                              </p>
                            )}
                            <div className="grid gap-3 md:grid-cols-2">
                              <div>
                                <Label className="text-xs">Áp ở đâu</Label>
                                <ScopePicker
                                  className="mt-1.5"
                                  scopes={scopes}
                                  allowedKinds={pd?.scopeKinds}
                                  value={o.scopeIds}
                                  onChange={(v) =>
                                    setOvs((s) =>
                                      s.map((x, j) => (j === i ? { ...x, scopeIds: v } : x)),
                                    )
                                  }
                                />
                              </div>
                              <div>
                                <Label className="text-xs">Lý do (bắt buộc)</Label>
                                <Textarea
                                  className="mt-1.5 h-24 resize-none"
                                  value={o.reason}
                                  placeholder="Vd: tạm cấp trong thời gian chị Lan nghỉ thai sản"
                                  onChange={(e) =>
                                    setOvs((s) =>
                                      s.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)),
                                    )
                                  }
                                />
                                {pd?.requiresCashbookPossession && (
                                  <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
                                    Quyền này chỉ có tác dụng khi người đó đang{' '}
                                    <strong>giữ sổ quỹ</strong> tương ứng. Cấp quyền không tự trao sổ.
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {!ovs.length && (
                    <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                      Chưa có ngoại lệ nào. Người này chỉ có quyền từ vai trò — đó là trạng thái dễ
                      hiểu và dễ kiểm nhất.
                    </p>
                  )}

                  <Button variant="outline" className="w-full" onClick={() => setThemQuyen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Thêm ngoại lệ
                  </Button>
                </div>
              </TabsContent>

              {/* ─────────────── ③ QUYỀN HIỆU LỰC ─────────────── */}
              <TabsContent value="hieuluc" className="mt-0 min-h-0 flex-1 overflow-auto px-6 py-4">
                <div className="mb-3 grid gap-2 sm:grid-cols-3">
                  <ODem nhan="Sau khi lưu" so={hieuLuc.ket.size} />
                  <ODem nhan="Được thêm" so={themVao.length} mau="text-emerald-600" />
                  <ODem nhan="Bị mất" so={matDi.length} mau="text-destructive" />
                </div>

                {(themVao.length > 0 || matDi.length > 0) && (
                  <div className="mb-4 space-y-3">
                    {matDi.length > 0 && <DanhSachThayDoi nhan="Sẽ MẤT" keys={matDi} am />}
                    {themVao.length > 0 && <DanhSachThayDoi nhan="Sẽ ĐƯỢC THÊM" keys={themVao} />}
                  </div>
                )}

                <p className="mb-2 text-sm text-muted-foreground">
                  Danh sách quyền người này thực sự dùng được (đã cộng vai trò, trừ cấm):
                </p>
                <ScrollArea className="h-56 rounded-md border">
                  <div className="grid gap-x-4 gap-y-1 p-3 sm:grid-cols-2">
                    {[...hieuLuc.ket].sort().map((k) => (
                      <div key={k} className="flex items-start gap-2 text-sm">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        <span className="min-w-0">
                          <span className="block truncate">{nhanQuyen(k).label}</span>
                          <code className="text-[11px] text-muted-foreground">{k}</code>
                        </span>
                      </div>
                    ))}
                    {!hieuLuc.ket.size && (
                      <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                        Không có quyền nào — người này sẽ không mở được màn hình nghiệp vụ nào.
                      </p>
                    )}
                  </div>
                </ScrollArea>

                <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Đây là "có quyền ở ít nhất một nơi". Ở từng toà/sổ cụ thể, kết quả còn phụ thuộc
                  phạm vi đã chọn — máy chủ luôn kiểm lại theo đúng nơi thao tác.
                </p>
              </TabsContent>
            </Tabs>

            <div className="border-t px-6 py-3">
              <Label htmlFor="lydo" className="text-xs">
                Lý do thay đổi (ghi vào nhật ký, bắt buộc)
              </Label>
              <Input
                id="lydo"
                className="mt-1.5"
                value={lyDo}
                placeholder="Vd: bàn giao khu B cho anh Nam từ 01/08"
                onChange={(e) => setLyDo(e.target.value)}
              />
            </div>

            <DialogFooter className="flex-col gap-2 border-t px-6 py-3 sm:flex-row sm:items-center">
              <div className="mr-auto min-w-0 text-xs">
                {loiKiem.length > 0 ? (
                  <span className="flex items-center gap-1.5 text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {loiKiem[0]}
                  </span>
                ) : coDoi ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                    {hieuLuc.ket.size} quyền sau khi lưu
                    {matDi.length > 0 && (
                      <span className="text-destructive"> · mất {matDi.length}</span>
                    )}
                    {themVao.length > 0 && (
                      <span className="text-emerald-600"> · thêm {themVao.length}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Chưa có thay đổi nào.</span>
                )}
              </div>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Đóng
              </Button>
              <Button onClick={guiLuu} disabled={!coDoi || loiKiem.length > 0 || luu.isPending}>
                {luu.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Lưu phân quyền
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Chọn quyền để thêm ngoại lệ */}
        <Dialog open={themQuyen} onOpenChange={setThemQuyen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Chọn quyền cần thêm ngoại lệ</DialogTitle>
              <DialogDescription>
                Tích vào quyền muốn cấp thêm hoặc cấm riêng cho người này.
              </DialogDescription>
            </DialogHeader>
            <PermissionPicker
              height="h-[380px]"
              availableKeys={availableKeys}
              inheritedKeys={hieuLuc.tuVaiTro}
              value={new Set(ovs.map((o) => o.permissionKey))}
              onToggle={(k, bat) =>
                setOvs((s) =>
                  bat
                    ? [...s, { permissionKey: k, effect: 'ALLOW', scopeIds: [], reason: '' }]
                    : s.filter((o) => o.permissionKey !== k),
                )
              }
            />
            <DialogFooter>
              <Button onClick={() => setThemQuyen(false)}>Xong</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

export const LOAI_TV: Record<string, string> = {
  OWNER: 'Chủ sở hữu',
  STAFF: 'Nhân sự',
  SHAREHOLDER: 'Cổ đông',
  PARTNER: 'Đối tác',
  SERVICE: 'Tài khoản dịch vụ',
};

function ODem({ nhan, so, mau }: { nhan: string; so: number; mau?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{nhan}</p>
      <p className={cn('text-2xl font-semibold tabular-nums', mau)}>{so}</p>
    </div>
  );
}

function DanhSachThayDoi({ nhan, keys, am }: { nhan: string; keys: string[]; am?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        am
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-emerald-500/30 bg-emerald-500/5',
      )}
    >
      <p className={cn('mb-1.5 text-xs font-medium', am ? 'text-destructive' : 'text-emerald-700')}>
        {nhan} · {keys.length} quyền
      </p>
      <div className="flex flex-wrap gap-1">
        {keys.slice(0, 24).map((k) => (
          <Badge key={k} variant="outline" className="font-normal">
            {nhanQuyen(k).label}
          </Badge>
        ))}
        {keys.length > 24 && (
          <Badge variant="outline" className="font-normal">
            +{keys.length - 24} nữa
          </Badge>
        )}
      </div>
    </div>
  );
}
