// Link chỉ đọc cho chủ nhà: mở trên điện thoại, không cần đăng nhập, thu hồi được.
import { useState } from 'react';
import { Copy, Link2, Plus, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonBar } from '@/components/loading/LoadingState';
import {
  useCreateLandlordShareLink,
  useLandlordShareLinks,
  useRevokeLandlordShareLink,
} from '@/hooks/useLandlordSettlement';
import { landlordErrorMessage, landlordShareUrl } from '@/lib/landlordSettlement';

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Đã sao chép link');
  } catch {
    toast.error('Trình duyệt chặn sao chép — bấm giữ vào link để sao chép tay');
  }
}

export function ShareLinkDialog({
  open, onOpenChange, buildingId, buildingName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  buildingName: string;
}) {
  const links = useLandlordShareLinks(buildingId, open);
  const create = useCreateLandlordShareLink();
  const revoke = useRevokeLandlordShareLink();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const onCreate = async () => {
    setError(null);
    if (label.trim().length > 120) { setError('Nhãn tối đa 120 ký tự.'); return; }
    try {
      const r = await create.mutateAsync({ buildingId, label: label.trim() || null });
      setLabel('');
      await copyText(landlordShareUrl(origin, r.token));
    } catch (err) {
      setError(landlordErrorMessage(err, 'Chưa tạo được link'));
    }
  };

  const onRevoke = async (token: string) => {
    setError(null);
    try {
      await revoke.mutateAsync({ token });
      toast.success('Đã thu hồi link — chủ nhà mở lại sẽ báo link không còn hiệu lực');
    } catch (err) {
      setError(landlordErrorMessage(err, 'Chưa thu hồi được link'));
    }
  };

  const active = (links.data ?? []).filter((l) => !l.revoked_at);
  const revoked = (links.data ?? []).filter((l) => l.revoked_at);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link cho chủ nhà — {buildingName}</DialogTitle>
          <DialogDescription>
            Chủ nhà mở link là xem được quyết toán từng tháng của toà này (chỉ đọc, không cần đăng nhập). Ai có link cũng xem được — gửi riêng cho chủ nhà; lộ link thì thu hồi và tạo link mới.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="link-label">Nhãn (không bắt buộc)</Label>
              <Input id="link-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="vd: gửi Zalo chủ nhà" />
            </div>
            <Button type="button" onClick={onCreate} disabled={create.isPending}>
              <Plus className="mr-1 h-4 w-4" />{create.isPending ? 'Đang tạo…' : 'Tạo link'}
            </Button>
          </div>

          {links.isLoading && <div className="space-y-2"><SkeletonBar className="h-10 w-full" /><SkeletonBar className="h-10 w-full" /></div>}
          {links.isError && <p role="alert" className="text-sm text-destructive">{landlordErrorMessage(links.error, 'Chưa tải được danh sách link')}</p>}

          {links.data && (
            <div className="space-y-2">
              {active.length === 0 && <p className="text-sm text-muted-foreground">Chưa có link nào đang mở.</p>}
              {active.map((l) => {
                const url = landlordShareUrl(origin, l.token);
                return (
                  <div key={l.token} className="min-w-0 rounded-md border p-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>{url}</span>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => copyText(url)}>
                        <Copy className="mr-1 h-3.5 w-3.5" />Sao chép
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-destructive" disabled={revoke.isPending} onClick={() => onRevoke(l.token)}>
                        <XCircle className="mr-1 h-3.5 w-3.5" />Thu hồi
                      </Button>
                    </div>
                    <p className="mt-1 pl-6 text-xs text-muted-foreground">
                      {l.label ? `${l.label} · ` : ''}tạo {new Date(l.created_at).toLocaleString('vi-VN')}
                    </p>
                  </div>
                );
              })}
              {revoked.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <Badge variant="outline" className="mr-1">{revoked.length}</Badge>link đã thu hồi.
                </p>
              )}
            </div>
          )}

          {error && <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
