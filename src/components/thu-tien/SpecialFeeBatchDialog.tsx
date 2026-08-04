import { useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Sparkles, AlertTriangle, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  useSpecialFeePreview, useGenerateSpecialFees, FEE_LABEL,
  type SpecialFeePreviewRow,
} from '@/hooks/useSpecialFeeBatch';
import { useAccounts } from '@/hooks/useAccounts';

const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString('vi-VN') + 'đ');

const STATUS_STYLE: Record<string, string> = {
  'SẼ_SINH': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40',
  'ĐÃ_SINH': 'bg-muted text-muted-foreground',
  'ĐÃ_CÓ_PHIẾU': 'bg-muted text-muted-foreground',
  'KHÔNG_ÁP_DỤNG': 'bg-muted text-muted-foreground',
  'THIẾU_GIÁ': 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40',
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  period: string;
}

/**
 * "Sinh phiếu hàng loạt" — xem trước rồi đồng ý một lần.
 *
 * Nút bấm CHỈ sinh những ô ở trạng thái SẼ_SINH. Bốn trạng thái còn lại hiện ra
 * kèm LÝ DO để chủ hiểu vì sao ô đó bị bỏ — đặc biệt là THIẾU_GIÁ, vốn chỉ thẳng
 * sang trang Cài đặt → Phí cố định.
 */
export function SpecialFeeBatchDialog({ open, onOpenChange, period }: Props) {
  const preview = useSpecialFeePreview(period, undefined, open);
  const generate = useGenerateSpecialFees();
  const accounts = useAccounts({ enabled: open });
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  /** '' = không chọn sổ ⇒ phiếu ra chờ duyệt, y như trước. */
  const [accountId, setAccountId] = useState<string>('');

  // Chỉ sổ THẬT: phí cố định là tiền ra khỏi két, sổ ảo không ghi sổ quỹ được.
  const realAccounts = useMemo(
    () => (accounts.data ?? []).filter((a: any) => !a.is_virtual),
    [accounts.data],
  );

  const rows = preview.data ?? [];
  const willGenerate = useMemo(
    () => rows.filter((r) => r.status === 'SẼ_SINH' && !skipped.has(`${r.buildingId}:${r.feeCategory}`)),
    [rows, skipped],
  );
  const total = willGenerate.reduce((s, r) => s + (r.amount ?? 0), 0);

  const byStatus = useMemo(() => {
    const m: Record<string, SpecialFeePreviewRow[]> = {};
    for (const r of rows) (m[r.status] ??= []).push(r);
    return m;
  }, [rows]);

  const run = async () => {
    // Server sinh theo TOÀ, nên toà nào bị bỏ hết hạng mục thì không gửi lên.
    const ids = [...new Set(willGenerate.map((r) => r.buildingId))];
    if (!ids.length) return;
    try {
      const res = await generate.mutateAsync({
        period, buildingIds: ids, accountId: accountId || null,
      });
      if (res.created === 0) {
        toast.success('Không có ô nào cần sinh thêm.');
      } else if (res.posted > 0) {
        toast.success(
          `Đã sinh ${res.created} phiếu — tổng ${fmt(res.totalAmount)}. ` +
          `${res.posted} phiếu đã tự duyệt và vào sổ; ${res.created - res.posted} phiếu chờ duyệt.`,
        );
      } else {
        toast.success(
          `Đã sinh ${res.created} phiếu — tổng ${fmt(res.totalAmount)}. Tất cả đang CHỜ DUYỆT.`,
        );
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không sinh được phiếu');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Sinh phiếu phí cố định — kỳ {period}
          </DialogTitle>
        </DialogHeader>

        {preview.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : preview.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {preview.error instanceof Error ? preview.error.message : 'Không đọc được danh sách'}
          </div>
        ) : (
          <>
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="text-sm">
                Sẽ sinh <strong className="tabular-nums">{willGenerate.length}</strong> phiếu
                {' · tổng '}
                <strong className="tabular-nums">{fmt(total)}</strong>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Bấm hai lần cũng không sinh trùng.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sfb-account">Chi từ sổ quỹ</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="sfb-account">
                  <SelectValue placeholder="Chưa chọn — phiếu sẽ nằm chờ duyệt" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Chưa chọn — phiếu nằm chờ duyệt</SelectItem>
                  {realAccounts.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {accountId
                  ? 'Ô nào đóng đúng giá bạn đã công bố sẽ TỰ DUYỆT và vào sổ ngay. Ô lệch giá vẫn nằm chờ duyệt.'
                  : 'Không chọn sổ thì mọi phiếu ra ở trạng thái CHỜ DUYỆT — hệ đề xuất, bạn duyệt.'}
              </p>
            </div>

            {byStatus['SẼ_SINH']?.length ? (
              <div className="rounded-md border overflow-hidden">
                <div className="bg-muted/60 px-3 py-2 text-xs font-medium">Sẽ sinh</div>
                <ul className="divide-y">
                  {byStatus['SẼ_SINH'].map((r) => {
                    const k = `${r.buildingId}:${r.feeCategory}`;
                    return (
                      <li key={k} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <Checkbox
                          checked={!skipped.has(k)}
                          onCheckedChange={(v) =>
                            setSkipped((prev) => {
                              const n = new Set(prev);
                              if (v === true) n.delete(k); else n.add(k);
                              return n;
                            })}
                        />
                        <span className="font-medium min-w-[8rem]">{r.buildingName}</span>
                        <span className="text-muted-foreground">
                          {FEE_LABEL[r.feeCategory] ?? r.feeCategory}
                        </span>
                        <span className="ml-auto tabular-nums font-medium">{fmt(r.amount)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <div className="rounded-md border p-4 text-sm text-muted-foreground text-center">
                Không có ô nào cần sinh cho kỳ này.
              </div>
            )}

            {byStatus['THIẾU_GIÁ']?.length ? (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  {byStatus['THIẾU_GIÁ'].length} ô chưa khai giá — bị bỏ qua
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Vào <strong>Cài đặt → Phí cố định</strong> khai giá rồi quay lại.
                </p>
              </div>
            ) : null}

            {(byStatus['ĐÃ_SINH']?.length || byStatus['ĐÃ_CÓ_PHIẾU']?.length) ? (
              <p className="text-xs text-muted-foreground">
                Đã bỏ qua {(byStatus['ĐÃ_SINH']?.length ?? 0)} ô đã sinh lượt trước và{' '}
                {(byStatus['ĐÃ_CÓ_PHIẾU']?.length ?? 0)} ô đã có phiếu được duyệt.
              </p>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button onClick={run} disabled={generate.isPending || willGenerate.length === 0}>
            <Check className="h-4 w-4 mr-1" />
            {generate.isPending
              ? 'Đang sinh…'
              : accountId
                ? `Sinh & chi ${willGenerate.length} phiếu`
                : `Sinh ${willGenerate.length} phiếu chờ duyệt`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
