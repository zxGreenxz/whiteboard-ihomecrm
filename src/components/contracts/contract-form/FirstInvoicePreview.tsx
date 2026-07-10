import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";

import { computeFirstBillingMonth } from "@/lib/firstInvoiceBuilder";

import { formatVND } from "./types";
import type { ContractFormState } from "./useContractFormState";

type FirstInvoicePreviewProps = Pick<
  ContractFormState,
  | "form"
  | "startBilling"
  | "endBilling"
  | "invoiceItems"
  | "invoiceSubtotal"
  | "firstInvoiceDiscount"
  | "invoiceTotal"
  | "addInvoiceItem"
  | "updateInvoiceItem"
  | "removeInvoiceItem"
>;

/** ===== Section 5: Xem trước hoá đơn cọc + tháng đầu ===== (JSX chuyển
 * NGUYÊN VĂN; gate `!isEditMode` giữ ở root như bản gốc) */
export function FirstInvoicePreview({
  form,
  startBilling,
  endBilling,
  invoiceItems,
  invoiceSubtotal,
  firstInvoiceDiscount,
  invoiceTotal,
  addInvoiceItem,
  updateInvoiceItem,
  removeInvoiceItem,
}: FirstInvoicePreviewProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h3 className="text-sm font-semibold text-foreground">
          Xem trước hoá đơn cọc + tháng đầu
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addInvoiceItem}
        >
          <Plus className="h-4 w-4 mr-1" />
          Thêm dòng
        </Button>
      </div>

      {(() => {
        // Kỳ thanh toán doanh thu của HĐ đầu (theo quy tắc tháng phủ
        // trọn) — cho quản lý thấy trước HĐ rơi vào tháng nào.
        const bm = computeFirstBillingMonth(
          startBilling || form.watch("start_date"),
          endBilling,
        );
        if (!bm) return null;
        const [yy, mm] = bm.split("-");
        return (
          <p className="text-xs text-muted-foreground">
            Kỳ thanh toán (ghi nhận doanh thu):{" "}
            <span className="font-medium text-foreground">{mm}/{yy}</span>
          </p>
        );
      })()}

      {invoiceItems.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Chưa có dữ liệu — hãy nhập tiền thuê / tiền cọc / ngày tính tiền để xem trước hoá đơn.
        </p>
      ) : (
        <>
          {/* Mobile layout: stacked cards */}
          <div className="md:hidden space-y-3">
            {invoiceItems.map((it) => (
              <div
                key={it.id}
                className="border rounded-md p-3 space-y-2 bg-card"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0 space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Mô tả
                    </Label>
                    <Input
                      className="h-9 text-sm"
                      value={it.description}
                      onChange={(e) =>
                        updateInvoiceItem(it.id, "description", e.target.value)
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 mt-5 text-destructive hover:text-destructive shrink-0"
                    onClick={() => removeInvoiceItem(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      SL
                    </Label>
                    <NumberInput
                      min={1}
                      className="w-full h-9 text-right"
                      value={it.quantity}
                      onChange={(v) =>
                        updateInvoiceItem(it.id, "quantity", v || 1)
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Đơn giá
                    </Label>
                    <CurrencyInput
                      suffix={false}
                      className="w-full h-9 text-right"
                      value={it.unit_price}
                      onChange={(v) =>
                        updateInvoiceItem(it.id, "unit_price", v)
                      }
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1 border-t">
                  <span className="text-xs text-muted-foreground">
                    Thành tiền
                  </span>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatVND(it.unit_price * it.quantity)}
                  </span>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between px-3 py-2 border rounded-md bg-slate-50">
              <span className="text-sm">Tạm tính</span>
              <span className="text-sm tabular-nums">
                {formatVND(invoiceSubtotal)}
              </span>
            </div>
            {firstInvoiceDiscount.amount > 0 && (
              <div
                className="flex items-center justify-between px-3 py-2 border rounded-md bg-amber-50 border-amber-200"
                title={firstInvoiceDiscount.notes}
              >
                <div className="flex flex-col">
                  <span className="text-sm text-amber-900">Giảm trừ</span>
                  <span className="text-[11px] text-amber-700 leading-tight">
                    {firstInvoiceDiscount.notes}
                  </span>
                </div>
                <span className="text-sm tabular-nums text-amber-900">
                  −{formatVND(firstInvoiceDiscount.amount)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2 border rounded-md bg-muted/40">
              <span className="text-sm font-semibold">Tổng cộng</span>
              <span className="text-sm font-semibold tabular-nums">
                {formatVND(invoiceTotal)}
              </span>
            </div>
          </div>

          {/* Desktop layout: table */}
          <div className="hidden md:block border rounded-md overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium">Mô tả</th>
                  <th className="text-right px-3 py-2 font-medium w-20">SL</th>
                  <th className="text-right px-3 py-2 font-medium w-36">Đơn giá</th>
                  <th className="text-right px-3 py-2 font-medium w-36">Thành tiền</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invoiceItems.map((it) => (
                  <tr key={it.id}>
                    <td className="px-3 py-2">
                      <Input
                        className="h-8 text-sm"
                        value={it.description}
                        onChange={(e) =>
                          updateInvoiceItem(it.id, "description", e.target.value)
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <NumberInput
                        min={1}
                        className="w-16 h-8 text-right ml-auto"
                        value={it.quantity}
                        onChange={(v) =>
                          updateInvoiceItem(it.id, "quantity", v || 1)
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <CurrencyInput
                        suffix={false}
                        className="w-32 h-8 text-right ml-auto"
                        value={it.unit_price}
                        onChange={(v) =>
                          updateInvoiceItem(it.id, "unit_price", v)
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {formatVND(it.unit_price * it.quantity)}
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => removeInvoiceItem(it.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-slate-50">
                  <td colSpan={3} className="px-3 py-2 text-right">
                    Tạm tính
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatVND(invoiceSubtotal)}
                  </td>
                  <td></td>
                </tr>
                {firstInvoiceDiscount.amount > 0 && (
                  <tr
                    className="bg-amber-50 border-amber-200"
                    title={firstInvoiceDiscount.notes}
                  >
                    <td colSpan={3} className="px-3 py-2 text-right text-amber-900">
                      <div className="flex flex-col items-end leading-tight">
                        <span>Giảm trừ</span>
                        <span className="text-[11px] text-amber-700">
                          {firstInvoiceDiscount.notes}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-amber-900 tabular-nums">
                      −{formatVND(firstInvoiceDiscount.amount)}
                    </td>
                    <td></td>
                  </tr>
                )}
                <tr className="bg-muted/40">
                  <td colSpan={3} className="px-3 py-2 text-right font-semibold">
                    Tổng cộng
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatVND(invoiceTotal)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
