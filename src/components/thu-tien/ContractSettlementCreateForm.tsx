import { useEffect, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { formatVND } from "@/lib/utils";
import type { SettlementSourceRef } from "@/lib/contractSettlement";
import type {
  SettlementCreateDraft,
  SettlementCreateResult,
  SettlementCreateSource,
} from "@/lib/contractSettlementCreate";
import { useContractSettlementCreate } from "@/hooks/useContractSettlementCreate";
export interface ContractSettlementCreateFormProps {
  sourceRef: SettlementSourceRef;
  onCreated: (result: SettlementCreateResult) => void;
  refreshRequired: () => Promise<void>;
  onBusyChange?: (blocked: boolean) => void;
}
const empty: SettlementCreateDraft = {
  amount: 0,
  voucherDate: "",
  payerName: "",
  recipientName: "",
  bank: "",
  accountNumber: "",
  itemDescription: "",
  attachments: [],
  force: false,
  forceReason: "",
  forceConfirmed: false,
};
function draftSchema(source: SettlementCreateSource | null) {
  return z
    .object({
      amount: z
        .number({ invalid_type_error: "Nhập số tiền nguyên lớn hơn 0." })
        .finite()
        .int("Nhập số tiền nguyên lớn hơn 0.")
        .positive("Nhập số tiền nguyên lớn hơn 0.")
        .max(Number.MAX_SAFE_INTEGER),
      voucherDate: z.string(),
      payerName: z.string(),
      recipientName: z.string(),
      bank: z.string(),
      accountNumber: z.string(),
      itemDescription: z.string(),
      attachments: z.array(z.string().trim().min(1)),
      force: z.boolean(),
      forceReason: z.string(),
      forceConfirmed: z.boolean(),
    })
    .superRefine((value, context) => {
      const issue = (field: keyof SettlementCreateDraft, message: string) =>
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message,
        });
      if (source?.kind !== "termination_refund") {
        const date = new Date(value.voucherDate + "T00:00:00Z");
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value.voucherDate) ||
          Number.isNaN(date.valueOf()) ||
          date.toISOString().slice(0, 10) !== value.voucherDate
        )
          issue("voucherDate", "Ngày lập phiếu không hợp lệ.");
      }
      if (
        source?.kind.startsWith("sale_") &&
        source.capAmount !== null &&
        value.amount > source.capAmount
      )
        issue("amount", "Số tiền đề xuất vượt trần thưởng đã công bố.");
      if (source?.kind === "termination_refund") {
        if (!source.refund || value.amount !== source.refund.requestedAmount)
          issue("amount", "Số tiền phải khớp nghĩa vụ hoàn đã được duyệt.");
        if (source.refund?.obligationStatus !== "OK") {
          if (!source.canForce || !value.forceConfirmed || !value.force)
            issue(
              "forceConfirmed",
              "Cần chủ tổ chức xác nhận khoản hoàn có cảnh báo.",
            );
          if (value.forceReason.trim().length < 8)
            issue("forceReason", "Ghi lý do vẫn hoàn ít nhất 8 ký tự.");
        }
      }
    });
}
export function ContractSettlementCreateForm(
  props: ContractSettlementCreateFormProps,
) {
  const c = useContractSettlementCreate(props),
    s = c.source,
    schema = useMemo(() => draftSchema(s), [s]),
    form = useForm<SettlementCreateDraft>({
      defaultValues: empty,
      resolver: zodResolver(schema),
      mode: "onSubmit",
    }),
    {
      register,
      reset,
      setValue,
      watch,
      handleSubmit,
      formState: { errors },
    } = form,
    draft = watch(),
    initializedSource = useRef<SettlementCreateSource | null>(null);
  useEffect(() => {
    if (s && !c.blocked && initializedSource.current !== s) {
      initializedSource.current = s;
      reset({
        ...empty,
        amount: s.suggestedAmount ?? 0,
        voucherDate: s.today,
        recipientName: s.recipientName ?? "",
        bank: s.recipientBank ?? "",
        accountNumber: s.recipientAccount ?? "",
        itemDescription:
          s.kind === "broker"
            ? "Hoa hồng môi giới theo hợp đồng"
            : s.kind === "termination_refund"
              ? "Hoàn tiền cọc theo hồ sơ thanh lý"
              : "Đề xuất thưởng Sale",
      });
    }
  }, [s, reset, c.blocked]);
  if (c.loading)
    return <p role="status">Đang tải nguồn và căn cứ lập phiếu…</p>;
  if (c.error || !s)
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>{c.error || "Chưa đọc được nguồn."}</p>
        <Button variant="outline" onClick={() => void c.reconcile()}>
          Tải lại
        </Button>
      </div>
    );
  const refund = s.kind === "termination_refund",
    refundBasis = s.refund,
    warning = refund && refundBasis?.obligationStatus !== "OK";
  if (refund && !refundBasis)
    return (
      <p role="alert">
        Chưa đọc đủ căn cứ hoàn tiền. Tải lại nguồn trước khi lập phiếu.
      </p>
    );
  return (
    <form
      className="space-y-4 text-sm"
      aria-label="Lập phiếu từ nguồn"
      noValidate
      onSubmit={handleSubmit(async (values) => {
        if (c.blocked || !s.canCreate || s.existingVoucherId) return;
        await c.createFromSource(values).catch(() => {});
      })}
    >
      <p className="text-muted-foreground">
        Lập phiếu chờ duyệt cho nguồn này. Chọn sổ quỹ và ghi nhận chi ở bước xử
        lý phiếu.
      </p>
      <div className="rounded-md border p-3 space-y-1">
        <b>{s.sourceCode || s.name}</b>
        <p>{s.name}</p>
        <p>
          Ngày nguồn: {s.sourceDate || "Chưa xác định"} · {s.sourceStatus}
        </p>
        {s.basis.months !== null && (
          <p>
            {s.basis.months} tháng · Bậc công bố:{" "}
            {s.basis.ratePercent === null
              ? "Chưa có"
              : `${s.basis.ratePercent}%`}
          </p>
        )}
        {s.basis.expectedAmount !== null && (
          <p>Căn cứ hoa hồng: {formatVND(s.basis.expectedAmount)}</p>
        )}
        {s.capAmount !== null && <p>Trần thưởng: {formatVND(s.capAmount)}</p>}
        {s.basis.warning && <p>{s.basis.warning}</p>}
      </div>
      {s.existingVoucherId ? (
        <div className="space-y-2">
          <p>Nguồn đã có phiếu. Mở phiếu để xem trạng thái hiện tại.</p>
          <Button
            type="button"
            disabled={c.blocked}
            onClick={() => void c.reconcile()}
          >
            Mở phiếu hiện có
          </Button>
        </div>
      ) : (
        <>
          <fieldset disabled={c.blocked} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="source-create-amount">
                Số tiền {refund ? "theo nghĩa vụ" : "đề xuất"} (đ)
              </Label>
              <Input
                id="source-create-amount"
                inputMode="numeric"
                type="number"
                min={1}
                step={1}
                {...register("amount", { valueAsNumber: true })}
                aria-invalid={!!errors.amount}
                aria-describedby={
                  errors.amount ? "source-create-amount-error" : undefined
                }
                readOnly={refund}
              />
              {errors.amount && (
                <p id="source-create-amount-error" role="alert">
                  {errors.amount.message}
                </p>
              )}
            </div>
            {refund ? (
              <>
                {refundBasis && (
                  <div className="rounded-md border p-3 space-y-1">
                    <p>Cọc thực đang giữ: {formatVND(refundBasis.realHeld)}</p>
                    <p>
                      Cọc chỉ ghi nhận: {formatVND(refundBasis.recognizedOnly)}
                    </p>
                    <p>
                      {refundBasis.warning ||
                        "Khoản hoàn khớp cọc thực theo căn cứ hiện tại."}
                    </p>
                    <p>Ngày lập phiếu do hệ thống ghi nhận: {s.today}</p>
                  </div>
                )}
                <div>
                  <Label>Người nhận tham khảo từ hồ sơ</Label>
                  <p>{s.recipientName || "Chưa có người nhận"}</p>
                  <p>
                    {s.recipientBank || "Chưa có ngân hàng"} ·{" "}
                    {s.recipientAccount || "Chưa có số tài khoản"}
                  </p>
                  <p className="text-muted-foreground">
                    Đối chiếu và sửa thông tin người nhận bên dưới trước khi lập
                    phiếu.
                  </p>
                </div>
                {warning && (
                  <div className="rounded-md border border-amber-300 p-3 space-y-2">
                    <p>
                      {s.canForce
                        ? "Chủ tổ chức có thể xác nhận vẫn hoàn dù có cảnh báo."
                        : "Cần chủ tổ chức xem xét khoản hoàn có cảnh báo."}
                    </p>
                    {s.canForce && (
                      <>
                        <Textarea
                          aria-label="Lý do vẫn hoàn"
                          {...register("forceReason")}
                          placeholder="Lý do ít nhất 8 ký tự"
                        />
                        {errors.forceReason && (
                          <p role="alert">{errors.forceReason.message}</p>
                        )}
                        <label className="flex gap-2">
                          <Checkbox
                            checked={draft.forceConfirmed}
                            onCheckedChange={(v) => {
                              setValue("forceConfirmed", v === true, {
                                shouldValidate: true,
                                shouldDirty: true,
                              });
                              setValue("force", v === true, {
                                shouldValidate: true,
                                shouldDirty: true,
                              });
                            }}
                          />
                          Tôi đã đối chiếu cọc thực và xác nhận khoản hoàn có
                          cảnh báo.
                        </label>
                        {errors.forceConfirmed && (
                          <p role="alert">{errors.forceConfirmed.message}</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="source-create-date">Ngày lập phiếu</Label>
                  <Input
                    id="source-create-date"
                    type="date"
                    {...register("voucherDate")}
                  />
                  {errors.voucherDate && (
                    <p role="alert">{errors.voucherDate.message}</p>
                  )}
                </div>
                {s.kind !== "sale_deposit" && (
                  <div className="space-y-1">
                    <Label htmlFor="source-create-payer">
                      Đơn vị môi giới / Sale
                    </Label>
                    <Input
                      id="source-create-payer"
                      {...register("payerName")}
                    />
                  </div>
                )}
                {s.kind !== "sale_deposit" && (
                  <div>
                    <Label htmlFor="source-create-basis">Căn cứ đề xuất</Label>
                    <Textarea
                      id="source-create-basis"
                      {...register("itemDescription")}
                    />
                  </div>
                )}
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="source-create-recipient">Người nhận</Label>
              <Input
                id="source-create-recipient"
                {...register("recipientName")}
                placeholder="Nhập tên người nhận"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="source-create-bank">Ngân hàng</Label>
                <Input id="source-create-bank" {...register("bank")} />
              </div>
              <div>
                <Label htmlFor="source-create-account">
                  Số tài khoản người nhận
                </Label>
                <Input
                  id="source-create-account"
                  {...register("accountNumber")}
                />
              </div>
            </div>
          </fieldset>
          {!s.canCreate && (
            <p role="status">
              {s.blockedReason || "Nguồn chưa đủ điều kiện lập phiếu."}
            </p>
          )}
          <Button
            type="submit"
            disabled={
              c.blocked ||
              !s.canCreate ||
              draft.amount <= 0 ||
              (warning &&
                (!s.canForce ||
                  !draft.forceConfirmed ||
                  draft.forceReason.trim().length < 8))
            }
          >
            Lập phiếu chờ duyệt
          </Button>
        </>
      )}
      {c.message && (
        <div role="status" className="rounded-md border p-3 space-y-2">
          <p>{c.message}</p>
          <Button
            type="button"
            variant="outline"
            disabled={c.phase === "writing" || c.phase === "refreshing"}
            onClick={() => void c.reconcile()}
          >
            Tải lại để đối chiếu
          </Button>
        </div>
      )}
    </form>
  );
}
