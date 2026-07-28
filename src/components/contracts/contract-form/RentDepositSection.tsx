import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { LockedCurrencyInput } from "@/components/ui/locked-currency-input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";

import type { PaymentCycle } from "@/types/contract";
import { PAYMENT_CYCLE_LABELS } from "@/types/contract";
// Ô tiền trong form dùng hậu tố "đ" (CurrencyInput), nên hint kèm theo cũng
// phải là formatVND của utils — KHÔNG dùng formatVND của ./types (ký hiệu ₫).
import { formatCurrency, formatVND as formatMoneyPlain } from "@/lib/utils";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import { SearchableSelect } from "@/components/ui/searchable-select";

import { depositAdjustmentHint } from "@/lib/contractPriceAdjustment";

import { formatVND } from "./types";
import type { ContractFormState } from "./useContractFormState";

type RentDepositSectionProps = Pick<
  ContractFormState,
  | "form"
  | "isEditMode"
  | "roomDefaultRent"
  | "rentDiffersFromRoom"
  | "rentUnlocked"
  | "unlockRent"
  | "depositUnlocked"
  | "unlockDeposit"
  | "depositAdjustment"
  | "depositRemaining"
  | "depositShortfall"
  | "depositDebtMode"
  | "depositRows"
  | "depositPaidTotal"
  | "orphanDepositVouchers"
  | "accounts"
  | "authUser"
  | "addDepositRow"
  | "updateDepositRow"
  | "removeDepositRow"
>;

