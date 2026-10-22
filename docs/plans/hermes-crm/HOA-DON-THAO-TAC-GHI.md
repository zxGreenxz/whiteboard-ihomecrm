# Thao tác ghi của Hermes — trang HOÁ ĐƠN (Đợt 3: THIẾT KẾ, chờ duyệt)

Ngày 22/10/2026 (giờ Việt Nam). Tài liệu này cắm các thao tác ghi của trang Hoá đơn vào khung chung đã có trên `main` ([NEN-CHUNG-THAO-TAC-GHI.md](NEN-CHUNG-THAO-TAC-GHI.md)), theo cùng khuôn với trang Hợp đồng (PR #270) và Thu chi (PR #271). Đây là Mốc 1: chỉ thiết kế, chưa có migration, chưa đổi mã, production chưa đổi.

Căn cứ, theo thứ tự ưu tiên:
1. Đáp án 40 câu chủ chốt ngày 21/10: Q2, Q3, Q7, Q13–Q19. Khi đáp án và plan mâu thuẫn, đáp án thắng.
2. Plan chi tiết trang Hoá đơn ngày 21/10 (§1, §2, §4–§7, §9). Plan nằm ở máy làm việc, không có trong repo. Phần "một tool riêng" của plan thay bằng thao tác trong danh mục chung.
3. Lượt đo nền ngày 22/10: bot production chạy trên TEST, 22 ca Hoá đơn, 5 ca đạt.
4. Mã trên `origin/main` `3ae1d57f6`, cộng nhánh của PR #267 (công nợ), #270, #271 (chỉ đọc).

## 0. Kết luận

1. **Sáu thao tác, một RPC trang, 0 byte `tools/list`.** `invoice.collect`, `invoice.meter_record`, `invoice.adjust`, `invoice.adjustment_check`, `invoice.cancel`, `invoice.restore` đi qua ba tool `crm_action_*`. RPC trang là `public.hermes_invoice_action_v1`, cùng chữ ký và cùng ba tầng với `hermes_contract_action_v1`: vỏ INVOKER thân SQL-standard → tra cứu INVOKER dưới RLS người hỏi → bước ghi DEFINER gọi **đúng** hàm ghi web. Mọi thao tác đều luôn xem trước (Q2: đều dính tiền).
2. **Thu tiền chỉ chuyển khoản (TK) và sổ HKD (TT).** `method = TM` bị từ chối có chỉ đường `/thu-tien` (Q13 = c), kể cả chủ ghi hộ. Hàm ghi là `record_invoice_collection_v5` (DEFINER, tự kiểm `thu_tien.collect` theo toà và từng sổ, khoá lạc quan `p_expected_paid_amount`, idempotency theo khoá + băm nội dung). Thiếu một khoá registry: M2 cố ý không seed `thu_tien.collect` (câu 13 cũ hiểu là cấm thu qua bot), và khối kiểm của M2 (đã áp) **đòi registry không có `thu_tien.collect`** — seed khoá đó sẽ làm M2 đỏ mỗi khi cửa idempotent chạy lại nó trên production. Vì vậy dùng khoá riêng Hermes `thu_tien.collect_transfer` (seed TẮT, quyền CRM giao vào = `thu_tien.collect`; tiền lệ `income_expenses.approve_vouchers`). Tên khoá nói luôn phạm vi: chỉ TK/TT (HDN1).
3. **Bốn hàm SQL dùng chung mới (luật 17/10), mỗi hàm có bộ vector đối chiếu với web:**
   - `public.invoice_collection_plan_v1`: kế hoạch thu (số áp, giữ lại, làm tròn < 10.000đ, sổ nhận, sổ làm tròn, cảnh báo thu trùng 30 phút). Thay công thức client `collectPlan.ts` / `collectionSettlement.ts` / `duplicateCollection.ts`, và luật chọn sổ thối theo **2 ID viết cứng** ở `changeAccounts.ts`;
   - `public.record_meter_readings_v2` (hàm ghi) + `public.meter_readings_plan_v1` (xem trước): chống trùng (công tơ, tháng) mà DB hiện không có. **Form web Ghi chỉ số chuyển sang gọi hàm ghi này** (Q16 + plan §8.2);
   - `public.invoice_adjustment_build_v1`: dựng danh sách dòng sau điều chỉnh từ dòng hiện có, như `invoiceAdjustmentEntry.ts`.
4. **Số còn nợ lấy từ `invoice_effective_outstanding_v1` (PR #267).** Lý do thật: nợ kỳ 9 đã kéo vào hoá đơn kỳ 10 vẫn còn `remaining_amount > 0` ở hoá đơn kỳ 9. Không có hàm này, "phòng 201 CK đủ" có thể chọn nhầm hoá đơn kỳ 9 và **thu trùng** món nợ đã nằm trong kỳ 10. Thu tiền, huỷ và đọc nợ của trang đều dùng nó; Mốc 2 trở đi đòi #267 đã áp.
5. **Xem trước bằng chạy thử hàm ghi thật** (khuôn Thu chi §3.2): lượt 1 gọi `record_invoice_collection_v5` / `adjust_invoice_v2` trong khối con rồi lùi (`HD001`). Bản xem trước nói đúng trạng thái sau, tiền giữ lại, làm tròn, và bắt lỗi của hàm ghi (tháng đã chốt, sổ không giữ, cọc không được làm tròn…) ngay ở lượt 1. Không có công thức tiền thứ hai.
6. **Đọc bù (a)–(f) và soạn tin nhắc nợ (Q18) đi bằng 7 báo cáo W2 mới ở gói A**, 0 byte `tools/list`, khoá đã bật `invoices.view` / `thu_tien.view`. Không sửa báo cáo cũ (khuôn cũ bị kiểm khít; connector lên trước SQL sẽ vỡ báo cáo).
7. **Ngoài phạm vi, bot từ chối có chỉ đường web:** tiền mặt (Q13), hoàn tác lần thu (Q14), đổi hình thức lần thu (Q57 đang hỏi), lập hoá đơn tháng (Q17), tự gửi Zalo cho khách (Q18), dòng điện/nước có chỉ số trong điều chỉnh. Hàm báo giá `invoice_month_quote_v1` (P7) chỉ có thiết kế ở mục 8.
8. **Ước công Mốc 2–5: 11–15 ngày kỹ sư**, P7 thêm 8–12 ngày nếu được duyệt. Mỗi mốc là một commit có test xanh; migration chỉ là file.

## 1. Phạm vi

| Trong (theo đáp án) | Ngoài: bot từ chối và chỉ đường web (mục 11) |
| --- | --- |
| Ghi nhận khách đã trả TK/TT: đủ, một phần, nhiều phòng cùng toà (≤ 10, một lần đồng ý); đưa dư ⇒ hỏi giữ lại / trả lại; thiếu < 10.000đ ⇒ làm tròn như web, nói rõ (Q15) | Thu tiền mặt, kể cả chủ ghi hộ (Q13 = c) ⇒ `/thu-tien` |
| Ghi chỉ số điện nước một phòng hoặc cả toà (≤ 60 dòng); luật ngày Q16 | Hoàn tác lần thu (Q14 = b); đổi hình thức lần thu (Q57 chưa chốt) |
| Điều chỉnh hoá đơn: giảm trừ, thêm khoản, sửa khoản không có chỉ số | Sửa dòng điện/nước có chỉ số; hoá đơn quyết toán (`SETTLEMENT`) |
| Xác nhận "đã kiểm tra" điều chỉnh sau khi xem trước/sau (Q19 = a) | Lập hoá đơn tháng/lẻ (Q17 = a: chưa); duyệt hoá đơn (tự duyệt, DRAFT = 0) |
| Huỷ / khôi phục hoá đơn chưa thu, lý do bắt buộc | Huỷ hoá đơn quá hạn (`OVERDUE`) hoặc đã thu; huỷ cưỡng bức super admin |
| Soạn tin nhắc nợ / gửi hoá đơn kèm link tra công khai, người dùng tự bấm gửi (Q18 = a) | Tự gửi Zalo cho khách (Q18) |
| Đọc bù (a)–(f) của lượt đo nền 22/10 | Ảnh biên nhận cho lần thu (v5 không cho bổ sung sau; chờ đường ảnh Zalo) |

## 2. Kiến trúc SQL của trang

Khuôn lấy từ `hermes_action_probe_v1` (M1, `20261021133823`) và `hermes_contract_action_v1` (#270). Vai `authenticated` không có USAGE trên `app_private`, nên vỏ gắn OID các hàm nó gọi lúc tạo.

```text
public.hermes_invoice_action_v1(p_binding, p_action, p_phase, p_request_id, p_params, p_resolved, p_expected_basis)
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public BEGIN ATOMIC   -- băm ở hermes-task-function-contract
  g: app_private.hermes_action_guard_v1(binding, action)              -- binding, registry, khoá kết nối, quyền CRM, tập toà (M1)
  l: app_private.hermes_invoice_lookup_core_v1(org, toà[], action, params)   -- chỉ ở preview/auto; plpgsql INVOKER,
       chỉ tham chiếu public.*: giải toà/phòng bằng hermes_write_name_resolve_v1 (D7, từng phòng của lô), tìm hoá đơn /
       công tơ / điều chỉnh dưới RLS người hỏi, gọi invoice_effective_outstanding_v1 (#267) và hàm kế hoạch dùng chung
  → app_private.hermes_invoice_action_step_v1(…, l)                   -- plpgsql DEFINER
```

**Bước ghi** (`app_private.hermes_invoice_action_step_v1`):
1. Kiểm NULL; chạy lại guard; toà đã giải ∈ `ctx.buildingIds`, phòng thuộc đúng toà, hoá đơn/công tơ/điều chỉnh thuộc đúng công ty, toà, phòng. Tham số mô hình gửi không bao giờ được tin thành id.
2. Đọc lại bản thật theo id mà `l` đưa; ở lượt apply khoá `FOR UPDATE` theo thứ tự id (lô nhiều hoá đơn không khoá chéo).
3. Tính `basis` (mục 3). Lượt apply lệch ⇒ `state_changed`, không mở biên nhận.
4. Lượt preview: chạy thử hàm ghi web trong khối con (`RAISE … USING ERRCODE='HD001'` rồi bắt), đọc kết quả trước khi lùi, trả `{kind:'preview', preview, basis, resolved, confirm:'required', warnings}`.
5. Lượt apply: `receipt_begin` (phát lại / xung đột / chưa rõ) → `BEGIN … EXCEPTION` quanh lời gọi hàm ghi web + hậu điều kiện → lỗi tạm `40001/40P01/55P03/PT409` `RAISE` lại → còn lại ánh xạ lý do (mục 5) → `receipt_finish` + audit `HERMES_ACTION_*`.

Khoá idempotency của hàm ghi web lấy từ requestId: `'hermes-inv:'||rid` (một hoá đơn), `'hermes-inv:'||rid||':'||n` (mục thứ n của lô), `'hermes-mtr:'||rid`, `'hermes-adj:'||rid`, `'hermes-cancel:'||rid`, `'hermes-restore:'||rid`. Tiền tố cho phép đếm lần ghi qua Hermes về sau (hiện không có cột kênh). Khoá chạy thử dùng `'hermes-dry:'||rid` và luôn bị lùi.

**Vì sao tra cứu là INVOKER.** Tên khách (`customers.view`), việc "thấy hoá đơn" và nợ thực (#267, INVOKER) phải theo RLS người hỏi. Bước ghi DEFINER chỉ tin id do tra cứu đưa sau khi tự đối chiếu; nó không trả thêm dữ liệu cá nhân nào mà tra cứu không thấy.

**Hàm ghi web đều là SECURITY DEFINER và tự kiểm `auth.uid()`** (đã tra): `record_invoice_collection_v5` (`thu_tien.collect` theo toà + từng sổ + giữ/biết sổ + sổ nằm trong danh sách sổ nhận của toà), `adjust_invoice_v2` (`invoices.edit`), `review_invoice_adjustment_v2` (`invoices.approve`), `cancel/restore_invoice_with_credit_v1` (`invoices.cancel` hoặc `invoices.delete`, rào câu 26 `20261021181209` đã áp production). `record_meter_readings_v2` là hàm ghi mới cùng khuôn (mục 4.2). Không có hàm DEFINER nào chép policy.

## 3. Danh mục thao tác (`infra/hermes-broker/invoice-action-contract.mjs`)

Mọi thao tác: `page: 'invoice'`, `rpc: 'hermes_invoice_action_v1'`, `private_only = true` (Q3), `confirm = 'always'`. Mã `invoice.meter_record` thay cho `meter_reading.record` của đề bài: `ACTION_PAGES` chỉ có `invoice` (thêm trang mới là thêm giá trị enum `page` của `crm_action_list`, tốn byte).

| id | Khoá Action = quyền CRM | Lớp | Tham số (`*` = bắt buộc) | Hàm ghi web | `basis` = md5 của |
| --- | --- | --- | --- | --- | --- |
| `invoice.collect` | `thu_tien.collect_transfer` (**khoá riêng Hermes mới, seed TẮT**) → quyền CRM `thu_tien.collect` (HDN1) | money | `buildingName*`, `roomName` hoặc `items` (list 1–10 của `{roomName*, month, amount}`), `month`, `method*` (`TK`/`TT`/`TM`), `amount` (VND; trống = đúng số còn nợ), `date`, `overpay` (`keep`/`return`), `cashbookName`, `note` (1–200) | `record_invoice_collection_v5` | mỗi hoá đơn: id, `paid_amount`, `total_amount`, `status`, `updated_at`, `adjustment_revision`; kế hoạch (dòng tiền, sổ, giữ lại, làm tròn), ngày thu |
| `invoice.meter_record` | `meter_readings.create` (sửa cần thêm `meter_readings.edit`) | money (quyết tiền điện) | `buildingName*`, `readings*` (list 1–60 của `{roomName*, value*, meterCode}`), `meterType` (`dien`/`nuoc`, mặc định điện), `month`, `replace` (bool, "sửa") | `record_meter_readings_v2` (mới) | mỗi dòng: công tơ, chỉ số đầu, dòng cùng tháng đang có (id, `updated_at`), cờ đã lên hoá đơn; tập dòng sẽ ghi |
| `invoice.adjust` | `invoices.edit` | money | `buildingName*`, `roomName*`, `month`, `reason*` (8–1000), `discount` (VND giảm THÊM), `addItems` (list 1–5 `{description*, amount*}`), `setItems` (list 1–5 `{match*, amount*}`) | `adjust_invoice_v2` | id, `adjustment_revision`, `paid_amount`, `updated_at`, danh sách dòng sau |
| `invoice.adjustment_check` | `invoices.approve` | irreversible (không bỏ được "đã kiểm tra") | `buildingName*`, `roomName*`, `month` | `review_invoice_adjustment_v2` | id điều chỉnh, `revision`, `review_status`, `invoices.updated_at` |
| `invoice.cancel` | `invoices.cancel` | money (đổi công nợ) | `buildingName*`, `roomName*`, `month`, `reason*` (8–500) | `cancel_invoice_with_credit_v1` | id, `status`, `paid_amount`, `updated_at`, credit đã cấn |
| `invoice.restore` | `invoices.cancel` | money | `buildingName*`, `roomName*`, `month`, `reason*` (8–500) | `restore_invoice_with_credit_v1` | id, `status`, `updated_at`, hoá đơn cùng HĐ + kỳ đang hiệu lực |

- `invoiceNumber` không thành tham số: hoá đơn giải bằng toà + phòng + kỳ (`INV-…` người dùng hay đọc sai; thêm sau nếu ca thử cần).
- `month` trống: hoá đơn **còn nợ thực** (`effective_outstanding > 0`) duy nhất của phòng; với điều chỉnh/kiểm tra/huỷ là hoá đơn MONTHLY mới nhất chưa huỷ (khôi phục: mới nhất đã huỷ). Có ≥ 2 ứng viên ⇒ `needs_input name_unresolved` với `field:'invoice'` và ứng viên dạng "kỳ 09/2026 (còn 1.200.000đ)", câu do `nameUnresolvedDetail` dựng sẵn: "Hoá đơn '…' khớp nhiều: … — hỏi người dùng nêu rõ." Không cần đổi runtime.
- Kiểu `list` / `record` và `param.name('cashbook')` dùng lại bản của Thu chi (TC8, #271). `readings` cần trần 60, trong khi bản TC8 đặt `MAX_LIST = 20`: đổi hằng này thành 60 là thay đổi file chung duy nhất của danh mục (HDN7).
- Ràng buộc chéo tham số (`roomName` xor `items`, `discount`/`addItems`/`setItems` có ít nhất một) kiểm ở SQL, trả `needs_input invalid_params`.

## 4. Từng thao tác: luồng, xem trước, kết quả, trùng lặp

Câu xem trước và câu kết quả do SQL dựng bằng tiếng Việt ở `preview.text` / `result.text`, kèm trường có cấu trúc: `buildingName`, `roomName`, `invoiceNumber`, `billingMonth`, `customerName` (null khi không có `customers.view` ở toà), tiền là chuỗi số nguyên VND. Ngày có thứ và khoảng cách tới hôm nay theo giờ tổ chức ("thứ Sáu 31/10/2026 (còn 9 ngày)"), dùng lại `app_private.hermes_contract_date_label_v1` của #270 — migration trang đòi hàm đó ở `$requires$`, không chép thân thứ hai. Tên sổ che dãy ≥ 5 chữ số như Thu chi. `link` là `/invoices/<id>` (mục 3.1 nền chung cho phép UUID trong link).

### 4.1 Ghi nhận khách đã trả (`invoice.collect`, Mốc 3)

**Luồng.**
1. `method = TM` ⇒ `rejected cash_collection_web_only` ngay, trước mọi tra cứu.
2. Tra cứu: toà + phòng (từng phòng của lô); hoá đơn trạng thái `APPROVED/PARTIAL_PAID/OVERDUE`, chưa xoá; nợ thực từ `invoice_effective_outstanding_v1`.
   - Hoá đơn được chọn có `carried_out_amount > 0` (nợ đã kéo vào hoá đơn kỳ sau chưa thu xong) ⇒ `needs_input debt_carried`: "nợ kỳ này đã cộng vào hoá đơn kỳ sau; thu ở hoá đơn kỳ sau". Đây là chỗ #267 chặn thu trùng.
   - Hoá đơn `PAID` / không còn số thu ⇒ `needs_input nothing_to_collect` (thường là nhầm phòng/kỳ). `DRAFT/CANCELLED` ⇒ `invoice_not_collectible`.
3. Kế hoạch: `invoice_collection_plan_v1` (mục 6.1) với một dòng `{method, amount}` (trống = số còn nợ), `overpay`, ngày thu.
4. Chạy thử `record_invoice_collection_v5(…, p_expected_paid_amount := paid_amount vừa đọc, p_idempotency_key := 'hermes-dry:'||rid)` trong khối con. Câu lỗi ⇒ lý do (mục 5) trả ngay ở lượt 1. Riêng `22023 Không được làm tròn bỏ qua cọc…` ⇒ chạy thử lại với `p_allow_rounding=false`, bản xem trước nói "không làm tròn được vì phần thiếu là cọc; hoá đơn còn nợ X".
5. Lượt 2: gọi thật với khoá `hermes-inv:`; hậu điều kiện: `collection_id` có, `applied_amount` = bản xem trước, không có dòng `TM`, hoá đơn `paid_amount` tăng đúng `applied_amount`.

**Ngày thu.** Trống = `org_today_v1` (giờ VN). Mô hình đổi "hôm qua", "thứ Hai tuần trước" thành `date`. Tương lai ⇒ `date_out_of_range` (needs_input; hàm ghi cũng chặn 22023). Cách hôm nay > 7 ngày ⇒ cảnh báo, vẫn cho ghi. Tháng đã chốt lợi nhuận / sổ đã chốt ⇒ hàm ghi `[PROFIT_LOCKED]`/`[CASHBOOK_CLOSED]` ⇒ `period_locked`.

**Đưa dư (Q15).** v5 chỉ cho thối (`REFUND`) từ dòng tiền mặt; TK/TT dư chỉ có hai đường, đúng như web (dialog web ép "giữ credit" khi không có TM):
- `overpay = keep` ⇒ `CREDIT`: giữ phần dư làm tiền dư của khách cho kỳ sau; hoá đơn không gắn HĐ ⇒ `credit_requires_contract`;
- `overpay = return` ⇒ chỉ ghi đúng số còn nợ; bản xem trước nói "phần dư X đ KHÔNG ghi vào CRM, anh/chị tự chuyển trả khách";
- thiếu `overpay` ⇒ **bản xem trước có câu hỏi**: "Khách trả 3.700.000đ, còn nợ 3.650.000đ, dư 50.000đ. CHƯA chọn: giữ lại cho kỳ sau (`overpay=keep`) hay trả lại khách (`overpay=return`)?" kèm `preview.choiceRequired:'overpay'`. Token phát ra gắn params không có `overpay`, nên lượt 2 với token đó bị bước ghi trả `needs_input overpay_needs_choice`, không ghi. Cách này cho mô hình đọc được con số mà không phải đổi runtime (lý do dạng `needs_input` của trang chỉ mang câu tĩnh) (HDN4).

**Thiếu < 10.000đ (Q15).** Kế hoạch bật `allow_rounding` khi `0 < thiếu < 10.000` (ngưỡng cứng trong v5), sổ làm tròn = sổ ảo "Làm tròn tiền thiếu" của công ty (như web). Bản xem trước: "làm tròn bỏ qua 5.000đ, hoá đơn thành ĐÃ THANH TOÁN". Thiếu ≥ 10.000đ ⇒ thu một phần, nói rõ còn nợ.

**Sổ nhận.** `get_receiving_cashbooks_v1(org, toà)`: TK/TT = sổ mặc định của toà rồi sổ phụ, giao với sổ người gọi giữ/biết. Không có sổ ⇒ `receiving_book_missing`. Nhiều sổ: mặc định sổ đầu (như web), bản xem trước nêu tên; `cashbookName` chọn sổ khác trong đúng danh sách đó.

**Lô (`items` ≤ 10, cùng toà, cùng hình thức).** Một requestId, một biên nhận, một lần đồng ý.
- Lỗi tên hoặc kỳ mơ hồ ở bất kỳ mục nào ⇒ cả lô `needs_input`, `wanted` chỉ ra phòng nào.
- Mục không thu được vì trạng thái (đã thu đủ, đã huỷ, nợ đã kéo) ⇒ **loại khỏi lô và nêu trong bản xem trước** ("305: đã thu đủ ngày 05/10 — bỏ"). Đồng ý = ghi đúng tập mục còn lại; `basis` gồm tập đó. Còn 0 mục ⇒ từ chối với lý do của mục đầu.
- Lượt 2 **cả tập hoặc không gì** (như TC3 của Thu chi): một mục lỗi hay lệch ⇒ `RAISE`, lùi cả lô và biên nhận, trả `state_changed`; bản xem trước mới chỉ ra mục có vấn đề.

**Xem trước (ví dụ).** "Sẽ ghi THU 3.650.000đ chuyển khoản ngày thứ Tư 22/10/2026 (hôm nay) vào sổ «MB ***» cho hoá đơn INV-2026-01234 — phòng 201 toà 44TL, kỳ 10/2026, khách «tên đại diện». Còn nợ 3.650.000đ → 0đ: ĐÃ THANH TOÁN ĐỦ. Không kèm ảnh biên nhận." Lô: bảng một dòng mỗi phòng + tổng.

**Trùng lặp.** (1) biên nhận Hermes theo requestId; (2) khoá idempotency v5 + băm nội dung (lớp thứ hai); (3) `p_expected_paid_amount` = số đã thu lúc xem trước (người khác vừa thu ⇒ PT409 ⇒ `state_changed`); (4) cảnh báo `possible_duplicate` của kế hoạch: đã có lần thu ACTIVE cùng hoá đơn, cùng số tiền trong 30 phút (luật `duplicateCollection.ts`), bản xem trước nêu giờ và người thu.

**Kết quả.** "Đã ghi thu 3.650.000đ CK cho hoá đơn INV-2026-01234 (44TL/201, kỳ 10/2026). Còn nợ 0đ — ĐÃ THANH TOÁN." + `applied`, `credit`, `rounding`, `remainingAfter`, `statusAfter`, `link`.

### 4.2 Ghi chỉ số điện nước (`invoice.meter_record`, Mốc 4)

**Ngày (Q16 = a).** `month` trống hoặc tháng hiện tại ⇒ `reading_date = org_today_v1`. `month` đã qua ⇒ ngày cuối tháng đó. Tháng tương lai ⇒ `date_out_of_range`. `settlement_month` do trigger suy từ `reading_date` (`auto_populate_meter_reading_fields`), nên quy ước này giữ đúng tháng.

**Từng dòng** (`meter_readings_plan_v1`, mục 6.2). Phòng → công tơ `ACTIVE`, chưa xoá, đúng loại; 0 công tơ ⇒ dòng `meter_not_found`; ≥ 2 mà không có `meterCode` ⇒ `meter_ambiguous`. Chỉ số đầu theo đúng luật trigger (dòng chưa xoá mới nhất theo `reading_date`, `created_at`; không có thì `initial_reading`). Trạng thái dòng:
- `ok`; cảnh báo `high_consumption` khi tiêu thụ ≥ 3 lần trung bình 3 kỳ trước, `zero_consumption` khi bằng 0;
- `lower_than_previous` (CHECK `current ≥ previous` của bảng, 23514): không ghi được, nêu số đầu;
- `duplicate_month`: công tơ đã có dòng (không phải `TLY%`) cùng `settlement_month`. Không "sửa" ⇒ không ghi (Q16). Có `replace=true` ⇒ thay số của dòng cũ, chỉ khi dòng đó **chưa lên hoá đơn** và không có chỉ số kỳ sau; người dùng cần `meter_readings.edit`;
- `used_by_invoice`: dòng cũ đã lên hoá đơn còn hiệu lực ⇒ không sửa; chỉ đường "điều chỉnh hoá đơn trên web". Vì `invoice_items` không có khoá nối chỉ số, "đã lên hoá đơn" suy bằng: hoá đơn chưa huỷ/xoá cùng phòng, `billing_month = settlement_month`, có dòng `SERVICE` cùng `service_id` và cùng `current_reading` (xem rủi ro mục 9).

**Lô ≤ 60 dòng, một lần đồng ý.** Bản xem trước là bảng phòng — đầu → cuối — tiêu thụ — trạng thái. Dòng không ghi được nêu rõ lý do và **không nằm trong tập sẽ ghi**; đồng ý = ghi đúng các dòng `ok` (+ dòng `replace` hợp lệ). `basis` gồm tập đó. Lượt 2 cả tập hoặc không gì. 0 dòng ghi được ⇒ trả lý do của dòng đầu (`meter_duplicate_month` / `meter_lower_than_previous` dạng `needs_input`).

**Trùng lặp.** Biên nhận Hermes + khoá idempotency của hàm ghi (`canonical_write_operations('meter.readings.v2', toà, người, khoá)` + băm), cộng rào chống trùng (công tơ, tháng) **ngay trong hàm ghi** dưới `pg_advisory_xact_lock` theo công tơ — hai người ghi cùng lúc vẫn chỉ một dòng.

**Xem trước (ví dụ).** "Sẽ ghi 38 chỉ số ĐIỆN toà 44TL, ngày chốt thứ Sáu 31/10/2026, tháng 10/2026: 101 1.200 → 1.234 (34 kWh) … Không ghi 2 dòng: 105 nhỏ hơn số đầu 2.210; 203 tháng 10 đã có 1.987 (nói 'sửa' để thay). Cảnh báo: 302 tiêu thụ 412 kWh, gấp 4,1 lần trung bình."

### 4.3 Điều chỉnh hoá đơn (`invoice.adjust`, Mốc 5)

- **Dựng dòng sau** bằng `invoice_adjustment_build_v1` (mục 6.3): dòng không đổi đi nguyên như `toAdjustmentItem` của web; `discount` cộng THÊM vào giảm trừ hiện có (HDN5); `addItems` thêm dòng `OTHER`, `accounting_class` mặc định như web (chủ chốt 12/09: không cho người dùng chọn); `setItems.match` khớp **đúng một** dòng theo mô tả đã bỏ dấu.
- **Chặn trước:** dòng khớp có chỉ số hoặc là dòng điện/nước/cọc/`NON_PNL` ⇒ `adjust_meter_line_web_only`; hoá đơn `SETTLEMENT` hoặc nợ cũ nhập tay lệch nguồn (luật `adjustmentReconcileBlocker`) ⇒ `web_only`; `match` khớp 0 hoặc ≥ 2 dòng ⇒ `needs_input name_unresolved` `field:'invoice'`, ứng viên là mô tả dòng.
- **Chạy thử** `adjust_invoice_v2(…, p_expected_revision, p_expected_paid_amount, p_expected_updated_at, 'hermes-dry:'||rid)`: tổng sau do chính hàm ghi tính (làm tròn nghìn), lỗi của hàm ghi ra lý do ngay ở lượt 1.
- **Xem trước:** bảng dòng trước/sau (chỉ dòng đổi), tạm tính, giảm trừ, tổng trước → sau, đã thu, trạng thái sau, lý do; câu "điều chỉnh sẽ chờ người có quyền xác nhận kiểm tra".
- **Trùng lặp:** biên nhận + khoá `hermes-adj:` (cùng khoá cùng vân tay ⇒ hàm ghi trả lại bản cũ) + ba giá trị kỳ vọng (PT409 ⇒ `state_changed`).

### 4.4 Xác nhận "đã kiểm tra" điều chỉnh (`invoice.adjustment_check`, Mốc 5, Q19 = a)

- Tra cứu: hoá đơn có `adjustment_review_status='PENDING'` và điều chỉnh có `revision = invoices.adjustment_revision` (hàm ghi chỉ cho kiểm phiên bản hiện hành).
- Xem trước: "Điều chỉnh lần 2 của hoá đơn INV-… (44TL/201, kỳ 10/2026) do «tên» làm lúc 15:20 thứ Hai 20/10/2026: tổng 3.650.000đ → 3.550.000đ (−100.000đ); lý do '…'; dòng đổi: …; đã thu 0đ." Tên người điều chỉnh qua `hermes_user_display_name_v1`/RLS `profiles`; điều chỉnh do chính người hỏi làm ⇒ cảnh báo "anh/chị tự kiểm tra điều chỉnh của mình" (web không cấm; HDN6).
- Không có điều chỉnh chờ ⇒ `needs_input nothing_to_check`. Phiên bản đổi giữa hai lượt ⇒ PT409 ⇒ `state_changed`.
- Lô "kiểm hết": không làm ở Mốc 5; danh sách chờ đọc bằng báo cáo `invoice_adjustments` (mục 7), kiểm từng cái (HDN6).

### 4.5 Huỷ / khôi phục hoá đơn (`invoice.cancel`, `invoice.restore`, Mốc 5)

- **Huỷ:** chỉ `DRAFT/APPROVED` và `paid_amount = 0` (luật hàm ghi). `OVERDUE` ⇒ `cancel_overdue_web_only`; đã thu ⇒ `cancel_has_payment`; đã huỷ ⇒ kết quả "đã huỷ trước đó, không đổi".
- **Khôi phục:** chỉ `CANCELLED`; đã có hoá đơn MONTHLY khác cùng HĐ, cùng kỳ còn hiệu lực ⇒ `restore_conflict`.
- **Lý do bắt buộc** (8–500). Hàm ghi không có tham số lý do: lý do nằm trong biên nhận Hermes (`input.params.reason`) và audit `HERMES_ACTION_APPLIED`; không ghi đè `invoices.notes` (HDN8).
- **Xem trước:** số hoá đơn, kỳ, tổng, credit đã cấn sẽ hoàn về khách, và — từ #267 — hoá đơn này đang gánh nợ cũ (`carried_in_amount > 0`): "huỷ thì nợ 1.200.000đ của kỳ 09/2026 tính lại ở hoá đơn kỳ 9".

### 4.6 Soạn tin nhắc nợ / gửi hoá đơn (Q18 = a; đọc, không phải thao tác)

Báo cáo W2 `invoice_reminders` (mục 7) trả từng hoá đơn còn nợ thực: phòng, kỳ, số hoá đơn, còn nợ, hạn + số ngày quá hạn, `publicLink` (`/c/<public_code>` của HĐ đang hiệu lực, trang công khai luôn hiện hoá đơn MỚI NHẤT của HĐ) và `messageText` do SQL dựng ("Chào anh/chị, phòng 201 toà 44TL: hoá đơn tháng 10/2026 còn 3.650.000đ, hạn 10/10/2026 (đã quá 12 ngày). Xem chi tiết: …"). Bot chép nguyên văn cho người dùng tự gửi; không có đường tự gửi.

- `public_code` hiện cố ý không ra khỏi các hàm đọc Hermes (`20261018000000`): Q18 = a là lý do có chủ ý để mở, chỉ cho HĐ `ACTIVE`, chỉ ở báo cáo này.
- Domain web: SQL không biết domain; dùng chung **một** cơ chế với `publicLink` của Hợp đồng (D-HĐ9, cấu hình host `publicWebOrigin`) — HDN9.

## 5. Lý do riêng trang (thêm vào danh sách đóng)

Khối "Hoá đơn" riêng trong `action-reasons.mjs`; mã dạng `rejected` vào thêm `REASONS` của `infra/hermes-runtime/host-ownership.mjs` cùng commit (test `audit-codes` khoá hai tập bằng nhau). Ánh xạ SQL đặt ở `app_private.hermes_invoice_reason_v1(sqlstate, message, constraint)`: câu riêng trang trước, rồi `hermes_action_reason_v1` của M1.

| Mã | Dạng | Câu tĩnh (tóm tắt) | Nguồn |
| --- | --- | --- | --- |
| `cash_collection_web_only` | rejected | Tiền mặt ghi trên web, trang Thu tiền (`/thu-tien`); bot chỉ ghi chuyển khoản/sổ HKD | `method=TM` (Q13) |
| `nothing_to_collect` | needs_input | Hoá đơn không còn số phải thu; hỏi lại phòng/kỳ | `PAID`, `55000 Hóa đơn không còn số tiền có thể thu` |
| `debt_carried` | needs_input | Nợ kỳ này đã cộng vào hoá đơn kỳ sau; thu ở hoá đơn kỳ sau | #267 `carried_out_amount > 0` |
| `overpay_needs_choice` | needs_input | Khách trả dư; hỏi giữ lại (`overpay=keep`) hay trả lại (`overpay=return`) | lượt 2 thiếu `overpay`; `22023 Số thu vượt còn phải thu` |
| `invoice_not_collectible` | rejected | Hoá đơn nháp/đã huỷ, không thu được | `55000 Trạng thái hóa đơn không cho phép thu tiền` |
| `credit_requires_contract` | rejected | Hoá đơn không gắn HĐ nên không giữ phần dư được; chọn trả lại | `22023 Không thể giữ credit…` |
| `receiving_book_missing` | rejected | Toà chưa cài sổ nhận TK/TT, hoặc anh/chị không giữ/biết sổ nào của toà | kế hoạch; `42501 Toà % chưa cài sổ nhận tiền`, `Sổ "%" không nằm trong danh sách…` |
| `reconciliation_required` | rejected | Hoá đơn có cơ cấu/bút toán chưa đối soát; nhờ kế toán kiểm trên web | các câu 55000 "đối soát", "semantic", "phân bổ" của v5 và `adjust_invoice_v2` |
| `meter_not_found` | needs_input | Phòng không có công tơ đang dùng loại này; hỏi lại phòng/loại | kế hoạch chỉ số |
| `meter_ambiguous` | needs_input | Phòng có nhiều công tơ cùng loại; hỏi mã công tơ | kế hoạch chỉ số |
| `meter_duplicate_month` | needs_input | Tháng này đã có chỉ số; người dùng nói "sửa" mới thay | kế hoạch chỉ số (Q16) |
| `meter_lower_than_previous` | needs_input | Chỉ số mới nhỏ hơn số đầu; hỏi lại số | 23514 `meter_readings_current_gte_previous` |
| `meter_used_by_invoice` | rejected | Chỉ số đã lên hoá đơn; sửa bằng điều chỉnh hoá đơn trên web | kế hoạch chỉ số |
| `adjust_meter_line_web_only` | rejected | Dòng điện/nước có chỉ số, cọc hay khoản nội bộ sửa trên web | dựng dòng |
| `adjust_has_rounding_or_credit` | rejected | Hoá đơn có làm tròn/cấn trừ đang hiệu lực; đảo giao dịch trên web trước | `55000 Hóa đơn có làm tròn hoặc cấn trừ…` |
| `adjust_debt_carried` | rejected | Nợ đã chuyển sang hoá đơn sau; xử lý hoá đơn sau trên web trước | `55000 Nợ đã chuyển sang hóa đơn sau…` |
| `adjust_below_collected` | rejected | Tổng mới thấp hơn số đã thu; đảo lần thu trên web trước | `55000 Nội dung mới thấp hơn tiền đã phân bổ…`, `Thành phần % thấp hơn…` |
| `adjust_no_change` | needs_input | Điều chỉnh không đổi gì; hỏi lại nội dung | `22023 Không có thay đổi nội dung hóa đơn` |
| `nothing_to_check` | needs_input | Hoá đơn không có điều chỉnh chờ kiểm tra | tra cứu |
| `cancel_has_payment` | rejected | Hoá đơn đã thu tiền nên không huỷ được; đảo lần thu trên web trước | trạng thái; P0001 `Không thể huỷ hoá đơn ở trạng thái này…` |
| `cancel_overdue_web_only` | rejected | Hoá đơn quá hạn huỷ trên web | `status='OVERDUE'` |
| `restore_conflict` | rejected | Kỳ này đã có hoá đơn khác đang hiệu lực; không khôi phục được | tra cứu; 23505 ràng buộc (HĐ, kỳ) |

Dùng lại mã chung: `period_locked` (`[PROFIT_LOCKED]`, `[CASHBOOK_CLOSED]`, `[HANDOVER_LOCKED]`), `cashbook_not_held` (`Bạn không được giao sổ quỹ này…`), `not_allowed` (42501 còn lại), `state_changed` (PT409 `Số đã thu vừa thay đổi…`, `Hóa đơn vừa thay đổi…`, `Hóa đơn đã có phiên bản mới…`), `date_out_of_range`, `reason_required`, `web_only` (rào hỗ trợ tiền phòng `REVENUE_CAP_REVIEW`, `SETTLEMENT`, writer đóng băng 55000), `duplicate_request` (chỉ đúng ràng buộc idempotency). 23505 "idempotency_key đã dùng với nội dung khác" của hàm ghi web **không** là `duplicate_request` (khoá do requestId cấp, trùng nghĩa là lệch đầu vào) ⇒ `crm_refused`. Tổng: 22 mã mới, 13 dạng `rejected`.

## 6. Hàm dùng chung mới (luật 17/10)

### 6.1 `public.invoice_collection_plan_v1(p_invoice_id uuid, p_lines jsonb, p_options jsonb DEFAULT '{}') RETURNS jsonb`

- `plpgsql STABLE SECURITY INVOKER SET search_path=''`, từ chối khi `current_user <> 'authenticated'`; GRANT `authenticated`. File migration không chứa `hermes_` (lệ hàm dùng chung). Gọi `get_receiving_cashbooks_v1`, `invoice_effective_outstanding_v1`, `is_overdue(invoices)`, `org_today_v1` (đều public).
- `p_lines`: `[{method: TM|TK|TT, amount|null, accountId|null, changeAmount|null}]` (web nhiều dòng; Hermes một dòng). `p_options`: `{overpay: reject|keep|refund|return, collectionDate, collectorUserId}`.
- Luật (đúng thứ tự client hiện nay):
  - `remaining = max(total − paid, 0)` (định nghĩa của v5); nợ thực + `carriedOut` từ #267 chỉ để cảnh báo/chặn thu trùng;
  - `deriveOverpayPolicy`: `canRefund = tiền mặt ≥ phần dư`, `canKeep = có HĐ`, `mustKeep = dư && !canRefund`; `return` = nhánh `cap` của `planCollect` (cắt về số còn nợ);
  - làm tròn: `0 < thiếu < 10.000` và không còn cọc phải thu (bản SQL của `deriveInvoiceDepositDue`); v5 vẫn là trọng tài cuối;
  - sổ: TK/TT trong danh sách sổ nhận (mặc định phần tử đầu), TM = sổ tiền mặt riêng, làm tròn = sổ ảo "Làm tròn tiền thiếu", thối = luật mới **không dùng ID viết cứng**: sổ ảo tên kết thúc "Thối" mà người thu giữ (possession); không có thì sổ "…Thối" đầu tiên như nhánh mặc định hiện nay. Luật này phải đo trên production (chỉ đọc) ở Mốc 3 trước khi chốt (HDN3);
  - cảnh báo: `possible_duplicate` (30 phút, cùng số), `overdue`, `debt_carried`, `old_date`; chặn: `not_collectible`, `nothing_to_collect`, `overpay_needs_choice`, `refund_requires_cash`, `credit_requires_contract`, `receiving_book_missing`, `rounding_book_missing`, `future_date`.
- Trả `{remaining, effectiveOutstanding, carriedOut, gross, applied, change, credit, rounding, overpayAction, allowRounding, tenders:[khuôn p_tenders của v5], after:{paid, remaining, status}, warnings, blockers}`.
- **Parity với web:** bộ vector `src/lib/__tests__/fixtures/invoice-collection-plan-vectors.json` dựng từ ca của `collectPlan.test.ts`, `collectionActualChange.test.ts`, `paymentRecordRpc.test.ts` (`deriveInvoiceDepositDue`), `duplicateCollection.test.ts`; vitest chạy trên TS, PG17 chạy trên SQL. Web **chưa** chuyển ở Mốc 3; chuyển dialog Thu tiền, `/thu-tien`, thu hàng loạt sang hàm này (bỏ `changeAccounts.ts`) là Mốc 3b nếu phiên chính duyệt (HDN3).

### 6.2 `public.record_meter_readings_v2` + `public.meter_readings_plan_v1`

- `meter_readings_plan_v1(p_building_id uuid, p_reading_date date, p_rows jsonb, p_replace boolean DEFAULT false) RETURNS jsonb`: `STABLE SECURITY INVOKER search_path=''`. Dòng `{meterId}` hoặc `{roomId, meterType, meterCode}`. Trả từng dòng: công tơ, phòng, chỉ số đầu, tiêu thụ, trung bình 3 kỳ, dòng cùng tháng, trạng thái và cảnh báo (mục 4.2).
- `record_meter_readings_v2(p_building_id uuid, p_reading_date date, p_rows jsonb, p_replace boolean DEFAULT false, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`: `SECURITY DEFINER`, kiểm quyền bằng **đúng biểu thức của policy INSERT/UPDATE** (`is_super_admin() OR building_id = ANY(app_private.buildings_for_v3('meter_readings.create'|'.edit'))`), công tơ thuộc đúng toà + công ty. Gọi lại `meter_readings_plan_v1` (một nguồn luật), dòng không `ok` ⇒ lỗi 22023 kèm mã dòng; INSERT `status='APPROVED'`, `approved_by = auth.uid()` (như form web), hoặc UPDATE `current_reading` khi thay. Trigger hiện có vẫn điền `settlement_month`, `previous_reading`, `recorded_by`, mã `CSS…`.
- **Web chuyển sang** (Mốc 4): `useBulkCreateMeterReadings` gọi hàm ghi qua service có kiểu (`src/lib/meterReadingRpc.ts`), không INSERT thẳng; form hiện lỗi "đã có chỉ số tháng này" thay vì ghi dòng thứ hai. Đây là đổi hành vi có chủ ý (plan §8.2), có test hook + component và kiểm màn Ghi chỉ số desktop + mobile. Nhập Excel (`bulk_create_meter_readings`, UNAPPROVED) và luồng lập hoá đơn Excel (INSERT chỉ số cuối kỳ) **không đổi** ở đợt này (rủi ro mục 9).

### 6.3 `public.invoice_adjustment_build_v1(p_invoice_id uuid, p_ops jsonb) RETURNS jsonb`

- `STABLE SECURITY INVOKER search_path=''`. Đọc hoá đơn + dòng dưới RLS. `p_ops`: `{discountAdd, addItems[], setItems[]}`.
- Trả `{before:{items, subtotal, discount, total}, after:{items, subtotal, discount}, paid, expected:{revision, paid, updatedAt}, changed:[…], blockers}`. **Tổng sau không tính ở đây**: hàm làm tròn là `app_private.round_invoice_total_v1` (INVOKER không gọi được `app_private`); bản xem trước lấy tổng từ chạy thử `adjust_invoice_v2`.
- Parity: vector từ `invoiceAdjustmentEntry.test.ts` / `invoiceAdjustmentEditor.test.ts` (giữ id, `service_id`, kỳ, `sort_order`; `amount` lệch `giá × SL × hệ số` ⇒ một dòng `unit_price = amount`). Web chưa chuyển (plan: "web sau").

## 7. Đọc bù (a)–(f) và nhắc nợ: 7 báo cáo W2 mới ở gói A

0 byte `tools/list`: báo cáo nằm trong kết quả `crm_read_report_list`; connector giải `buildingName`/`roomName` thành id sẵn (B5d). Thêm báo cáo mới thay vì sửa `invoice_detail` / `collection`: khuôn cũ bị kiểm khít, connector lên trước migration sẽ làm vỡ báo cáo cũ. Thứ tự an toàn: SQL trước (bản broker cũ bỏ qua mã lạ), connector sau.

| Câu đo nền | Báo cáo | Khoá | Tham số | Hàng / summary |
| --- | --- | --- | --- | --- |
| (a) chi tiết khoản một hoá đơn theo phòng + kỳ (TC-I03); (b) hạn đóng một hoá đơn (TC-I10) | `invoice_room_detail` | `invoices.view` | `roomId*`, `month` (mặc định tháng này) | như `invoice_detail` (gọi đúng `invoice_detail_v1`) + `dueDate`, `paidDate`, `isOverdue`, `overdueDays`, nợ thực; dòng điện/nước có `consumption = cuối − đầu` |
| (b) ai hay trả trễ (TC-I05) | `invoice_lateness` | `invoices.view` | `buildingId`, `fromDate`/`toDate` theo kỳ (mặc định 3 kỳ gần nhất) | mỗi hoá đơn: phòng, kỳ, hạn, ngày thu đủ (hoặc lần thu cuối), số ngày trễ; summary: theo phòng (số lần trễ, trễ trung bình), toàn bộ |
| (c) thu tháng này tách CK/TM/TT (TC-I06) | `collection_by_method` | `thu_tien.view` | `month` hoặc `fromDate`/`toDate` (ngày thu), `buildingId` | theo (toà, hình thức): số lần, số tiền; summary: tổng TM/TK/TT/CT |
| (d) điều chỉnh chờ kiểm + lịch sử (TC-I07) | `invoice_adjustments` | `invoices.view` | `buildingId`, `status` (pending/checked), `fromDate`/`toDate` | phòng, kỳ, số HĐ, lần, tổng trước/sau, chênh, lý do, người điều chỉnh, lúc, trạng thái, người/lúc kiểm; summary: số chờ, chờ lâu nhất |
| (e) phòng có HĐ hiệu lực chưa có hoá đơn kỳ M (TC-I08) | `invoice_missing` | `invoices.view` | `month*`, `buildingId` | phòng, số HĐ, ngày bắt đầu HĐ; summary: số phòng, theo toà |
| (f) "nợ quá hạn" = hoá đơn còn nợ quá hạn (TC-I09) | `invoice_overdue_rooms` | `invoices.view` | `buildingId`, `days` (quá hạn ≥ N ngày) | mỗi PHÒNG: số hoá đơn quá hạn, hạn cũ nhất, số ngày quá hạn lớn nhất, nợ thực; summary: số phòng, số hoá đơn, tổng |
| Q18 soạn tin nhắc nợ | `invoice_reminders` | `invoices.view` | `buildingId`, `roomId`, `days` | mục 4.6 |

- Quá hạn tính theo `is_overdue` (hạn < hôm nay giờ tổ chức, chưa thu đủ), không theo `status='OVERDUE'` (chỉ được đánh dấu khi có người mở trang Hoá đơn). Nợ = `effective_outstanding` (#267).
- Hàm đọc dùng chung mới (INVOKER, `search_path=''`, file không chứa `hermes_`): `invoice_missing_v1`, `invoice_adjustments_list_v1`, `invoice_lateness_v1`, `collection_by_method_v1`, `invoice_overdue_rooms_v1`, `invoice_reminders_v1`. Web dùng được cho màn "điều chỉnh chờ kiểm" về sau (plan §8.7).
- `app_private.hermes_w2a_read_v1` và `hermes_w2a_catalog_v1` dựng lại **từ thân đang chạy** (bài học #267): md5 `prosrc` production = TEST = repo, ghim ở `$requires$`. Test đếm `wave2-a.test.mjs` 9 → 16.
- Lỗi SOUL của lượt đo nền (TC-J01/J02 coi tiền khách trả là phiếu chi, TC-I01 không tìm ra tool, TC-I09) sửa ở SOUL (mục 12), không cần mã.

## 8. Hàm báo giá hoá đơn tháng (P7, Q17 = a) — chỉ thiết kế, MỐC CUỐI tuỳ chọn

Q17 = a: bot chưa lập hoá đơn; làm hàm tính tiền dùng chung trước. Phần này chỉ để phiên chính duyệt phạm vi; hiện thực sau khi duyệt, bot vẫn không lập hoá đơn.
- `public.invoice_month_quote_v1(p_contract_id uuid, p_billing_month text, p_options jsonb) RETURNS jsonb`, INVOKER STABLE: trả đúng các dòng mà Mode Excel dựng hôm nay (`useExcelInvoiceData.ts`, `invoiceEntry.ts`, `excelInvoiceRows.ts`): tiền phòng chia ngày /30, điện = (cuối − đầu) × giá, nước theo người, phí dịch vụ, gửi xe, hỗ trợ tiền phòng, nợ cũ có nguồn, credit; `subtotal`, `total` (làm tròn nghìn), hạn thanh toán **một nguồn** (hiện có 4 nguồn mâu thuẫn).
- Nghiệm thu: báo giá khớp từng dòng với mọi hoá đơn kỳ 09–10 trên TEST (≈ 600 hoá đơn); chỗ lệch là lệch có giải thích hoặc lỗi web cần chủ chốt.
- Sau đó (đợt khác): Mode Excel và lập lẻ gọi báo giá; `create_invoice_v1` kiểm subtotal/amount theo báo giá (vá lỗ "máy chủ tin tiền client gửi"); mới tới thao tác bot `invoice.create`.
- Công: 8–12 ngày. Rủi ro lớn nhất: hai bộ dựng hiện đã lệch nhau (gửi xe, nguồn credit, mô tả dòng) nên "khớp web" phải chọn một bên.

## 9. Rủi ro

| Rủi ro | Mức | Giảm |
| --- | --- | --- |
| Thu trùng món nợ đã kéo sang kỳ sau | Cao nếu thiếu #267 | `debt_carried` + chọn hoá đơn theo nợ thực; migration đòi #267 ở `$requires$` |
| Mô hình tự gọi lượt 2 không chờ người dùng | Cao ở thao tác tiền | Sàn `money` luôn xác nhận; SOUL; ca N10 của nền chung |
| Chạy thử v5 để lại dấu vết ngoài giao dịch | Thấp | Đã tra thân v5 (`20260925083655`): không có `nextval`, `net.http`, `pg_notify`; mã phiếu dùng bảng đếm (Thu chi). Hàm con v5 gọi chưa tra hết ⇒ tầng 2 kiểm 0 dòng còn lại sau khi khối con lùi, đo khe SEQUENCE và độ trễ lô 10 |
| Seed nhầm `thu_tien.collect` làm M2 đỏ ở cửa idempotent | Vừa | HDN1 dùng khoá riêng Hermes; test khoá chéo: migration trang không chứa chuỗi seed `thu_tien.collect` |
| "Đã lên hoá đơn" của chỉ số chỉ suy được (không có khoá nối) | Vừa | Chặn khi nghi ngờ (cùng phòng, kỳ, dịch vụ, số); có chỉ số kỳ sau ⇒ không thay; ghi rõ ở bản xem trước |
| Form web đổi sang hàm ghi mới làm hỏng ghi chỉ số hằng tháng (~260 dòng/tháng, ngày 30–31) | Vừa | Test hook/component, kiểm màn desktop + mobile, E2E fleet trên TEST; phát hành giữa tháng; lùi bằng deployment đã xác minh (hàm mới để nguyên) |
| Nhập Excel và lập hoá đơn Excel vẫn INSERT chỉ số trùng được | Vừa (sẵn có) | Ghi rõ là ngoài đợt; chuyển cùng P7 |
| Sổ thối theo luật possession chọn khác 2 ID viết cứng | Vừa (chỉ web, TM) | Đo production trước; Mốc 3b chỉ làm khi khớp; Hermes không thối (chỉ TK/TT) |
| Chủ là Super Admin: hàm ghi tin `is_super_admin()` ở vài chỗ | Vừa | Guard Hermes tự rào toà ∩ overlay ∩ `buildings.view`; không bao giờ gọi đường super admin (huỷ cưỡng bức) |
| Bật khoá ⇒ mọi kết nối `inherit_crm` có quyền nhận ngay | Vừa, tăng khi cấp cho Quản Lý Tòa (Q7) | Trước khi cấp: loại trừ khoá tiền ở kết nối của quản lý hoặc O2 (nền chung §8.3) |
| Lần thu qua bot không có ảnh biên nhận (35 % lần thu web cũng thiếu) | Thấp | Bản xem trước nói rõ; đường ảnh Zalo (PR #260/#268) về sau |
| `crm_action_list` của trang quá lớn (6 thao tác, list/record) | Thấp | Test ≤ 8 KB như Hợp đồng |
| Ba phiên song song sửa cùng file chung | Vừa | Khối nhãn "Hoá đơn" riêng; rebase theo người gộp trước (mục 10) |

## 10. Migration dự kiến, thứ tự áp, file chung

Tên lấy bằng `scripts/tao-ten-migration.mjs` ở mốc tương ứng; chỉ là file, phiên chính áp qua lane. Migration trang nối tiếp vào cùng một file cho tới khi gộp (như D-HĐ10); đã gộp thì mốc sau dùng migration mới.

| Mốc | Migration (tên tạm) | Nội dung | Đòi đã áp |
| --- | --- | --- | --- |
| 2 | `invoice_reads_shared_v1` | 6 hàm đọc dùng chung (mục 7) | #267 |
| 2 | `hermes_w2a_invoice_reads_v1` | catalog + reader gói A dựng từ thân đang chạy (md5 ghim), 7 báo cáo | dòng trên |
| 3 | `invoice_collection_plan_v1` | hàm kế hoạch thu | #267 |
| 3 | `hermes_invoice_action_v1` | seed khoá `thu_tien.collect_transfer` TẮT; 6 dòng `hermes_action_policies`; ánh xạ lý do; tra cứu, bước ghi, vỏ (nhánh `collect`) | M1, M2, M5, #267, #270 (nhãn ngày), dòng trên |
| 4 | `meter_readings_v2` | `meter_readings_plan_v1` + `record_meter_readings_v2` (`gen:types`) | — |
| 4 | (nối vào migration trang) | nhánh `meter_record` | dòng trên |
| 5 | `invoice_adjustment_build_v1` + (nối vào migration trang) | hàm dựng dòng; nhánh `adjust`, `adjustment_check`, `cancel`, `restore` | — |
| 6 | `invoice_month_quote_v1` | nếu P7 được duyệt | — |

**Thứ tự áp (cửa idempotent của CI main chạy từng migration trên trạng thái production):** #267 → M1/M2/M5 (đã áp) → migration Mốc 2 → Mốc 3 → Mốc 4 → Mốc 5; mỗi cái áp TEST rồi production **trước khi gộp** PR. Khoá `thu_tien.collect_transfer` seed TẮT cùng lần promote web có khoá trong `capability-contract.mjs` + nhãn (bài học 19/10). Bật khoá bằng migration riêng sau nghiệm thu. Không migration nào được seed `thu_tien.collect`: khối kiểm của M2 `20261021134531` đòi khoá đó vắng.

**File chung phải đụng** (mỗi file một khối nhỏ gắn nhãn "Hoá đơn"; người gộp sau rebase):

| File | Thay đổi |
| --- | --- |
| `HB/action-reasons.mjs`, `infra/hermes-runtime/host-ownership.mjs` | 22 mã (mục 5); 13 mã `rejected` vào `REASONS` |
| `HB/action-catalog.mjs` | `MAX_LIST` 20 → 60 (sau khi TC8 gộp) |
| `HB/capability-contract.mjs` | khối `HERMES_INVOICE_ACTION_KEYS = ['thu_tien.collect_transfer']` (không chạm `HERMES_ACTION_FOUNDATION_KEYS`: test khoá chéo với seed M2) |
| `src/hermes/capabilityLabels.ts` (+ test) | nhãn khoá riêng Hermes `thu_tien.collect_transfer` ("Hermes: ghi khách đã chuyển khoản / trả vào sổ HKD, không tiền mặt, có xem trước"); sửa nhãn `invoices.edit` (bỏ "xác nhận kiểm tra") và `invoices.approve` ("xác nhận đã kiểm tra điều chỉnh", không phải duyệt hoá đơn) |
| `HB/server.mjs` + cấu hình host `actionPages` (#270) | thêm `invoice` |
| `HB/wave2-a-contract.mjs` | 7 báo cáo |
| `HB/CONNECTOR.md`, `scripts/hermes-task-function-contract.mjs` (băm vỏ), `scripts/hermes-read-function-specs.mjs` / `scripts/test-hermes-private-flow.mjs` (hàm `search_path=''`), `scripts/__tests__/hermes-durable-forward-fixture.mjs`, `supabase/migration-unknown-review.json`, provenance, `tooling/test-matrix.json` | dòng của Hoá đơn |

Byte `tools/list`: không đổi (họ thao tác 1 959 B đã tính; báo cáo W2 nằm trong kết quả). Test `action-tools-budget` khẳng định lại.

## 11. Kiểm thử

**Tầng 1, offline (`node:test`).**
- `invoice-action.test.mjs`: danh mục nạp được; khoá ⊆ `HERMES_ACTION_CAPABILITIES`; lý do ∈ danh sách đóng; khuôn và gợi ý tĩnh từng thao tác (list 1–10, 1–60, 1–5; snake_case trong record); sàn: cả 6 luôn xem trước dù chính sách ghi `never`; runtime với dịch vụ giả: `needs_input` không phải lỗi MCP; `rejected` qua `mcp-http` đúng câu tĩnh; preview có `choiceRequired` ⇒ lượt 2 ra `needs_input`; `crm_action_list` của trang ≤ 8 KB.
- `audit-codes.test.mjs` xanh với 13 mã mới (đỏ nếu quên `host-ownership.mjs`); `action-tools-budget`: byte bằng khi chỉ có danh mục thử.
- `wave2-a.test.mjs`: 16 báo cáo, catalog JS = SQL.
- Vitest: vector kế hoạch thu (TS), vector dựng dòng điều chỉnh (TS), hook ghi chỉ số gọi RPC (mock client), form hiện lỗi trùng tháng.
- **Kiểm đột biến** (Contract §8; băm file trước/sau, khôi phục theo CODEBASE_STRUCTURE). Gỡ từng rào phải có test đỏ: TM bị chặn; phạm vi toà/phòng của bản đã giải; đối chiếu id tra cứu; `debt_carried`; so `basis`; `p_expected_paid_amount` truyền đúng; lô cả-hoặc-không; trần 10/60; chống trùng tháng trong hàm ghi; `used_by_invoice`; sàn `always`; vỏ quay về plpgsql; tra cứu chuyển sang DEFINER; `$requires$` #267.

**Tầng 1b, PG17 dùng một lần** (khuôn `action-foundation-sql.test.mjs` + `finance-fixture.mjs`). Hàm ghi web quá lớn để nạp: dùng bản port tối giản cùng chữ ký và đúng các câu lỗi đã liệt kê (như #270). Chạy: mọi nhánh mục 4; chạy thử không để lại dòng nào; basis lệch ⇒ `state_changed` không chốt; lỗi cuối ⇒ chốt và phát lại; bảng câu lỗi thật ⇒ đúng mã; ba hàm dùng chung chạy trên vector parity; `record_meter_readings_v2` thật (đủ nhỏ để nạp) + trigger thật: trùng tháng, nhỏ hơn số đầu, thay khi chưa lên hoá đơn, hai phiên song song.

**Tầng 2, SQL thật trên TEST, không model** (`npm run test-env:thu-sql -- <file.sql>`, ROLLBACK mặc định, KHÔNG `--ghi`). Kịch bản ghép thân migration (bỏ `BEGIN/COMMIT`) + bật khoá trong giao dịch + kết nối/phiên/binding thử + `set_config('request.jwt.claims', …, true)` + `SET ROLE authenticated` → preview → apply → `SET CONSTRAINTS ALL IMMEDIATE` → SELECT chấm.
- Persona: chủ (giữ sổ TK các toà); Quản Lý Tòa trong phạm vi; Quản Lý Tòa ngoài phạm vi; vai chỉ có `invoices.record_payment` (không có `thu_tien.collect`); vai thiếu `invoices.approve`.
- Chấm: `invoice_payment_collections` (khoá tiền tố `hermes-inv:`, gross/applied/credit/rounding), `invoice_payment_tenders` (hình thức, sổ), `income_expenses` + dòng sổ, `invoices` (paid/remaining/status), `customer_credit_lots`, `meter_readings` (số dòng, tháng, đầu/cuối), `invoice_adjustments`, biên nhận, audit `HERMES_ACTION_*`.
- Đo: chạy thử v5 lô 10 (mục tiêu p95 < 2 s), dấu vết sau chạy thử, câu lỗi thật của TEST.

**Tầng 3, bot thật** (phiên chính, TEST): ma trận độc lập ≥ 60 câu do phiên chính soạn, mỗi ca 3 lần, đạt khi 0 ghi sai và ≥ 95 % ca đạt cả 3 lần. Phiên con đề xuất 20 ca phát triển ở `hoa-don-ca-phat-trien.json` (scratchpad phiên chính). Playwright MCP kiểm màn Ghi chỉ số (desktop + mobile) trên dev server trỏ TEST, không bấm Lưu; luồng ghi thật kiểm bằng E2E fleet do phiên chính chạy.

## 12. Từ chối có chỉ đường web và đề xuất SOUL (phiên chính quyết)

- "Khách trả/đóng/chuyển tiền phòng, tiền hoá đơn" = **thu tiền hoá đơn** (`invoice.collect`), không phải phiếu chi hay phiếu thu lập tay (TC-J01/J02).
- Tiền mặt: "Tiền mặt anh/chị ghi trên web ở trang Thu tiền (/thu-tien); em chỉ ghi khoản chuyển khoản hoặc vào sổ HKD." Không hỏi thêm để "lập phiếu".
- Hoàn tác / đổi hình thức lần thu: "làm trên web: Hoá đơn › Lịch sử thanh toán."
- Lập hoá đơn tháng: "em chưa lập hoá đơn được; anh/chị dùng Mode Excel ở trang Hoá đơn. Em liệt kê được phòng chưa có hoá đơn kỳ này" (`invoice_missing`).
- Gửi hoá đơn / nhắc nợ: luôn đọc `invoice_reminders`, chép nguyên `messageText` + link, nói rõ "anh/chị bấm gửi giúp em".
- Đọc: "nợ quá hạn" = `invoice_overdue_rooms` (đếm PHÒNG); "phòng nào chưa đóng tháng này" = báo cáo `collection`; "hạn đóng / chi tiết điện nước một phòng" = `invoice_room_detail`; "thu tháng này CK bao nhiêu" = `collection_by_method`; "điều chỉnh chờ kiểm" = `invoice_adjustments`.
- Ghi: luôn đọc nguyên `preview.text` + mọi `warnings`; preview có `choiceRequired` ⇒ hỏi đúng câu đó, không gọi lượt 2; chỉ số "sửa" mới gửi `replace=true`; tháng đã qua gửi `month`, không tự đặt ngày.

## 13. Quyết định cần chốt (mặc định đề xuất in đậm)

| # | Câu | Mặc định | Phương án khác |
| --- | --- | --- | --- |
| HDN1 | Khoá cho thu tiền | **Khoá riêng Hermes `thu_tien.collect_transfer` seed TẮT, quyền CRM giao vào `thu_tien.collect`** (đúng quyền hàm ghi kiểm; không đụng khối kiểm của M2), promote web cùng nhãn | Seed `thu_tien.collect` (làm M2 đỏ khi chạy lại); dùng `invoices.record_payment` (lệch quyền hàm ghi) |
| HDN2 | Lô thu tiền | **Mục không thu được loại khỏi lô và nêu ở xem trước; lượt 2 cả tập hoặc không** | Cả lô hoặc không ngay từ xem trước (như TC3) |
| HDN3 | Kế hoạch thu cho web | **Mốc 3: hàm SQL + vector parity; web chuyển ở Mốc 3b sau khi đo luật sổ thối trên production** | Chuyển web ngay ở Mốc 3; hoặc để web đợt sau |
| HDN4 | Hỏi giữ lại/trả lại khi đưa dư | **Bản xem trước có câu hỏi (`choiceRequired`), không đổi runtime** | Mở rộng runtime cho `needs_input` mang số liệu (đổi file lõi, ảnh hưởng 4 trang) |
| HDN5 | "Giảm 100k" khi đã có giảm trừ | **Cộng thêm** (xem trước nêu cũ → mới) | Đặt tổng giảm trừ mới |
| HDN6 | Xác nhận kiểm tra | **Cho cả điều chỉnh của chính mình (kèm cảnh báo); từng cái một** | Cấm tự kiểm; lô ≤ 10 |
| HDN7 | Trần lô chỉ số | **`MAX_LIST` chung 20 → 60** | Trần riêng theo khuôn (thêm tham số cho `param.list`) |
| HDN8 | Lý do huỷ/khôi phục | **Chỉ ở biên nhận + audit Hermes** | Nối vào `invoices.notes` (đổi dữ liệu web hiển thị) |
| HDN9 | Domain cho link công khai | **Dùng chung cơ chế D-HĐ9 của Hợp đồng** | Hằng số trong SQL / cấu hình DB |
| HDN10 | P7 hàm báo giá | **Chỉ thiết kế; hiện thực khi phiên chính duyệt sau Mốc 5** | Bỏ khỏi đợt |

## 14. Việc phiên chính phải làm

1. Duyệt thiết kế và HDN1–HDN10.
2. Thứ tự phụ thuộc: áp #267 (TEST + production) trước Mốc 2; gộp TC8 (#271) và áp + gộp #270 (`actionPages`, hàm nhãn ngày) trước Mốc 3.
3. Trước khi bật khoá cho Quản Lý Tòa (Q7): loại trừ khoá tiền ở kết nối của họ hoặc làm O2.
4. Trên TEST, khi tới tầng 3: bật `thu_tien.collect_transfer`, `meter_readings.create`, `invoices.edit`, `invoices.approve`, `invoices.cancel` bằng script TEST (không bằng migration production); `actionPages` thêm `invoice` ở connector 8741.
5. SOUL: đoạn mục 12.
6. Promote web cùng migration seed khoá (Mốc 3) và cùng form chỉ số (Mốc 4).

## 15. Mốc

| Mốc | Nội dung | Công |
| --- | --- | --- |
| 1 ✓ | Tài liệu này + 20 ca phát triển | — |
| 2 | Đọc bù: 6 hàm đọc dùng chung + 7 báo cáo W2 gói A; tầng 1 + PG17 + tầng 2 | 2–3 |
| 3 | `invoice.collect` (đơn + lô) + `invoice_collection_plan_v1` + seed khoá + nhãn | 4–5 |
| 3b | (nếu duyệt) web Thu tiền chuyển sang kế hoạch SQL, bỏ `changeAccounts.ts` | 1,5–2 |
| 4 | `invoice.meter_record` + `record_meter_readings_v2` + form web | 3–4 |
| 5 | `invoice.adjust`, `invoice.adjustment_check`, `invoice.cancel`, `invoice.restore` + `invoice_adjustment_build_v1` | 3–4 |
| 6 | P7 `invoice_month_quote_v1` (nếu duyệt) | 8–12 |

## 16. Chưa xác minh

- Luật sổ thối theo possession có trùng 2 ID viết cứng ở `changeAccounts.ts` không (đo chỉ đọc trên production ở Mốc 3).
- Chạy thử v5 trong khối con: khoá tư vấn và thời gian lô 10 (đo ở tầng 2).
- Hook options màn tạo kết nối nhận khoá riêng Hermes `thu_tien.collect_transfer` thế nào (`hermes_*_extend_options_v1` theo danh sách cứng hay theo registry); tiền lệ `income_expenses.approve_vouchers` cho thấy chỉ cần `capability-contract.mjs` + nhãn, chưa thử trên TEST.
- Heuristic "chỉ số đã lên hoá đơn" trên dữ liệu thật: số ca dương tính giả/âm tính giả (đo chỉ đọc ở Mốc 4).
- Bản dựng lại `hermes_w2a_read_v1` / `hermes_w2a_catalog_v1` khớp md5 production. Đã đọc production 22/10 (chỉ đọc): `md5(prosrc)` = `13812ba605e0faa0d6d526fb3b47278e` / `c24d2655c8cd4574a4e0c5288866eddf`; còn phải so với TEST và thân trong repo ở Mốc 2.

**Đã đọc production 22/10 (chỉ đọc, `npm run -s db:query`):** registry có `invoices.view`, `thu_tien.view`, `meter_readings.view` BẬT; `meter_readings.create`, `invoices.edit`, `invoices.cancel`, `invoices.approve` TẮT; không có `thu_tien.collect`. `invoice_effective_outstanding_v1` chưa có (#267 chưa áp). `authenticated` không có EXECUTE trên `app_private.round_invoice_total_v1` (nên mục 6.3 lấy tổng từ chạy thử hàm ghi).
