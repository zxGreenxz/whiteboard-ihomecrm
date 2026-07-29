// Đợt 6 — ĐỀ NGHỊ chốt & bàn giao quỹ (bước của người ĐANG GIỮ sổ).
//
// Ba bước cố ý: (1) dọn rào, (2) đếm tiền, (3) đọc lại hệ quả rồi gõ xác nhận.
// Bấm xong ở đây CHƯA khoá gì cả — phải bên nhận ký. Nói rõ điều đó để người
// dùng không hoảng, và cũng để họ hiểu vì sao còn một bước nữa.

import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, CheckCircle2, Loader2, Lock } from "lucide-react";
import {
  useClosingBlockers, useCashbookBalanceAsOf, useProposeCashbookClosing,
} from "@/hooks/useCashbookClosing";

const CONFIRM_WORD = "CHOT SO";

function fmtVND(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("vi-VN").format(Number(n)) + "đ";
}

export interface CloseCashbookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cashbookId: string | null;
  cashbookName?: string | null;
  /** Ai được chọn làm người xác nhận (đã lọc quyền ở phía gọi). */
  candidates: Array<{ user_id: string; full_name: string | null }>;
}

export default function CloseCashbookDialog({
  open, onOpenChange, cashbookId, cashbookName, candidates,
}: CloseCashbookDialogProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [counted, setCounted] = useState("");
  const [confirmer, setConfirmer] = useState("");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");

  const { data: blockers = [], isLoading: loadingBlockers } = useClosingBlockers(open ? cashbookId : null);
  const { data: systemBalance } = useCashbookBalanceAsOf(open ? cashbookId : null);
  const proposeMut = useProposeCashbookClosing();

  useEffect(() => {
    if (!open) {
      setStep(1); setCounted(""); setConfirmer(""); setNote(""); setTyped("");
    }
  }, [open]);

  const hardBlockers = blockers.filter((b) => b.blocking);
  const warnings = blockers.filter((b) => !b.blocking);
  const countedNum = counted.trim() === "" ? null : Number(counted.replace(/[^\d.-]/g, ""));
  const diff = countedNum !== null && systemBalance !== null && systemBalance !== undefined
    ? countedNum - systemBalance : null;

  const canGoStep2 = hardBlockers.length === 0 && !loadingBlockers;
  const canGoStep3 = countedNum !== null && !Number.isNaN(countedNum) && !!confirmer;
  const canSubmit = canGoStep3 && typed.trim().toUpperCase() === CONFIRM_WORD;

  const confirmerName = useMemo(
    () => candidates.find((c) => c.user_id === confirmer)?.full_name ?? "người nhận",
    [candidates, confirmer],
  );

  const submit = async () => {
    if (!cashbookId || countedNum === null) return;
    await proposeMut.mutateAsync({
      cashbookId, countedBalance: countedNum, confirmerUserId: confirmer,
      note: note.trim() || null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!proposeMut.isPending) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Chốt sổ &amp; bàn giao quỹ — {cashbookName ?? "sổ quỹ"}
          </DialogTitle>
          <DialogDescription>Bước {step}/3</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-3">
            {loadingBlockers ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Đang kiểm tra sổ…
              </p>
            ) : hardBlockers.length === 0 ? (
              <p className="text-sm text-emerald-700 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Sổ đã sẵn sàng để chốt.
              </p>
            ) : (
              <div className="rounded-md border border-red-300 bg-red-50 p-3 space-y-2">
                <p className="text-sm font-medium text-red-800">Phải dọn xong những việc này trước:</p>
                <ul className="list-disc pl-5 text-sm text-red-800 space-y-1">
                  {hardBlockers.map((b) => <li key={b.code}>{b.detail}</li>)}
                </ul>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-1">
                <p className="text-sm font-medium text-amber-900">Lưu ý (không chặn):</p>
                <ul className="list-disc pl-5 text-sm text-amber-900 space-y-1">
                  {warnings.map((b) => <li key={b.code}>{b.detail}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="rounded-md border p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Số dư theo sổ (bút toán, tới hôm nay)</span>
                <span className="font-semibold tabular-nums">{fmtVND(systemBalance)}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="counted">Số tiền thực đếm trong két</Label>
              <Input
                id="counted" inputMode="numeric" value={counted}
                onChange={(e) => setCounted(e.target.value)}
                placeholder="Đếm tiền mặt rồi nhập vào đây"
              />
            </div>
            {diff !== null && (
              <p className={`text-sm ${diff === 0 ? "text-emerald-700" : "text-amber-800"}`}>
                {diff === 0
                  ? "Khớp sổ."
                  : `Lệch ${fmtVND(Math.abs(diff))} ${diff > 0 ? "thừa quỹ" : "thiếu quỹ"} — số lệch này sẽ được ghi vào biên bản.`}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="confirmer">Người nhận bàn giao (sẽ ký xác nhận)</Label>
              <Select value={confirmer} onValueChange={setConfirmer}>
                <SelectTrigger id="confirmer"><SelectValue placeholder="Chọn người nhận" /></SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.user_id} value={c.user_id}>
                      {c.full_name ?? c.user_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {candidates.length === 0 && (
                <p className="text-sm text-red-700">
                  Chưa có ai đủ quyền xác nhận sổ này. Nhờ quản trị cấp quyền
                  “Xác nhận nhận bàn giao” cho người nhận trước.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note">Ghi chú (tuỳ chọn)</Label>
              <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="rounded-md border border-red-300 bg-red-50 p-3 space-y-2">
              <p className="text-sm font-semibold text-red-800 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> Sau khi {confirmerName} xác nhận, kỳ này khoá VĨNH VIỄN
              </p>
              <ul className="list-disc pl-5 text-sm text-red-800 space-y-1">
                <li>Mọi phiếu có ngày phát sinh ≤ ngày chốt sẽ không sửa, huỷ hay xoá được nữa.</li>
                <li>Không ai mở lại được — kể cả chủ tổ chức. Sai sót phát hiện sau phải xử lý bằng phiếu điều chỉnh ở kỳ hiện tại.</li>
                <li>Vẫn bổ sung được ảnh chứng từ và ghi chú cho phiếu cũ; chỉ số tiền là khoá cứng.</li>
              </ul>
            </div>
            <div className="rounded-md border p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Số dư theo sổ</span>
                <span className="tabular-nums">{fmtVND(systemBalance)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Số thực đếm</span>
                <span className="tabular-nums font-semibold">{fmtVND(countedNum)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Chênh lệch</span>
                <span className="tabular-nums">{fmtVND(diff)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Người nhận</span>
                <span>{confirmerName}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="typed">Gõ <b>{CONFIRM_WORD}</b> để gửi đề nghị</Label>
              <Input id="typed" value={typed} onChange={(e) => setTyped(e.target.value)}
                     placeholder={CONFIRM_WORD} autoComplete="off" />
            </div>
            <p className="text-xs text-muted-foreground">
              Bước này chỉ GỬI đề nghị. Sổ chưa khoá cho tới khi {confirmerName} đếm lại và ký nhận.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step > 1 && (
            <Button variant="outline" onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                    disabled={proposeMut.isPending}>
              Quay lại
            </Button>
          )}
          {step === 1 && (
            <Button onClick={() => setStep(2)} disabled={!canGoStep2}>Tiếp tục</Button>
          )}
          {step === 2 && (
            <Button onClick={() => setStep(3)} disabled={!canGoStep3}>Tiếp tục</Button>
          )}
          {step === 3 && (
            <Button onClick={submit} disabled={!canSubmit || proposeMut.isPending}
                    className="bg-red-600 hover:bg-red-700">
              {proposeMut.isPending
                ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Đang gửi…</>)
                : "Gửi đề nghị chốt sổ"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
