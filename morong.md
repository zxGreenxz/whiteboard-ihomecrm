# morong.md — Hướng dẫn KHÔI PHỤC tính năng "Thuế" đã gỡ

> Ngày gỡ: 2026-06-01. Toàn bộ phần "thuế" đã bị xoá khỏi hệ thống theo yêu cầu:
> **thuế hoá đơn** (`tax_percent`, `tax_amount`), **thuế suất dịch vụ** (`tax_rate`),
> **mã số thuế khách tổ chức** (`tax_code`), **mã số thuế công ty** (`company_tax_code`).
>
> File này ghi lại **chính xác** những gì đã xoá + cách thêm lại để khôi phục.

---

## 0. Cách khôi phục NHANH NHẤT (khuyến nghị)

Tất cả thay đổi nằm trong **1 commit** (xem `git log` — commit "chore(tax): gỡ bỏ hoàn toàn tính năng thuế").

```bash
git revert <hash-commit-gỡ-thuế>     # revert code
```

Sau đó **khôi phục DB** bằng migration đảo ngược (mục 1 bên dưới) và **regenerate** lại
`src/integrations/supabase/types.ts` (hoặc revert luôn file đó trong commit).

> Lưu ý: dữ liệu thuế cũ KHÔNG mất gì khi gỡ vì toàn bộ giá trị thuế đều = 0
> (0/548 hoá đơn, 0/32 dịch vụ có thuế ≠ 0). Khôi phục cột → mặc định 0.

Nếu không revert được, làm thủ công theo mục 1–4.

---

## 1. DATABASE (migration đã gỡ: `supabase/migrations/20260601000000_remove_tax_fields.sql`)

### Đã xoá
- Cột `public.invoices.tax_percent` — `numeric(5,2) NOT NULL DEFAULT 0`
- Cột `public.invoices.tax_amount` — `numeric(15,2) NOT NULL DEFAULT 0`
- Cột `public.services.tax_rate` — `numeric DEFAULT 0`
- Cột `public.customers.tax_code` — `text` (comment: 'Tax code (for ORGANIZATION type)')
- (Phòng hờ) constraint `invoices_tax_non_negative` nếu còn.
- Sửa RPC `get_public_latest_invoice_by_contract`: **bỏ** dòng `'tax_amount', i.tax_amount,`
  trong `jsonb_build_object` của nhánh có hoá đơn. (RPC `get_public_latest_invoice_by_code`
  gọi nội bộ hàm này nên tự khớp.)

### Migration KHÔI PHỤC (chạy SQL này)
```sql
-- 1) Thêm lại các cột
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS tax_percent numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS tax_amount  numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE public.services  ADD COLUMN IF NOT EXISTS tax_rate    numeric DEFAULT 0;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS tax_code    text;
COMMENT ON COLUMN public.customers.tax_code IS 'Tax code (for ORGANIZATION type)';

-- 2) Recreate RPC, THÊM LẠI dòng 'tax_amount', i.tax_amount sau 'discount_amount'.
--    Lấy nguyên body từ supabase/migrations/20260530000000_fix_dangling_bed_refs_after_drop_beds.sql
--    (định nghĩa get_public_latest_invoice_by_contract gốc CÓ tax) rồi CREATE OR REPLACE lại,
--    GRANT EXECUTE ... TO anon, authenticated.
```
> Chính xác dòng cần chèn lại trong nhánh main của jsonb (ngay sau `'discount_amount', i.discount_amount,`):
> ```
>       'tax_amount', i.tax_amount,
> ```

### Công thức total_amount
- **Trước (có thuế):** `total_amount = subtotal − discount + tax_amount + previous_debt`
- **Sau (đã gỡ):**     `total_amount = subtotal − discount + previous_debt`
- `total_amount` tính ở **app layer** (không phải generated column / trigger).
  `remaining_amount` là generated `= total_amount − paid_amount` (không liên quan thuế).

---

## 2. FRONTEND — INVOICE TAX (thuế hoá đơn)

