import {parseCurrencyAmount} from '@/lib/currencyAmountInput';
import { feeFailureMessage } from "@/lib/feeFeedback";
import { focusFirstError } from "@/lib/formErrors";
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Check, X, Pencil, Eraser } from 'lucide-react';
import { toast } from 'sonner';
import {
  FEE_KINDS, useSaveFeeConfig,
  type FeeConfigCell, type FeeKind,
} from '@/hooks/useFeeConfigMatrix';
import { type SpecialFeePrice, useSetSpecialFeePrice } from '@/hooks/useSpecialFeePrices';

const fmt = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('vi-VN') + 'đ';

/** Empty means keep the previous suggestion; invalid text must never change its value. */
const parseAmount=(raw:string):number|null=>raw.trim()===''?null:parseCurrencyAmount(raw).value??Number.NaN;

interface EditState {
  buildingId: string;
  feeCategory: FeeKind;
  amount: string;
  providerCode: string;
  accountHolder: string;
}

/** Hộp thoại công bố giá — chỉ chủ tổ chức thấy. */
interface PublishState {
  buildingId: string;
  buildingName: string;
  feeCategory: FeeKind;
  feeLabel: string;
  amount: string;
  month: string;           // 'YYYY-MM'
  currentAmount: number | null;
}

export default function FeeDetails({ cell, price, month }: {
  cell: FeeConfigCell;
  price: SpecialFeePrice | undefined;
  month: string;
}) {
  const save = useSaveFeeConfig();
  const setPrice = useSetSpecialFeePrice();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [publish, setPublish] = useState<PublishState | null>(null);
  const editRoot=useRef<HTMLDivElement>(null);
  const [editError,setEditError]=useState<string|null>(null);
  const publishRoot=useRef<HTMLDivElement>(null);
  const [publishErrors,setPublishErrors]=useState<Record<string,string>>({});
  const [submitError,setSubmitError]=useState<string|null>(null);
  const beginEdit = (c: FeeConfigCell) => {
    setEditError(null);
    setEdit({
      buildingId: c.buildingId,
      feeCategory: c.feeCategory,
      amount: c.defaultAmount == null ? '' : String(c.defaultAmount),
      providerCode: c.providerCode,
      accountHolder: c.accountHolder,
    });
  };

  const commit = async (clearAmount = false) => {
    if (!edit || save.isPending) return;
    const parsed = parseAmount(edit.amount);
    if(!clearAmount && parsed!==null && !Number.isFinite(parsed)){
      const message='Nhập số tiền nguyên theo đồng; không nhập số âm, chữ hoặc số lẻ.';setEditError(message);void focusFirstError({amount:message},{root:editRoot.current,order:['amount']});return;
    }
    setEditError(null);
    try {
      await save.mutateAsync({
        buildingId: edit.buildingId,
        feeCategory: edit.feeCategory,
        // null ⇒ RPC bật cờ xoá. undefined ⇒ không đụng.
        defaultAmount: clearAmount ? null : (parsed ?? undefined),
        providerCode: edit.providerCode.trim() === '' ? undefined : edit.providerCode.trim(),
        accountHolder: edit.accountHolder.trim() === '' ? undefined : edit.accountHolder.trim(),
      });
      toast.success(clearAmount ? 'Đã xoá giá mặc định' : 'Đã lưu cấu hình');
      setEdit(null);
    } catch (e) {
      toast.error(feeFailureMessage(e,'lưu cấu hình phí'));
    }
  };

  const commitPublish = async () => {
    if (!publish || setPrice.isPending) return;
    const parsed = parseAmount(publish.amount);
    const errors:Record<string,string>={};
    if(parsed===null || !Number.isFinite(parsed) || parsed<=0) errors.amount='Nhập giá công bố nguyên theo đồng và lớn hơn 0';
    if(!/^\d{4}-\d{2}$/.test(publish.month))errors.month='Chọn tháng bắt đầu áp dụng giá';
    setPublishErrors(errors);setSubmitError(null);
    if(Object.keys(errors).length){void focusFirstError(errors,{root:publishRoot.current,order:['amount','month']});return;}

    try {
      const res = await setPrice.mutateAsync({
        buildingId: publish.buildingId,
        feeCategory: publish.feeCategory,
        amount: parsed!,
        effectiveFromMonth: publish.month,
      });
      toast.success(`Đã công bố giá ${fmt(parsed)} cho ${publish.feeLabel} · ${publish.buildingName}, từ kỳ ${publish.month}.`);
      setPublish(null);
    } catch (e) {
      const message=feeFailureMessage(e,'công bố giá phí');setSubmitError(message);toast.error(message);
    }
  };

  const toggleNotApplicable = async (c: FeeConfigCell) => {
    try {
      await save.mutateAsync({
        buildingId: c.buildingId,
        feeCategory: c.feeCategory,
        notApplicable: !c.notApplicable,
      });
      toast.success(!c.notApplicable
        ? `Đã tắt "${FEE_KINDS.find((k) => k.key === c.feeCategory)?.label}" cho toà này`
        : 'Đã bật lại hạng mục');
    } catch (e) {
      toast.error(feeFailureMessage(e,'đổi áp dụng phí; trạng thái vẫn giữ theo lần lưu trước'));
    }
  };

  const c = cell;
  const feeLabel = FEE_KINDS.find(k => k.key === c.feeCategory)?.label ?? c.feeCategory;
  return (
    <div className="space-y-3">
      <p className="text-sm">Giá công bố <strong>{!price ? 'Chưa có dữ liệu giá' : price.amount != null ? fmt(price.amount) : 'Chưa công bố'}</strong>
        {price?.effectiveFrom && ` · từ tháng ${price.effectiveFrom}`}</p>
      {edit ? (
        <div ref={editRoot} className="space-y-1.5 min-w-[8rem]"
             onKeyDown={(e) => {
               if (e.key === 'Enter') { e.preventDefault(); commit(); }
               if (e.key === 'Escape') { e.preventDefault(); setEdit(null); }
             }}>
          <Input name="amount" aria-invalid={!!editError} aria-describedby={editError?'fee-edit-error':undefined} autoFocus inputMode="numeric" placeholder="Giá mỗi kỳ"
                 value={edit.amount}
                 onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                 className="h-8 text-sm" />
          {editError && <p id="fee-edit-error" role="alert" className="text-sm text-destructive">{editError}</p>}
          <Input placeholder="Mã khách hàng" value={edit.providerCode}
                 onChange={(e) => setEdit({ ...edit, providerCode: e.target.value })}
                 className="h-8 text-xs" />
          <Input placeholder="Chủ hộ" value={edit.accountHolder}
                 onChange={(e) => setEdit({ ...edit, accountHolder: e.target.value })}
                 className="h-8 text-xs" />
          <div className="flex items-center gap-1">
            <Button aria-label="Lưu gợi ý" size="sm" className="h-7 px-2" onClick={() => commit()}
                    disabled={save.isPending}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button aria-label="Huỷ sửa gợi ý" size="sm" variant="ghost" className="h-7 px-2"
                    onClick={() => setEdit(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
            {c.defaultAmount != null && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-destructive"
                            aria-label="Xoá giá mặc định" onClick={() => commit(true)}
                            disabled={save.isPending}>
                      <Eraser className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Xoá giá mặc định</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          {!c.notApplicable && <>
            <button type="button"
                    onClick={() => beginEdit(c)}
                    className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:underline"
                    aria-label={`Sửa gợi ý ${feeLabel} của ${c.buildingName}`}>
              <span className="tabular-nums">
                Gợi ý: {c.defaultAmount == null ? '—' : fmt(c.defaultAmount)}
              </span>
              <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
            </button>

            {price?.canEdit && (
              <button type="button"
                      onClick={() => setPublish({
                        buildingId: c.buildingId,
                        buildingName: c.buildingName,
                        feeCategory: c.feeCategory,
                        feeLabel,
                        amount: price.amount != null ? String(price.amount)
                              : (c.defaultAmount != null ? String(c.defaultAmount) : ''),
                        month,
                        currentAmount: price.amount,
                      })}
                      className="block text-[11px] text-primary hover:underline">
                {price.amount == null ? 'Công bố giá' : 'Đổi giá'}
              </button>
            )}
          </>}
          {c.providerCode && <span className="text-sm">Mã khách hàng {c.providerCode}</span>}
          {c.voucherCount > 0 && <span className="text-sm">{c.voucherCount} phiếu · {c.lastVoucherDate}</span>}
          <button type="button"
                  onClick={() => toggleNotApplicable(c)}
                  disabled={save.isPending}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted">
            {c.notApplicable ? 'Bật lại' : 'Tắt hạng mục'}
          </button>
        </div>
      )}
      <Dialog open={publish !== null} onOpenChange={(o) => !o && setPublish(null)}>
        <DialogContent ref={publishRoot} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {publish?.currentAmount == null ? 'Công bố giá' : 'Đổi giá công bố'}
            </DialogTitle>
            <DialogDescription>
              {publish?.feeLabel} — {publish?.buildingName}
            </DialogDescription>
          </DialogHeader>

          {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
          {Object.entries(publishErrors).map(([field,message])=><p key={field} id={`publish-${field}-error`} role="alert" className="text-sm text-destructive">{message}</p>)}
          {publish && (
            <div className="space-y-4"
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') { e.preventDefault(); commitPublish(); }
                 }}>
              <div className="space-y-1.5">
                <Label htmlFor="sfp-amount">Mức phí mỗi tháng</Label>
                <Input name="amount" aria-invalid={!!publishErrors.amount} aria-describedby="publish-amount-error" id="sfp-amount" autoFocus inputMode="numeric"
                       placeholder="Ví dụ: 1.500.000"
                       value={publish.amount}
                       onChange={(e) => setPublish({ ...publish, amount: e.target.value })} />
                {publish.currentAmount != null && (
                  <p className="text-[11px] text-muted-foreground">
                    Đang công bố: {fmt(publish.currentAmount)}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sfp-month">Áp dụng từ tháng</Label>
                <Input name="month" aria-invalid={!!publishErrors.month} aria-describedby="publish-month-error" id="sfp-month" type="month" value={publish.month}
                       onChange={(e) => setPublish({ ...publish, month: e.target.value })} />
                <p className="text-[11px] text-muted-foreground">
                  Phiếu của các tháng <strong>trước</strong> tháng này giữ nguyên giá cũ —
                  không có gì bị tính lại.
                </p>
              </div>

              <div className="rounded-md border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
                Giá này dùng để đối chiếu khi đóng phí cố định theo giá công bố. Kiểm tra cách duyệt của kỳ ở bảng Chi phí theo tòa.
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPublish(null)}>Huỷ</Button>
            <Button onClick={() => commitPublish()} disabled={setPrice.isPending}>
              {setPrice.isPending ? 'Đang lưu…' : 'Công bố'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
