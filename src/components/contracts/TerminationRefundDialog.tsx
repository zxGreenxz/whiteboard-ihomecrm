import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, Check, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import {
  useRefundPreview, useRecordObligation, useCreateRefundVoucher,
  OBLIGATION_LABEL,
} from '@/hooks/useTerminationRefund';

const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN') + 'đ';

interface Props {
  terminationId: string | null;
  onOpenChange: (v: boolean) => void;
}

/**
 * Kiểm tra & sinh phiếu hoàn cọc cho một hồ sơ thanh lý.
 *
 * Điểm mấu chốt: hiện SONG SONG "số trên hồ sơ" và "cọc thật đã thu". Trước đây
 * chỉ có con số đầu, không ai đối chiếu — nên mới có 9 hồ sơ hoàn vượt cọc thật.
 */
export function TerminationRefundDialog({ terminationId, onOpenChange }: Props) {
  const preview = useRefundPreview(terminationId);
  const record = useRecordObligation();
  const create = useCreateRefundVoucher();
  const [reason, setReason] = useState('');

  const p = preview.data;
  const warn = p && p.obligationStatus !== 'OK';

  const run = async () => {
    if (!terminationId || !p) return;
    if (warn && reason.trim().length < 8) {
      toast.error('Phải nhập lý do ít nhất 8 ký tự để ép sinh phiếu');
      return;
    }
    try {
      const ob = await record.mutateAsync(terminationId);
      const v = await create.mutateAsync({
        obligationId: ob.obligationId,
        force: warn,
        forceReason: warn ? reason.trim() : undefined,
      });
      toast.success(
        v.alreadyCreated
          ? `Hồ sơ này đã có phiếu hoàn ${v.code}`
          : `Đã tạo phiếu hoàn ${v.code} — ${fmt(v.amount)}, đang CHỜ DUYỆT.`,
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không tạo được phiếu hoàn');
    }
  };

  return (
    <Dialog open={!!terminationId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" /> Hoàn tiền cọc
          </DialogTitle>
        </DialogHeader>

        {preview.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : preview.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {preview.error instanceof Error ? preview.error.message : 'Không đọc được'}
          </div>
        ) : p ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Số hoàn trên hồ sơ</div>
                <div className="text-lg font-semibold tabular-nums">{fmt(p.requestedAmount)}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Cọc THẬT đang giữ</div>
                <div className={`text-lg font-semibold tabular-nums ${
                  p.realHeld < p.requestedAmount ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                  {fmt(p.realHeld)}
                </div>
              </div>
            </div>

            {p.recognizedOnly > 0 && (
              <p className="text-xs text-muted-foreground">
                Ngoài ra có <strong>{fmt(p.recognizedOnly)}</strong> chỉ được ghi nhận trên
                sổ ảo — chưa từng vào két thật, nên không tính vào số đang giữ.
              </p>
            )}

            {warn ? (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 space-y-2">
                <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  {OBLIGATION_LABEL[p.obligationStatus]}
                </div>
                <p className="text-sm text-muted-foreground">{p.warning}</p>
                <Textarea
                  placeholder="Lý do vẫn hoàn (bắt buộc, ít nhất 8 ký tự) — sẽ lưu vào ghi chú phiếu"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                />
                <p className="text-[11px] text-muted-foreground">
                  Chỉ <strong>chủ tổ chức</strong> mới ép được khi đang cảnh báo.
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm
                              text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                <Check className="h-4 w-4" /> Số hoàn khớp với cọc thật đã thu.
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Phiếu tạo ra ở trạng thái <strong>CHỜ DUYỆT</strong> — tiền chỉ ra khỏi két
              khi có người duyệt.
            </p>
          </>
        ) : (
          /* Không có dữ liệu xem trước: trước đây render `null` nên hộp thoại mở ra
             TRỐNG TRƠN, nút bị vô hiệu mà không nói vì sao — người dùng không biết
             mình đã làm sai hay hệ thống hỏng. Bắt được khi chạy E2E trên DEMO. */
          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            Hồ sơ thanh lý này <strong>không có khoản hoàn nào</strong> để chi — thường
            là do sau khi cấn trừ thì khách còn nợ, hoặc số hoàn bằng 0. Không có phiếu
            chi nào được tạo.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button
            onClick={run}
            disabled={!p || p.requestedAmount <= 0 || record.isPending || create.isPending}
          >
            {record.isPending || create.isPending ? 'Đang tạo…' : 'Tạo phiếu hoàn'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
