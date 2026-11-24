import { useRef, useState } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useExtendContractExitHold, useReopenContractExitHold } from '@/hooks/contracts/useContractExitEarlyTerms';
import {
  EXIT_HOLD_DAY_OPTIONS, EXIT_HOLD_DEFAULT_DAYS, exitHoldCaseLabel, exitHoldOldContractLabel, exitHoldUntilLabel,
} from '@/pages/phong-trong/exitHold';
import type { RoomExitHoldInfo } from '@/pages/phong-trong/sampleData';

export interface ExitHoldAction {
  mode: 'reopen' | 'extend';
  roomId: string;
  roomLabel: string;
  /** Hồ sơ đọc mới nhất của phòng (phiên bản dùng làm expectedVersion). */
  hold: RoomExitHoldInfo;
}

const REASON_MAX = 2000;

/**
 * Mở bán lại / Giữ tiếp phòng chờ khách nhận sang nhượng. Chỉ mount khi người dùng đã đăng nhập trong app
 * (hook đọc tổ chức đang chọn). Lỗi và thành công do hook báo; hộp thoại giữ nguyên nội dung để thử lại.
 * Mỗi ý định bấm (hồ sơ + phiên bản + số ngày + lý do) có một mã yêu cầu, bấm lặp cùng ý định dùng lại mã cũ.
 */
export function ExitHoldDialog({ action, blockedReason, onClose, onDone }: {
  action: ExitHoldAction;
  blockedReason?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const reopen = useReopenContractExitHold();
  const extend = useExtendContractExitHold();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState<number>(EXIT_HOLD_DEFAULT_DAYS);
  const requestIds = useRef(new Map<string, string>());
  const submitting = useRef(false);
  const pending = reopen.isPending || extend.isPending;
  const { hold, mode, roomLabel } = action;
  const isReopen = mode === 'reopen';

  const requestIdFor = (intent: Record<string, unknown>) => {
    const key = JSON.stringify(intent);
    let id = requestIds.current.get(key);
    if (!id) { id = crypto.randomUUID(); requestIds.current.set(key, id); }
    return id;
  };
  const submit = async () => {
    if (submitting.current || pending || blockedReason) return;
    const base = { caseId: hold.exitCaseId, expectedVersion: hold.version };
    const note = reason.trim() || null;
    submitting.current = true;
    try {
      if (isReopen) {
        await reopen.mutateAsync({ ...base, requestId: requestIdFor({ mode, ...base, reason: note }), reason: note });
      } else {
        await extend.mutateAsync({ ...base, requestId: requestIdFor({ mode, ...base, days, reason: note }), days, reason: note });
      }
      onDone?.();
      onClose();
    } catch {
      /* Hook đã báo lỗi (quyền / phiên bản / luật máy chủ); giữ hộp thoại để đối chiếu và thử lại. */
    } finally {
      submitting.current = false;
    }
  };

  const title = isReopen ? 'Mở bán lại phòng?' : 'Giữ tiếp phòng cho khách sang nhượng';
  return <AlertDialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <AlertDialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto rounded-lg p-5 sm:p-6">
      <AlertDialogHeader className="text-left">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{roomLabel}</p>
            <p>Khách cũ: {exitHoldOldContractLabel(hold)} · {exitHoldCaseLabel(hold)}.</p>
            <p>{hold.active ? `Đang giữ đến ${exitHoldUntilLabel(hold.holdUntil)} (giờ Việt Nam).` : `Đã hết hạn giữ lúc ${exitHoldUntilLabel(hold.holdUntil)}; phòng đang rao lại.`}</p>
            {isReopen
              ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-950">
                Phòng được rao bán lại ngay trên link công khai, bot và Hermes. Hợp đồng mới tạo cho phòng sau đó
                <b> KHÔNG tự nối</b> với hồ sơ trả phòng của khách cũ.
              </p>
              : <p>Trong thời gian giữ, phòng không được chào trên link công khai, bot và Hermes; người khác vẫn cọc hoặc tạo hợp đồng được. Hết hạn thì phòng tự rao lại.</p>}
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {!isReopen && <div className="space-y-1.5">
        <Label htmlFor="exit-hold-days">Giữ thêm</Label>
        <select id="exit-hold-days" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={days} disabled={pending}
          onChange={event => setDays(Number(event.target.value))}>
          {EXIT_HOLD_DAY_OPTIONS.map(value => <option key={value} value={value}>{value} ngày</option>)}
        </select>
        <p className="text-xs text-muted-foreground">Tính từ lúc bấm Giữ tiếp.</p>
      </div>}
      <div className="space-y-1.5">
        <Label htmlFor="exit-hold-reason">Lý do (tuỳ chọn)</Label>
        <Textarea id="exit-hold-reason" rows={2} maxLength={REASON_MAX} value={reason} disabled={pending}
          placeholder={isReopen ? 'VD: khách nhận phòng huỷ' : 'VD: khách nhận hẹn ký hợp đồng cuối tuần'}
          onChange={event => setReason(event.target.value)} />
      </div>
      {blockedReason && <p role="alert" className="text-sm text-destructive">{blockedReason}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>Đóng</AlertDialogCancel>
        <Button type="button" variant={isReopen ? 'destructive' : 'default'} disabled={pending || !!blockedReason} onClick={() => void submit()}>
          {pending ? 'Đang lưu…' : isReopen ? 'Mở bán lại' : `Giữ tiếp ${days} ngày`}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export default ExitHoldDialog;