| File | Đã xoá → Khôi phục |
|------|--------------------|
| `src/types/invoice.ts` | `Invoice`: thêm lại `tax_percent: number;` + `tax_amount: number;` (sau `discount_amount`). `InvoiceTotals`: thêm lại `tax_percent`/`tax_amount`. `InvoiceFormData`: thêm lại `tax_percent: number;` (trước `prepaid_amount`). |
| `src/lib/invoiceUtils.ts` | `calculateInvoiceTotals` đổi lại signature `(items, discount, taxPercent, prepaid)`; thêm lại `const tax_amount = subtotal * taxPercent / 100;`; `total_amount = subtotal - discount + tax_amount`; return thêm `tax_percent: taxPercent, tax_amount`. (Hiện tại: `(items, discount, prepaid)`, `total = subtotal - discount`.) |
| `src/lib/invoiceValidation.ts` | Thêm lại `tax_percent: z.number().min(0).default(0),` trong `invoiceFormSchema`. |
| `src/hooks/useInvoices.ts` | `useCreateInvoice` + `useUpdateInvoice`: thêm lại `const tax_amount = subtotal * (invoiceFields.tax_percent || 0) / 100;`, cộng `+ tax_amount` vào `total_amount`, và thêm `tax_percent: invoiceFields.tax_percent || 0, tax_amount,` vào object `.insert(...)`/`.update(...)`. |
| `src/hooks/useContracts.ts` | `createFirstInvoiceForContract`: thêm lại `tax_percent: 0, tax_amount: 0,` vào `.insert(...)` hoá đơn. |
| `src/lib/invoiceHelpers.ts` | `generateInvoiceForContract`: thêm lại `tax_rate: 0, tax_amount: 0,` vào insert (sau `discount_amount: 0,`). |
| `src/components/invoices/InvoiceSummarySection.tsx` | Thêm lại `const taxPercent = watch('tax_percent') || 0;`; trong useMemo thêm `const taxAmount = subtotal * taxPercent / 100;`, `total = subtotal - discountAmount + taxAmount + (previousDebt||0)`, return `taxAmount`, dep `taxPercent`; **thêm lại 2 block UI**: Label "Thuế %" + `<NumberInput value={watch('tax_percent')} onChange=...>`, và Label "Tiền thuế" + `<div>{formatCurrency(totals.taxAmount)}</div>` (đặt trước "Thành tiền"). |
| `src/components/invoices/InvoiceForm.tsx` | defaultValues thêm lại `tax_percent: 0,`. |
| `src/components/invoices/EditInvoiceDialog.tsx` | formData thêm lại `tax_percent: 0,`. |
| `src/components/invoices/GenerateInvoiceDialog.tsx` | invoiceFormData thêm lại `tax_percent: 0,`. |
| `src/components/invoices/ExcelInvoiceDialog.tsx` | per-row payload thêm lại `tax_percent: 0,`. |

### Hiển thị / In (đã xoá dòng "Thuế")
| File | Khôi phục |
|------|-----------|
| `src/pages/invoices/InvoiceDetailPage.tsx` | Thêm lại block `{invoice.tax_amount > 0 && (<TableRow><TableCell colSpan={3} className="text-right text-gray-600">Thuế</TableCell><TableCell className="text-right font-medium">{formatCurrency(invoice.tax_amount)}</TableCell></TableRow>)}` (trước dòng "Nợ cũ kỳ trước"). |
| `src/components/invoices/InvoiceDetailPage.tsx` | Thêm lại `<SummaryRow label={\`Thuế (${invoice.tax_percent}%)\`} value={formatVND(invoice.tax_amount)} />` (trước `<Separator/>` + "Thành tiền"). |
| `src/pages/invoices/InvoicePrintPage.tsx` | Thêm lại `{Number(inv.tax_amount || 0) > 0 && (<div><span>Thuế ({inv.tax_percent}%):</span><span>{formatVND(inv.tax_amount)}</span></div>)}`. |
| `src/components/invoices/PrintInvoiceDialog.tsx` | Thêm lại dòng template: `${invoice.tax_amount ? \`<div class="summary-row"><span>Thuế (${invoice.tax_percent}%):</span><span>${fmtCurrency(invoice.tax_amount)}</span></div>\` : ''}`. |
| `src/lib/pdfHelpers.ts` | Thêm lại field `tax_amount: number;` trong type tham số; và block `${invoice.tax_amount > 0 ? \`<tr><td colspan="4" class="text-right">Thuế VAT:</td><td class="text-right">${formatCurrency(invoice.tax_amount)}</td></tr>\` : ''}`. |
| `src/components/invoices/InvoiceHistoryDialog.tsx` | Thêm lại `'tax_amount',` vào `MONEY_FIELDS`; thêm lại `tax_percent: 'Thuế (%)',` và `tax_amount: 'Tiền thuế',` vào `FIELD_LABELS`. |
| `src/pages/public/PublicContractInvoicePage.tsx` | Thêm lại `tax_amount: number | null;` trong type `PublicInvoice`; thêm lại `if (invoice.tax_amount && invoice.tax_amount > 0) adjustments.push({ label: 'Thuế', amount: invoice.tax_amount, sign: '', cls: '' });`. |

