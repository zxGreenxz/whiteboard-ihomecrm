# Hoàn lại khách khi thanh lý — thiết kế

> **[LỊCH SỬ — ĐÃ SHIP 22–28/08/2026]** Migration `20260822093000_termination_customer_refund_items` + `20260822113000_refund_kpi_split` + hardening `20260828090000` live. Hiện hành: `docs/he-thong/16-thanh-ly-hop-dong.md`; runbook `../runbooks/2026-08-28-hoan-coc-runbook.md`. Giữ làm bằng chứng.

> Ngày chốt: 2026-08-22 · Phạm vi: nhánh thanh lý **Khách rời phòng** (move-out)

## Vấn đề

Khách đóng tiền phòng cả tháng rồi đi sớm. Hộp thoại thanh lý hiện **không có
chỗ nào** nhập khoản phải trả lại. Ba ô tiền đang có đều bị chặn đúng theo thiết
kế của chúng:

| Ô | Trần chặn | Vì sao không dùng được |
|---|---|---|
| Tiền cọc hoàn trả | `LEAST(refund, deposit_paid)` | không thể vượt cọc thật đã thu |
| Tiền thừa (credit) | `requested > available → 22023` | chỉ kéo credit **đã tồn tại**; credit lot chỉ sinh ra lúc THU tiền |
| Thu thêm | lọc `amount > 0`, ô tiền xoá ký tự không phải chữ số | đây là "khách trả thêm", không phải "mình trả lại" |

Công thức quyết toán thiếu hẳn vế "khoản mình nợ lại khách":

```
Trả lại khách = Cọc hoàn + Credit − Công nợ − Thu thêm
```

## Quyết định đã chốt

1. **Cấn trừ** — khoản hoàn nhập vào cùng phép quyết toán, cuối cùng chỉ ra MỘT
   con số (trả khách hoặc khách trả thêm). Một lần đưa tiền.
2. **Chỉ nhánh "Khách rời phòng"** — không đụng nhánh bỏ cọc, nơi
   `guard_termination_forfeit_voucher_v1` khoá cứng bút toán.
3. **Dòng prorate tự tính + dòng tự do** — soi gương mục "Thu thêm" đã có.

## Ràng buộc phát hiện khi khảo sát

### R1 — `contract_terminations.refund_amount` là cột GENERATED ALWAYS

```
refund_amount = total_deposit − (outstanding_debt + prorated_rent + prorated_services
              + early_termination_fee + notice_violation_fee + damage_fee
              + cleaning_fee + other_fees)
```

Cơ chế **nghĩa vụ hoàn cọc** (`preview_termination_refund_v1`) đọc đúng cột này
rồi đối chiếu với cọc thật đang giữ để gắn cờ `OK` / `VUOT_COC_THAT` /
`CHUA_TUNG_VAO_KET`.

Hệ quả bắt buộc:

- `v_refund_dep` phải **giữ nguyên** `GREATEST(v_deposit − v_charges, 0)`. Nếu
  khoản hoàn mới cấn trước cọc, `refund_amount` và phiếu hoàn cọc lệch nhau.
- **Cấm ghi vào `prorated_rent` / `prorated_services`** dù tên rất hợp — chúng
  nằm ở vế **trừ** của công thức và sẽ làm `refund_amount` teo lại.

### R2 — `system_source='termination.refund'` là "tổng tiền trả lại khách"

`get_refund_forfeit_summary` tự ghi trong chú thích rằng nó cố ý lấy
`total_amount` của **cả phiếu** vì "cả phiếu là số tiền TRẢ LẠI KHÁCH", và nó
**đã** gộp sẵn dòng hoàn cọc + dòng hoàn tiền thừa. Thêm dòng thứ ba nằm đúng
trong ngữ nghĩa đó ⇒ **dùng chung phiếu chi, không tách phiếu**.

### R3 — KQKD đếm theo hạng mục, không theo phiếu

`income_expense_types.is_deposit`: `TRUE` = ngoài KQKD (tiền giữ hộ),
`FALSE` = vào KQKD. Hoàn cọc là `TRUE`. **Hoàn tiền phòng phải là `FALSE`** —
tiền đó đã ghi thành doanh thu, trả lại là giảm lãi thật.

