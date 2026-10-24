// Link tên miền cho chủ nhà (chủ nhắn 24/10/2026): tên link cố định (src/lib/landlordPortal.ts) — ở đây chỉ GỘP TOÀ
// vào link và quản lý người xem (tên + PIN 6 số; mỗi PIN là một người, thao tác trên trang ghi theo người đó).
// PIN chỉ hiện đúng một lần lúc thêm; server không lưu PIN thô. Server kiểm quyền và chống dò PIN.
import { useEffect, useState } from 'react';
import { Copy, KeyRound, UserPlus, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonBar } from '@/components/loading/LoadingState';
import {
  useAddLandlordPortalViewer,
  useLandlordPortals,
  useRevokeLandlordPortalViewer,
  useSaveLandlordPortal,
} from '@/hooks/useLandlordPortal';
import { LANDLORD_PORTAL_LINKS, PORTAL_PIN, isWeakPin, landlordPortalUrl, type LandlordPortals } from '@/lib/landlordPortal';
import { landlordErrorMessage, sameIdSet, vnDateTime, type LandlordOperation } from '@/lib/landlordSettlement';

async function copyText(text: string, done = 'Đã sao chép') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error('Trình duyệt chặn sao chép — bấm giữ để sao chép tay');
  }
}

type Portal = LandlordPortals['portals'][number];

