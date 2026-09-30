import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";

import { computeFirstBillingMonth } from "@/lib/firstInvoiceBuilder";
import { flattenFieldErrors } from '@/lib/formErrors';

import { formatVND } from "./types";
import type { ContractFormState } from "./useContractFormState";

type FirstInvoicePreviewProps = Pick<
  ContractFormState,
  | "depositRemaining"
  | "setInvoiceItems"
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
  | "sourceIssues"
>;

/** ===== Section 5: Xem trước hoá đơn cọc + tháng đầu ===== (JSX chuyển
 * NGUYÊN VĂN; gate `!isEditMode` giữ ở root như bản gốc) */
export function FirstInvoicePreview({
  depositRemaining,
  setInvoiceItems,
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
  sourceIssues,
}: FirstInvoicePreviewProps) {
  const fieldErrors = flattenFieldErrors(form.formState.errors);
  const rowError = (id: string, field: string) => fieldErrors[`invoice_items.${id}.${field}`];
  const depositNeedsRepair = !!fieldErrors.first_invoice || invoiceItems.some(item=>item.accounting_class==='DEPOSIT' && !!rowError(item.id,'unit_price'));
  const repairDeposit = () => {
    if(sourceIssues.length || !Number.isFinite(depositRemaining) || depositRemaining < 0) return;
    const previous=invoiceItems.find(item=>item.accounting_class==='DEPOSIT');
    const others=invoiceItems.filter(item=>item.accounting_class!=='DEPOSIT');
    setInvoiceItems([...others,...(depositRemaining>0?[{id:previous?.id??`deposit-${crypto.randomUUID()}`,type:'OTHER' as const,accounting_class:'DEPOSIT' as const,description:previous?.description??'Tiền cọc',unit_price:depositRemaining,quantity:1}]:[])]);
    form.clearErrors('first_invoice' as never);
    for(const item of invoiceItems.filter(item=>item.accounting_class==='DEPOSIT'))form.clearErrors(`invoice_items.${item.id}` as never);
  };
  return (
    <div className="space-y-4" data-field-name="first_invoice" tabIndex={-1} aria-invalid={!!fieldErrors.first_invoice}>
      {'state' in firstInvoiceDiscount && firstInvoiceDiscount.state === 'NEEDS_REVIEW' && <p role="alert" className="text-sm text-destructive">{firstInvoiceDiscount.notes || 'Nhập đủ ngày để xác định kỳ hỗ trợ. Chưa thể ghi nhận hóa đơn.'}</p>}
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
      {(form.formState.errors as Record<string, { message?: string }>).first_invoice?.message && (
        <p role="alert" className="text-sm font-medium text-destructive">{(form.formState.errors as Record<string, { message?: string }>).first_invoice?.message}</p>
      )}
      {depositNeedsRepair && <Button type="button" variant="outline" onClick={repairDeposit} disabled={sourceIssues.length>0}>Cập nhật dòng tiền cọc theo phần còn thiếu</Button>}
      {sourceIssues.length > 0 && <p role="alert" className="text-sm font-medium text-destructive">
        Bản xem trước chưa đầy đủ vì chưa tải được {sourceIssues.map(issue => issue.label).join(', ')}. Tải lại nguồn trước khi kiểm tra số tiền và ký.
      </p>}

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
                data-field-name={`invoice_items.${it.id}.period`}
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
                    disabled={it.accounting_class === "DEPOSIT"}
                    title={
                      it.accounting_class === "DEPOSIT"
                        ? "Dòng cọc bắt buộc, không thể xoá"
                        : "Xoá dòng"
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1" data-field-name={`invoice_items.${it.id}.quantity`}>
                    <Label className="text-xs text-muted-foreground">
                      SL
                    </Label>
                    <NumberInput
                      aria-invalid={!!rowError(it.id, 'quantity')}
                      min={1}
                      className="w-full h-9 text-right"
                      value={it.quantity}
                      disabled={it.accounting_class === "DEPOSIT"}
                      onChange={(v) =>
                        updateInvoiceItem(it.id, "quantity", v || 1)
                      }
                    />
                    {rowError(it.id, 'quantity') && <p role="alert" className="text-xs text-destructive">{rowError(it.id, 'quantity')}</p>}
                  </div>
                  <div className={`space-y-1 ${rowError(it.id,'unit_price')?'rounded border border-destructive p-1':''}`} tabIndex={it.accounting_class==="DEPOSIT"?-1:undefined} aria-invalid={!!rowError(it.id,'unit_price')} aria-describedby={rowError(it.id,'unit_price')?`invoice-mobile-${it.id}-price-error`:undefined} data-field-name={`invoice_items.${it.id}.unit_price`}>
                    <Label className="text-xs text-muted-foreground">
                      Đơn giá
                    </Label>
                    <CurrencyInput
                      aria-invalid={!!rowError(it.id, 'unit_price')}
                      suffix={false}
                      className="w-full h-9 text-right"
                      value={it.unit_price}
                      disabled={it.accounting_class === "DEPOSIT"}
                      onChange={(v) =>
                        updateInvoiceItem(it.id, "unit_price", v)
                      }
                    />
                    {rowError(it.id, 'unit_price') && <p id={`invoice-mobile-${it.id}-price-error`} role="alert" className="text-xs text-destructive">{rowError(it.id, 'unit_price')}</p>}
                  </div>
                </div>
                {rowError(it.id, 'period') && <p role="alert" className="text-xs text-destructive">{rowError(it.id, 'period')}</p>}
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
                  <tr key={it.id} data-field-name={`invoice_items.${it.id}.period`}>
                    <td className="px-3 py-2">
                      <Input
                        className="h-8 text-sm"
                        value={it.description}
                        onChange={(e) =>
                          updateInvoiceItem(it.id, "description", e.target.value)
                        }
                      />
                      {rowError(it.id, 'period') && <p role="alert" className="text-xs text-destructive">{rowError(it.id, 'period')}</p>}
                    </td>
                    <td className="px-3 py-2" data-field-name={`invoice_items.${it.id}.quantity`}>
                      <NumberInput
                        aria-invalid={!!rowError(it.id, 'quantity')}
                        min={1}
                        className="w-16 h-8 text-right ml-auto"
                        value={it.quantity}
                        disabled={it.accounting_class === "DEPOSIT"}
                        onChange={(v) =>
                          updateInvoiceItem(it.id, "quantity", v || 1)
                        }
                      />
                      {rowError(it.id, 'quantity') && <p role="alert" className="text-xs text-destructive">{rowError(it.id, 'quantity')}</p>}
                    </td>
                    <td className={`px-3 py-2 ${rowError(it.id,'unit_price')?'border border-destructive':''}`} tabIndex={it.accounting_class==="DEPOSIT"?-1:undefined} aria-invalid={!!rowError(it.id,'unit_price')} aria-describedby={rowError(it.id,'unit_price')?`invoice-desktop-${it.id}-price-error`:undefined} data-field-name={`invoice_items.${it.id}.unit_price`}>
                      <CurrencyInput
                        aria-invalid={!!rowError(it.id, 'unit_price')}
                        suffix={false}
                        className="w-32 h-8 text-right ml-auto"
                        value={it.unit_price}
                        disabled={it.accounting_class === "DEPOSIT"}
                        onChange={(v) =>
                          updateInvoiceItem(it.id, "unit_price", v)
                        }
                      />
                      {rowError(it.id, 'unit_price') && <p id={`invoice-desktop-${it.id}-price-error`} role="alert" className="text-xs text-destructive">{rowError(it.id, 'unit_price')}</p>}
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
                        disabled={it.accounting_class === "DEPOSIT"}
                        title={
                          it.accounting_class === "DEPOSIT"
                            ? "Dòng cọc bắt buộc, không thể xoá"
                            : "Xoá dòng"
                        }
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