### Đã kiểm và KHÔNG xung đột

- Cả 92 phiếu `termination.*` trên prod đều **không** có dòng
  `income_expense_flow_ownership` ⇒ guard đóng băng hạng mục không áp.
- `guard_termination_forfeit_voucher_v1` chỉ bảo vệ `termination.forfeit_*`.
- Chuỗi hàm chỉ có 3 mắt xích, không ai khác gọi vào.

## Quyền

| Bước | Quyền được kiểm | Mức | Đổi? |
|---|---|---|---|
| Bấm thanh lý | `contracts.edit` trên toà (hoặc super admin) | MANAGE | không |
| Áp credit | `excess_amounts.edit` | MANAGE | không |
| Khách trả thêm | `thu_tien.collect` + chiếm hữu sổ quỹ | MANAGE | không |
| Duyệt phiếu chi hoàn | `income_expenses.approve` | ELEVATED | không |

**Không cần quyền mới.** Khoản hoàn đi chung phiếu chi hoàn đang có nên chịu
đúng cửa duyệt cũ.

> Lệch có sẵn, không thuộc phạm vi việc này: `contracts.terminate` (ELEVATED) có
> trong danh mục nhưng writer thanh lý không hề kiểm — nó chỉ kiểm `contracts.edit`.

## Toán quyết toán

```
v_owed         = tổng "Hoàn lại khách"                          ← MỚI

v_applied_dep  = LEAST(v_deposit, v_charges)                    ← GIỮ NGUYÊN
v_refund_dep   = v_deposit − v_applied_dep                      ← GIỮ NGUYÊN
v_refund_exc   = v_excess − LEAST(v_excess,
                   GREATEST(v_charges − v_deposit, 0))          ← GIỮ NGUYÊN

v_charges_left = GREATEST(v_charges − v_deposit − v_excess, 0)  ← MỚI
v_owed_applied = LEAST(v_owed, v_charges_left)                  ← phần bị cấn
v_refund_owed  = v_owed − v_owed_applied                        ← phần chi thật

v_applied      = LEAST(v_pool + v_owed, v_charges)              ← + v_owed
v_S            = v_deposit + v_excess + v_owed − v_charges      ← + v_owed
```

### Bảng chân trị

| cọc | credit | nợ | hoàn | applied_dep | refund_dep | owed_applied | refund_owed | v_S |
|---|---|---|---|---|---|---|---|---|
| 5tr | 0 | 8tr | 2tr | 5tr | 0 | 2tr | 0 | −1tr (khách trả thêm 1tr) |
| 5tr | 0 | 1tr | 2tr | 1tr | 4tr | 0 | 2tr | +6tr (chi hoàn 6tr) |
| 5tr | 0 | 0 | 2tr | 0 | 5tr | 0 | 2tr | +7tr (chi hoàn 7tr) |
| 0 | 0 | 0 | 2tr | 0 | 0 | 0 | 2tr | +2tr (chi hoàn 2tr) |

Ở mọi hàng, `refund_amount` (generated) vẫn bằng `v_refund_dep` khi dương ⇒ **R1
được giữ**.

## Bút toán

| Phần | Ghi vào đâu | Loại hạng mục | KQKD |
|---|---|---|---|
| `v_owed_applied` | cặp bút toán nội bộ trên sổ nội bộ (`_internal_settlement_account`), net 0 — gương của cặp cấn cọc | chi `Hoàn tiền phòng thanh lý` (is_deposit=FALSE) · thu `Doanh thu thanh lý` (is_deposit=FALSE) | −X rồi +X = 0 |
| `v_refund_owed` | **thêm một dòng hạng mục vào chính phiếu chi `termination.refund`** | `Hoàn tiền phòng thanh lý` (is_deposit=FALSE) | −X |

`system_source` của cặp nội bộ mới: `termination.rent_refund_offset` và
`termination.rent_refund_revenue`.