function PortalSection({ slug, host, portal, operations }: {
  slug: string; host: string; portal: Portal | null; operations: readonly LandlordOperation[];
}) {
  const save = useSaveLandlordPortal();
  const add = useAddLandlordPortalViewer();
  const revoke = useRevokeLandlordPortalViewer();
  const goc = portal?.building_ids ?? [];
  const [ids, setIds] = useState<string[]>(goc);
  // nạp lại khi server đổi (lưu xong / người khác sửa) mà mình chưa sửa gì
  const [base, setBase] = useState<string[]>(goc);
  if (!sameIdSet(base, goc)) {
    setBase(goc);
    if (sameIdSet(ids, base)) setIds(goc);
  }
  const [label, setLabel] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<{ label: string; pin: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const url = landlordPortalUrl(slug);
  const doiToa = !sameIdSet(ids, goc);

  const onSave = async () => {
    setError(null);
    try {
      await save.mutateAsync({ slug, buildingIds: ids });
      toast.success(`Đã lưu toà của link ${host}`);
    } catch (err) {
      setError(landlordErrorMessage(err, 'Chưa lưu được toà của link'));
    }
  };
  const onAdd = async () => {
    setError(null);
    const ten = label.trim();
    if (!ten) { setError('Nhập tên người xem.'); return; }
    if (ten.length > 60) { setError('Tên người xem tối đa 60 ký tự.'); return; }
    if (pin && !PORTAL_PIN.test(pin)) { setError('PIN phải đúng 6 chữ số (hoặc để trống để hệ thống tạo).'); return; }
    if (pin && isWeakPin(pin)) { setError('PIN quá dễ đoán (lặp một số hoặc dãy liên tiếp) — chọn PIN khác.'); return; }
    try {
      const r = await add.mutateAsync({ slug, label: ten, pin: pin || null });
      setNewPin({ label: r.label, pin: r.pin });
      setLabel('');
      setPin('');
    } catch (err) {
      setError(landlordErrorMessage(err, 'Chưa thêm được người xem'));
    }
  };
  const onRevoke = async (viewerId: string) => {
    if (confirmRevoke !== viewerId) { setConfirmRevoke(viewerId); return; }
    setConfirmRevoke(null);
    try {
      await revoke.mutateAsync({ viewerId });
      toast.success('Đã thu hồi — PIN này không vào được nữa');
    } catch (err) {
      setError(landlordErrorMessage(err, 'Chưa thu hồi được'));
    }
  };

  const conHieuLuc = portal?.viewers.filter((v) => !v.revoked_at) ?? [];
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid={`portal-${slug}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 break-all text-sm font-bold">{host}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void copyText(url, 'Đã sao chép link')}>
          <Copy className="mr-1 h-3.5 w-3.5" />Sao chép link
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label>Toà trong link</Label>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {operations.map((o) => {
            const on = ids.includes(o.building_id);
            return (
              <label key={o.building_id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                <Checkbox checked={on} aria-label={`${o.building_name} trong ${host}`}
                  onCheckedChange={(v) => setIds((cur) => (v === true ? [...cur, o.building_id] : cur.filter((x) => x !== o.building_id)))} />
                <span className="min-w-0 flex-1 truncate">{o.building_name}</span>
                <span className="truncate text-xs text-muted-foreground">{o.landlord_name}</span>
              </label>
            );
          })}
        </div>
        {(doiToa || !portal) && (
          <Button type="button" size="sm" onClick={onSave} disabled={save.isPending || (!portal && ids.length === 0)}>
            {save.isPending ? 'Đang lưu…' : portal ? 'Lưu toà của link' : 'Tạo link với các toà đã chọn'}
          </Button>
        )}
      </div>

      {portal && (
        <div className="space-y-1.5">
          <Label>Người xem ({conHieuLuc.length})</Label>
          {portal.viewers.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có người xem — thêm người xem để có PIN vào link.</p>
          ) : (
            <ul className="space-y-1">
              {portal.viewers.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                  data-testid="portal-viewer-row">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className={v.revoked_at ? 'text-muted-foreground line-through' : 'font-medium'}>{v.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {v.revoked_at ? `thu hồi ${vnDateTime(v.revoked_at)}`
                      : v.last_login_at ? `vào lần cuối ${vnDateTime(v.last_login_at)}` : 'chưa vào lần nào'}
                  </span>
                  {!v.revoked_at && (
                    <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 text-destructive"
                      onClick={() => void onRevoke(v.id)} disabled={revoke.isPending}>
                      <XCircle className="mr-1 h-3.5 w-3.5" />{confirmRevoke === v.id ? 'Bấm lần nữa để thu hồi' : 'Thu hồi'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {newPin && (
            <div role="status" className="rounded-md border border-amber-400 bg-amber-50 p-2.5 text-sm dark:bg-amber-950/40" data-testid="portal-new-pin">
              <p>PIN của <b>{newPin.label}</b>: <b className="font-mono text-lg tracking-widest">{newPin.pin}</b></p>
              <p className="mt-0.5 text-xs text-muted-foreground">Chỉ hiện lần này — gửi riêng cho người xem cùng link {host}.</p>
              <Button type="button" variant="outline" size="sm" className="mt-1.5"
                onClick={() => void copyText(`${url} — PIN ${newPin.pin}`, 'Đã sao chép link + PIN')}>
                <Copy className="mr-1 h-3.5 w-3.5" />Sao chép link + PIN
              </Button>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-[1fr_110px_auto]">
            <Input aria-label="Tên người xem" placeholder="Tên người xem (vd Chị Giang)" value={label} maxLength={60}
              onChange={(e) => setLabel(e.target.value)} />
            <Input aria-label="PIN 6 số (để trống: tự tạo)" placeholder="PIN (tự tạo)" inputMode="numeric" value={pin} maxLength={6}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <Button type="button" onClick={onAdd} disabled={add.isPending}>
              <UserPlus className="mr-1 h-4 w-4" />{add.isPending ? 'Đang thêm…' : 'Thêm'}
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{error}</p>}
    </section>
  );
}

export function LandlordPortalDialog({ open, onOpenChange, operations }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  operations: readonly LandlordOperation[];
}) {
  const portals = useLandlordPortals(open);
  // đóng hộp thì lần mở sau dựng lại từ đầu (PIN vừa tạo không còn hiện)
  const [lan, setLan] = useState(0);
  useEffect(() => { if (!open) setLan((x) => x + 1); }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Link tên miền cho chủ nhà</DialogTitle>
          <DialogDescription>
            Chủ nhà mở link trên điện thoại và vào bằng PIN 6 số của riêng mình; máy nhớ đăng nhập. Gộp toà vào link,
            thêm hoặc thu hồi người xem ở đây.
          </DialogDescription>
        </DialogHeader>
        {portals.isLoading ? (
          <div className="space-y-2"><SkeletonBar className="h-24 w-full" /><SkeletonBar className="h-24 w-full" /></div>
        ) : portals.isError ? (
          <p role="alert" className="text-sm text-destructive">{landlordErrorMessage(portals.error, 'Chưa tải được link')}</p>
        ) : (
          <div key={lan} className="space-y-3">
            {LANDLORD_PORTAL_LINKS.map((l) => (
              <PortalSection key={l.slug} slug={l.slug} host={l.host} operations={operations}
                portal={portals.data?.portals.find((p) => p.slug === l.slug) ?? null} />
            ))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
