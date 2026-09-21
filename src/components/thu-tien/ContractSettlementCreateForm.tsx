import { useEffect, useState } from "react";
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
export function ContractSettlementCreateForm(
  props: ContractSettlementCreateFormProps,
) {
  const c = useContractSettlementCreate(props),
    s = c.source,
    [draft, setDraft] = useState(empty);
  useEffect(() => {
    if (s)
      setDraft({
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
  }, [s]);
  const set = <K extends keyof SettlementCreateDraft>(
    key: K,
    value: SettlementCreateDraft[K],
  ) => setDraft((v) => ({ ...v, [key]: value }));
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
      onSubmit={(e) => {
        e.preventDefault();
        void c.createFromSource(draft).catch(() => {});
      }}
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
                value={draft.amount || ""}
                onChange={(e) => set("amount", Number(e.target.value))}
                readOnly={refund}
              />
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
                          value={draft.forceReason}
                          onChange={(e) => set("forceReason", e.target.value)}
                          placeholder="Lý do ít nhất 8 ký tự"
                        />
                        <label className="flex gap-2">
                          <Checkbox
                            checked={draft.forceConfirmed}
                            onCheckedChange={(v) => {
                              set("forceConfirmed", v === true);
                              set("force", v === true);
                            }}
                          />
                          Tôi đã đối chiếu cọc thực và xác nhận khoản hoàn có
                          cảnh báo.
                        </label>
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
                    value={draft.voucherDate}
                    onChange={(e) => set("voucherDate", e.target.value)}
                  />
                </div>
                {s.kind !== "sale_deposit" && (
                  <div className="space-y-1">
                    <Label htmlFor="source-create-payer">
                      Đơn vị môi giới / Sale
                    </Label>
                    <Input
                      id="source-create-payer"
                      value={draft.payerName}
                      onChange={(e) => set("payerName", e.target.value)}
                    />
                  </div>
                )}
                {s.kind !== "sale_deposit" && (
                  <div>
                    <Label htmlFor="source-create-basis">Căn cứ đề xuất</Label>
                    <Textarea
                      id="source-create-basis"
                      value={draft.itemDescription}
                      onChange={(e) => set("itemDescription", e.target.value)}
                    />
                  </div>
                )}
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="source-create-recipient">Người nhận</Label>
              <Input
                id="source-create-recipient"
                value={draft.recipientName}
                onChange={(e) => set("recipientName", e.target.value)}
                placeholder="Nhập tên người nhận"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="source-create-bank">Ngân hàng</Label>
                <Input
                  id="source-create-bank"
                  value={draft.bank}
                  onChange={(e) => set("bank", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="source-create-account">
                  Số tài khoản người nhận
                </Label>
                <Input
                  id="source-create-account"
                  value={draft.accountNumber}
                  onChange={(e) => set("accountNumber", e.target.value)}
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