---

## 3. FRONTEND — THUẾ SUẤT DỊCH VỤ (`tax_rate`)

| File | Khôi phục |
|------|-----------|
| `src/hooks/useServices.ts` | Thêm lại export:<br>`export const TAX_RATE_OPTIONS = [{ value: 0, label: "Không thuế" }, { value: 5, label: "5%" }, { value: 8, label: "8%" }, { value: 10, label: "10%" }];` |
| `src/components/services/CreateServiceDialog.tsx` | Thêm lại import `TAX_RATE_OPTIONS`; zod `tax_rate: z.string().optional(),`; default `tax_rate: "0",`; payload `tax_rate: data.tax_rate ? parseFloat(data.tax_rate) : 0,`; và FormField `name="tax_rate"` (Select "Thuế suất" map `TAX_RATE_OPTIONS`). |
| `src/components/services/EditServiceDialog.tsx` | Tương tự Create + `tax_rate: String(service.tax_rate ?? 0)` trong defaultValues **và** trong `form.reset(...)`. |

---

## 4. FRONTEND — MÃ SỐ THUẾ (khách tổ chức + công ty)

| File | Khôi phục |
|------|-----------|
| `src/types/customer.ts` | Thêm lại `tax_code: string | null;` trong `Customer` (mục Organization), và `tax_code?: string;` trong type form-data. |
| `src/components/customers/CustomerOrganizationFields.tsx` | Thêm lại FormField `name="tax_code"` (Label "Mã số thuế", Input placeholder "Nhập mã số thuế") — đặt trước "Người đại diện"; và dòng comment "Mã số thuế" ở JSDoc đầu file. |
| `src/lib/customerValidation.ts` | Thêm lại `tax_code: z.string().optional(),`. |
| `src/pages/customers/CustomerFormPage.tsx` | Thêm lại `tax_code: customer.tax_code ?? undefined,` trong prefill. |
| `src/lib/contractTemplateEngine.ts` | Thêm lại `REPRESENT_BUSINESS_CODE: repStr("tax_code"),` (biến template hợp đồng = MST người đại diện). |
| `src/hooks/useSettings.ts` | Thêm lại `company_tax_code?: string;` trong interface `CompanyInfo`. |
| `src/integrations/supabase/types.ts` | Thêm lại `tax_code` (customers Row/Insert/Update), `tax_rate` (services), `tax_amount`/`tax_percent` (invoices) — hoặc chạy `supabase gen types` sau khi khôi phục cột DB. |

---

## 5. TESTS đã sửa (khôi phục lại assertion thuế)
- `src/lib/__tests__/invoiceUtils.test.ts` — đổi lại các call `calculateInvoiceTotals(items, discount, taxPercent, prepaid)` (4 tham số), thêm lại test "applies tax correctly" + assertion `tax_amount`.
- `src/lib/__tests__/invoiceCalculations.property.test.ts` — thêm lại `taxPercentArb`, property "tax_amount = subtotal × tax_percent / 100", và `tax_percent` vào các property khác.

---

## 6. KHÔNG đụng tới (lịch sử — vẫn còn chữ "thuế", cố ý giữ)
- Migration cũ (lịch sử, KHÔNG sửa): `20250601000001_invoice_reimplementation.sql` (tạo cột thuế), `005_billing_tables.sql`, `20260222155059_rebuild_services_schema.sql` (tax_rate), `20250701000001_customer_vehicle_reimplementation.sql` (tax_code), các RPC cũ `20260515000001/2`, `20260528000007`, `20260530000000` (jsonb có tax).
- Tài liệu (docs/, resident-docs/, .kiro/specs/, PHASE-20-COMPLETE.md) — chỉ là tài liệu, không phải code chạy; chưa scrub. Nếu muốn sạch hẳn thì sửa prose ở các file đó.
