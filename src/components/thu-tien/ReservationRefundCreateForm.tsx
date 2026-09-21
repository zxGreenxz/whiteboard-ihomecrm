import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatVND } from "@/lib/utils";
import {
  reservationRefundDraftSchema,
  type ReservationRefundDraft,
  type ReservationRefundSourceRef,
} from "@/lib/reservationRefundWorkflow";
import type { SettlementCreateResult } from "@/lib/contractSettlementCreate";
import { useReservationRefundCreate } from "@/hooks/useReservationRefundCreate";
export interface ReservationRefundCreateFormProps {
  sourceRef: ReservationRefundSourceRef;
  onCreated: (result: SettlementCreateResult) => void;
  refreshRequired: () => Promise<void>;
  onBusyChange?: (blocked: boolean) => void;
  creationDisabled?: boolean;
}
export function ReservationRefundCreateForm(
  props: ReservationRefundCreateFormProps,
) {
  const c = useReservationRefundCreate(props),
    s = c.source;
  const {
    register,
    reset,
    handleSubmit,
    formState: { errors },
  } = useForm<ReservationRefundDraft>({
    defaultValues: { recipientName: "", bank: "", accountNumber: "" },
    resolver: zodResolver(reservationRefundDraftSchema),
  });
  const initialized = useRef<typeof s>(null);
  useEffect(() => {
    if (s && !c.blocked && initialized.current !== s) {
      initialized.current = s;
      reset({ recipientName: s.payerName ?? "", bank: "", accountNumber: "" });
    }
  }, [s, c.blocked, reset]);
  if (c.loading) return <p role="status">Đang tải căn cứ hoàn giữ chỗ…</p>;
  if (c.error || !s)
    return (
      <div role="alert">
        <p>{c.error || "Chưa đọc đủ nguồn hoàn giữ chỗ."}</p>
        <Button variant="outline" onClick={() => void c.reconcile()}>
          Tải lại
        </Button>
      </div>
    );
  return (
    <form
      aria-label="Lập phiếu hoàn giữ chỗ"
      noValidate
      className="space-y-4 text-sm"
      onSubmit={handleSubmit(async (values) => {
        if (!props.creationDisabled && !c.blocked && s.canCreate && !s.existingVoucherId)
          await c.createFromSource(values).catch(() => {});
      })}
    >
      <p>
        Lập phiếu chờ duyệt cho toàn bộ khoản hoàn còn lại. Chọn sổ quỹ và ghi
        nhận chi ở bước xử lý phiếu.
      </p>
      <div className="rounded-md border p-3 space-y-1">
        <b>{s.sourceCode || "Phiếu giữ chỗ"}</b>
        <p>Cọc thực nhận: {formatVND(s.depositAmount)}</p>
        <p>
          Giữ lại: {formatVND(s.retainedAmount)} · Đã hoàn: {formatVND(s.paid)}
        </p>
        <p>
          Còn phải hoàn: <strong>{formatVND(s.remaining)}</strong>
        </p>
      </div>
      {!s.existingVoucherId && (
        <fieldset disabled={props.creationDisabled || c.blocked || !s.canCreate} className="space-y-3">
          <p className="text-muted-foreground">
            Tên người nhận được gợi ý từ phiếu cọc để đối chiếu. Kiểm tra thông
            tin nhận tiền trước khi lập phiếu.
          </p>
          <div>
            <Label htmlFor="reservation-recipient">Người nhận</Label>
            <Input id="reservation-recipient" {...register("recipientName")} />
            {errors.recipientName && (
              <p role="alert">{errors.recipientName.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="reservation-bank">Ngân hàng</Label>
            <Input id="reservation-bank" {...register("bank")} />
            {errors.bank && <p role="alert">{errors.bank.message}</p>}
          </div>
          <div>
            <Label htmlFor="reservation-account">Số tài khoản</Label>
            <Input id="reservation-account" {...register("accountNumber")} />
            {errors.accountNumber && (
              <p role="alert">{errors.accountNumber.message}</p>
            )}
          </div>
        </fieldset>
      )}
      {s.blockedReason && <p role="alert">{s.blockedReason}</p>}
      {c.message && <p role="status">{c.message}</p>}
      <div className="flex flex-wrap gap-2">
        {s.existingVoucherId ? (
          <Button
            type="button"
            disabled={c.blocked}
            onClick={() => void c.reconcile()}
          >
            Mở phiếu đã có
          </Button>
        ) : (
          <Button type="submit" disabled={props.creationDisabled || c.blocked || !s.canCreate}>
            Lập phiếu chờ duyệt
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => void c.reconcile()}
        >
          Tải lại để đối chiếu
        </Button>
      </div>
    </form>
  );
}