/** ===== Section 3: Tiền thuê & Tiền cọc ===== (JSX chuyển NGUYÊN VĂN) */
export function RentDepositSection({
  form,
  isEditMode,
  roomDefaultRent,
  rentDiffersFromRoom,
  rentUnlocked,
  unlockRent,
  depositUnlocked,
  unlockDeposit,
  depositAdjustment,
  depositRemaining,
  depositShortfall,
  depositDebtMode,
  depositRows,
  depositPaidTotal,
  orphanDepositVouchers,
  accounts,
  authUser,
  addDepositRow,
  updateDepositRow,
  removeDepositRow,
}: RentDepositSectionProps) {
  const depositHint = depositAdjustmentHint(depositAdjustment);
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground border-b pb-2">
        Tiền thuê & Tiền cọc
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tiền thuê — mặc định = giá niêm yết của phòng, khoá xám; bấm bút
            chì để ký giá khác. Giá lệch sẽ vào lịch sử giá của phòng. */}
        <FormField
          control={form.control}
          name="rent_price"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tiền thuê</FormLabel>
              <FormControl>
                <LockedCurrencyInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                  locked={!rentUnlocked}
                  onUnlock={unlockRent}
                  unlockLabel="Sửa tiền thuê"
                />
              </FormControl>
              {roomDefaultRent > 0 && (
                <p
                  className={
                    rentDiffersFromRoom
                      ? "text-xs text-amber-600 dark:text-amber-500"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {rentDiffersFromRoom
                    ? `Khác giá mặc định của phòng (${formatMoneyPlain(roomDefaultRent)}) — thay đổi này được ghi vào lịch sử giá của phòng.`
                    : `Giá mặc định của phòng: ${formatMoneyPlain(roomDefaultRent)}`}
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Chu kỳ thanh toán */}
        <FormField
          control={form.control}
          name="payment_cycle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Chu kỳ thanh toán</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn chu kỳ" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {(
                    Object.entries(PAYMENT_CYCLE_LABELS) as [
                      PaymentCycle,
                      string,
                    ][]
                  ).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Ngày bắt đầu tính tiền */}
        <FormField
          control={form.control}
          name="start_billing_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ngày BĐ tính tiền</FormLabel>
              <FormControl>
                <DateInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Đến ngày (mặc định ngày 5 tháng kế tiếp) */}
        <FormField
          control={form.control}
          name="end_billing_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Đến ngày</FormLabel>
              <FormControl>
                <DateInput
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Tiền cọc — mặc định bám tiền thuê, khoá xám; bấm bút chì để chỉnh
            theo thoả thuận. Lệch mặc định thì cảnh báo rõ tăng/giảm ngay dưới
            ô và ghi 1 dòng "[Điều chỉnh cọc]" vào ghi chú HĐ để lọc sau này. */}
        <FormField
          control={form.control}
          name="total_deposit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tiền cọc</FormLabel>
              <FormControl>
                <LockedCurrencyInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                  locked={!depositUnlocked}
                  onUnlock={unlockDeposit}
                  unlockLabel="Sửa tiền cọc"
                />
              </FormControl>
              {depositHint ? (
                <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                  {depositHint}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Mặc định bằng tiền thuê — bấm bút chì để chỉnh.
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Tiền cọc phải đóng (calculated readonly) — gộp vào HĐ tháng đầu */}
        <div className="space-y-2">
          <Label>Tiền cọc phải đóng (gộp vào hoá đơn)</Label>
          <Input
            type="text"
            readOnly
            className="bg-muted"
            value={formatVND(depositRemaining)}
          />
        </div>
      </div>

      {/* Đã đặt cọc — chỉ ghi cọc khách ĐÃ ĐƯA TIỀN MẶT (giữ chỗ trước /
          đưa thêm lúc ký): mỗi dòng [số tiền | sổ quỹ | ngày | ảnh] → 1
          phiếu thu cọc (is_deposit) vào sổ thật. Phần cọc CÒN LẠI tự gộp
          vào hoá đơn tháng đầu (thu cùng hoá đơn, tách phiếu khi thu). */}
      {!isEditMode && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Đã đặt cọc (khách đã đưa tiền mặt)</Label>
              <p className="text-xs text-muted-foreground">
                Cọc còn thiếu tự gộp vào hoá đơn tháng đầu — chỉ thêm
                dòng nếu khách đưa tiền mặt cọc lúc ký.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addDepositRow()}
            >
              <Plus className="h-4 w-4 mr-1" /> Thêm lần cọc
            </Button>
          </div>

          {/* Phiếu cọc cũ của phòng (giữ chỗ / cọc trước) — XÁM, chỉ xem.
              RPC nhận ID rõ ràng và gắn cùng transaction; không tạo lại. */}
          {orphanDepositVouchers.map((v) => (
            <div
              key={v.id}
              className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr_auto] gap-2 items-center rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            >
              <span className="tabular-nums">
                {formatVND(v.total_amount)}
              </span>
              <span className="truncate">
                {v.code ? `${v.code} — ` : ""}
                {v.name}
              </span>
              <span className="text-xs whitespace-nowrap">
                {v.voucher_date}
                {v.approval_status === "APPROVED"
                  ? " · đã thu"
                  : " · chưa duyệt (chưa tính)"}
              </span>
            </div>
          ))}

          {/* Dòng nhập mới */}
          {depositRows.map((r) => (
            <div key={r.uid} className="rounded-md border p-3 space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                <CurrencyInput
                  value={r.amount}
                  onChange={(v) =>
                    updateDepositRow(r.uid, { amount: v ?? 0 })
                  }
                />
                <SearchableSelect
                  placeholder="Sổ quỹ"
                  value={r.account_id}
                  onValueChange={(v) =>
                    updateDepositRow(r.uid, { account_id: v })
                  }
                  options={accounts.map((a) => ({
                    value: a.id,
                    label: a.name,
                    keywords: a.code,
                  }))}
                />
                <DateInput
                  value={r.received_date}
                  onChange={(iso) =>
                    updateDepositRow(r.uid, { received_date: iso })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                  onClick={() => removeDepositRow(r.uid)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {authUser?.id && (
                <AttachmentUpload
                  attachments={r.images}
                  onChange={(urls) =>
                    updateDepositRow(r.uid, { images: urls })
                  }
                  userId={authUser.id}
                />
              )}
            </div>
          ))}

          <div className="flex items-center justify-between text-sm px-1">
            <span className="text-muted-foreground">Tổng đã đặt cọc</span>
            <span className="font-medium tabular-nums">
              {formatVND(depositPaidTotal)}
            </span>
          </div>
        </div>
      )}

      {/* Xử lý thiếu cọc — chặn ký khi khách chưa đóng đủ cọc. Chọn
          "Đóng đủ trong hoá đơn" (cọc còn thiếu GỘP vào hoá đơn tháng
          đầu, thu cùng hoá đơn rồi tách phiếu cọc khi thanh toán) hoặc
          "Nợ cọc" (theo dõi nợ + nhắc, không vào hoá đơn). Chỉ hiện
          khi tạo mới & thiếu cọc. */}
      {!isEditMode && depositShortfall && (
        <Alert variant="destructive" className="space-y-3">
          <AlertDescription className="space-y-3">
            <div>
              <p className="font-medium">
                Khách chưa đóng đủ cọc — còn thiếu{" "}
                {formatCurrency(depositRemaining)}
              </p>
              <p className="text-xs">
                Chọn "Đóng đủ trong hoá đơn" để gộp cọc còn thiếu vào
                hoá đơn tháng đầu (thu cùng hoá đơn), hoặc "Nợ cọc" để
                theo dõi nợ. Chọn cách xử lý để lưu hợp đồng.
              </p>
            </div>

            <FormField
              control={form.control}
              name="deposit_debt_mode"
              render={({ field }) => (
                <FormItem className="space-y-2">
                  <FormControl>
                    <RadioGroup
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      className="gap-2"
                    >
                      <label className="flex items-start gap-2 cursor-pointer">
                        <RadioGroupItem
                          value="FIRST_INVOICE"
                          className="mt-0.5"
                        />
                        <span className="text-sm">
                          <span className="font-medium">
                            Đóng đủ trong hoá đơn
                          </span>{" "}
                          — cọc còn thiếu tính vào hoá đơn tháng đầu,
                          thu cùng hoá đơn (tự tách phiếu cọc khi thu).
                        </span>
                      </label>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <RadioGroupItem value="DEBT" className="mt-0.5" />
                        <span className="text-sm">
                          <span className="font-medium">Nợ cọc</span>{" "}
                          — KHÔNG vào hoá đơn; theo dõi &amp; nhắc khách
                          bổ sung cọc sau.
                        </span>
                      </label>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {depositDebtMode === "DEBT" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="deposit_debt_reason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Lý do cho nợ cọc</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          placeholder="VD: khách hẹn bổ sung sau khi nhận lương"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="deposit_topup_due_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Hẹn bổ sung cọc</FormLabel>
                      <FormControl>
                        <DateInput
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Số tháng giảm */}
        <FormField
          control={form.control}
          name="discount_months"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Số tháng giảm</FormLabel>
              <FormControl>
                <NumberInput
                  min={0}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Số tiền giảm/tháng */}
        <FormField
          control={form.control}
          name="discount_amount_per_month"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Số tiền giảm/tháng</FormLabel>
              <FormControl>
                <CurrencyInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}