Điều kiện sinh phiếu chi hoàn đổi từ
`v_refund_dep > 0 OR v_refund_exc > 0` thành
`v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0`.

## Dấu vết audit

Thêm cột **mới, thường** (KHÔNG generated, KHÔNG nằm trong công thức R1):

```sql
ALTER TABLE public.contract_terminations
  ADD COLUMN IF NOT EXISTS rent_refund_amount numeric(15,2) NOT NULL DEFAULT 0;
```

Ghi `v_owed` vào đó ở bước audit. Bản `v_breakdown` thêm dòng "Hoàn lại khách".

## Chữ ký RPC

Thêm `p_refund_items jsonb DEFAULT '[]'::jsonb` vào **cuối** ba hàm:

```
terminate_contract_move_out_with_credit_v1(..., p_idempotency_key, p_refund_items)
terminate_contract_move_out(..., p_receipt_account_id, p_refund_items)
terminate_contract_move_out_impl(..., p_receipt_account_id, p_refund_items)
```

**Postgres không thêm tham số bằng `CREATE OR REPLACE`** — nó đẻ overload thứ
hai và PostgREST chọn nhầm. Bắt buộc `DROP FUNCTION` đúng chữ ký cũ rồi `CREATE`,
và cấp lại ACL **đúng như đã đo trên prod**:

| Hàm | authenticated | service_role |
|---|---|---|
| `terminate_contract_move_out` | ✓ | ✓ |
| `terminate_contract_move_out_impl` | ✗ | ✓ |
| `..._with_credit_v1` | ✓ | ✗ |

`p_refund_items` phải vào `payload_hash` idempotency, nếu không hai lần gọi khác
khoản hoàn sẽ bị coi là replay.

### Chuẩn hoá `p_refund_items` phía server

Tổng chỉ cộng phần tử có `amount` số, `> 0`. Bỏ qua phần tử rác — cùng cách
`p_extra_charges` đang làm, để một dòng hỏng không giết cả cú thanh lý.

## Giao diện

`src/components/contracts/TerminationRefundItems.tsx` — mới, emit-only, soi
gương `TerminationExtraCharges.tsx`:

- Dòng prorate: *"Không ở từ [dd/mm] đến [dd/mm]"* → tự tính theo cùng cơ sở với
  Thu thêm (tiền phòng + nước×số người + PDV), gõ đè được (`touched` pattern)
- Nút *"Thêm khoản hoàn khác"*: tên + số tiền
- Chỉ render ở nhánh **Khách rời phòng**

Bảng tổng kết:

```
Trả lại khách = Cọc hoàn + Credit + Hoàn lại khách − Công nợ − Thu thêm
```

Kiểu dữ liệu mới trong `src/lib/contractValidation.ts`:

```ts
export const refundItemSchema = z.object({
  kind: z.enum(['PRORATED_REFUND', 'CUSTOM']),
  description: z.string().min(1),
  amount: z.number().min(0),
  days: z.number().min(0).optional(),
  unit_price: z.number().min(0).optional(),
});
```

## Dọn kèm

Gỡ câu *"tính năng áp credit vào quyết toán hiện chưa được kích hoạt, nhập số
lớn hơn 0 sẽ bị hệ thống từ chối"* dưới ô credit — cờ `customer.credit.apply.v1`
đã `mode=ON` / route `CANONICAL` cho cả hai org từ 2026-07-28. Dòng chữ này đang
bảo người dùng rằng một ô chạy được là vô dụng.

## Kiểm chứng

1. Test SQL-text cho migration (mẫu `*Migration.test.ts`) + test thuần cho phép
   toán quyết toán.
2. `npm run gen:types` (KHÔNG dùng dấu `>`).
3. `node scripts/generate-migration-provenance.mjs` rồi
   `npm run migrate:forward -- <file> --apply`. **Không POST thẳng Management API.**
4. Diễn tập trên org **DEMO** với hợp đồng thật, đối chiếu bốn điểm:
   phiếu chi hoàn · cặp bút toán nội bộ · KQKD · nghĩa vụ hoàn cọc.
5. Hỏi chủ dự án một câu trước khi chạm production.
