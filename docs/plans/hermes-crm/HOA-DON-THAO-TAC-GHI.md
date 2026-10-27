# Thao tác ghi của Hermes — trang HOÁ ĐƠN (Đợt 3: thiết kế ĐÃ DUYỆT, đang hiện thực)

Ngày 22/10/2026 (giờ Việt Nam). Tài liệu này cắm các thao tác ghi của trang Hoá đơn vào khung chung đã có trên `main` ([NEN-CHUNG-THAO-TAC-GHI.md](NEN-CHUNG-THAO-TAC-GHI.md)), theo cùng khuôn với trang Hợp đồng (PR #270) và Thu chi (PR #271). Phiên chính đã duyệt Mốc 1 và chốt HDN1–HDN10 (22/10; HDN6, HDN7 khác mặc định, xem mục 13). Tiến độ ở mục 15. Hai migration đọc Mốc 2 đã áp production 22/10; migration Mốc 3 (thu tiền) chỉ là file, chưa áp.

Căn cứ, theo thứ tự ưu tiên:
1. Đáp án 40 câu chủ chốt ngày 21/10: Q2, Q3, Q7, Q13–Q19. Khi đáp án và plan mâu thuẫn, đáp án thắng.
2. Plan chi tiết trang Hoá đơn ngày 21/10 (§1, §2, §4–§7, §9). Plan nằm ở máy làm việc, không có trong repo. Phần "một tool riêng" của plan thay bằng thao tác trong danh mục chung.
3. Lượt đo nền ngày 22/10: bot production chạy trên TEST, 22 ca Hoá đơn, 5 ca đạt.
4. Mã trên `origin/main` `3ae1d57f6`, cộng nhánh của PR #267 (công nợ), #270, #271 (chỉ đọc).

## 0. Kết luận

1. **Sáu thao tác, một RPC trang, 0 byte `tools/list`.** `invoice.collect`, `invoice.meter_record`, `invoice.adjust`, `invoice.adjustment_check`, `invoice.cancel`, `invoice.restore` đi qua ba tool `crm_action_*`. RPC trang là `public.hermes_invoice_action_v1`, cùng chữ ký và cùng ba tầng với `hermes_contract_action_v1`: vỏ INVOKER thân SQL-standard → tra cứu INVOKER dưới RLS người hỏi → bước ghi DEFINER gọi **đúng** hàm ghi web. Mọi thao tác đều luôn xem trước (Q2: đều dính tiền).
2. **Thu tiền chỉ chuyển khoản (TK) và thanh toán (TT — sổ POS của toà; nhãn như web: `RecordPaymentDialog` gọi TT là "Thanh toán", `building.ts` gọi sổ TT là POS).** `method = TM` bị từ chối có chỉ đường `/thu-tien` (Q13 = c: chủ chốt "Thu tiền mặt qua bot? → c) Không cho" trên trang chốt đáp án G4EjReGT ngày 21/10), kể cả chủ ghi hộ. Hàm ghi là `record_invoice_collection_v5` (DEFINER, tự kiểm `thu_tien.collect` theo toà và từng sổ, khoá lạc quan `p_expected_paid_amount`, idempotency theo khoá + băm nội dung). Thiếu một khoá registry: M2 cố ý không seed `thu_tien.collect` (câu 13 cũ hiểu là cấm thu qua bot), và khối kiểm của M2 (đã áp) **đòi registry không có `thu_tien.collect`** — seed khoá đó sẽ làm M2 đỏ mỗi khi cửa idempotent chạy lại nó trên production. Vì vậy dùng khoá riêng Hermes `thu_tien.collect_transfer` (seed TẮT, quyền CRM giao vào = `thu_tien.collect`; tiền lệ `income_expenses.approve_vouchers`). Tên khoá nói luôn phạm vi: chỉ TK/TT (HDN1).
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
| `invoice.collect` | `thu_tien.collect_transfer` (**khoá riêng Hermes mới, seed TẮT**) → quyền CRM `thu_tien.collect` (HDN1) | money | `buildingName*`, `roomName` hoặc `items` (list 1–10 của `{roomName*, month, invoiceNumber, amount}`), `month`, `invoiceNumber` (chọn một trong các hoá đơn còn nợ cùng phòng, Mốc 3b), `method*` (`TK`/`TT`/`TM`), `amount` (VND; trống = đúng số còn nợ), `date`, `overpay` (`keep`/`return`), `cashbookName`, `note` (1–200) | `record_invoice_collection_v5` | mỗi hoá đơn: id, `paid_amount`, `total_amount`, `status`, `updated_at`, `adjustment_revision`; kế hoạch (dòng tiền, sổ, giữ lại, làm tròn), ngày thu |
| `invoice.meter_record` | `meter_readings.create` (sửa cần thêm `meter_readings.edit`) | money (quyết tiền điện) | `buildingName*`, `readings*` (list 1–60 của `{roomName*, value*, meterCode}`), `meterType` (`dien`/`nuoc`, mặc định điện), `month`, `replace` (bool, "sửa") | `record_meter_readings_v2` (mới) | mỗi dòng: công tơ, chỉ số đầu, dòng cùng tháng đang có (id, `updated_at`), cờ đã lên hoá đơn; tập dòng sẽ ghi |
| `invoice.adjust` | `invoices.edit` | money | `buildingName*`, `roomName*`, `month`, `reason*` (8–1000), `discount` (VND giảm THÊM), `addItems` (list 1–5 `{description*, amount*}`), `setItems` (list 1–5 `{match*, amount*}`) | `adjust_invoice_v2` | id, `adjustment_revision`, `paid_amount`, `updated_at`, danh sách dòng sau |
| `invoice.adjustment_check` | `invoices.approve` | irreversible (không bỏ được "đã kiểm tra") | `buildingName*`, `roomName*`, `month` | `review_invoice_adjustment_v2` | id điều chỉnh, `revision`, `review_status`, `invoices.updated_at` |
| `invoice.cancel` | `invoices.cancel` | money (đổi công nợ) | `buildingName*`, `roomName*`, `month`, `reason*` (8–500) | `cancel_invoice_with_credit_v1` | id, `status`, `paid_amount`, `updated_at`, credit đã cấn |
| `invoice.restore` | `invoices.cancel` | money | `buildingName*`, `roomName*`, `month`, `reason*` (8–500) | `restore_invoice_with_credit_v1` | id, `status`, `updated_at`, hoá đơn cùng HĐ + kỳ đang hiệu lực |

- `invoiceNumber` không thành tham số: hoá đơn giải bằng toà + phòng + kỳ (`INV-…` người dùng hay đọc sai; thêm sau nếu ca thử cần).
- `month` trống: hoá đơn **còn nợ thực** (`effective_outstanding > 0`) duy nhất của phòng; với điều chỉnh/kiểm tra/huỷ là hoá đơn MONTHLY mới nhất chưa huỷ (khôi phục: mới nhất đã huỷ). Có ≥ 2 ứng viên ⇒ `needs_input name_unresolved` với `field:'invoice'` và ứng viên dạng "kỳ 09/2026 (còn 1.200.000đ)", câu do `nameUnresolvedDetail` dựng sẵn: "Hoá đơn '…' khớp nhiều: … — hỏi người dùng nêu rõ." Không cần đổi runtime.
- Kiểu `list` / `record` và `param.name('cashbook')` dùng lại bản của Thu chi (TC8, #271). `readings` cần trần 60, trong khi bản TC8 đặt `MAX_LIST = 20`. Đã chốt (HDN7): **không** nâng trần chung; `param.list` nhận thêm tham số tuỳ chọn trần riêng theo khuôn (mặc định giữ 20), chỉ `readings` khai 60. Nếu #271 chưa gộp khi tới Mốc 4, phần nối ghi rõ trong PR để phiên chính hợp nhất.
- Ràng buộc chéo tham số (`roomName` xor `items`, `discount`/`addItems`/`setItems` có ít nhất một) kiểm ở SQL, trả `needs_input invalid_params`.

## 4. Từng thao tác: luồng, xem trước, kết quả, trùng lặp

Câu xem trước và câu kết quả do SQL dựng bằng tiếng Việt ở `preview.text` / `result.text`, kèm trường có cấu trúc: `buildingName`, `roomName`, `invoiceNumber`, `billingMonth`, `customerName` (null khi không có `customers.view` ở toà), tiền là chuỗi số nguyên VND. Ngày có thứ và khoảng cách tới hôm nay theo giờ tổ chức ("thứ Sáu 31/10/2026 (còn 9 ngày)"), dùng lại `app_private.hermes_contract_date_label_v1` của #270 — migration trang đòi hàm đó ở `$requires$`, không chép thân thứ hai. Tên sổ che dãy ≥ 5 chữ số như Thu chi. `link` là `/invoices/<id>` (mục 3.1 nền chung cho phép UUID trong link).

### 4.1 Ghi nhận khách đã trả (`invoice.collect`, Mốc 3)

**Luồng.**
1. `method = TM` ⇒ `rejected cash_collection_web_only` ngay, trước mọi tra cứu.
2. Tra cứu: toà + phòng (từng phòng của lô); hoá đơn trạng thái `APPROVED/PARTIAL_PAID/OVERDUE`, chưa xoá; nợ thực từ `invoice_effective_outstanding_v1`.
   - Hoá đơn được chọn có `carried_out_amount > 0` (nợ đã kéo vào hoá đơn kỳ sau chưa thu xong) ⇒ `needs_input debt_carried`: "nợ kỳ này đã cộng vào hoá đơn kỳ sau; thu ở hoá đơn kỳ sau". Đây là chỗ #267 chặn thu trùng.
   - Hoá đơn `PAID` / không còn số thu ⇒ `needs_input nothing_to_collect` (thường là nhầm phòng/kỳ). `DRAFT/CANCELLED` ⇒ `invoice_not_collectible`.
   - ≥ 2 hoá đơn còn nợ khớp (kể cả hai hoá đơn CÙNG kỳ, vd hoá đơn tháng + hoá đơn phát sinh) ⇒ hỏi lại; mỗi ứng viên mang **số hoá đơn** ("kỳ 10/2026 · INV-… (còn …đ, extra)") và mô hình chọn lại bằng `invoiceNumber` (một phòng: tham số chung; lô: trong từng mục). Không phân biệt hoa thường; số không khớp ⇒ hỏi lại với các hoá đơn còn nợ (Mốc 3b).
3. Kế hoạch: `invoice_collection_plan_v1` (mục 6.1) với một dòng `{method, amount}` (trống = số còn nợ), `overpay`, ngày thu.
4. Chạy thử `record_invoice_collection_v5(…, p_expected_paid_amount := paid_amount vừa đọc, p_idempotency_key := 'hermes-dry:'||rid)` trong khối con. Câu lỗi ⇒ lý do (mục 5) trả ngay ở lượt 1. Riêng `22023 Không được làm tròn bỏ qua cọc…` ⇒ chạy thử lại với `p_allow_rounding=false`, bản xem trước nói "không làm tròn được vì phần thiếu là cọc; hoá đơn còn nợ X".
5. Lượt 2: gọi thật với khoá `hermes-inv:`; hậu điều kiện: `collection_id` có, `applied_amount` = bản xem trước, không có dòng `TM`, hoá đơn `paid_amount` tăng đúng `applied_amount`.

**Ngày thu.** Trống = `org_today_v1` (giờ VN). Mô hình đổi "hôm qua", "thứ Hai tuần trước" thành `date`. Tương lai ⇒ `date_out_of_range` (needs_input; hàm ghi cũng chặn 22023). Cách hôm nay > 7 ngày ⇒ cảnh báo, vẫn cho ghi. Tháng đã chốt lợi nhuận / sổ đã chốt ⇒ hàm ghi `[PROFIT_LOCKED]`/`[CASHBOOK_CLOSED]` ⇒ `period_locked`.

**Đưa dư (Q15).** v5 chỉ cho thối (`REFUND`) từ dòng tiền mặt; TK/TT dư chỉ có hai đường, đúng như web (dialog web ép "giữ credit" khi không có TM):
- `overpay = keep` ⇒ `CREDIT`: giữ phần dư làm tiền dư của khách cho kỳ sau; hoá đơn không gắn HĐ ⇒ `credit_requires_contract`;
- `overpay = return` ⇒ chỉ ghi đúng số còn nợ; bản xem trước nói "phần dư X đ KHÔNG ghi vào CRM, anh/chị tự chuyển trả khách";
- thiếu `overpay` ⇒ **bản xem trước có câu hỏi**: "Khách trả 3.700.000đ, còn nợ 3.650.000đ, dư 50.000đ. CHƯA chọn: giữ lại cho kỳ sau (`overpay=keep`) hay trả lại khách (`overpay=return`)?" kèm `preview.choiceRequired:'overpay'`. Token phát ra gắn params không có `overpay`, nên lượt 2 với token đó bị bước ghi trả `needs_input overpay_needs_choice`, không ghi. Cách này cho mô hình đọc được con số mà không phải đổi runtime (lý do dạng `needs_input` của trang chỉ mang câu tĩnh) (HDN4).

**Thiếu < 10.000đ (Q15).** Kế hoạch bật `allow_rounding` khi `0 < thiếu < 10.000` (ngưỡng cứng trong v5), sổ làm tròn = sổ ảo "Làm tròn tiền thiếu" của công ty (như web). Bản xem trước (lượt 8): "… → 5.000đ: ĐÃ THANH TOÁN nhờ làm tròn như web — 5.000đ số lẻ KHÔNG thu, ghi vào sổ «Làm tròn tiền thiếu»; cột còn nợ của hoá đơn vẫn hiện 5.000đ", kèm trường `rounding`. Không bao giờ nói "ĐỦ" khi còn số lẻ: `remaining_amount` là cột GENERATED tổng − đã thu, nên vẫn mang số làm tròn dù hoá đơn `PAID` (báo cáo nợ chỉ tính `APPROVED`/`PARTIAL_PAID`/`OVERDUE`). Thiếu ≥ 10.000đ ⇒ thu một phần, nói rõ còn nợ.

**Sổ nhận.** `get_receiving_cashbooks_v1(org, toà)`: TK/TT = sổ mặc định của toà rồi sổ phụ, giao với sổ người gọi giữ/biết. Không có sổ ⇒ lượt 8 tách hai mã: toà ĐÃ cài sổ cho hình thức đó (`app_private.receiving_cashbook_ids_v1(org, toà, hình thức, NULL)` — mọi sổ, không lọc người giữ) mà người hỏi không giữ/biết sổ nào ⇒ `receiving_book_not_held` (luật giữ sổ của v5, web cũng không cho); toà chưa cài ⇒ `receiving_book_missing`. Nhiều sổ: mặc định sổ đầu (như web), bản xem trước nêu tên; `cashbookName` chọn sổ khác trong đúng danh sách đó.

**Lô (`items` ≤ 10, cùng toà, cùng hình thức).** Một requestId, một biên nhận, một lần đồng ý.
- Lỗi tên hoặc kỳ mơ hồ ở bất kỳ mục nào ⇒ cả lô `needs_input`, `wanted` chỉ ra phòng nào.
- Mục không thu được vì trạng thái (đã thu đủ, đã huỷ, nợ đã kéo) ⇒ **loại khỏi lô và nêu trong bản xem trước** ("305: đã thu đủ ngày 05/10 — bỏ"). Đồng ý = ghi đúng tập mục còn lại; `basis` gồm tập đó. Còn 0 mục ⇒ từ chối với lý do của mục đầu.
- Lượt 2 **cả tập hoặc không gì** (như TC3 của Thu chi): một mục lỗi hay lệch ⇒ `RAISE`, lùi cả lô và biên nhận, trả `state_changed`; bản xem trước mới chỉ ra mục có vấn đề.

**Xem trước (ví dụ).** "Sẽ ghi THU 3.650.000đ bằng chuyển khoản ngày 22/10/2026 (thứ Năm, hôm nay) vào sổ «MB ***» cho hoá đơn INV-2026-01234." + mỗi hoá đơn một dòng "Phòng 201 toà 44TL, kỳ 10/2026 (INV-…): thu 3.650.000đ; còn nợ 3.650.000đ → 0đ: ĐÃ THANH TOÁN ĐỦ." + "Không kèm ảnh biên nhận". Lô: một dòng mỗi phòng + mục bị loại.

**Đã làm ở Mốc 3 (22/10), khác thiết kế ở các điểm sau (có lý do):**
- Nhãn ngày dùng `app_private.hermes_vn_date_text_v1` của Thu chi (đã áp production), không chờ hàm nhãn của #270.
- Bản xem trước KHÔNG nêu tên khách: bớt dữ liệu cá nhân, câu đủ rõ bằng toà + phòng + kỳ + số hoá đơn. Thêm sau nếu ca thử cần.
- Kỳ trống: ứng viên "còn nợ" bỏ hoá đơn có nợ đã kéo sang kỳ sau (#267 tính nợ ở hoá đơn gốc, thu ở hoá đơn gánh). Vì vậy "phòng 201 CK đủ" chọn đúng hoá đơn gánh, không hỏi lại. Nêu đích danh kỳ cũ ⇒ `debt_carried`.
- Không làm tròn được thì xem trước lại KHÔNG làm tròn, nói rõ trong cảnh báo (hoá đơn còn nợ phần thiếu). Có hai trường hợp:
  - v5 chặn vì phần thiếu là cọc/NON_PNL;
  - công ty chưa có sổ ảo "Làm tròn tiền thiếu".

  Cả hai không thành lý do từ chối riêng. Quyết định ghi vào `resolved.noRounding` để lượt 2 tính cùng kế hoạch.
- **Thứ tự khoá (sửa ở Mốc 3b; câu "lấy khoá công ty trước, như v5" của Mốc 3 là SAI).**
  - `record_invoice_collection_v5` khoá dòng hoá đơn `FOR UPDATE` → toà/công ty `FOR SHARE` → công ty `lock_org_for_decision_v1`.
  - Guard dùng chung của MỌI thao tác Hermes đã khoá dòng công ty ngay đầu giao dịch: `hermes_action_binding_v1` → `hermes_private_command_connection_v1` → `lock_org_for_decision_v1`. Bỏ hàm phạm vi riêng `hermes_invoice_scope_v1` (lấy khoá đó lần hai) không đổi được thứ tự này.
  - Hai thứ tự ngược nhau. Nếu Hermes **chờ** dòng hoá đơn mà web đang giữ (web lại đang chờ dòng công ty Hermes giữ) thì thành vòng 40P01, và phía web nhận lỗi ngẫu nhiên. Test PG17 hai kết nối tái hiện được: đột biến bỏ `NOWAIT` ⇒ 40P01.
  - Vì vậy bước ghi khoá các dòng hoá đơn của lô bằng `FOR UPDATE NOWAIT`, theo id tăng, ngay sau khi đối chiếu bản đã giải. Bận ⇒ `55P03` ⇒ cả giao dịch lùi ⇒ connector (`bound-user-rpc.mjs`) trả `state_changed` (xem trước lại). Web chạy tiếp ngay khi Hermes lùi.
  - Sau khoá mới gọi `authorize_tenant_action_v3(current_uid, org, 'thu_tien.collect', toà)` (đúng lời kiểm của v5); toà guard cho mà v5 không cho ⇒ `not_allowed` ngay ở bản xem trước.
  - Người không qua guard không giữ dòng hoá đơn nào. Người qua guard mà v5 không cho chỉ giữ khoá tới khi giao dịch kết thúc (trả `not_allowed`).
  - Kế hoạch đọc SAU khi giữ khoá, nên `p_expected_paid_amount` không thể lệch trong cùng giao dịch.
- **Khoá công ty giữ suốt lượt.** Guard giữ dòng công ty tới hết giao dịch, kể cả lượt xem trước (chạy thử v5). Đo trên TEST: một phòng 0,4–0,5 s (lần đầu 2,4 s), lô 9 phòng ≈ 2,1 s. Trong lúc đó các thao tác web cùng công ty có lấy khoá công ty (thu tiền, duyệt…) phải chờ. Đây là hành vi chung của khung thao tác Hermes; v5 của web cũng giữ khoá này suốt lần ghi.
- **SEQUENCE nhảy mỗi lượt xem trước.** Chạy thử v5 làm hai SEQUENCE id nhật ký nội bộ nhảy (+10, +3) mỗi lần xem trước, vì SEQUENCE không lùi theo giao dịch. Đây là id nhật ký, không phải mã phiếu người dùng thấy; đã chấp nhận như ở Thu chi.
- Cùng `requestId` ở hai kết nối: lượt hai chờ ở khoá công ty của guard, rồi kiểm phát lại thấy biên nhận đã commit ⇒ trả đúng kết quả lượt đầu, không tính lại kế hoạch (PG17).
- Cảnh báo xem trước: mã chưa có câu thì bỏ qua (`jsonb || NULL` từng làm mất cả mảng), chỉ giữ chuỗi, ≤ 10.
- Migration Mốc 3 chỉ thêm dòng chính sách `invoice.collect`. Năm thao tác còn lại thêm dòng ở mốc của chúng: mỗi mốc là migration mới vì file đã áp không được sửa.
- Hàm kế hoạch tách làm hai:
  - lõi THUẦN `invoice_collection_plan_core_v1`: vector parity chạy trên chính nó;
  - `invoice_collection_plan_v1`: đọc dữ kiện, chấp nhận vai gọi `authenticated` và chủ hàm `postgres`. Bước ghi DEFINER gọi lại sau khi tự đối chiếu id; `auth.uid()` vẫn là người hỏi.

**Trùng lặp.** (1) biên nhận Hermes theo requestId; (2) khoá idempotency v5 + băm nội dung (lớp thứ hai); (3) `p_expected_paid_amount` = số đã thu đọc dưới khoá dòng hoá đơn (lệch ⇒ v5 PT409, bước ghi ném lại nguyên mã, connector trả `context_changed`; trong cùng giao dịch không xảy ra), người khác vừa thu giữa hai lượt ⇒ `basis` lệch ⇒ `state_changed`; (4) cảnh báo `possible_duplicate` của kế hoạch: đã có lần thu ACTIVE cùng hoá đơn, cùng số tiền trong 30 phút (luật `duplicateCollection.ts`), bản xem trước nêu giờ và người thu.

**Kết quả.** "Đã ghi thu 3.650.000đ bằng chuyển khoản cho hoá đơn INV-2026-01234 (44TL/201, kỳ 10/2026). Hết nợ — ĐÃ THANH TOÁN ĐỦ." + `applied`, `credit`, `rounding`, `remainingAfter`, `statusAfter`, `link`. Lượt 8: làm tròn ⇒ "ĐÃ THANH TOÁN nhờ làm tròn: 5.000đ số lẻ không thu, ghi vào sổ «Làm tròn tiền thiếu»; cột còn nợ của hoá đơn vẫn hiện 5.000đ."; thu một phần ⇒ "Còn nợ X."; giữ dư ⇒ thêm "Dư X giữ lại cho kỳ sau (tiền dư của khách)."; trả dư ⇒ "Phần dư X KHÔNG ghi vào CRM; anh/chị tự chuyển trả khách."

**Lượt 8 (24/10, sửa theo nghiệm thu bot trên TEST; migration `20261024041712_hermes_invoice_collect_v2`).** Tầng thu tiền v2 = bản chép NGUYÊN v1 (md5 ghim), vỏ chuyển `invoice.collect` sang v2:
- hoá đơn thanh lý (`kind = 'SETTLEMENT'`, HĐ đã kết thúc, khách cũ) KHÔNG bị loại theo thiết kế — tầng 2 trên TEST xem trước được với người giữ sổ nhận. Lý do bot "chỉ sang web" là `receiving_book_missing` cho người không giữ sổ nhận nào của toà (toà đã cài sổ) ⇒ nay `receiving_book_not_held`, câu không nói "cài sổ";
- ứng viên / dòng xem trước / câu đã ghi gọi "hoá đơn thanh lý" như web (trước đây ứng viên ghi chữ `settlement`);
- sổ người dùng nêu không còn trong danh sách ở lượt 2 ⇒ `state_changed` (xem trước lại nói đúng lý do);
- câu làm tròn / "ĐỦ" như trên.

**Lượt 14 (25/10, sửa theo nghiệm thu lượt cuối C3c; migration `20261024181440_hermes_invoice_period_closed_reason_order_v1`).** Tra cứu + bước ghi thu tiền v3 = bản chép NGUYÊN v2 (md5 ghim), vỏ chuyển cả hai tầng sang v3:
- **Ngày thu ở tháng đã chốt lợi nhuận** (toà + tháng của ngày thu có `profit_monthly.locked_at`) ⇒ `rejected period_closed` kèm `facts.month` (YYYY-MM) NGAY sau kiểm phạm vi — trước sổ nhận, khoá hoá đơn và kế hoạch. Trước đây kế hoạch trả `debt_carried` ("nợ đã cộng sang hoá đơn kỳ sau, hỏi lại kỳ"), bot hỏi tháng rồi kẹt. Cùng hàm với web: hàm thu web ghi phiếu thu ngày = ngày thu và trigger `income_expenses_check_profit_lock` → `assert_profit_month_open_v2` → `app_private.profit_month_locked_v1(toà, ngày phiếu)`. Máy chủ không tự đổi ngày.
- **Sổ nhận người dùng nêu (GHI SAI của nghiệm thu: "ck vào HKD Tâm" ⇒ bot để "Tâm" ở `note`, máy chủ ghi TK vào sổ mặc định MBHIEP; đúng là TT vào HKDTAM).** `cashbookName` (tên phụ `cashbook`, như `expense.create`) tìm trong CẢ hai danh sách sổ nhận TK và TT của toà — mỗi danh sách là ô sổ của form web theo hình thức (luật `so_nhan_tien`: TK/TT = sổ mặc định của toà ∪ sổ phụ) — so tên bỏ dấu / hoa thường, rồi bỏ khoảng trắng + dấu câu ("HKD Tâm" = HKDTAM), rồi chứa. Đúng một sổ ⇒ dùng sổ đó; sổ chỉ thuộc MỘT hình thức ⇒ ghi theo hình thức của sổ (`resolved.methodFromBook`), thuộc cả hai ⇒ giữ hình thức người dùng nói. Không khớp / nhiều sổ ⇒ `needs_input name_unresolved field=cashbook`, ứng viên kèm hình thức ("HKDTAM — thanh toán (TT)") — KHÔNG rơi về sổ mặc định.
- **Bản xem trước mở đầu bằng sổ nhận:** "Sổ nhận: «HKDTAM» — thanh toán (TT/POS), theo sổ người dùng nêu (sổ này nhận thanh toán (TT/POS), không nhận chuyển khoản ở toà này). Sẽ ghi THU 350.000đ ngày … cho hoá đơn …" / "… — chuyển khoản, sổ mặc định của toà (người dùng chưa nêu sổ)." + trường `receivingBook`, `method`. Chưa nêu sổ mà toà còn sổ nhận khác ⇒ cảnh báo ĐẦU: "Chưa nêu sổ nhận nên dùng sổ mặc định «MBHIEP» (TK). Toà còn sổ nhận «HKDTAM» (TT). Người dùng đã nói sổ/tài khoản nhận khác thì gọi lại kèm cashbookName …, KHÔNG xác nhận bản này." + "Ghi chú «Tâm» giống tên sổ «HKDTAM»." khi ghi chú trùng (≥ 3 ký tự) một phần tên sổ khác. Không đoán, không đổi sổ theo ghi chú.
- **Toà không nêu** (`buildingName` tuỳ chọn ở connector): một phòng ⇒ phòng duy nhất trong phạm vi được ghi quyết định toà (hàm giải tên dùng chung đã làm được; connector trước đây bắt buộc toà); không thấy phòng, hoặc lô không có toà ⇒ `needs_input name_unresolved field=building why=unspecified` (hỏi toà).
- **Thu hoá đơn thanh lý (quyết toán) của khách cũ — vẫn KHÔNG bị loại theo thiết kế** (tầng 2 lượt 14 trên TEST: người giữ sổ nhận TK của toà xem trước được hai hoá đơn thanh lý OVERDUE, có số hoá đơn hay chỉ kỳ). Máy chủ chỉ từ chối khi: tiền mặt (`cash_collection_web_only`, luật Q13 cho mọi hoá đơn), người hỏi không giữ / biết sổ nhận nào của toà (`receiving_book_not_held`), hoặc các lý do chung của hoá đơn tháng. "Đẩy sang web" cho hoá đơn thanh lý mà không có một trong các mã đó là việc của SOUL.

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

**Đã làm ở Mốc 4 (23/10), khác thiết kế ở các điểm sau (có lý do):**
- **Chỉ số đầu: hai số, không phải một.**
  - CHECK `current ≥ previous` so với số đầu của TRIGGER `auto_populate_previous_reading`: dòng chưa xoá mới nhất (mọi trạng thái), không có thì `meters.initial_reading`, không có nữa thì 0. Kế hoạch chép đúng luật này; `$requires$` ghim md5 thân trigger.
  - Hoá đơn tháng (`excelInvoiceRows`, `GenerateInvoiceDialog`) lại lấy số đầu từ dòng `APPROVED` mới nhất và KHÔNG đọc `initial_reading`.
  - Khi hai số lệch, kế hoạch cảnh báo: `no_approved_start` (công tơ chưa có chỉ số đã duyệt ⇒ hoá đơn tính từ 0) hoặc `start_differs` (dòng mới nhất chưa duyệt). Không có trigger sinh dòng đầu khi tạo công tơ.
- **Khoá tư vấn THEO TOÀ, không theo công tơ.** Hàm ghi chưa biết công tơ trước khi giải dòng. Khoá theo toà tránh phải sắp thứ tự khoá nhiều công tơ, mà vẫn đủ chống trùng (công tơ thuộc một toà). Lượt 2 của Hermes lấy khoá này bằng `pg_try_advisory_xact_lock`: KHÔNG CHỜ, vì guard đã giữ dòng công ty (bài học Mốc 3b); bận ⇒ 55P03 ⇒ `state_changed`.
- **Trùng tháng chỉ tính chỉ số tháng:** bỏ chỉ số chốt trả phòng (`TLY…`) và dòng gắn ranh giới hợp đồng (`boundary_id`). Không thêm unique: production có sẵn 12 cặp (công tơ, tháng) trùng ngoài `TLY`, và chốt trả phòng hợp lệ cùng tháng. Nhiều dòng tháng ⇒ "sửa" cũng không thay (không biết thay dòng nào).
- **Mới: `has_later_reading`** (lý do `meter_has_later_reading`, rejected). Đã có chỉ số ngày SAU ngày chốt ⇒ không ghi, vì trigger lấy số đầu theo `reading_date` mới nhất nên ghi lùi ngày làm lệch chuỗi (án lệ 23/09).
- **"Đã lên hoá đơn" KHÔNG xét `service_id`** (thiết kế cũ đòi trùng). Đo production 23/10 (chỉ đọc, chỉ số tháng 07–09/2026, không TLY):
  - giữ điều kiện `service_id` thì chỉ ~3 % khớp, vì dòng hoá đơn mang `service_id` khác của công tơ (383 dòng còn NULL);
  - bỏ điều kiện thì 663/692 (96 %) khớp số cuối của hoá đơn CÙNG kỳ; 597/692 là số đầu của hoá đơn kỳ SAU (đã chặn bằng `has_later_reading` khi kỳ sau có chỉ số);
  - không phòng nào khớp có hơn một công tơ điện.
- **RPC trang:** file mới thay VỎ SQL-standard để chuyển theo thao tác. `invoice.meter_record` đi tới tra cứu + bước ghi chỉ số mới; thu tiền giữ nguyên thân `075230` (md5 ghim ở `$requires$`).
- **Tham số:** `readings[].value` là số nguyên (công tơ điện; production chỉ có 274 công tơ ĐIỆN đang dùng, nước số lẻ ghi trên web). `meterType` là `dien`/`nuoc`. `meterCode` chỉ cần khi phòng có nhiều công tơ cùng loại. Mã công tơ chỉ hiện trong câu xem trước khi người dùng nêu mã.
- **Form web Ghi chỉ số** (đổi hành vi có chủ ý):
  - gọi `record_meter_readings_v2` qua `src/lib/meterReadingRpc.ts`, mỗi lần một toà và một ngày chốt (đúng cách form đang chọn);
  - tháng đã có chỉ số ⇒ cả lô bị từ chối; form nêu lỗi ở thông báo và ở đúng dòng, không ghi dòng thứ hai;
  - khoá idempotency = `requestKey` của workflow; tải lại trang rồi gửi lại đúng nội dung ⇒ hàm ghi trả kết quả cũ, không ghi lần hai.
  - Nhập Excel (`bulk_create_meter_readings`) và INSERT chỉ số cuối kỳ của luồng lập hoá đơn KHÔNG đổi.

**Lượt 8 (24/10, sửa theo nghiệm thu; migration dùng chung `20261024041049_meter_readings_plan_previous_period_v1`, form web nhận cùng bản sửa).**
- **Vì sao "ghi chỉ số tháng này" gần như luôn bị từ chối.** Lập hoá đơn tháng Excel ghi số cuối kỳ của kỳ M lúc lập hoá đơn (cuối tháng M−1) với `reading_date` = ngày cuối kỳ M (ngày tương lai) ⇒ trigger đặt `settlement_month = M`. Đo production 24/10 (chỉ đọc): 258 chỉ số kỳ 10/2026 tạo 29–30/09 mang ngày 31/10; gần như mọi chỉ số kỳ 08–10 như vậy. Ghi chỉ số đọc hôm nay ⇒ thấy dòng kỳ 10 đó ⇒ `duplicate_month`; "sửa" ⇒ dòng đó đã lên hoá đơn ⇒ `used_by_invoice`; bỏ qua được trùng thì 31/10 > hôm nay ⇒ `has_later_reading`.
- **Chỉ số chốt kỳ trước ghi trước ngày** = tạo (giờ công ty) TRƯỚC ngày chốt mới VÀ `reading_date` SAU ngày chốt mới: không tính vào trùng tháng, không bị thay. Số đầu của dòng mới vẫn theo trigger (= chính chỉ số chốt đó).
- **Không loại dòng mang ngày ≤ ngày chốt, kể cả đã lên hoá đơn** (quy ước `GenerateInvoiceDialog`: `reading_date` = ngày phát hành). Loại thì dòng mới thành "APPROVED mới nhất theo `reading_date`" = số đầu của hoá đơn kỳ sau (cả hai luồng lập hoá đơn) ⇒ phần tiêu thụ trước nó không vào hoá đơn nào. Cùng lý do, ngày chốt = đúng ngày của chỉ số chốt (31/10) vẫn chặn.
- **`has_later_reading` theo ngày đọc thật** `LEAST(reading_date, ngày tạo)`: chỉ chỉ số đọc thật SAU ngày chốt mới chặn; `laterReadingDate` là ngày đọc thật.
- **Chỉ số tháng đã lên hoá đơn ⇒ `used_by_invoice` ngay**, không qua `duplicate_month` ("nói sửa" rồi mới từ chối là câu sai). "Sửa" khi tháng chỉ còn chỉ số chốt đã lên hoá đơn cùng kỳ ⇒ `used_by_invoice`; chưa lên hoá đơn ⇒ ghi dòng mới. Ghi đè chỉ với chỉ số tháng chưa lên hoá đơn (luật cũ).
- **Chưa đổi (đề xuất, ngoài phạm vi):** hai luồng lập hoá đơn không điền sẵn số cuối từ chỉ số đã ghi (người lập gõ lại); bộ lọc "phòng chưa ghi chỉ số" của web lọc theo `settlement_month` nên coi phòng đã có chỉ số chốt kỳ trước là "đã ghi".

### 4.3 Điều chỉnh hoá đơn (`invoice.adjust`, Mốc 5)

- **Dựng dòng sau** bằng `invoice_adjustment_build_v1` (mục 6.3): dòng không đổi đi nguyên như `toAdjustmentItem` của web; `discount` cộng THÊM vào giảm trừ hiện có (HDN5); `addItems` thêm dòng `OTHER`, `accounting_class` mặc định như web (chủ chốt 12/09: không cho người dùng chọn); `setItems.match` khớp **đúng một** dòng theo mô tả đã bỏ dấu.
- **Chặn trước:** dòng khớp có chỉ số hoặc là dòng điện/nước/cọc/`NON_PNL` ⇒ `adjust_meter_line_web_only`; hoá đơn `SETTLEMENT` hoặc nợ cũ nhập tay lệch nguồn (luật `adjustmentReconcileBlocker`) ⇒ `web_only`; `match` khớp 0 hoặc ≥ 2 dòng ⇒ `needs_input name_unresolved` `field:'invoice'`, ứng viên là mô tả dòng.
- **Chạy thử** `adjust_invoice_v2(…, p_expected_revision, p_expected_paid_amount, p_expected_updated_at, 'hermes-dry:'||rid)`: tổng sau do chính hàm ghi tính (làm tròn nghìn), lỗi của hàm ghi ra lý do ngay ở lượt 1.
- **Xem trước:** bảng dòng trước/sau (chỉ dòng đổi), tạm tính, giảm trừ, tổng trước → sau, đã thu, trạng thái sau, lý do; câu "điều chỉnh sẽ chờ người có quyền xác nhận kiểm tra".
- **Trùng lặp:** biên nhận + khoá `hermes-adj:` (cùng khoá cùng vân tay ⇒ hàm ghi trả lại bản cũ) + ba giá trị kỳ vọng (PT409 ⇒ `state_changed`).

**Đã làm ở Mốc 5, khác thiết kế ở các điểm sau:**
- `invoice_adjustment_build_v1` nhận thao tác THEO ID dòng: `{discountAdd, addItems[{description, amount}], setItems[{id, amount}]}`.
  - Khớp `setItems.match` theo mô tả đã bỏ dấu nằm ở tầng tra cứu Hermes, vì file hàm dùng chung không được chứa hàm trợ lý. Nhờ vậy web gọi được cùng hàm.
- **Form Điều chỉnh của web chuyển sang hàm này**: dòng giữ nguyên và câu chặn (thanh lý, nợ cũ lệch nguồn) lấy từ máy chủ; `toAdjustmentItem` / `adjustmentReconcileBlocker` ở trình duyệt đã gỡ.
  - Web phát hành SAU khi áp `20261023042242`; trước đó form báo "Chưa tải được dữ liệu điều chỉnh" và không cho lưu.
- Dòng khoá theo đúng luật nhận diện của web (`decomposeInvoice`): có chỉ số; SERVICE có chữ "điện"/"nước" (kể cả chữ hoa); cọc (`DEPOSIT`); `NON_PNL`; dòng `DISCOUNT`.
- `invoiceNumber` (tuỳ chọn) có ở cả bốn thao tác như thu tiền Mốc 3b, để chọn đích danh khi một kỳ có hai hoá đơn.
- Lỗi PT409 `REVENUE_CAP_REVIEW` / `Support discount changes…` (hoá đơn có hỗ trợ tiền phòng) ⇒ `web_only`, không ném lại như PT409 "vừa đổi".

**Lượt 14 (25/10, nghiệm thu C3c: giảm 300k hoá đơn 44TL/201 tháng 10 đã thu đủ 7.300.000; bot hỏi lý do TRƯỚC nên không bao giờ thấy chặn).** Bước ghi sửa/huỷ/khôi phục v2 (`20261024181440`) = bản chép NGUYÊN v1 (md5 ghim), chỉ đổi thứ tự:
- `reason` TUỲ CHỌN ở khuôn của `invoice.adjust` / `invoice.cancel` / `invoice.restore` (có thì vẫn 8–1000 / 8–500). Bản xem trước chạy mọi kiểm cứng và chạy thử hàm ghi web TRƯỚC; chỉ khi qua hết mới trả `reason_required` (dạng needs_input). Điều chỉnh chưa có lý do chạy thử `adjust_invoice_v2` với lý do tạm (hàm ghi đòi 3–1000 ký tự; khối con lùi, không để lại gì).
- Tổng mới < đã thu ⇒ `rejected adjust_below_collected` kèm `facts {collected, totalAfter}` (chuỗi chữ số VND; tổng sau làm tròn bằng `round_invoice_total_v1` như hàm ghi) ⇒ câu tới mô hình: "Tổng mới thấp hơn số đã thu; đảo lần thu … Đã thu 7.300.000đ; tổng sau điều chỉnh 7.000.000đ." (tầng 2 trên TEST, đúng ca nghiệm thu).
- Lượt 2 (cùng params với bản xem trước, connector khoá) vẫn kiểm lý do ngay đầu.

### 4.4 Xác nhận "đã kiểm tra" điều chỉnh (`invoice.adjustment_check`, Mốc 5, Q19 = a)

- Tra cứu: hoá đơn có `adjustment_review_status='PENDING'` và điều chỉnh có `revision = invoices.adjustment_revision` (hàm ghi chỉ cho kiểm phiên bản hiện hành).
- Xem trước: "Điều chỉnh lần 2 của hoá đơn INV-… (44TL/201, kỳ 10/2026) do «tên» làm lúc 15:20 thứ Hai 20/10/2026: tổng 3.650.000đ → 3.550.000đ (−100.000đ); lý do '…'; dòng đổi: …; đã thu 0đ." Tên người điều chỉnh dưới RLS `profiles`.
- **Điều chỉnh do chính người hỏi làm ⇒ từ chối** `adjustment_self_check_web_only` (HDN6 đã chốt: Q19 nói "do người khác làm"; tự kiểm làm mất ý nghĩa kiểm chéo). Web không cấm, nên câu chỉ đường web.
- Không có điều chỉnh chờ ⇒ `needs_input nothing_to_check`. Phiên bản đổi giữa hai lượt ⇒ PT409 ⇒ `state_changed`.
- Lô "kiểm hết": không làm; danh sách chờ đọc bằng báo cáo `invoice_adjustments` (mục 7), kiểm từng cái (HDN6).

### 4.5 Huỷ / khôi phục hoá đơn (`invoice.cancel`, `invoice.restore`, Mốc 5)

- **Huỷ:** chỉ `DRAFT/APPROVED` và `paid_amount = 0` (luật hàm ghi). `OVERDUE` ⇒ `cancel_overdue_web_only`; đã thu ⇒ `cancel_has_payment`; đã huỷ ⇒ kết quả "đã huỷ trước đó, không đổi".
- **Khôi phục:** chỉ `CANCELLED`; đã có hoá đơn MONTHLY khác cùng HĐ, cùng kỳ còn hiệu lực ⇒ `restore_conflict`.
- **Lý do bắt buộc** (8–500). Hàm ghi không có tham số lý do: lý do nằm trong biên nhận Hermes (`input.params.reason`) và audit `HERMES_ACTION_APPLIED`; không ghi đè `invoices.notes` (HDN8).
- **Xem trước:** số hoá đơn, kỳ, tổng, credit đã cấn sẽ hoàn về khách, và — từ #267 — hoá đơn này đang gánh nợ cũ (`carried_in_amount > 0`): "huỷ thì nợ 1.200.000đ của kỳ 09/2026 tính lại ở hoá đơn kỳ 9".

**Đã làm ở Mốc 5:**
- Nợ cũ đang gánh đọc từ `previous_debt_sources` (nguồn `invoice`), không gọi lại #267.
- "Đã huỷ trước đó" (huỷ) và "đang hiệu lực" (khôi phục) không trả được dạng `applied` ở lượt xem trước (runtime chỉ nhận `applied` ở lượt 2). Hai mã mới thay thế: `invoice_already_cancelled`, `invoice_not_cancelled` (mục 5).
- Khôi phục kiểm trùng kỳ trước khi chạy thử: cùng HĐ, cùng kỳ, MONTHLY chưa huỷ; chỉ mục duy nhất `idx_invoices_unique_contract_billing` cũng ra `restore_conflict`.
- **Thứ tự khoá đo được:**
  - Hoá đơn KHÔNG gắn hợp đồng: `invoice_rent_support_lock_v1` bỏ qua khoá công ty, nên hàm huỷ/điều chỉnh web chỉ giữ dòng hoá đơn ⇒ Hermes nhận 55P03 ngay.
  - Hoá đơn có hợp đồng: web giữ công ty trước ⇒ Hermes chờ ở guard rồi `state_changed`.

### 4.6 Soạn tin nhắc nợ / gửi hoá đơn (Q18 = a; đọc, không phải thao tác)

Báo cáo W2 `invoice_reminders` (mục 7) trả **mỗi phòng một dòng** còn nợ thực: tổng nợ gộp sẵn, `details` từng tháng (còn nợ, hạn, đã quá mấy ngày), `publicPath` (`/c/<public_code>` của HĐ đang hiệu lực, trang công khai luôn hiện hoá đơn MỚI NHẤT của HĐ) và `messageText` do SQL dựng ("Chào anh/chị, phòng 201 toà 44TL hiện còn 3.650.000đ chưa thanh toán: tháng 10/2026: 3.650.000đ (hạn 10/10/2026, đã quá 12 ngày). Chi tiết hoá đơn xem ở link kèm theo. …"). Bot chép nguyên văn cho người dùng tự gửi; không có đường tự gửi.

- `public_code` hiện cố ý không ra khỏi các hàm đọc Hermes (`20261018000000`): Q18 = a là lý do có chủ ý để mở, chỉ cho HĐ `ACTIVE`, chỉ ở báo cáo này.
- Domain web: SQL không biết domain; dùng chung **một** cơ chế với `publicLink` của Hợp đồng (D-HĐ9, cấu hình host `publicWebOrigin`) — HDN9.
- **Lượt 12 (24/10, kiểm khói C3 trên TEST: bot trả `publicPath` rồi bảo người dùng tự thay tên miền):** bước cuối của đường đọc miền (`domain-mount` `finishDomainResult`, `public-link.mjs` `withReportPublicLinks`) đổi mỗi dòng `publicPath` ⇒ `publicLink` tuyệt đối = origin host + `/c/<mã>` (khuôn `/c/` + 6–8 chữ/số, origin https), cùng chỗ trong dòng; mô hình không thấy `publicPath`.
  - Tin một khối: có link ⇒ link xuống dòng ở **cuối** `messageText` (sau câu "Chi tiết hoá đơn xem ở link kèm theo."). Web không có màn soạn nhắc nợ; mẫu gần nhất là hộp QR của HĐ (`ContractQRDialog`) chép riêng link `origin + /c/<mã>` — bot làm đúng link đó, nhưng ghép vào cuối tin để người dùng chép một lần.
  - Không ghép được (host chưa khai origin / đường sai khuôn) ⇒ `publicLink` null, bỏ câu hứa link khỏi tin, `summary.withLink` = 0 khi vắng origin. Không migration.

## 5. Lý do riêng trang (thêm vào danh sách đóng)

Khối "Hoá đơn" riêng trong `action-reasons.mjs`; mã dạng `rejected` vào thêm `REASONS` của `infra/hermes-runtime/host-ownership.mjs` cùng commit (test `audit-codes` khoá hai tập bằng nhau). Ánh xạ SQL đặt ở `app_private.hermes_invoice_reason_v1(sqlstate, message, constraint)`: câu riêng trang trước, rồi `hermes_action_reason_v1` của M1.

| Mã | Dạng | Câu tĩnh (tóm tắt) | Nguồn |
| --- | --- | --- | --- |
| `cash_collection_web_only` | rejected | Tiền mặt ghi trên web, trang Thu tiền (`/thu-tien`); bot chỉ ghi chuyển khoản / thanh toán (TT/POS) | `method=TM` (Q13) |
| `nothing_to_collect` | needs_input | Hoá đơn không còn số phải thu; hỏi lại phòng/kỳ | `PAID`, `55000 Hóa đơn không còn số tiền có thể thu` |
| `debt_carried` | needs_input | Nợ kỳ này đã cộng vào hoá đơn kỳ sau; thu ở hoá đơn kỳ sau | #267 `carried_out_amount > 0` |
| `overpay_needs_choice` | needs_input | Khách trả dư; hỏi giữ lại (`overpay=keep`) hay trả lại (`overpay=return`) | lượt 2 thiếu `overpay`; `22023 Số thu vượt còn phải thu` |
| `invoice_not_collectible` | rejected | Hoá đơn nháp/đã huỷ, không thu được | `55000 Trạng thái hóa đơn không cho phép thu tiền` |
| `credit_requires_contract` | rejected | Hoá đơn không gắn HĐ nên không giữ phần dư được; chọn trả lại | `22023 Không thể giữ credit…` |
| `receiving_book_missing` | rejected | Toà chưa cài sổ nhận cho hình thức này (TK/POS); nhờ chủ cài ở Sổ nhận tiền trên web | kế hoạch (toà chưa cài sổ); `42501 Toà % chưa cài sổ nhận tiền`, `Sổ "%" không nằm trong danh sách…` |
| `receiving_book_not_held` | rejected | Anh/chị chưa được giao (giữ/biết) sổ nhận TK/POS nào của toà; nhờ chủ giao sổ hoặc để người giữ sổ ghi (lượt 8, mới) | kế hoạch chặn sổ nhận mà toà đã cài sổ |
| `reconciliation_required` | rejected | Hoá đơn có cơ cấu/bút toán chưa đối soát; nhờ kế toán kiểm trên web | các câu 55000 "đối soát", "semantic", "phân bổ" của v5 và `adjust_invoice_v2` |
| `meter_not_found` | needs_input | Phòng không có công tơ đang dùng loại này; hỏi lại phòng/loại | kế hoạch chỉ số |
| `meter_ambiguous` | needs_input | Phòng có nhiều công tơ cùng loại; hỏi mã công tơ | kế hoạch chỉ số |
| `meter_duplicate_month` | needs_input | Tháng này đã có chỉ số (chưa lên hoá đơn); người dùng nói "sửa" mới thay | kế hoạch chỉ số (Q16; lượt 8: không tính chỉ số chốt kỳ trước ghi trước ngày) |
| `meter_lower_than_previous` | needs_input | Chỉ số mới nhỏ hơn số đầu; hỏi lại số | 23514 `meter_readings_current_gte_previous` |
| `meter_used_by_invoice` | rejected | Chỉ số đã lên hoá đơn; sửa bằng điều chỉnh hoá đơn trên web | kế hoạch chỉ số |
| `meter_has_later_reading` | rejected | Công tơ đã có chỉ số ngày sau ngày chốt; sửa chuỗi chỉ số trên web (Mốc 4, mới) | kế hoạch chỉ số |
| `adjust_meter_line_web_only` | rejected | Dòng điện/nước có chỉ số, cọc hay khoản nội bộ sửa trên web | dựng dòng |
| `adjust_has_rounding_or_credit` | rejected | Hoá đơn có làm tròn/cấn trừ đang hiệu lực; đảo giao dịch trên web trước | `55000 Hóa đơn có làm tròn hoặc cấn trừ…` |
| `adjust_debt_carried` | rejected | Nợ đã chuyển sang hoá đơn sau; xử lý hoá đơn sau trên web trước | `55000 Nợ đã chuyển sang hóa đơn sau…` |
| `adjust_below_collected` | rejected | Tổng mới thấp hơn số đã thu; đảo lần thu trên web trước | `55000 Nội dung mới thấp hơn tiền đã phân bổ…`, `Thành phần % thấp hơn…` |
| `adjust_no_change` | needs_input | Điều chỉnh không đổi gì; hỏi lại nội dung | `22023 Không có thay đổi nội dung hóa đơn` |
| `nothing_to_check` | needs_input | Hoá đơn không có điều chỉnh chờ kiểm tra | tra cứu |
| `adjustment_self_check_web_only` | rejected | Không tự xác nhận kiểm tra điều chỉnh của chính mình qua bot (cần người khác kiểm); làm trên web nếu thật cần | `adjusted_by = auth.uid()` (HDN6) |
| `cancel_has_payment` | rejected | Hoá đơn đã thu tiền nên không huỷ được; đảo lần thu trên web trước | trạng thái; P0001 `Không thể huỷ hoá đơn ở trạng thái này…` |
| `cancel_overdue_web_only` | rejected | Hoá đơn quá hạn huỷ trên web | `status='OVERDUE'` |
| `restore_conflict` | rejected | Kỳ này đã có hoá đơn khác đang hiệu lực; không khôi phục được | tra cứu; 23505 ràng buộc (HĐ, kỳ) |
| `invoice_already_cancelled` | rejected | Hoá đơn này đã huỷ; muốn dùng lại thì khôi phục trước (Mốc 5, mới) | tra cứu; `noop` của hàm huỷ |
| `invoice_not_cancelled` | rejected | Hoá đơn đang hiệu lực, không có gì để khôi phục (Mốc 5, mới) | tra cứu; `noop` / `55000 Only cancelled invoices…` |

Dùng lại mã chung: `period_locked` (`[PROFIT_LOCKED]`, `[CASHBOOK_CLOSED]`, `[HANDOVER_LOCKED]`), `cashbook_not_held` (`Bạn không được giao sổ quỹ này…`), `not_allowed` (42501 còn lại), `state_changed` (PT409 `Số đã thu vừa thay đổi…`, `Hóa đơn vừa thay đổi…`, `Hóa đơn đã có phiên bản mới…`), `date_out_of_range`, `reason_required`, `web_only` (rào hỗ trợ tiền phòng `REVENUE_CAP_REVIEW`, `SETTLEMENT`, writer đóng băng 55000), `duplicate_request` (chỉ đúng ràng buộc idempotency). 23505 "idempotency_key đã dùng với nội dung khác" của hàm ghi web **không** là `duplicate_request` (khoá do requestId cấp, trùng nghĩa là lệch đầu vào) ⇒ `crm_refused`. Tổng: 23 mã mới, 14 dạng `rejected`. Mã vào file chung theo mốc của thao tác dùng chúng (Mốc 2 chỉ đọc nên chưa thêm mã nào). Mốc 3 đã thêm 8 mã của thu tiền:
- dạng `rejected` (cũng vào `host-ownership.mjs`): `cash_collection_web_only`, `invoice_not_collectible`, `credit_requires_contract`, `receiving_book_missing`, `reconciliation_required`;
- dạng `needs_input`: `nothing_to_collect`, `debt_carried`, `overpay_needs_choice`.

Mốc 4 thêm 6 mã của ghi chỉ số:
- dạng `needs_input`: `meter_not_found`, `meter_ambiguous`, `meter_duplicate_month`, `meter_lower_than_previous`;
- dạng `rejected` (cũng vào `host-ownership.mjs`): `meter_used_by_invoice`, `meter_has_later_reading`.

Mốc 5 thêm 12 mã (10 của bảng trên + hai mã mới cho trạng thái "đã huỷ" / "chưa huỷ"):
- dạng `needs_input`: `adjust_no_change`, `nothing_to_check`;
- dạng `rejected` (cũng vào `host-ownership.mjs`): `adjust_meter_line_web_only`, `adjust_has_rounding_or_credit`, `adjust_debt_carried`, `adjust_below_collected`, `adjustment_self_check_web_only`, `cancel_has_payment`, `cancel_overdue_web_only`, `restore_conflict`, `invoice_already_cancelled`, `invoice_not_cancelled`.

Ánh xạ câu lỗi của bốn hàm ghi web nằm ở `app_private.hermes_invoice_edit_reason_v1`, rơi về `hermes_invoice_reason_v1` của Mốc 3.

Lượt 8 thêm 1 mã dạng `rejected` (cũng vào `host-ownership.mjs`): `receiving_book_not_held`. Connector phải biết mã TRƯỚC khi áp migration thu tiền v2 (mã lạ ⇒ `crm_refused`).

Lượt 14 thêm 1 mã dạng `rejected` (cũng vào `host-ownership.mjs`): `period_closed` — "Ngày thu thuộc tháng toà đã chốt lợi nhuận: không ghi thu với ngày đó, không tự đổi ngày; báo người dùng (chủ mở khoá tháng ở tab Chốt LN, hoặc nói ngày khác)." + "Tháng đã chốt: MM/YYYY." Và **dữ kiện kèm lý do** (`facts`, connector `actionFacts`): danh sách đóng theo mã, mỗi trường một khuôn — `period_closed {month: YYYY-MM}`, `adjust_below_collected {collected, totalAfter?}` (chuỗi chữ số VND) — ghép thành câu sau câu tĩnh ("Đã thu 7.300.000đ; tổng sau điều chỉnh 7.000.000đ."); dữ kiện lệch khuôn hay gắn vào mã không khai ⇒ khuôn lệch (`backend_unavailable`), MCP chỉ chuyển câu khi khớp đúng dữ kiện. Connector cũ gặp `facts` ⇒ `backend_unavailable`, nên connector lượt 14 lên TRƯỚC migration.

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

**Đã làm ở Mốc 2** (`20261022051118` hàm dùng chung, `20261022051620` hàm đọc + bảng báo cáo; khai báo ở `HB/wave2-a-contract.mjs`). Ghi chú đo nền lượt 2 (phiên chính, 22/10): mô hình tự cộng các dòng hoá đơn của một phòng và lệch 1.000đ, và đếm hoá đơn thay vì phòng ⇒ mọi báo cáo nợ trả **sẵn tổng theo phòng và số phòng phân biệt**.

| Câu đo nền | Báo cáo | Khoá | Tham số | Hàng / summary | Hàm dùng chung |
| --- | --- | --- | --- | --- | --- |
| (a) chi tiết khoản một hoá đơn theo phòng + kỳ (TC-I03); (b) hạn đóng một hoá đơn (TC-I10) | `invoice_room_detail` | `invoices.view` | `roomId*` (hoặc `roomName`), `month` (mặc định tháng này) | hàng = từng khoản (dòng có chỉ số kèm `consumption` = cuối − đầu; số cuối nhỏ hơn số đầu, vd thay đồng hồ, ⇒ `null`, không trả số âm) + lần thu (hình thức, ngày, REVERSED); summary = đầu hoá đơn + `dueDate`, `paidDate`, `isOverdue`, `overdueDays`, `effectiveOutstanding`, `otherInvoices` | `invoice_room_invoices_v1` + `invoice_detail_v1` sẵn có |
| (b) ai hay trả trễ (TC-I05) | `invoice_lateness` | `invoices.view` | `buildingId`, `roomId`, `fromDate`/`toDate` theo HẠN (mặc định 90 ngày qua; SQL kẹp ≤ 366 ngày tính lùi từ `toDate`) | mỗi hoá đơn: hạn, ngày trả đủ (lần thu làm số đã thu đạt tổng), số ngày trễ (còn nợ = trễ tới hôm nay); summary gộp sẵn `topLateRooms` (số lần trễ, trung bình ngày) | `invoice_lateness_v1` |
| (c) thu tháng này tách CK/TM/TT (TC-I06) | `collection_by_method` | `thu_tien.view` | `month` hoặc `fromDate`/`toDate` (NGÀY THU), `buildingId` | theo (toà, hình thức): số lần, số hoá đơn, số tiền; summary `tm`/`tk`/`tt`/`ct`/`total`. Lượt 14: số = tiền **giữ lại** (`active_payment_receipts.collected_amount` = áp vào hoá đơn + tiền dư khách để lại, trừ tiền thối) theo ngày thu — cùng nguồn thẻ "Đã thu"/TM/TK/TT/Cấn trừ của trang Hoá đơn (thẻ đó lọc theo kỳ hoá đơn); cấn trừ CT có số giữ lại 0 nên không cộng vào tổng | `invoice_collection_by_method_v1` |
| (d) điều chỉnh chờ kiểm + lịch sử (TC-I07) | `invoice_adjustments` | `invoices.view` | `buildingId`, `roomId`, `status` (PENDING/CHECKED), `fromDate`/`toDate` theo ngày điều chỉnh (mặc định và trần 366 ngày; summary nêu `fromDate`/`toDate` thật đã dùng); bỏ hoá đơn đã huỷ | tổng trước/sau, chênh, lý do (chỉ khi mọi khách của HĐ nhìn thấy, như ghi chú hoá đơn), người/ngày/giờ điều chỉnh, người/ngày kiểm, `current`; summary `pendingCount` = chờ kiểm thật (phiên bản hiện hành) | `invoice_adjustments_list_v1` |
| (e) phòng có HĐ hiệu lực chưa có hoá đơn kỳ M (TC-I08) | `invoice_missing` | `invoices.view` | `month*`, `buildingId` | phòng, số HĐ, khách (đại diện, RLS ẩn thì khách đầu), ngày bắt đầu/kết thúc; summary số phòng + `byBuilding` | `invoice_missing_v1` |
| (f) "nợ quá hạn" (TC-I09) + công nợ theo phòng | `invoice_room_debts` (tên mới, thay `invoice_overdue_rooms` của Mốc 1) | `invoices.view` | `buildingId`, `roomId`, `days` (chỉ hoá đơn quá hạn ≥ N ngày; "hơn 1 tháng" ⇒ 31) | mỗi PHÒNG: tổng nợ thực, số hoá đơn, quá hạn, hạn cũ nhất, các tháng; summary `rooms` = số phòng. Có `days` ⇒ **mọi số (hàng và summary) chỉ cộng các hoá đơn quá hạn ≥ N ngày**, không cộng hoá đơn mới hơn của cùng phòng (Mốc 2b, review độc lập) | `invoice_open_debts_v1` |
| Q18 soạn tin nhắc nợ | `invoice_reminders` | `invoices.view` | `buildingId`, `roomId`, `days` (lọc PHÒNG có hoá đơn quá hạn ≥ N ngày) | mỗi phòng: `messageText` soạn sẵn (không tên khách) = **toàn bộ** nợ của phòng (tin gửi khách phải đủ), tối đa 8 dòng chi tiết rồi "và N hoá đơn khác" (không cắt giữa câu), `details`, tổng nợ thực, `publicPath` (chỉ khi người hỏi được **xem khách** ở toà đó; connector đổi thành `publicLink`, lượt 12) | `invoice_open_debts_v1` |

- Quá hạn tính theo `is_overdue` (hạn < hôm nay giờ tổ chức, chưa thu đủ), không theo `status='OVERDUE'` (chỉ được đánh dấu khi có người mở trang Hoá đơn). Nợ = `effective_outstanding` (#267) trên tập hoá đơn mở của phạm vi, như công nợ.
- Sáu hàm dùng chung: INVOKER, STABLE, `search_path=''`, chỉ `authenticated`, tự kiểm khoá web theo toà (`invoices.view`; `thu_tien.view` cho thu theo hình thức), lọc công ty tường minh; file không chứa hàm của trợ lý. Web dùng được về sau (vd màn "điều chỉnh chờ kiểm", plan §8.7).
- `app_private.hermes_w2a_read_v1` và `hermes_w2a_catalog_v1` dựng lại **từ thân đang chạy** (bài học #267) bằng script sinh (chép nguyên thân + chèn nhánh): md5 `prosrc` production = TEST = repo (đo 22/10), ghim ở `$requires$`; nhận thêm thân trước đó `d7fea7ee…` (chuỗi của fixture PGlite gói A, không có `20261019040948`) vì thân mới là siêu tập của nó. Ghim băm ở forward fixture chuyển nguồn sang file mới; thân của `20261019040948` thành bản "superseded".
- Phòng chưa có hoá đơn (`invoice_missing`): không xét `payment_cycle` của hợp đồng — bộ lập hoá đơn web cũng không dùng trường này, và TEST đo 22/10 mọi HĐ hiệu lực đều `MONTHLY`. Khi web lập hoá đơn theo chu kỳ khác tháng thì báo cáo phải theo.
- `$requires$` của `20261022051620` dừng (fail-closed) nếu thiếu bất kỳ hàm web nào mà sáu hàm dùng chung gọi lúc chạy: `invoice_effective_outstanding_v1(uuid[])` (#267), `is_overdue(invoices)`, `can_do_on_building(text,text,uuid)`, `org_today_v1(uuid)`; file `20261022051118` không có `$requires$` (tạo hàm `plpgsql` không cần hàm phụ có sẵn; khối đọc mới là nơi chặn).
- Đường dẫn công khai: SQL trả `publicPath` = `/c/<mã>` **chỉ khi người hỏi có `customers.view` ở toà đó** (mã cổng khách mở được hồ sơ khách; người chỉ xem hoá đơn không được nhận — kiểm ở cả hàm dùng chung `invoice_open_debts_v1` lẫn khối đọc, Mốc 2b); link tuyệt đối = địa chỉ web + đường dẫn theo cơ chế D-HĐ9 (cấu hình host `publicWebOrigin` của connector, chưa có ở connector). Tới khi có, SOUL dặn bot ghép địa chỉ web CRM.
- Lỗi SOUL của lượt đo nền (TC-J01/J02 coi tiền khách trả là phiếu chi, TC-I01 không tìm ra tool, TC-I09) sửa ở SOUL (mục 12), không cần mã.
- **Lượt 14 — soát hai báo cáo lệch truth của bộ chấm (TEST, tháng 10/2026, toàn công ty):**
  - (c) `collection_by_method` LỆCH web ⇒ đã sửa (`20261024185815_hermes_w2a_invoice_collection_retained_v1` thay thân hàm dùng chung, dải gói A, production = TEST = `7a752b9f…`). Trước: cộng `payments.amount` (chỉ phần áp vào hoá đơn) và cộng cả cấn trừ ⇒ tổng 1.300.779.779 = TK 716.666.000 + TM 439.256.000 + TT 126.266.000 + CT 18.591.779. Sau: số giữ lại như thẻ trang Hoá đơn ⇒ TK 716.666.000, TM 444.941.000 (gồm 5.685.000 tiền dư khách để lại), TT 126.266.000, CT 0, tổng 1.287.873.000 = đúng truth. Trang Thu tiền (`/thu-tien`) không có tổng theo hình thức (lọc theo kỳ hoá đơn, cộng `payments.amount` khi chọn bộ lọc) nên không là đích so.
  - (d) `invoice_adjustments` KHỚP web ⇒ truth đúng, không sửa: 21 điều chỉnh chờ kiểm (phiên bản hiện hành PENDING, bỏ hoá đơn huỷ), cũ nhất 12/09/2026 — bằng số web đếm (`invoice_list_v1`, hoá đơn `adjustment_review_status='PENDING'`, đang hiệu lực, không giới hạn ngày). Chỉ lệch khi có hoá đơn đã huỷ còn PENDING (TEST hiện có 1, cả hai bên đều bỏ).

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
| 2 ✓ | `20261022051118_hermes_w2a_invoice_shared_v1` | 6 hàm đọc dùng chung (mục 7); tên trong dải gói A, nội dung không có hàm trợ lý | #267 (gọi lúc chạy) |
| 2 ✓ | `20261022051620_hermes_w2a_invoice_reads_v1` | catalog + reader gói A dựng từ thân đang chạy (md5 ghim ở `$requires$`), 7 báo cáo | dòng trên |
| 3 ✓ | `20261022075219_invoice_collection_plan_v1` | lõi thuần + hàm kế hoạch thu (file không chứa hàm trợ lý) | #267 |
| 3 ✓ | `20261022075230_hermes_invoice_action_v1` | seed khoá `thu_tien.collect_transfer` TẮT; dòng chính sách `invoice.collect`; ánh xạ lý do; phạm vi, tra cứu, bước ghi, vỏ | M1, M5, #267, Mốc 2 (`invoice_room_invoices_v1`), Thu chi (nhãn tiền/ngày), dòng trên |
| 4 | `20261022183026_meter_readings_v2` | `meter_readings_plan_v1` + `record_meter_readings_v2` (`gen:types` sau khi áp; web gọi qua service có kiểu nên không chờ types) | — |
| 4 | `20261022183445_hermes_invoice_meter_v1` | tra cứu + bước ghi `invoice.meter_record`, THAY vỏ RPC trang (chuyển theo thao tác), dòng chính sách | `075230`, dòng trên |
| 5 | `20261023042242_invoice_adjustment_build_v1` | hàm dựng dòng dùng chung (file không chứa hàm trợ lý); form Điều chỉnh web gọi | — |
| 5 | `20261023042723_hermes_invoice_edit_v1` | lý do, tra cứu, bước ghi `adjust` / `adjustment_check` / `cancel` / `restore`, THAY vỏ RPC trang (thân thu tiền + chỉ số md5 ghim), bốn dòng chính sách | `183445`, dòng trên |
| lượt 8 | `20261024041049_meter_readings_plan_previous_period_v1` | THAY thân `meter_readings_plan_v1` (cùng chữ ký; md5 thân `183026` + hai trigger ghim): chỉ số chốt kỳ trước ghi trước ngày không còn là trùng tháng / ngày sau; đã lên hoá đơn ⇒ `used_by_invoice` ngay (mục 4.2). File không chứa hàm trợ lý. Hàm đã có trên production ⇒ provenance coi là catalog-proven dù CHƯA áp: áp đích danh | `183026` |
| lượt 8 | `20261024041712_hermes_invoice_collect_v2` | tra cứu + bước ghi thu tiền `_v2` (bản chép `075230`, md5 ghim), THAY vỏ RPC trang (thu tiền sang v2, nhánh khác giữ nguyên) | `042723`; connector biết `receiving_book_not_held` |
| lượt 14 | `20261024181440_hermes_invoice_period_closed_reason_order_v1` | tra cứu + bước ghi thu tiền `_v3` (bản chép `041712`, md5 ghim: tháng đã chốt LN ⇒ `period_closed`, sổ nhận ở cả TK + TT, hình thức theo sổ, câu đầu "Sổ nhận", hỏi toà khi không thấy phòng), bước ghi sửa/huỷ/khôi phục `_v2` (bản chép `042723`: lý do đòi sau kiểm cứng, `facts` số đã thu), THAY vỏ RPC trang | `041712`; connector lượt 14 (mã `period_closed`, `facts`, `reason` / `buildingName` tuỳ chọn, tên phụ `cashbook`) |
| lượt 14 | `20261024185815_hermes_w2a_invoice_collection_retained_v1` | THAY thân hàm đọc dùng chung `invoice_collection_by_method_v1` (dải gói A; thân production `7a752b9f…` ghim): số giữ lại `active_payment_receipts.collected_amount` | — (khuôn báo cáo không đổi; áp trước hay sau connector đều được) |
| C07 | `20261026234255_hermes_invoice_collect_commit_checks_v1` | THAY thân bước ghi thu tiền `_v3` (thân `181440` md5 `79e1bc11…` ghim): ép kiểm hoãn (constraint trigger DEFERRED) chạy trong khối con — cuối chạy thử và tập dượt tự lùi sau khi chốt biên nhận | `181440`; không mã mới (connector nào cũng được). Hàm đã có trên production ⇒ provenance catalog-proven giả, áp đích danh |
| 6 | `invoice_month_quote_v1` | nếu P7 được duyệt | — |

**Thứ tự áp (cửa idempotent của CI main chạy từng migration trên trạng thái production):** #267 → M1/M2/M5 (đã áp) → migration Mốc 2 → Mốc 3 → Mốc 4 → Mốc 5; mỗi cái áp TEST rồi production **trước khi gộp** PR. Khoá `thu_tien.collect_transfer` seed TẮT cùng lần promote web có khoá trong `capability-contract.mjs` + nhãn (bài học 19/10). Bật khoá bằng migration riêng sau nghiệm thu. Không migration nào được seed `thu_tien.collect`: khối kiểm của M2 `20261021134531` đòi khoá đó vắng.

**File chung phải đụng** (mỗi file một khối nhỏ gắn nhãn "Hoá đơn"; người gộp sau rebase):

| File | Thay đổi |
| --- | --- |
| `HB/action-reasons.mjs`, `infra/hermes-runtime/host-ownership.mjs` | 23 mã (mục 5); 14 mã `rejected` vào `REASONS` (theo mốc dùng chúng) |
| `HB/action-catalog.mjs` | `param.list(item, { max })`: trần riêng theo khuôn, mặc định giữ 20 (HDN7; sau khi TC8 gộp) |
| `HB/capability-contract.mjs` | khối `HERMES_INVOICE_ACTION_KEYS = ['thu_tien.collect_transfer']` (không chạm `HERMES_ACTION_FOUNDATION_KEYS`: test khoá chéo với seed M2) |
| `src/hermes/capabilityLabels.ts` (+ test) | nhãn khoá riêng Hermes `thu_tien.collect_transfer` ("Ghi khách đã chuyển khoản / thanh toán POS (Hermes, không tiền mặt, có xem trước)"); sửa nhãn `invoices.edit` (bỏ "xác nhận kiểm tra") và `invoices.approve` ("xác nhận đã kiểm tra điều chỉnh", không phải duyệt hoá đơn) |
| `HB/server.mjs` + cấu hình host `actionPages` (#270) | thêm `invoice` |
| `HB/wave2-a-contract.mjs`, `HB/wave2-a-sql-fixture.mjs`, `wave2-a.test.mjs`, `wave2-a-coc-quy.test.mjs` | 7 báo cáo (Mốc 2 ✓); fixture thêm cột điều chỉnh, `profiles`, bản port `is_overdue`; hai test cũ thêm tham số mặc định + thân sống mới |
| `scripts/__tests__/hermes-durable-forward-fixture.mjs`, `hermes-durable-schema.test.mjs` | ghim băm reader/catalog gói A sang `20261022051620`, thân `20261019040948` thành superseded (Mốc 2 ✓) |
| `HB/CONNECTOR.md`, `scripts/hermes-task-function-contract.mjs` (băm vỏ), `scripts/hermes-read-function-specs.mjs` / `scripts/test-hermes-private-flow.mjs` (hàm `search_path=''`), `scripts/__tests__/hermes-durable-forward-fixture.mjs`, `supabase/migration-unknown-review.json`, provenance, `tooling/test-matrix.json` | dòng của Hoá đơn |

Byte `tools/list`: không đổi (họ thao tác 1 959 B đã tính; báo cáo W2 nằm trong kết quả). Test `action-tools-budget` khẳng định lại.

## 11. Kiểm thử

**Tầng 1, offline (`node:test`).**
- `invoice-action.test.mjs`: danh mục nạp được; khoá ⊆ `HERMES_ACTION_CAPABILITIES`; lý do ∈ danh sách đóng; khuôn và gợi ý tĩnh từng thao tác (list 1–10, 1–60, 1–5; snake_case trong record); sàn: cả 6 luôn xem trước dù chính sách ghi `never`; runtime với dịch vụ giả: `needs_input` không phải lỗi MCP; `rejected` qua `mcp-http` đúng câu tĩnh; preview có `choiceRequired` ⇒ lượt 2 ra `needs_input`; `crm_action_list` của trang ≤ 8 KB.
- `audit-codes.test.mjs` xanh với 14 mã mới dạng `rejected` (đỏ nếu quên `host-ownership.mjs`); `action-tools-budget`: byte bằng khi chỉ có danh mục thử.
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
- Tiền mặt: "Tiền mặt anh/chị ghi trên web ở trang Thu tiền (/thu-tien); em chỉ ghi khoản chuyển khoản hoặc thanh toán (TT/POS)." Không hỏi thêm để "lập phiếu".
- Hoàn tác / đổi hình thức lần thu: "làm trên web: Hoá đơn › Lịch sử thanh toán."
- Lập hoá đơn tháng: "em chưa lập hoá đơn được; anh/chị dùng Mode Excel ở trang Hoá đơn. Em liệt kê được phòng chưa có hoá đơn kỳ này" (`invoice_missing`).
- Gửi hoá đơn / nhắc nợ: luôn đọc `invoice_reminders`, chép nguyên `messageText` (lượt 12: connector đã nối `publicLink` xuống dòng ở cuối tin), nói rõ "anh/chị bấm gửi giúp em". `publicLink` null ⇒ không có link (tin cũng không hứa link); không bao giờ tự ghép tên miền.
- Đọc: "nợ quá hạn (hơn 1 tháng)" = `invoice_room_debts` với `days` (31), trả lời bằng `summary.rooms` (số PHÒNG, không đếm hoá đơn); "tổng nợ / nợ từng phòng" = `invoice_room_debts` (đọc số gộp sẵn, không tự cộng); "phòng nào chưa đóng tháng này" = báo cáo `collection`; "phòng nào chưa có hoá đơn tháng M" = `invoice_missing`; "hạn đóng / chi tiết điện nước một phòng" = `invoice_room_detail`; "ai hay đóng trễ" = `invoice_lateness` (`summary.topLateRooms`); "thu tháng này CK/TM bao nhiêu" = `collection_by_method`; "điều chỉnh chờ kiểm" = `invoice_adjustments` `status=PENDING` (`summary.pendingCount`).
- Ghi: luôn đọc nguyên `preview.text` + mọi `warnings`; preview có `choiceRequired` ⇒ hỏi đúng câu đó, không gọi lượt 2; chỉ số "sửa" mới gửi `replace=true`; tháng đã qua gửi `month`, không tự đặt ngày.
- **Lượt 14 (khuôn mới SOUL cần biết):**
  - Sổ/tài khoản nhận người dùng nêu ("ck vào HKD Tâm", "vào MB") ⇒ LUÔN truyền `cashbookName` (hoặc `cashbook`), không ghi vào `note`; máy chủ chọn TK/TT theo sổ. Bản xem trước mở đầu "Sổ nhận: «…»": đọc câu đó cho người dùng; cảnh báo "Chưa nêu sổ nhận…" mà người dùng đã nói sổ khác ⇒ gọi lại kèm `cashbookName`, không xác nhận bản cũ. `needs_input field=cashbook` ⇒ hỏi sổ nào (ứng viên kèm hình thức).
  - `period_closed` (tháng đã chốt lợi nhuận) ⇒ báo đúng tháng trong `detail`, KHÔNG tự đổi ngày; chỉ gọi lại khi người dùng nói ngày thu khác (hoặc chủ đã mở khoá tháng).
  - Điều chỉnh / huỷ / khôi phục hoá đơn: GỌI NGAY, không hỏi lý do trước (máy chủ kiểm chặn trước). `adjust_below_collected` ⇒ báo số đã thu + tổng sau trong `detail` và chỉ đường "đảo lần thu ở Lịch sử thanh toán trên web"; `needs_input reason_required` ⇒ lúc đó mới hỏi lý do (≥ 8 ký tự) rồi gọi lại.
  - `crm_action_list` có `notPermitted` ⇒ thao tác đó CÓ trên bot nhưng người này chưa có quyền CRM ⇒ "anh/chị chưa có quyền … (nhờ chủ/quản trị cấp ở Phân quyền)"; chỉ nói "bot chưa hỗ trợ" khi thao tác không có ở cả `items` lẫn `notPermitted`.
  - Thu theo hình thức (`collection_by_method`): số = tiền giữ lại theo ngày thu như thẻ Đã thu trang Hoá đơn; cấn trừ (CT) không phải tiền thu.
  - Thu hoá đơn thanh lý (quyết toán) của khách cũ: gọi `invoice.collect` như hoá đơn tháng (chọn bằng `invoiceNumber` khi phòng có cả hoá đơn của khách mới); chỉ chỉ đường web khi máy chủ trả `cash_collection_web_only` (tiền mặt) hoặc `receiving_book_not_held`.
  - Chỉ số công tơ ("điện 8500") là `readings[].value` của `invoice.meter_record`, KHÔNG phải tiền; số tiền khách trả mới là `amount` của `invoice.collect` (câu gợi ý của hai tham số đã nói rõ).
  - Phòng nêu không kèm toà ("Paris 2"): gọi luôn không có `buildingName` (một phòng); `needs_input field=building why=unspecified` ⇒ hỏi toà.

## 13. Quyết định cần chốt (mặc định đề xuất in đậm)

| # | Câu | Mặc định | Phương án khác |
| --- | --- | --- | --- |
| HDN1 | Khoá cho thu tiền | **Khoá riêng Hermes `thu_tien.collect_transfer` seed TẮT, quyền CRM giao vào `thu_tien.collect`** (đúng quyền hàm ghi kiểm; không đụng khối kiểm của M2), promote web cùng nhãn | Seed `thu_tien.collect` (làm M2 đỏ khi chạy lại); dùng `invoices.record_payment` (lệch quyền hàm ghi) |
| HDN2 | Lô thu tiền | **Mục không thu được loại khỏi lô và nêu ở xem trước; lượt 2 cả tập hoặc không** | Cả lô hoặc không ngay từ xem trước (như TC3) |
| HDN3 | Kế hoạch thu cho web | **Mốc 3: hàm SQL + vector parity; web chuyển ở Mốc 3b sau khi đo luật sổ thối trên production** | Chuyển web ngay ở Mốc 3; hoặc để web đợt sau |
| HDN4 | Hỏi giữ lại/trả lại khi đưa dư | **Bản xem trước có câu hỏi (`choiceRequired`), không đổi runtime** | Mở rộng runtime cho `needs_input` mang số liệu (đổi file lõi, ảnh hưởng 4 trang) |
| HDN5 | "Giảm 100k" khi đã có giảm trừ | **Cộng thêm** (xem trước nêu cũ → mới) | Đặt tổng giảm trừ mới |
| HDN6 | Xác nhận kiểm tra | **ĐÃ CHỐT (khác mặc định): không tự kiểm điều chỉnh của chính mình qua bot** ⇒ `adjustment_self_check_web_only`; từng cái một | (mặc định cũ: cho tự kiểm kèm cảnh báo) |
| HDN7 | Trần lô chỉ số | **ĐÃ CHỐT (khác mặc định): trần riêng theo khuôn** — `param.list` nhận `max` tuỳ chọn, mặc định giữ 20; chỉ số khai 60 | (mặc định cũ: nâng `MAX_LIST` chung lên 60) |
| HDN8 | Lý do huỷ/khôi phục | **Chỉ ở biên nhận + audit Hermes** | Nối vào `invoices.notes` (đổi dữ liệu web hiển thị) |
| HDN9 | Domain cho link công khai | **Dùng chung cơ chế D-HĐ9 của Hợp đồng** | Hằng số trong SQL / cấu hình DB |
| HDN10 | P7 hàm báo giá | **Chỉ thiết kế; hiện thực khi phiên chính duyệt sau Mốc 5** | Bỏ khỏi đợt |

## 14. Việc phiên chính phải làm

1. ~~Duyệt thiết kế và HDN1–HDN10~~ (22/10). **Mốc 2:** áp `20261022051118` rồi `20261022051620` qua lane (TEST rồi production, sau #267 đã áp) trước khi gộp; sau áp: provenance, gỡ hồ sơ `migration-unknown-review.json`, `gen:types` (6 hàm public mới), `rpc-surface`. Connector cần phát hành để mục lục có 7 báo cáo (SQL trước, connector sau đều an toàn).
2. Thứ tự phụ thuộc: áp #267 (TEST + production) trước Mốc 2 (✓). **Mốc 3:**
   - áp `20261022075219` rồi `20261022075230` qua lane (TEST rồi production), sau Mốc 2 đã áp, trước khi gộp PR Mốc 3;
   - khoá seed TẮT nên không đổi quyền của ai;
   - sau áp: provenance, gỡ hai hồ sơ unknown-review, `gen:types` (2 hàm public kế hoạch + vỏ trang), `rpc-surface`;
   - phát hành connector có `invoice-actions-contract.mjs`;
   - promote web có khoá + nhãn TRƯỚC khi bật khoá;
   - bật khoá bằng migration riêng sau nghiệm thu tầng 3.

   Không cần #270: nhãn ngày dùng hàm của Thu chi; `actionPages` không có trên main — danh mục nạp ở `server.mjs`.
3. Trước khi bật khoá cho Quản Lý Tòa (Q7): loại trừ khoá tiền ở kết nối của họ hoặc làm O2.
4. Trên TEST, khi tới tầng 3: bật `thu_tien.collect_transfer`, `meter_readings.create`, `invoices.edit`, `invoices.approve`, `invoices.cancel` bằng script TEST (không bằng migration production); `actionPages` thêm `invoice` ở connector 8741.
5. SOUL: đoạn mục 12.
6. Promote web cùng migration seed khoá (Mốc 3) và cùng form chỉ số (Mốc 4).

## 15. Mốc

| Mốc | Nội dung | Công |
| --- | --- | --- |
| 1 ✓ | Tài liệu này + 20 ca phát triển | — |
| 2 ✓ | Đọc bù: 6 hàm đọc dùng chung + 7 báo cáo W2 gói A; tầng 1 + PGlite + tầng 2 (kết quả bên dưới) | 2–3 |
| 2b ✓ | Sửa theo review độc lập Mốc 2 (4 bắt buộc + tuỳ chọn) | 0,5 |
| 3 ✓ | `invoice.collect` (đơn + lô) + `invoice_collection_plan_v1` + seed khoá + nhãn (kết quả bên dưới) | 4–5 |
| 3b | (nếu duyệt) web Thu tiền chuyển sang kế hoạch SQL, bỏ `changeAccounts.ts` | 1,5–2 |
| 4 | `invoice.meter_record` + `record_meter_readings_v2` + form web | 3–4 |
| 5 | `invoice.adjust`, `invoice.adjustment_check`, `invoice.cancel`, `invoice.restore` + `invoice_adjustment_build_v1` | 3–4 |
| 6 | P7 `invoice_month_quote_v1` (nếu duyệt) | 8–12 |

**Kết quả Mốc 2 (22/10/2026, chưa áp migration):**
- Tầng 1 (PGlite gói A): `wave2-a.test.mjs` 53/53 (vòng lặp mọi báo cáo giờ gồm 16 báo cáo: rào công ty, rào đầu ra, che tên khách, quyền theo toà, broker chiếu đúng khuôn); `wave2-a-hoa-don.test.mjs` 21/21 — số tính tay từng báo cáo, ca nợ kéo #267 (phòng gánh nợ cũ chỉ tính một lần), cấu trúc 6 hàm dùng chung, 10/10 đột biến bị bắt (nợ thực, quá hạn theo hạn, khoá trang, chỉ `authenticated`, hoá đơn huỷ, ngày trả đủ, lọc ≥ N ngày, tên khách, lý do điều chỉnh, chờ kiểm theo phiên bản hiện hành); `wave2-a-coc-quy`, `wave2-foundation`, `copied-text-parity-sql` xanh; `hermes-durable-schema` 98/98.
- Tầng 2 (TEST, `test-env:thu-sql`, ROLLBACK, 3 kết nối Hermes ACTIVE thật qua lối vào `public.hermes_w2_read_v1`): 0 lỗi; 7 báo cáo 150–850 ms; persona quản lý chỉ thấy toà của mình. Số khớp đối chiếu đo nền: chi tiết hoá đơn một phòng (tiền phòng, điện theo số đầu–cuối và kWh, nước, dịch vụ), hạn đóng một phòng (TC-I10), 11 phòng chưa có hoá đơn tháng 10 cùng một toà (TC-I08), 23 phòng quá hạn hơn 1 tháng (TC-I09, khớp truy vấn độc lập không RLS), tổng nợ một toà và tổng nợ một phòng đúng như bản sửa #267 (TC-I02, ghi chú lượt 2).
- Byte `tools/list`: không đổi (báo cáo W2 nằm trong kết quả `crm_read_report_list`).

**Mốc 2b (22/10/2026, sửa theo review độc lập Mốc 2; vẫn chưa áp):**
- Mã cổng khách / `publicPath` chỉ khi có `customers.view` ở toà.
- `invoice_room_debts` có `days` chỉ cộng hoá đơn quá hạn ≥ N ngày.
- `$requires$` của `20261022051620` đòi bốn hàm web chạy lúc gọi.
- Kẹp 366 ngày.
- Điều chỉnh của hoá đơn huỷ bị bỏ.
- `consumption` âm ⇒ `null`.
- Tin nhắc nợ tối đa 8 dòng chi tiết.

Kiểm:
- `wave2-a-hoa-don.test.mjs` 29/29 (15 ca + 14 đột biến).
- Gói W2 khác + nền 186/186; fixture W2 chung có bản thế chỗ đóng an toàn cho hai hàm web khi thiếu.
- `hermes-durable-schema` 98/98.
- Tầng 2 (4 kết nối ACTIVE): 0 lỗi ngoài rào phạm vi. `days=31` cho 23 phòng / 44 hoá đơn, tổng nợ thực khớp truy vấn độc lập không RLS. Các số khớp đo nền ở Mốc 2 giữ nguyên.

**Kết quả Mốc 3 (22/10/2026, chưa áp migration; nhánh xếp chồng trên #273, đã gộp #271):**
- **Vector parity** (33 ca: tiền, phần dư, làm tròn, cọc, sổ, sổ thối, thu trùng, khuôn `p_tenders` của v5):
  - SQL `invoice_collection_plan_core_v1` 33/33;
  - TS (`planCollect` + `collectionSettlement` + `findRecentDuplicateCollection` + `findOwnChangeAccount`) 28/28 ca có phía TS;
  - 5 ca chỉ SQL: SQL chặt hơn có chủ ý, hoặc khuôn sổ/dòng v5.
- **HDN3, đo production (chỉ đọc):**
  - luật "sổ …Thối người thu giữ/biết" chọn đúng sổ của cả hai người thu có thối trong 120 ngày, khớp map cứng của `changeAccounts.ts`;
  - chủ giữ cả hai sổ ⇒ chọn sổ đầu theo thứ tự.
- **PGlite RPC trang** (`invoice-write-sql.test.mjs`) 11/11 ca. Bản port v5 cùng chữ ký, cùng câu lỗi. Các ca:
  - tiền mặt bị chặn trước mọi tra cứu;
  - chạy thử không để lại lần thu / khoá idempotency / biên nhận / tiền;
  - phát lại;
  - nợ kéo #267;
  - trả dư hỏi lại, keep / return;
  - làm tròn, v5 chặn làm tròn ⇒ xem trước lại;
  - lô loại mục đã thu và cả-hoặc-không;
  - basis;
  - tên / kỳ mơ hồ;
  - phạm vi = guard ∩ quyền thu của v5;
  - bảng câu lỗi;
  - ACL.
- **Connector:**
  - `invoice-actions.test.mjs` 5/5;
  - lý do / audit / ngân sách byte / server xanh;
  - `crm_action_list` của trang ≤ 8 KB;
  - `tools/list` không đổi byte.
- **Tầng 2 trên TEST** (ROLLBACK, v5 thật, 4 kết nối Hermes ACTIVE):
  - p2, p3 (TK) và p4 (TT): xem trước → ghi → phát lại khớp. Số đã thu tăng đúng số còn nợ, ĐÃ THANH TOÁN, lần thu khoá `hermes-inv:<requestId>`, biên nhận `applied`;
  - tiền mặt ⇒ `cash_collection_web_only`;
  - thu lại cùng hoá đơn ⇒ `nothing_to_collect`;
  - trả dư chưa chọn ⇒ bản xem trước hỏi;
  - lô 9 phòng: xem trước 2,0 s, ghi 1,8 s (một mẫu);
  - một phòng: xem trước 0,5–0,7 s (lần đầu 2,9 s), ghi 1,0–1,4 s;
  - p1 (chủ) không giữ/biết sổ TK nào trên TEST và không có hoá đơn còn nợ ở toà có sổ TT ⇒ chưa có ca ghi.
- **Dấu vết chạy thử trên TEST:**
  - 0 lần thu, 0 khoá idempotency;
  - hai SEQUENCE id nội bộ nhảy (`finance_v2_backfill_change_log_sequence_id_seq` +10, `income_expense_change_log_id_seq` +3). SEQUENCE không lùi theo giao dịch; đây là id nhật ký nội bộ, không phải mã phiếu người dùng thấy.

**Mốc 3b (22/10 tối, sửa theo review độc lập; hai migration vẫn CHƯA áp, sửa thẳng trong file):**
- **Thứ tự khoá:** bỏ `hermes_invoice_scope_v1`; vỏ gắn thẳng guard. Bước ghi khoá dòng hoá đơn `FOR UPDATE NOWAIT` rồi mới kiểm quyền của v5 (mục 4.1). Review chỉ ra deadlock; gốc thật là guard dùng chung khoá công ty trước, không phải hàm phạm vi.
- **Cảnh báo:** mã lạ không làm mất mảng cảnh báo.
- **Hai hoá đơn cùng kỳ:** ứng viên có số hoá đơn; tham số `invoiceNumber` (một phòng và từng mục lô).
- **Nhãn TT:** "thanh toán (TT/POS)" như web, ở bản xem trước, kết quả, lý do `cash_collection_web_only`, nhãn khoá, tiêu đề thao tác. Câu tổng kết bỏ "vào sổ" lặp.
- **PGlite** `invoice-write-sql.test.mjs` 16/16 (thêm: `request_conflict`, `possible_duplicate` qua RPC trang, TT trả dư keep/return, cảnh báo lạ, hai hoá đơn cùng kỳ + `invoiceNumber`, PT409/55P03 ném lại cả hai lượt). Fixture tách ra `invoice-write-fixture.mjs` để PG17 dùng chung.
- **PG17 hai kết nối** `invoice-write-race-sql.test.mjs` 3/3:
  - Hermes giữ công ty, web giữ hoá đơn và chờ công ty ⇒ Hermes nhận `55P03` ngay (< 1 s), web ghi xong;
  - đối chứng: đột biến bỏ `NOWAIT` ⇒ đúng một bên nhận 40P01;
  - cùng `requestId` ở hai kết nối ⇒ lượt hai chờ ở khoá công ty rồi phát lại y hệt, một lần thu.
- **Tầng 2 trên TEST** (ROLLBACK, v5 thật, 4 kết nối ACTIVE; ba người có hoá đơn mục tiêu, chủ thì không):
  - catalog TEST: `hermes_action_binding_v1` gọi `hermes_private_command_connection_v1`, hàm đó gọi `lock_org_for_decision_v1` (guard khoá công ty);
  - `get_receiving_cashbooks_v1` và `list_cashbooks_for_income_v2` gọi ở tầng DEFINER (`current_user = postgres`) cho kết quả trùng khi gọi bằng `authenticated`, `collectorUserId = auth.uid()`; khác nhau giữa người (1 / 25 / 17 / 5 sổ);
  - một phòng TK ×2 người, TT ×1 người: xem trước → ghi → phát lại khớp, ĐÃ THANH TOÁN; cùng `requestId` khác nội dung ⇒ `request_conflict`;
  - hoá đơn có hợp đồng, chọn bằng `invoiceNumber` (chữ thường) ⇒ đúng hoá đơn; thu một phần 100.000đ rồi xem trước cùng số ⇒ cảnh báo THU TRÙNG; trả dư `keep` đi hết v5 thật ⇒ lần thu `credit_amount` 50.000đ, ĐÃ THANH TOÁN (TK ×2, TT ×1);
  - lô 9 / 3 / 1 phòng: xem trước 2,1 / 0,8 / 0,4 s, ghi 2,1 / 0,9 / 0,5 s.

**Mốc 4 (23/10, ghi chỉ số; hai migration MỚI chưa áp — `20261022183026_meter_readings_v2` dùng chung, `20261022183445_hermes_invoice_meter_v1` trang):**
- **PGlite** `invoice-meter-sql.test.mjs` 8 ca: năm trigger BEFORE INSERT của production chạy nguyên văn (`meter-trigger-bodies.json`). Phủ: kế hoạch (số đầu trigger vs hoá đơn, TLY, ghi lùi ngày, nhiều công tơ, cảnh báo); hàm ghi đường web (cả-hoặc-không, idempotency khoá + băm, DETAIL từng dòng, quyền tạo/sửa/tổ chức); "sửa"; Hermes (xem trước/loại/cảnh báo, ghi, phát lại, `request_conflict`, lý do của dòng đầu, Q16, đổi loại, phạm vi = guard ∩ quyền hàm ghi ngay ở bản xem trước, bản đã giải giả, basis lệch); ACL; số kiểu Việt.
- **PG17 hai kết nối** `invoice-meter-race-sql.test.mjs` 3/3:
  - form web đang ghi cùng toà (giữ khoá toà) ⇒ Hermes lượt 2 nhận 55P03 ngay (< 1 s), không ghi;
  - luồng lập hoá đơn INSERT thẳng (giữ khoá mã `CSS2610`) ⇒ Hermes chờ rồi ghi xong, không vòng chờ;
  - cùng `requestId` hai kết nối ⇒ phát lại, một dòng.
- **Web:** vitest `meterReadingRpc` 5, hook 19, `insertGuiOrganizationId` 33, form 4. Kiểm màn Ghi chỉ số (Playwright, vite worktree trỏ TEST, desktop 1366 + mobile 390): RPC mới chặn và giả lập ở trình duyệt (chưa có trên TEST), 0 request ghi tới TEST.
  - bị từ chối trùng tháng ⇒ form giữ mở, lỗi ở thông báo và ở đúng dòng;
  - lưu lại ⇒ đóng form, "Đã tạo 1 chỉ số thành công", khoá idempotency mới.
  - Mobile: vùng cuộn của form rộng hơn màn 22 px ngay từ trước (có sẵn); khi có lỗi, focusFirstError cuộn 22 px tới ô nhập (như lỗi kiểm ở client).
- **Tầng 2 trên TEST** (ROLLBACK, bốn migration trong giao dịch, binding thật):
  - chủ và joey: xem trước 0,26–0,37 s → ghi 0,47–0,58 s → phát lại khớp; số đầu trigger khớp kế hoạch; mã `CSS…`; khoá `hermes-meter:<requestId>`;
  - ghi lại ⇒ `meter_duplicate_month`; "sửa" ⇒ bản thay số;
  - đường web gọi thẳng hàm ghi ⇒ ghi; ghi lại ⇒ 22023 `meter_readings_rejected`, hint `duplicate_month`, DETAIL JSON;
  - lô 40 dòng xem trước 0,84 s (39 dòng loại vì tháng 10 đã có chỉ số trên TEST);
  - bosshuy: guard từ chối (không có quyền `meter_readings.create`).

**Mốc 5 (23/10, điều chỉnh / xác nhận kiểm tra / huỷ / khôi phục; hai migration MỚI chưa áp — `20261023042242_invoice_adjustment_build_v1` dùng chung, `20261023042723_hermes_invoice_edit_v1` trang):**
- **PGlite** `invoice-edit-sql.test.mjs` 18 ca. Thân production chạy nguyên văn (`invoice-writer-bodies.json`, md5 kiểm trong test): review, huỷ, khôi phục, khoá hợp đồng, dựng/làm tròn dòng, rào quyền; `adjust_invoice_v2` là bản port cùng thứ tự khoá và câu lỗi. Phủ:
  - hàm dựng dòng: ca chép từ `invoiceAdjustmentEntry.test.ts` (dòng lệch thành tiền, nợ cũ lệch/không nguồn/nguồn lạ, thanh lý), khoá dòng, thao tác, khuôn sai ⇒ 22023;
  - điều chỉnh: chạy thử không dấu vết, ghi `hermes-adj:`, phát lại, `request_conflict`, khớp dòng theo mô tả, basis lệch, dòng điện/nước, các lý do của hàm ghi (cấn trừ, nợ đã kéo, thấp hơn đã thu, thanh lý, hỗ trợ tiền phòng, kỳ chốt, không đổi), PT409 khác ném lại;
  - xác nhận kiểm tra: người làm/giờ/dòng đổi, CHECKED, phát lại, tự kiểm, không có gì để kiểm, phiên bản đổi;
  - huỷ/khôi phục: tiền dư đã cấn, nợ cũ đang gánh, đã thu, quá hạn, trùng kỳ, lý do chỉ ở biên nhận (HDN8), quyền đúng hàm ghi ngay ở bản xem trước;
  - bản đã giải giả, basis sai, ACL.
- **PG17 hai kết nối** `invoice-edit-race-sql.test.mjs` 8 ca, mỗi hàm ghi web một ca:
  - `adjust_invoice_v2`, `cancel_…`, `restore_…` (công ty → hợp đồng → hoá đơn): Hermes chờ ở dòng công ty, web xong, Hermes `state_changed`;
  - hoá đơn không hợp đồng (web không xin công ty) và `review_invoice_adjustment_v2` (hoá đơn → điều chỉnh): Hermes 55P03 ngay;
  - v5 giữ hoá đơn / đường giữ hợp đồng rồi xin công ty: Hermes 55P03; đối chứng đột biến bỏ NOWAIT ở hoá đơn, rồi ở hợp đồng ⇒ đúng một bên 40P01;
  - cùng `requestId` hai kết nối ⇒ phát lại.
- **Web:** form Điều chỉnh lấy dòng giữ nguyên + câu chặn từ hàm dùng chung (`src/lib/invoiceAdjustmentBuildRpc.ts`, hook `useInvoiceAdjustmentBuild`); vitest service, bộ dựng dòng, component.
- **Tầng 2 trên TEST** (ROLLBACK, sáu migration trong giao dịch, binding ACTIVE thật; md5 bốn hàm ghi web + khoá hợp đồng trên TEST = production):
  - hai người: điều chỉnh xem trước 0,25–0,95 s → ghi 0,5–0,6 s → phát lại khớp; khoá `hermes-adj:<requestId>`; chạy thử không để lại dấu vết; người thứ hai điều chỉnh tiếp ⇒ cảnh báo "đang chờ kiểm";
  - huỷ rồi khôi phục cùng hoá đơn qua hàm thật: ĐÃ HUỶ → ĐÃ DUYỆT;
  - điều chỉnh TĂNG hoá đơn đã thu: hàm ghi thật qua đủ đối soát, cảnh báo "khách còn nợ";
  - xác nhận một điều chỉnh có sẵn do người khác làm ⇒ CHECKED, dòng đổi đúng ảnh trước/sau;
  - tự kiểm ⇒ `adjustment_self_check_web_only`; sửa dòng điện ⇒ `adjust_meter_line_web_only`; huỷ hoá đơn đã thu / quá hạn ⇒ `cancel_has_payment` / `cancel_overdue_web_only`; khôi phục hoá đơn đang hiệu lực ⇒ `invoice_not_cancelled`;
  - người không có `invoices.edit` / `invoices.approve`: guard từ chối.

## 16. Chưa xác minh

- Luật sổ thối theo possession có trùng 2 ID viết cứng ở `changeAccounts.ts` không (đo chỉ đọc trên production ở Mốc 3).
- ~~Chạy thử v5 trong khối con: khoá tư vấn và thời gian lô 10~~ — đo ở tầng 2 Mốc 3/3b (lô 9 phòng ≈ 2 s, giữ khoá công ty suốt lượt).
- NOWAIT trên TEST/production với web thật (hai kết nối): tầng 2 chỉ chạy một kết nối; bằng chứng thứ tự khoá là PG17 hai kết nối với bản port v5 cùng thứ tự khoá + catalog TEST của guard.
- Hook options màn tạo kết nối nhận khoá riêng Hermes `thu_tien.collect_transfer` thế nào (`hermes_*_extend_options_v1` theo danh sách cứng hay theo registry); tiền lệ `income_expenses.approve_vouchers` cho thấy chỉ cần `capability-contract.mjs` + nhãn, chưa thử trên TEST.
- ~~Heuristic "chỉ số đã lên hoá đơn" trên dữ liệu thật~~ — đo ở Mốc 4 (mục 4.2): 96 % khớp khi bỏ `service_id`; 4 % còn lại là hoá đơn không có dòng chỉ số hoặc số cuối khác (sửa tay) ⇒ "sửa" qua bot có thể thay một chỉ số mà hoá đơn đã dùng số khác — hoá đơn không đổi, chỉ chuỗi chỉ số đổi.
- Mobile 390 px: vùng cuộn của form Ghi chỉ số rộng hơn màn 22 px (có sẵn trước Mốc 4).
- Tên người điều chỉnh ở bản xem trước xác nhận kiểm tra đọc dưới RLS `profiles` (thiết kế mục 4.4). Tầng 2: chủ không thấy tên người điều chỉnh (khác nhóm) ⇒ "một người khác". Muốn hiện tên thì đọc ở bước ghi DEFINER — cần phiên chính quyết.
- Form Điều chỉnh web: "khoản thêm" đang có (gửi xe, cọc, phạt…) vẫn gửi đơn giá × SL theo form, không theo dạng "giữ nguyên" của máy chủ — y như trước Mốc 5. Dòng lệch thành tiền thuộc loại này có thể mất phần lệch khi lưu (có sẵn, chưa đổi).
- ~~Bản dựng lại `hermes_w2a_read_v1` / `hermes_w2a_catalog_v1` khớp md5 production~~ — đã đo ở Mốc 2: production = TEST = repo (`13812ba6…` / `c24d2655…`).
- Thời gian trả lời của bot với 7 báo cáo mới và việc bot chọn đúng báo cáo (tầng 3, phiên chính).

**Đã đọc production 22/10 (chỉ đọc, `npm run -s db:query`):** registry có `invoices.view`, `thu_tien.view`, `meter_readings.view` BẬT; `meter_readings.create`, `invoices.edit`, `invoices.cancel`, `invoices.approve` TẮT; không có `thu_tien.collect`. `invoice_effective_outstanding_v1` chưa có (#267 chưa áp). `authenticated` không có EXECUTE trên `app_private.round_invoice_total_v1` (nên mục 6.3 lấy tổng từ chạy thử hàm ghi).

## Lượt C3j — lưới an toàn thu tiền khi ghi chú nói "chưa trả" (26/10)

**Vì sao:** nghiệm thu C3i (TEST, 26/10) có ghi sai thật TC-A03 — người dùng nói "1392: phòng 205 với 306 ck đủ phần còn thiếu tháng 10 rồi, L06 thì chưa nha"; mô hình gọi THÊM `invoice.collect` cho L06 với ghi chú "Chưa thanh toán phần còn thiếu tháng 10" rồi xác nhận ⇒ ghi thu 3.970.000đ cho khoản khách chưa trả. Lần thu đó đã hoàn tác trên TEST.

| Đổi | Chi tiết |
| --- | --- |
| `infra/hermes-broker/collect-guard.mjs` (mới) | `invoice.collect` có `note` nói "chưa thanh toán / chưa trả / chưa đóng / chưa chuyển / chưa ck / không trả…" (bỏ dấu) ⇒ `needs_input invalid_params` kèm câu "thu tiền chỉ ghi khoản khách ĐÃ trả…", không gửi gì xuống SQL. `cashbookName` là nhãn ứng viên của máy chủ ("HKDHUY — thanh toán (TT)", TC-A06) ⇒ phần mã trước dấu gạch |
| `action-runtime.mjs` | áp sau bước quy đổi cụm ngày, cho cả hai lượt (lượt đồng ý gửi y nguyên ⇒ cùng kết quả) |

**Phát hành:** chỉ connector, không migration; SOUL v4.28 (không thu phòng "thì chưa", khách cũ trả hoá đơn thanh lý ⇒ `invoice.collect`, tên phòng "MB"/"Paris 2", chỉ số công tơ) lên cùng.

**Test:** `collect-guard.test.mjs` (đơn vị + vòng đời qua broker thật). Đột biến bằng tay: tắt nhánh "chưa trả" ⇒ ca L06 đỏ.

## Lượt C3l — tên sổ trùng tên phòng (26/10)

**Vì sao:** nghiệm thu C3j (TEST, 26/10) TC-A07 "Toà 80 phòng MB ck 2tr796 tiền tháng 10": mô hình gửi cả `roomName` "MB" lẫn `cashbookName` "MB" ⇒ máy chủ không thấy sổ "MB", hỏi chọn TK939/HKDHUY; người dùng "ok" ⇒ bot hỏi lại, không ghi. SOUL v4.28 đã dặn "phòng MB" là tên phòng, mô hình vẫn lẫn.

| Đổi | Chi tiết |
| --- | --- |
| `infra/hermes-broker/collect-guard.mjs` | `invoice.collect`: `cashbookName` (bỏ dấu, bỏ khoảng trắng hai đầu) trùng `roomName` hoặc một `items[].roomName` của chính lệnh ⇒ bỏ `cashbookName`, máy chủ dùng sổ mặc định theo phương thức; sổ thật ("MBHIEP"…) và nhãn ứng viên "X — …" giữ luật cũ |

**Phát hành:** chỉ connector, không migration. Đi cùng SOUL v4.30 (đồng ý bản xem trước = ghi đúng sổ mặc định, không hỏi lại sổ; khách cũ trả "tiền quyết toán" ⇒ `invoice.collect`; chỉ số nhỏ hơn đầu kỳ ⇒ nêu số đầu kỳ).

**Test:** `collect-guard.test.mjs` thêm ca đơn vị (phòng "MB", `items[]` "Paris 2", sổ thật giữ nguyên). Đột biến bằng tay: tắt nhánh ⇒ ca đỏ.

## Lượt C3m — ngày thu tiền nói bằng lời (27/10)

**Vì sao:** nghiệm thu c3k (TEST, 26/10) TC-D04 "Thứ hai tuần trước phòng 205 toà 1392 ck 82k mà anh quên ghi" ⇒ ngày khách trả do mô hình tự tính (cùng lớp lỗi CV-T12 / HD-T22 / TC-A04 đã sửa ở C3i, C3l).

| Đổi | Chi tiết |
| --- | --- |
| `invoice-actions-contract.mjs` | `datePhrase` (tuỳ chọn, ≤ 80 ký tự) cho `invoice.collect` |
| `vn-relative-date.mjs` | `DATE_PHRASE_FIELDS['invoice.collect']`: hướng QUÁ KHỨ, connector ghi đè `date`, cụm không xuống SQL, xem trước nêu "Hiểu '…' là …" |

**Phát hành:** chỉ connector; SOUL v4.33 (dặn gửi `datePhrase` cho thu tiền) lên cùng.

**Test:** `vn-relative-date.test.mjs` (Chủ nhật / thứ Hai, "hôm qua", cụm không hiểu), `invoice-actions.test.mjs` (khuôn trường). Đột biến bằng tay: bỏ ánh xạ ⇒ ca đỏ.

## Lượt C07 — lần thu bị từ chối lúc COMMIT ra action_outcome_unknown (27/10)

**Vì sao:** nghiệm thu TEST 26/10 và 27/10 (3/3 lần): chuyển khoản một phần hoá đơn kỳ 08 của phòng còn 4 hoá đơn mở (kỳ 07 cũ hơn chưa trả, kỳ 10 có điều chỉnh chờ kiểm): bản xem trước đúng, lượt xác nhận ⇒ `action_outcome_unknown` (finalize 3,3–3,8 s, `resultBytes` 0, không hết giờ), `crm_action_status` ⇒ `not_found`. Bước ghi bắt mọi lỗi của `record_invoice_collection_v5` trong khối con, nên lỗi tới PostgREST chỉ có thể nổ SAU khi hàm trả `applied`: kiểm hoãn (constraint trigger `DEFERRABLE INITIALLY DEFERRED`) của các bảng v5 ghi chạy lúc COMMIT ⇒ mã lạ (55000 ⇒ HTTP 500) ⇒ connector giữ cờ "chưa rõ"; giao dịch lùi cả biên nhận. Chạy thử của bản xem trước lùi khối con nên sự kiện hoãn bị bỏ — không bao giờ thấy. Trigger cụ thể trên TEST CHƯA xác minh (ứng viên: phân bổ thành phần `allocate_finance_collection_components_v1` "Phân bổ thành phần không đủ…", chứng cứ đồng hồ `meter_capture_assert_invoice_facts_v1`, cọc có phòng 23514).

| Đổi | Chi tiết |
| --- | --- |
| `20261026234255_hermes_invoice_collect_commit_checks_v1` | `hermes_invoice_action_step_v3` thân `181440` + `SET CONSTRAINTS ALL IMMEDIATE` cuối chạy thử (lỗi ⇒ lý do đóng, vd `reconciliation_required`) và khối con tập dượt tự lùi (HC001) sau khi chốt biên nhận (lỗi ⇒ `state_changed`; sự kiện hoãn chạy lại lúc COMMIT như cũ, chế độ ràng buộc không rò) |
| `invoice-write-fixture.mjs` | kiểm hoãn giả `fixture_collection_commit_check` (bảng `fixture_commit_reject`, trống ⇒ không làm gì); chuỗi `l14` nạp thêm file C07 |

**Phát hành:** chỉ migration, áp đích danh qua lane (provenance catalog-proven giả vì hàm đã có), TEST rồi production; connector / SOUL không đổi.

**Test:** `invoice-write-sql.test.mjs` ca C07 (đỏ trước sửa: bản xem trước "ghi được", lượt ghi ném 55000 lúc COMMIT); bốn đột biến (bỏ ép ở chạy thử / bỏ tập dượt / tập dượt không tự lùi / tập dượt trước khi chốt biên nhận) đều bị bắt.

## Lượt E03 — chỉ số nhỏ hơn số đầu nêu kèm số đầu (27/10)

**Vì sao:** nghiệm thu (trượt lặp nhiều vòng) "Điện phòng 102 toà 15 tháng này 8500" ⇒ `invoice.meter_record` trả `needs_input meter_lower_than_previous` với câu tĩnh "Chỉ số mới nhỏ hơn chỉ số đầu; hỏi lại số trên công tơ." — không có số đầu 8.580. SOUL dặn tự tra báo cáo lấy số đầu nhưng mô hình không làm. Người dùng sửa "8750" thì xem trước lại bình thường (đã đúng).

| Đổi | Chi tiết |
| --- | --- |
| `20261027093517_hermes_invoice_meter_lower_facts_v1` | bước ghi chỉ số dựng lại từ thân `183445` (md5 `bcaeccc8…` ⇒ `a1ffa3cf…`): không còn dòng ghi được ở lượt xem trước mà dòng quyết định lý do (dòng bị loại đầu tiên) là `lower_than_previous` ⇒ `rejected meter_lower_than_previous` kèm `facts {room, value, previous, meterCode?}` (tên phòng bỏ ký tự điều khiển ≤ 120; số trơn `trim_scale`; mã công tơ chỉ khi người dùng nêu mã). Mọi nhánh khác giữ từng byte; lô còn dòng ghi được vẫn ra bản xem trước nêu dòng lệch ở `excluded` |
| `broker.mjs` | khuôn đóng `meter_lower_than_previous` trong `ACTION_REJECT_FACTS` (cờ `whole`: câu ghép THAY câu tĩnh) ⇒ "Chỉ số mới 8.500 nhỏ hơn chỉ số đầu 8.580 (phòng 102); hỏi lại số trên công tơ." (có mã: "(phòng P104, công tơ DH-104B)"); số kiểu Việt như `hermes_invoice_reading_text_v1` |
| `action-runtime.mjs` | lý do dạng `needs_input` SQL trả qua `rejected` nhận `facts` đúng khuôn ⇒ câu ghép; không facts ⇒ câu tĩnh như trước |

**Phạm vi dữ liệu:** số đầu là của chính công tơ người dùng đang ghi, sau kiểm phạm vi guard + quyền ghi `meter_readings.create` của toà (cùng chỗ bản xem trước đã nêu số đó ở `excluded`); không đọc thêm gì.

**Phát hành:** connector TRƯỚC, rồi migration (lane `migrate:forward`). Connector mới + SQL cũ: không facts ⇒ câu tĩnh như hôm nay. Connector cũ + SQL mới: facts lạ với mã này ⇒ khuôn lệch ⇒ `backend_unavailable` (tệ hơn hôm nay) — không áp migration trước connector. Sau khi áp: `20261023042723` ghim md5 thân `183445` của hàm này ⇒ chạy lại đơn lẻ file đó trên production ném `hermes_invoice_edit_dependency_invalid` đúng thiết kế ⇒ cần ngoại lệ pinned trong `migration-policy.json` (kèm biên nhận áp), như các cặp ghim md5 chéo trước.

**Test:** PGlite `invoice-meter-sql.test.mjs` (chuỗi `e03`: một dòng, lô hai dòng cùng nhỏ hơn — dữ kiện của dòng 1 —, số đầu lẻ, mã công tơ, lô còn dòng ghi được, sửa số; chạy lại + thân lạ bị từ chối) đỏ trước — xanh sau; `invoice-actions.test.mjs` (câu ghép, không facts ⇒ câu tĩnh, facts lệch khuôn / mã không khai ⇒ `backend_unavailable`). Đột biến bằng tay: SQL bỏ `previous` / lấy dòng cuối / luôn kèm mã; connector bỏ nhánh facts / bỏ `whole` / bỏ số đầu / bỏ phân nghìn / nới khuôn phòng ⇒ đều đỏ.
