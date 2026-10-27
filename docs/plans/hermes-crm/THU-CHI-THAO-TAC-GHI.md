# Thao tác ghi Hermes — trang THU CHI (Đợt 2: thiết kế đã duyệt; Mốc 2–4 xong)

Ngày 22/10/2026 (giờ Việt Nam). Nhánh `claude/hermes-thu-chi-ghi-20261022`, gốc `origin/main` `2d0a0099a`.
Phiên chính duyệt thiết kế 22/10: TC1–TC10 theo mặc định, riêng TC5 đổi thành cờ chính sách (mục 12). Mốc 2–3b đã lên production 22/10 (PR #271, mục 16–18). Mốc 4 (sửa, huỷ, cờ TC5) ở mục 19: migration mới chỉ là file, chưa áp.

Nguồn:
- Khung chung [NEN-CHUNG-THAO-TAC-GHI.md](NEN-CHUNG-THAO-TAC-GHI.md) mục 3–8 và 12. Khung đã gộp `main` (#253) và đã áp production (#269).
- Plan chi tiết Thu chi ngày 21/10 (máy làm việc, không nằm trong repo): §1 kiểm kê web, §2 số liệu, §4 thao tác, §5 thiết kế tool, §6 test, §7 đợt.
- Đáp án 40 câu của chủ (21/10). Đáp án là luật; plan mâu thuẫn với đáp án thì theo đáp án. Các câu liên quan: Q2, Q3, Q4, Q5, Q8–Q13, Q25, Q27.
- Lượt đo nền r1 ngày 22/10: bot production, 29 ca đọc và từ chối của Thu chi, 13 ca đạt, 0 ghi sai.

Ký hiệu: `HB` = `infra/hermes-broker`; `M/<ts>` = `supabase/migrations/<ts>_*.sql`; `B` = `supabase/baseline/schema.sql`.

## 0. Kết luận

1. **Năm thao tác, cắm vào `crm_action_*`, không thêm byte `tools/list`.**

   | Thao tác | Làm gì | Xác nhận |
   | --- | --- | --- |
   | `expense.create` | Lập phiếu chi: mỗi khoản một phiếu, tối đa 5 khoản cho một lần đồng ý (Q10) | luôn xem trước |
   | `expense.note` | Ghi chú phiếu | ghi thẳng (Q2) |
   | `expense.edit` | Sửa phiếu chi chờ duyệt | luôn xem trước |
   | `expense.cancel` | Huỷ phiếu chi lập tay | luôn xem trước |
   | `expense.approve` | Duyệt, hoặc duyệt và chi, tối đa 10 phiếu lập tay (Q8) | luôn xem trước |

   Phần đọc bù gồm 4 báo cáo W2 mới, đi qua `crm_read_report` sẵn có.
2. **Xem trước bằng cách chạy thử chính hàm ghi web trong savepoint rồi lùi.** Bản xem trước nói "vào sổ ngay" hay "chờ duyệt vì …" theo kết quả thật của `create_income_expense_v1`, không chép thang duyệt sang chỗ khác. Cách này cũng bắt sớm mọi lý do từ chối: kỳ đã chốt, sổ không giữ, hạng mục hệ thống.
   - Đã tra: mã phiếu đếm bằng bảng `voucher_code_counters` nên lùi không làm nhảy số. Trigger không gọi ra ngoài DB (không `pg_net`, không `NOTIFY`). Thông báo chỉ là dòng `public.notifications` và lùi theo.
   - Lượt 2 ghi thật, rồi so kết cục với bản đã xem. Lệch thì lùi cả lệnh và trả `state_changed`, không chốt biên nhận.
3. **Gọi đúng hàm ghi web, không viết thẳng bảng tiền:**
   - lập phiếu: `create_income_expense_v1`;
   - sửa: `revise_pending_income_expense_v1`;
   - huỷ: `cancel_income_expense_flex_v1`;
   - duyệt và chi: `adopt_voucher_attachments_as_evidence_v2` rồi `approve_and_post_income_expense_v2`;
   - chỉ duyệt: `approve_income_expense_v2`;
   - ghi chú: `append_income_expense_supplement_v1`.

   Hàm ghi tự kiểm `auth.uid()`, nên quyền giống hệt web.
4. **Luật 17/10.** Web đang tính hai công thức bằng TypeScript mà Hermes cũng cần. Cả hai thành hàm SQL dùng chung, web chuyển sang gọi, có test parity:
   - gợi ý hạng mục (`categoryRules.ts`, bộ 414 câu thật làm vector);
   - sổ mặc định (`cashbook.ts`).

   Web **không** dự báo trạng thái sinh bằng TypeScript (đã tra), nên phần đó không có gì để chuyển.
5. **File dùng chung chỉ đổi những khối nhỏ** (mục 9):
   - thêm kiểu tham số `list` và `record` vào danh mục. Trang Hợp đồng cũng cần cho gia hạn lô; phiên chính chốt một bản;
   - thêm 2 mã lý do `system_voucher`, `evidence_required`;
   - thêm 2 loại tên `category`, `cashbook`;
   - sửa nhãn `income_expenses.create` (đang nói sai "không vào sổ").
6. **Cần phiên chính hoặc chủ chốt 10 điểm** (mục 12), mỗi điểm có mặc định. Điểm lớn nhất là TC1: dùng lại khoá `income_expenses.create` cho `expense.create`. Lớp quyền khung chung báo `context_changed` khi khoá của nó đã được họ khác cấp. Vì vậy dùng lại khoá thì phải gỡ hẳn họ `crm_expense_*` khỏi connector trong cùng bản (`HB/server.mjs`, `createExpenseActionAuth`).
7. **Ước công 9–12 ngày kỹ sư**, chia 5 mốc (mục 13). SQL tầng 2 chạy được trên TEST trước khi có bot.

## 1. Phạm vi

| Làm (Đợt 2) | Không làm, bot từ chối có chỉ đường web |
| --- | --- |
| Phiếu CHI lập tay: lập (≤ 5 khoản/lần), ghi chú, sửa khi chờ duyệt, huỷ (Q9), duyệt / duyệt + chi ≤ 10 phiếu (Q8) | Phiếu THU lập tay (plan Q5); thu tiền mặt (Q13 = c) |
| Tiền nhà/điện/nước theo cam kết (Q12): cho lập, xem trước bắt buộc báo kỳ đã chi chưa và số còn lại theo cam kết | Huỷ/sửa/duyệt phiếu hệ thống: thu tiền HĐ, cọc, thanh lý, hoa hồng, bỏ cọc, bàn giao, lương, chia lợi nhuận |
| Gợi ý hạng mục, sổ mặc định, giải tên toà/phòng/hạng mục/sổ/mã phiếu trong SQL | Hoàn tác vào sổ, bỏ duyệt, khôi phục, kết sổ, cam kết chi, ví cá nhân |
| Đọc bù: chi tiết phiếu, phiếu chờ duyệt theo tuổi, khoản chi sắp theo tiền, tổng chi theo hạng mục | Ảnh bill qua Zalo (Q11 = b) là luồng riêng của phiên chính: Thu chi chỉ chừa chỗ (mục 2.6) |
| Web: Báo chi nhanh gọi hàm SQL dùng chung (hạng mục, sổ mặc định) | Đề xuất UI khác ở plan §8 (nhãn nguồn Hermes, thẻ "chờ > 7 ngày"…): để sau |

## 2. Danh mục thao tác

### 2.1 Khai báo

Danh mục mới nằm ở `HB/expense-actions-contract.mjs`, theo khuôn `action-probe-contract.mjs`. Mọi thao tác dùng chung một RPC trang `hermes_expense_write_v1`.

| `id` | Khoá registry (Hermes) | Quyền CRM giao vào (`crm_permission`) | Lớp | Chính sách DB |
| --- | --- | --- | --- | --- |
| `expense.create` | `income_expenses.create` (TC1) | `income_expenses.create` | `money` | `always`, `private_only` |
| `expense.note` | `income_expenses.create` | `income_expenses.create` | `reversible` | `never` (Q2: ghi thẳng), `private_only` |
| `expense.edit` | `income_expenses.edit` | `income_expenses.create` (TC6) | `money` | `always` |
| `expense.cancel` | `income_expenses.cancel` | `income_expenses.create` (TC6) | `irreversible` | `always` |
| `expense.approve` | `income_expenses.approve_vouchers` | `income_expenses.approve` | `money` | `always` |

- Khoá `income_expenses.edit/cancel/approve_vouchers` đã seed TẮT ở `M/20261021134531` và đã có trong `capability-contract.mjs` cùng nhãn.
- `income_expenses.create` hiện đang TẮT (`M/20261021113528`, Q4).
- Một khoá phục vụ nhiều thao tác thì mọi thao tác đó phải cùng `crm_permission`. Lý do: `hermes_action_capabilities_v1` lấy quyền CRM theo thao tác đầu của khoá.

### 2.2 Tham số

Mọi tên là chuỗi như người dùng nói; SQL giải (mục 4). Tiền là số nguyên VND. Ngày theo giờ Việt Nam.

```text
expense.create   items*: list 1–5 của record {
                   buildingName* name(building), roomName name(room), amount* vnd,
                   content* text 1–200      (tên phiếu = nội dung người dùng nói, như Báo chi nhanh),
                   category name(category)  (trống ⇒ SQL gợi ý theo content; không chắc ⇒ hỏi lại),
                   payee text 1–100         (người nhận, ghi vào payer_name),
                   voucherDate date         (trống = hôm nay VN),
                   period month             (kỳ của khoản cam kết, vd tiền nhà tháng 10; trống = kỳ = ngày phiếu),
                   cashbook name(cashbook)  (trống ⇒ sổ mặc định dùng chung, mục 4.3) }
expense.note     voucherCode* name(voucher), note* text 1–1000
expense.edit     voucherCode*, amount, category, content, payee, voucherDate, cashbook, buildingName, roomName, reason text 8–1000
                 (ít nhất một trường đổi; đổi tiền/hạng mục/sổ/toà ⇒ hàm ghi đòi lý do ⇒ needs_input reason_required)
expense.cancel   voucherCode*, reason* text 8–1000
expense.approve  voucherCodes* list 1–10 của name(voucher), post bool (mặc định true = duyệt và chi)
```

- Một dòng cho mỗi phiếu: plan §2.2 đếm 302/302 phiếu lập tay là một dòng. Không nhận `lines[]`.
- Không nhận STK người nhận, hợp đồng hay KQKD. Phiếu cần các trường này thì làm trên web.

### 2.3 Lý do riêng của trang (thêm vào danh sách đóng)

| Mã | Dạng | Câu tĩnh (dự kiến) | Nguồn |
| --- | --- | --- | --- |
| `system_voucher` | rejected | Phiếu thuộc luồng hệ thống (thu tiền hoá đơn, cọc, thanh lý, hoa hồng, bàn giao, lương); sửa/huỷ/duyệt ở màn gốc trên web. | `[NOT_MANUAL]`, `luồng hệ thống`, `do hệ thống sinh`, `owned by system flow`, 0A000 `chỉ được sinh từ hệ thống` |
| `evidence_required` | rejected | Phiếu chưa có chứng từ nên chưa chi được; thêm ảnh trên web hoặc chỉ duyệt. | `at least one FINALIZED evidence is required` |

Các mã chung còn lại được dùng như sau:
- `web_only`: phiếu THU, và thao tác ngoài phạm vi.
- `not_found` (needs_input): mã phiếu không thấy.
- `date_out_of_range`: `Ngày phiếu phải nằm trong khoảng …`.
- `not_pending`: phiếu không còn chờ duyệt; cả các câu tiếng Anh `voucher not in an approvable state` và `voucher not approvable+postable`.
- `cashbook_not_held`: thêm câu `Quyền sử dụng sổ quỹ đã bị thu hồi`.

Ánh xạ đặt trong hàm của trang, `app_private.hermes_expense_reason_v1(sqlstate, message, constraint)`. Hàm khớp mẫu riêng của Thu chi trước, không khớp thì gọi `app_private.hermes_action_reason_v1`. Hàm chung không đổi, nên phiên Hợp đồng không xung đột ở SQL.

### 2.4 Kết quả `applied` (có tên, không UUID)

```text
create:  {vouchers:[{code, building, room, category, amount, amountText, cashbook, voucherDate,
                     approvalStatus, postingStatus, statusText}], link}         link = /income-expense/voucher/<id> (1 phiếu) hoặc /income-expense
edit:    {code, changed:[{field, before, after}], statusText, link}
cancel:  {code, cancellationKind: CANCELLED_UNPOSTED | CANCELLED_AFTER_POSTING, statusText, link}
approve: {items:[{code, outcome: approved | approved_posted | state_changed | rejected, reason?, statusText}], totalPosted, link}
note:    {code, noted:true, link}
```

`amountText` ("350.000đ") do SQL dựng bằng hàm định dạng dùng chung. `statusText` là một câu tiếng Việt, ví dụ:
- "Đã duyệt và CHI khỏi sổ Tiền mặt 1392QT".
- "Chờ duyệt: vượt ngưỡng tự duyệt 600.000đ".

### 2.5 Cách tính trùng

Bản xem trước của `create` có `warnings[]` (≤ 10 câu, ≤ 300 ký tự) cho các trường hợp sau:

1. **Trùng ô kỳ.** Gọi `get_voucher_slot_warning_v1(toà, [hạng mục], kỳ đầu, kỳ cuối)`, đúng hàm form web đang dùng. Kỳ là tháng `period` nếu có; không có thì là ngày phiếu ± 3 ngày. Hàm trả phiếu cùng toà, cùng hạng mục, có kỳ giao nhau. Phiếu nào cùng số tiền thì gắn "có thể trùng". Web cũng so cột `same_amount` ở trình duyệt, cùng phép bằng.
2. **Trùng trong lô.** Hai khoản trong cùng `items` có cùng toà, hạng mục và số tiền.
3. **Khoản cam kết (Q12).** Hạng mục gắn phí cam kết: tiền nhà, điện, nước, internet, quản lý… Ánh xạ hạng mục → `fee_category` theo luật hạng mục của bộ máy chi; Mốc 3 chốt nguồn ánh xạ. Với hạng mục loại này:
   - đọc `app_private.commitment_for_v1(toà, fee_category, kỳ)` lấy cam kết và số còn lại;
   - nêu "Cam kết tháng 10: …; đã chi/giữ: …; còn: …";
   - nêu kết quả của bộ máy chi trong lần chạy thử (`WITHIN_COMMITMENT` / `OVER_COMMITMENT`);
   - kỳ đã có phiếu thì nêu mã phiếu đó.

   Đây là luật bắt buộc của Q12. Không đọc được cam kết thì bản xem trước nói rõ "không đọc được cam kết", không im lặng.
4. **Câu nhắc khác.** Ngày lùi quá 7 ngày, tiền ≥ 50 triệu, tiền không tròn nghìn (dễ nhầm ×1 000), tiền ≥ ngưỡng tự duyệt.

### 2.6 Ảnh (Q11 = b)

`ATTACHMENTS_READY = false` ở `HB/action-catalog.mjs`. Đường ảnh Zalo (#268, M1+M2) đã có worker và adapter nhưng chưa gắn CRM.

- **Bây giờ:** kết quả `applied` có `link` tới trang phiếu. Câu `statusText` của phiếu chờ duyệt nói "thêm ảnh ở link để duyệt và chi được".
- **Khi phiên chính bật luồng ảnh:** thêm tham số `attachments` cho `expense.create` (theo từng khoản) và `expense.note`. Tham số đưa xuống `p_attachments` của hàm ghi web và của hàm bổ sung, không thêm thao tác mới.

## 3. Vòng đời trong SQL

### 3.1 Hai tầng theo khuôn thao tác thử (`M/20261021133823` mục 7)

```text
public.hermes_expense_write_v1(p_binding, p_action, p_phase, p_request_id, p_params, p_resolved, p_expected_basis)
  INVOKER, thân SQL-standard (BEGIN ATOMIC), search_path pg_catalog,public — ghim băm ở scripts/hermes-task-function-contract.mjs
  g = app_private.hermes_action_guard_v1(binding, action)        -- binding, registry, khoá kết nối, quyền CRM, tập toà
  r = app_private.hermes_expense_resolve_core_v1(org, toà[], action, params)   -- chỉ ở preview/auto; INVOKER, dưới RLS người hỏi
  → app_private.hermes_expense_write_step_v1(binding, action, phase, rid, params, resolved, basis, r)   -- DEFINER
```

- **Lõi giải tên** (`hermes_expense_resolve_core_v1`): plpgsql INVOKER đặt ở `app_private`, chỉ tham chiếu `public.*`, giống `hermes_write_name_resolve_core_v1`.
  - Toà và phòng: gọi `public.hermes_write_name_resolve_v1` cho từng khoản.
  - Hạng mục, sổ và mã phiếu: tự giải (mục 4).
  - Client không gọi thẳng được vì không có USAGE `app_private`; chỉ tới được qua OID gắn trong vỏ.
- **Bước ghi** (DEFINER) làm theo thứ tự:
  1. Chạy lại guard.
  2. Kiểm bản đã giải còn đúng phạm vi:
     - toà ∈ `ctx.buildingIds`;
     - phòng thuộc toà;
     - hạng mục qua `app_private.hermes_expense_category_ok_v1`;
     - sổ nằm trong `list_cashbooks_for_expense_v2()` ∩ công ty;
     - phiếu thuộc công ty, có toà ∈ phạm vi, lập tay và là CHI.
  3. Chạy thử hoặc ghi thật.
  4. Mở và chốt biên nhận bằng `hermes_action_receipt_begin/finish_v1`.

  Ở lượt 2 bước 2 chạy lại đầy đủ, vì bản đã giải đến từ bộ nhớ connector.

### 3.2 Chạy thử để xem trước

```text
BEGIN                                   -- khối con = savepoint
  v := <hàm ghi web>(…, khoá 'hermes-dry:<rid>:<i>')
  đọc trong cùng khối: approval_status, posting_status, lý do sinh của bộ máy chi (spend_decisions vừa chèn, hoặc
       current_setting('app.spend_gate_last')), dòng sổ (nếu vào sổ), phiếu sau sửa…  → biến plpgsql
  RAISE 'hermes_dry_run' USING ERRCODE='HD001'
EXCEPTION
  WHEN SQLSTATE 'HD001' THEN NULL       -- mọi thứ trong khối đã lùi; biến giữ kết quả
  WHEN OTHERS THEN lý do := hermes_expense_reason_v1(SQLSTATE, SQLERRM, constraint)  -- từ chối sớm ở lượt 1
END
```

- **Vì sao không tách hàm dự báo.** Thang trạng thái sinh nằm inline trong `create_income_expense_v1` (`M/20260926160000:3295-3355`, khoảng 51 dòng).
  - Thang này gồm: người lập có quyền duyệt; phiếu THU; hạng mục bắt buộc duyệt; ngưỡng `ie_auto_approve_config`; cổng bộ máy chi `ie_spend_gate_v1` khi `enforce`.
  - Chép thang sang hàm xem trước là có công thức tiền thứ hai. Tách thang ra hàm dùng chung thì phải thay thân hàm ghi tiền gần 3 600 dòng.
  - Chạy thử dùng chính hàm ghi, không có bản sao nào.
- **Đã tra, không có dấu vết sau khi lùi:**
  - mã phiếu dùng bảng đếm, không dùng SEQUENCE (`M/20260925072852:105-111`);
  - `set_config(…, true)` của cổng chi bị hoàn khi khối con lùi;
  - `spend_decisions`, `spend_commitment_draws`, `canonical_write_operations`, `notifications`, audit, change-log đều là dòng trong DB.

  Chỉ còn khe trong id `income_expense_change_log_id_seq`; khe này vô hại.
- **Rào "birth boundary".** Duyệt hay chi trong cùng giao dịch với lúc lập bị chặn (`assert_committed_birth_boundary_v2`, 55000). Chạy thử duyệt chỉ áp cho phiếu đã có từ trước, nên không chạm rào này.
- **Chưa xác minh, kiểm ở tầng 2:**
  - khoá tư vấn `pg_advisory_xact_lock` (nếu hàm ghi dùng) được nhả khi khối con lùi hay giữ tới hết giao dịch xem trước. Giữ thì cũng chỉ trong một lời gọi ngắn;
  - thời gian chạy thử 5 khoản hoặc 10 phiếu (mục tiêu p95 dưới 2 s).

### 3.3 `basis` và lượt 2

| Thao tác | `basis` = md5 của | Lượt 2 |
| --- | --- | --- |
| `create` | Mỗi khoản: ID đã giải, tiền, ngày, kỳ, sổ, trạng thái dự kiến + lý do sinh, tập phiếu trùng, số còn lại của cam kết | **Cả lô hoặc không gì** (TC3). Mở biên nhận, rồi ghi từng khoản bằng khoá `hermes-expense:<rid>:<i>`. Đọc lại trạng thái và tính lại basis. Lệch, hoặc một khoản lỗi, thì `RAISE` để lùi cả lô và biên nhận, trả `state_changed` không chốt. Bản xem trước mới sẽ chỉ ra khoản có vấn đề |
| `edit` | ID phiếu, `approval_version`, `posting_version`, patch, ảnh chụp sau sửa | Hàm ghi tự CAS `approval_version` (PT409 / 55000) ⇒ `state_changed` không chốt |
| `cancel` | ID phiếu, `approval_version`, `posting_version`, `posting_status` | CAS hai version của hàm huỷ (40001) ⇒ `state_changed` không chốt |
| `approve` | Danh sách (ID, `approval_version`, `posting_version`, kế hoạch: duyệt+chi / chỉ duyệt, số chứng từ) | **Từng phiếu một**, mỗi phiếu một khối con (plan G4). Lệch version thì phiếu đó ra `state_changed`, còn phiếu khác vẫn chạy. Có ≥ 1 phiếu xong ⇒ chốt `applied` kèm kết quả từng mã. 0 phiếu xong mà có lý do cuối ⇒ chốt `rejected`. Tất cả `state_changed` ⇒ không chốt |
| `note` | — | `auto`: ghi thẳng bằng khoá `hermes-note:<rid>`; biên nhận như thao tác thử |

**Phân loại lỗi hàm ghi ở lượt 2:**
- **Lỗi tạm hoặc lệch phiên bản.** Gồm `40001`, `40P01`, `55P03`, `PT409`, `55000 … version mismatch`, `Phiếu vừa được người khác …`. Bước ghi `RAISE` để lùi, rồi ra `state_changed`.
- **Mọi lỗi khác.** Chốt `rejected` kèm mã lý do, và phát lại y nguyên khi gọi lại cùng `requestId`.

## 4. Giải tên và hai hàm dùng chung mới

### 4.1 Toà, phòng

Dùng `public.hermes_write_name_resolve_v1` (D7) cho từng khoản, trong phạm vi toà của khoá ghi. Phòng chỉ khớp bằng. "201" mà không nêu toà và có ở nhiều toà thì trả `needs_input` kèm ứng viên.

### 4.2 Hạng mục: `public.ie_category_suggest_v1(p_organization_id uuid, p_texts text[])` (dùng chung với web)

- **Nguồn luật.** Luật đang nằm ở `src/lib/quickEntry/categoryRules.ts` (248 dòng):
  - `OWNER_RULES`, `STRONG`, `DISTINCT`, `PHRASE_NOT`, `NGUOI_NGOAI` viết cứng trong TS;
  - `income_expense_types.rule_key` / `keywords` trong DB.

  Port sang SQL gồm hai phần:
  - đặc tả luật thành dữ liệu trong một hàm IMMUTABLE `public.ie_category_rule_spec_v1()`. Đổi luật bằng migration;
  - thuật toán `ruleMatch` thành hàm STABLE INVOKER:
    - chuẩn hoá có dấu và không dấu như `accentedText` / `bareText`;
    - chỉ dùng dạng không dấu khi cả câu gõ không dấu;
    - luật chủ chạy theo thứ tự ưu tiên, có loại trừ `not`;
    - từ khoá DB chỉ nhận cụm ≥ 2 từ hoặc từ trong `DISTINCT`;
    - chỉ trả kết quả khi đúng một hạng mục khớp;
    - có cờ `strong`.
- **Kết quả.** Mỗi câu ra `{typeId, ruleKey, strong} | null`. Hàm đọc `income_expense_types` dưới RLS người gọi và lọc `organization_id` tường minh.
- **Hermes:**
  - `category` có giá trị thì giải theo tên: bỏ dấu, khớp bằng rồi khớp chứa duy nhất, trong tập `hermes_expense_category_ok_v1`;
  - `category` trống thì gọi hàm này với `content`. Một kết quả ⇒ dùng, và bản xem trước ghi "hạng mục tự chọn theo nội dung: …";
  - null hoặc nằm ngoài tập Hermes ⇒ `needs_input` (`field: 'category'`), ứng viên là hạng mục gần nhất. **Không chọn "Chi khác" thay người dùng** (plan B3).
- **Web.** `categorySuggest.ts` gọi một RPC cho cả lô thẻ thay `ruleMatch`; phần AI phía sau giữ nguyên. Hiện `suggestCategory` chạy đồng bộ trong `compose.ts` (2 chỗ gọi), nên Mốc 5 phải đổi bước gợi ý hạng mục sang bất đồng bộ.
- **Parity.** `src/lib/quickEntry/__tests__/fixtures/cau-chi-that-2026-10.json` có 414 câu. Commit chuyển đổi chạy cả TS lẫn SQL trên PG17 dùng một lần và bắt hai kết quả giống hệt. Sau đó TS `ruleMatch` bị xoá, bộ câu chỉ chạy trên SQL. Mục tiêu giữ như hiện nay: 292 câu khoá đúng, 0 câu sai.

### 4.3 Sổ quỹ: `public.ie_default_cashbook_v1(p_organization_id uuid, p_building_id uuid, p_last_used uuid DEFAULT NULL)` (dùng chung)

- **Thứ tự chọn.** Đúng `pickDefaultAccount` của `cashbook.ts`: sổ gắn toà (`quick_default_building_id`) → `p_last_used` nếu còn dùng được → sổ `is_default` → sổ đầu tiên. Tập sổ = `list_cashbooks_for_expense_v2()` ∩ công ty, bỏ sổ ảo.
- **Web.** Truyền id "sổ dùng lần trước" đang giữ trong localStorage, nên hành vi web không đổi.
- **Hermes.** Truyền sổ của phiếu CHI lập tay gần nhất của chính người dùng. Xem trước luôn nêu tên sổ.
- **Sổ nêu tên.** Giải trong cùng tập sổ (bỏ dấu, bằng rồi chứa duy nhất). Sổ thấy được nhưng không dùng được (không giữ) ⇒ `cashbook_not_held` ngay ở lượt 1, TRƯỚC câu hỏi hạng mục (lượt 19, mục 30).

### 4.4 Mã phiếu

Lõi giải tên tìm `income_expenses.code` trong công ty, dưới RLS `income_expenses` của người hỏi. Mã cũ có thể trùng giữa các dãy (trước 25/09), nên khớp ≥ 2 phiếu ⇒ `needs_input` (`field: 'voucher'`). Mỗi ứng viên ghi "mã · ngày · toà · số tiền". Không có ứng viên ⇒ `not_found`.

### 4.5 "Lập tay" và loại phiếu

Phiếu lập tay theo đúng allow-list của `app_private.assert_manual_voucher_v1` (`B:2440`):
- không có hàng flow ownership, hoặc flow là `CANONICAL_INCOME_EXPENSE`;
- không gắn hoá đơn hay thanh toán;
- không gắn lương, cổ đông hay quản lý lợi nhuận;
- không phải bút toán đảo;
- không thuộc bàn giao;
- `system_source IS NULL`;
- không giữ chỗ chi lợi nhuận.

Bổ sung cho thao tác ghi:
- **Chỉ phiếu CHI.** Phiếu THU ⇒ `web_only`.
- **Phiếu con định kỳ** (tự lập từ phiếu lặp): nhận diện bằng `income_expenses.repeat_parent_id` (`generate_recurring_vouchers`). Mặc định TẠM coi là KHÔNG lập tay (TC5, cờ `expense.recurring_child_manual`, mục 19).

## 5. Xem trước nói gì

Mỗi bản xem trước có `summary` (một câu để bot đọc nguyên văn) và dữ liệu có cấu trúc. Giá trị là tiếng Việt; tiền viết cả số lẫn chữ dạng `350.000đ`. Bản xem trước không chứa UUID.

```text
create  summary: "Ghi 2 phiếu chi, tổng 1.550.000đ."
        items: [{stt:1, building:"1392QT", room:"201", category:"Mua đồ điện nước", categoryAuto:true, content:"mua vòi nước",
                 amount:"350.000đ", payee:"anh thợ", voucherDate:"22/10/2026 (thứ Năm, hôm nay)", cashbook:"Tiền mặt 1392QT",
                 willBe:"VÀO SỔ NGAY khi ghi (dưới ngưỡng tự duyệt 600.000đ) — trừ sổ Tiền mặt 1392QT"},
                {stt:2, …, willBe:"CHỜ DUYỆT: hạng mục 'Đóng tiền nước' bắt buộc duyệt"}]
        warnings: ["Khoản 2: cam kết tiền nước 15KV tháng 10 còn 200.000đ; khoản này vượt cam kết", "Khoản 1: chưa có ảnh — …"]
edit    summary: "Sửa phiếu PC2610xxx (chờ duyệt): số tiền 400.000đ → 450.000đ; lý do: ghi nhầm."  before/after từng trường; willBe sau sửa
cancel  summary: "Huỷ phiếu PC2610xxx — 350.000đ, Mua đồ điện nước, 1392QT, lập 21/10."
        willBe: "ĐÃ VÀO SỔ Tiền mặt 1392QT ⇒ huỷ sẽ tạo bút toán đảo, KHÔNG khôi phục được"  |  "chưa vào sổ ⇒ huỷ, giải phóng cam kết"
approve summary: "Duyệt 3 phiếu: chi 2 phiếu (1.200.000đ) khỏi sổ Tiền mặt 44TL, chỉ duyệt 1 phiếu chưa có ảnh."
        items: [{code, content, building, category, amount, maker, ageDays, attachments, cashbook,
                 plan:"duyệt + chi" | "chỉ duyệt (chưa có ảnh)" | "chỉ duyệt (anh/chị không giữ sổ …)" | "không làm: <câu lý do>"}]
```

- **Lý do sinh.** Lấy từ lần chạy thử: mã lý do của bộ máy chi trong `spend_decisions` (`UNDER_THRESHOLD`, `SELF_APPROVER`, `OVER_THRESHOLD`, `FORCE_APPROVAL`, `WITHIN_/OVER_COMMITMENT`, `NO_CASHBOOK`), đổi ra câu tiếng Việt. Nếu Mốc 2 thấy hàm ghi không chèn `spend_decisions` cho mọi phiếu, câu "vì …" dựng từ dữ kiện:
  - cờ `force_approval`;
  - ngưỡng;
  - quyền duyệt của người lập;
  - kết quả cổng chi.

  Khi đó câu này chỉ để giải thích. Trạng thái luôn lấy từ hàm ghi.
- **Khoản không ghi được trong lô.**
  - Lỗi tên (mơ hồ, không thấy) ⇒ cả lô `needs_input`. `wanted` chỉ ra khoản nào.
  - Lỗi nghiệp vụ ở lần chạy thử ⇒ lô bị từ chối với lý do đầu tiên, kèm `summary` nêu khoản số mấy. Không cho đồng ý một lô "ghi một phần" (TC3).
- **Q8, phiếu không ảnh.** Phiếu chưa có ảnh thì kế hoạch luôn là "chỉ duyệt". Người duyệt không giữ sổ của phiếu thì cũng "chỉ duyệt" (TC4). Bản xem trước nói rõ cả hai.
- **Q25.** `approve_income_expense_v2` / `approve_and_post_income_expense_v2` đã đòi quyền `income_expenses.approve`, và khoá Hermes giao vào cũng là quyền này. Người lập không có quyền duyệt vì vậy không tự duyệt được qua bot.
  - PR #263 (draft) chỉ chặn hai hàm duyệt cũ `approve_income_expense_v1` và `approve_voucher`.
  - Nếu #263 gộp trước Mốc 4, bước duyệt gọi thêm `app_private.ie_self_approve_over_threshold_blocked_v1`. Trường hợp `true` thì ra `not_allowed`, làm rào thứ hai.

## 6. Đọc bù (W2, không thêm tool)

Đọc bù gồm 4 báo cáo thêm vào gói B (`tai_chinh`, `HB/wave2-b-contract.mjs`), quyền `income_expenses.view`, phạm vi `rows`:
- hạng mục hạn chế, lương, cổ đông bị bỏ như `crm_read_income_expenses`;
- tiền là chuỗi số nguyên;
- có `link`.

| Báo cáo | Tham số (đã có trong `W2_PARAMS`) | Hàng / summary | Câu đo nền r1 |
| --- | --- | --- | --- |
| `voucher_detail` | `query*` = mã phiếu | người lập, ngày lập/ngày phiếu, toà/phòng, hạng mục, sổ, tiền, trạng thái duyệt/sổ, review, số ảnh, số lần sửa + lần sửa cuối (trường, lý do), link; mã trùng ⇒ ≤ 5 hàng | P5 |
| `pending_vouchers` | `days` (chờ quá N ngày, theo ngày lập), `buildingId` | phiếu chờ duyệt sắp theo tuổi: mã, toà, tiền, người lập, ngày lập, tuổi, có ảnh, lập tay; summary `count`, `olderThanDays`, `byBuilding` | (b) "chờ duyệt quá N ngày" đếm đúng |
| `expenses_by_amount` | `month*`, `buildingId` | phiếu CHI đã duyệt của tháng, sắp tiền giảm dần, phân trang 50; summary `count`, `total` | (a) "các khoản chi trên X triệu": đọc trang đầu tới khi dưới ngưỡng, không lọc tay 3 trang |
| `expense_by_category` | `month` hoặc `fromDate`/`toDate`, `buildingId`, `query` (tên hạng mục, bỏ dấu, chứa) | tổng CHI đã duyệt theo (toà, hạng mục): tiền, số phiếu | (c) "tiền điện nước toà X tháng Y hết bao nhiêu" |

- Bộ khung W2 cấm gói A–D sửa `wave2-kit.mjs`. Vì vậy không thêm tham số `minAmount`; câu (a) dùng báo cáo đã sắp theo tiền.
- `fa_type_breakdown` / `bp_categories` đã có tổng theo hạng mục, nhưng cần khoá `reports_finance.*` hạn chế đang tắt. `expense_by_category` là bản không gồm hạng mục hạn chế, dưới quyền xem thu chi.
- Thay `app_private.hermes_w2b_catalog_v1` / `hermes_w2b_read_v1` bằng migration mới, có ghim md5 thân đang chạy (bài học #267: dựng từ thân cũ có thể gỡ bản vá).
- Chưa xác minh: `w2Report` có nhận khoá đọc cũ `income_expenses.view` không. Nếu không, phải dùng khoá đọc khác.

## 7. Connector

1. `HB/expense-actions-contract.mjs`: danh mục 5 thao tác bằng `defineAction`, `rpc: 'hermes_expense_write_v1'`.
2. `HB/server.mjs` nạp danh mục production. Thao tác chỉ hiện khi khoá được bật và `hermes_action_capabilities_v1` cấp. Thiếu RPC trang (PGRST202) ⇒ `action_disabled`, như khung đã xử.
3. TC1 = dùng lại khoá ⇒ gỡ hẳn họ cũ khỏi connector:
   - `expense-action-*.mjs`;
   - `createExpenseActionAuth` / `createExpenseActionService`;
   - nhánh `crm_expense_*` trong `broker.mjs`;
   - các phép đo của họ cũ.

   SQL cũ giữ nguyên, không DROP. Bỏ luôn rào "họ cũ ẩn khi họ thao tác hiện", vì không còn họ cũ.
4. Đổi nhãn `income_expenses.create` ở `src/hermes/capabilityLabels.ts` cho đúng: "phiếu dưới ngưỡng, hoặc do người có quyền duyệt lập, vào sổ ngay; luôn có xem trước". Nhãn `income_expenses.approve` đổi thành "không còn công cụ dùng". Web phải build lại.
5. `CONNECTOR.md`: thêm dòng `expense.*`, bỏ dòng họ cũ.
6. `tool-plan-cases.mjs` thêm ca:
   - "ghi phiếu chi" ⇒ `crm_action_run expense.create`;
   - "duyệt phiếu PC…" ⇒ `expense.approve`;
   - "thu 200k…" ⇒ không có thao tác (phiếu THU).

**Byte `tools/list`:** không đổi. Danh mục nằm trong kết quả `crm_action_list`; họ thao tác vẫn 1 959 B (đo của nền chung).

## 8. Kiểm thử

### 8.1 Tầng 1, offline (`node:test`)

- **Danh mục:**
  - khuôn từng thao tác;
  - kiểu `list` / `record`: biên 1–5 và 1–10, khoá lạ trong record, gợi ý tĩnh dạng `items[2].amount (…)`;
  - snake_case trong record.
- **Runtime với dịch vụ giả:**
  - lô 5 khoản ra một token;
  - lượt 2 đổi một khoản ⇒ `confirmation_invalid`;
  - `needs_input` cho `category`, `cashbook`, `voucher` kèm ứng viên;
  - sàn xác nhận: `create/edit/cancel/approve` luôn xem trước dù chính sách ghi `never`; `note` ghi thẳng;
  - `approve` trả kết quả từng mã.
- **Lý do:** `system_voucher`, `evidence_required` có câu tĩnh, có trong `AUDIT_REASONS`, `mcp-http` chuyển được. Test `audit-codes` khoá hai tập bằng nhau.
- **Byte:** họ thao tác giữ nguyên. Gỡ họ cũ ⇒ cập nhật `tool-argument-shape` / `action-tools-budget`.
- **Kiểm đột biến** (Contract §8). Gỡ từng rào sau thì phải có test đỏ:
  - sàn xác nhận;
  - kiểm phạm vi của bản đã giải ở lượt 2;
  - lô cả-hoặc-không;
  - "chỉ duyệt khi không ảnh";
  - danh sách lý do.

### 8.2 SQL, PG17 dùng một lần (khuôn `action-foundation-sql.test.mjs`)

Hàm ghi thật quá lớn để nạp ở đây, nên dùng hàm ghi giả cùng chữ ký. Các phép kiểm:
- chạy thử không để lại dòng nào: biên nhận, phiếu, bộ đếm mã;
- `basis` lệch ⇒ `state_changed` không chốt;
- lỗi cuối ⇒ chốt và phát lại;
- lô lỗi một khoản ⇒ lùi cả lô;
- duyệt từng phiếu;
- bảng câu lỗi thật ở mục 2.3 (chép từ hàm ghi) ⇒ đúng mã;
- vỏ là SQL-standard;
- không cấp EXECUTE thừa;
- ràng buộc trigger "settled".

Hai hàm dùng chung cũng chạy trên PG17:
- `ie_category_suggest_v1`: 414 câu;
- `ie_default_cashbook_v1`: bảng ca của `cashbook.ts`.

### 8.3 Tầng 2, SQL thật trên TEST, không model (`npm run test-env:thu-sql`, ROLLBACK, không `--ghi`)

- **Ghép file.** `thu-sql` từ chối file tự mở hay đóng transaction. Script ghép bỏ `BEGIN;`/`COMMIT;` của các migration, rồi nối thêm kịch bản.
- **Kịch bản, chạy trong cùng transaction rồi ROLLBACK:**
  1. Bật khoá ở registry.
  2. Tạo kết nối, phiên và binding thử cho từng persona.
  3. Đặt `request.jwt.claims`, rồi `SET ROLE authenticated`.
  4. Gọi `hermes_expense_write_v1` qua preview → apply.
  5. `SET CONSTRAINTS ALL IMMEDIATE` để kích trigger biên nhận.
  6. Chấm bằng SELECT.
- **Persona:**
  - chủ: giữ sổ, có quyền duyệt;
  - Quản Lý Tòa trong phạm vi: có tạo, không duyệt;
  - Quản Lý Tòa ngoài phạm vi;
  - vai thiếu quyền huỷ.
- **Chấm:**
  - `income_expenses` (trạng thái, tiền, toà, hạng mục, sổ);
  - `income_expense_postings`;
  - `spend_decisions` / `spend_commitment_draws`;
  - `canonical_write_operations`;
  - `app_private.hermes_action_receipts`;
  - audit `HERMES_ACTION_*`;
  - `app_private.spend_ledger_audit_v1()` = 0 lệch.
- **Tầng này cũng đo:** độ trễ chạy thử, khoá tư vấn, câu lỗi thật của TEST.

### 8.4 Tầng 3, bot thật (phiên chính)

Ma trận độc lập ≥ 60 câu do phiên chính soạn. Mỗi ca chạy 3 lần; đạt khi 0 ghi sai và ≥ 95 % ca đạt cả 3 lần. Phiên con soạn 20 ca phát triển ở `thu-chi-ca-phat-trien.json` (scratchpad của phiên chính) để phiên chính chạy giúp khi cần.

## 9. File dùng chung (giữ khối nhỏ, gom riêng)

| File | Đổi | Ghi chú gộp |
| --- | --- | --- |
| `HB/action-catalog.mjs` | `param.list(item, {min, max})`, `param.record(fields)` (chỉ trong list, ≤ 12 trường vô hướng); `param.name` thêm `category`, `cashbook` | Hợp đồng cần `list` cho gia hạn lô ≤ 20. Phiên chính chốt một bản; phiên gộp sau rebase và dùng lại |
| `HB/action-contract.mjs` | `NAME_FIELDS` / `LABELS` thêm `category` (hạng mục), `cashbook` (sổ quỹ) | 2 dòng |
| `HB/action-reasons.mjs` + `infra/hermes-runtime/host-ownership.mjs` | `system_voucher`, `evidence_required` | Khối "Thu chi" riêng trong mỗi file |
| `src/hermes/capabilityLabels.ts` | Nhãn `income_expenses.create` / `.approve` | — |
| `CONNECTOR.md`, `supabase/migration-provenance.json`, `tooling/test-matrix.json`, `scripts/hermes-task-function-contract.mjs` | Dòng của Thu chi | Sinh lại bằng generator khi xung đột |

## 10. Migration dự kiến (chỉ file; phiên chính áp qua lane)

Tên lấy bằng `scripts/tao-ten-migration.mjs` ở mốc tương ứng.

| # | Nội dung | Mốc |
| --- | --- | --- |
| TC-M1 | `public.ie_category_rule_spec_v1`, `public.ie_category_suggest_v1`, `public.ie_default_cashbook_v1` (INVOKER, `search_path=''`, `authenticated`) | 2 |
| TC-M2 | `app_private.hermes_expense_reason_v1`, `…_resolve_core_v1`, `…_write_step_v1`, vỏ `public.hermes_expense_write_v1`; 5 dòng `hermes_action_policies`; GRANT như thao tác thử; khối kiểm catalog | 2 (create/note), 3 (edit/cancel), 4 (approve) — một migration mỗi mốc, mỗi lần `CREATE OR REPLACE` bước ghi có ghim md5 thân trước |
| TC-M3 | W2 gói B: 4 báo cáo (thay catalog + read có ghim md5) | 5 |
| (phiên chính) | Bật khoá registry: `income_expenses.create` (create + note) → `.edit`, `.cancel` → `.approve_vouchers`. Mỗi migration bật kèm rào legacy như `M/20261021113528` | sau mỗi mốc |

Có hàm public mới ⇒ chạy `gen:types` sau khi áp.

## 11. Rủi ro

| Rủi ro | Mức | Giảm |
| --- | --- | --- |
| Chạy thử hàm ghi để lại dấu vết chưa thấy (khoá tư vấn, bảng ngoài) | Vừa | Đã tra trigger, bộ đếm, `pg_net`. Tầng 2 so bảng trước/sau trên TEST. Nếu có dấu vết, lùi về phương án tách `ie_birth_decision_v1` (đổi hàm ghi, cần kiểm đột biến + reconcile-money) |
| Bot tự gọi lượt 2 khi người dùng chưa đồng ý | Cao (tiền) | Sàn xác nhận, câu `huongDan`, SOUL. Ca N10 của nền chung đo lại cho Thu chi |
| Nhầm ×1 000, nhầm toà/phòng | Cao | Phòng chỉ khớp bằng; tiền viết cả chữ; nhắc "không tròn nghìn", "≥ 50 triệu"; xem trước luôn nêu tên toà, phòng, sổ |
| Gợi ý hạng mục SQL lệch TS | Vừa | 414 câu parity trước khi xoá TS |
| Chi tiền nhầm phiếu (mã cũ trùng giữa các dãy) | Vừa | Mã khớp ≥ 2 ⇒ hỏi lại kèm ngày/toà/tiền; bản xem trước của duyệt nêu nội dung từng phiếu |
| Gỡ họ phiếu chi cũ làm đỏ test byte / composition | Thấp | Cùng commit cập nhật phép đo; production không quảng bá họ cũ (khoá đang tắt) |
| Bật `approve_vouchers` ⇒ mọi kết nối `inherit_crm` có quyền duyệt CRM nhận ngay | Vừa | Hiện mọi kết nối là của chủ. Trước khi cấp Hermes cho Quản Lý Tòa (Q7) phải loại trừ khoá này hoặc làm O2 (nền chung §8.3) |
| Thay dispatcher W2 gói B gỡ mất bản vá | Vừa | Ghim md5 thân đang chạy; gộp `main` trước khi áp |
| Xung đột file dùng chung với Hợp đồng | Thấp | Khối riêng; phiên gộp sau rebase |
| Chạy thử để lại khe số trong `app_private.income_expense_change_log_id_seq` | Thấp | **Chấp nhận** (phiên chính, 22/10): chỉ là khe số id nhật ký, không phải dữ liệu tiền; SEQUENCE vốn không theo giao dịch |
| Hai requestId khác nhau, cùng nội dung, chạy song song ⇒ cả hai đều ghi | Thấp | Chấp nhận (review Mốc 2+3): chống trùng chỉ là cảnh báo ở bản xem trước ("đã có phiếu … CÙNG SỐ TIỀN"), giống web. Cùng một requestId thì phát lại đúng kết quả đã chốt |
| Guard Hermes (role_bindings) và hàm ghi web (staff_assignments) cho hai tập toà khác nhau | Vừa | Mốc 3: phạm vi thao tác thu chi = guard ∩ `authorize_income_expense_on_building` gọi y như hàm ghi (mục 17). Tài khoản chỉ có role_bindings cũng không lập được phiếu trên web — việc của chủ/phiên chính |

## 12. Điểm cần chốt (mặc định đề xuất in đậm)

| # | Câu hỏi | Mặc định |
| --- | --- | --- |
| TC1 | Khoá cho lập phiếu và ghi chú | **Dùng lại `income_expenses.create`, gỡ họ `crm_expense_*` khỏi connector cùng bản** (Q4: "tắt tới khi bản mới xong"). Phương án khác là khoá Hermes mới: phải seed thêm, và họ cũ thành mã chết |
| TC2 | Xem trước bằng cách nào | **Chạy thử hàm ghi thật trong savepoint.** Phương án khác: tách `ie_birth_decision_v1` và thay thân hàm ghi |
| TC3 | Lô 5 khoản ở lượt 2 | **Cả lô hoặc không gì; khoản nào lỗi ⇒ xem trước lại cả lô.** Phương án khác: ghi từng khoản |
| TC4 | Duyệt khi phiếu không ảnh hoặc người duyệt không giữ sổ | **Tự hạ xuống "chỉ duyệt" và nói rõ trong bản xem trước** (Q8). Phương án khác: từ chối phiếu đó |
| TC5 | Phiếu con của phiếu lặp có được bot duyệt | **Đã chốt khác mặc định:** làm thành cờ chính sách trong DB, không viết cứng trong mã. Mặc định tạm là "không" cho tới khi chủ trả lời câu 55; đổi cờ không cần sửa mã. Làm ở Mốc 4 |
| TC6 | Quyền CRM giao vào cho sửa / huỷ | **`income_expenses.create`**, giống web: người lập sửa/huỷ phiếu của mình; hàm ghi kiểm phần còn lại. Phương án khác: `income_expenses.edit` / `.cancel` (Quản Lý Tòa thiếu hai quyền này sẽ không tự sửa/huỷ được phiếu mình lập qua bot) |
| TC7 | Q8 "cần kết nối mới" | **Coi là đạt khi chủ tạo lại kết nối "NG TÂM" một lần (Q27) trước khi bật `approve_vouchers`.** Kết nối của Quản Lý Tòa loại trừ khoá này |
| TC8 | Kiểu `list` / `record` trong danh mục chung | **Thu chi viết ở Mốc 2; Hợp đồng dùng lại.** Ai gộp sau thì rebase |
| TC9 | Sổ mặc định phía web | **Hàm SQL nhận `p_last_used`; web giữ localStorage**, nên hành vi web không đổi |
| TC10 | Đọc bù đặt ở đâu | **Gói W2 B, quyền `income_expenses.view`.** Mốc 3 thêm tham số `minAmount` vì phiên chính yêu cầu lọc theo ngưỡng tiền (mục 17) |

## 13. Các mốc

| Mốc | Nội dung | Test | Công |
| --- | --- | --- | --- |
| 1 | Tài liệu này | docs gate | 0,5 |
| 2 | `list`/`record`; TC-M1 (hạng mục, sổ, 414 câu parity); TC-M2 phần create + note; danh mục connector; gỡ họ cũ (TC1); lý do mới | tầng 1 + PG17 + tầng 2 (A, B, C, H của plan §6) | 3–4 |
| 3 | (phiên chính đổi thứ tự 22/10) Phạm vi ghi = hàm kiểm quyền của hàm ghi; toà ảo; đọc bù W2 (phiếu chi theo tiền/tuổi, tổng theo hạng mục, gợi ý tham số W2) — mục 17 | tầng 1 + 2 | 2 |
| 4 | `edit` + `cancel` (TC-M2 lượt 2), cam kết Q12 trong xem trước, cờ TC5 | tầng 1 + 2 (E, F) | 2 |
| 5 | `approve` lô ≤ 10, duyệt / duyệt + chi, hạ "chỉ duyệt" | tầng 1 + 2 (G) | 2 |
| 6 | Web Báo chi nhanh gọi SQL dùng chung (Playwright màn bị đổi, `e2e:fleet:bien-nhan` nếu manifest đòi); nhãn; `CONNECTOR.md` | parity + màn web | 1–2 |

## 14. Việc phiên chính phải làm

1. Chốt TC1–TC10.
2. Sau mỗi mốc, áp TC-M* lên TEST rồi production qua `migrate:forward`. Chạy `gen:types`. Phát hành connector **trước** migration bật khoá: connector chịu được thiếu RPC trang.
3. **Trên TEST:** bật lần lượt `income_expenses.create` → `.edit`, `.cancel` → `.approve_vouchers` bằng script TEST, rồi chạy ma trận ≥ 60 câu. Kết nối TEST giữ khoá tương ứng.
4. Promote web cùng lúc với nhãn mới và Báo chi nhanh gọi SQL (Mốc 5).
5. **SOUL bản 5, đoạn Thu chi đề xuất:**
   - "Ghi/chi … tiền" ⇒ `crm_action_run` `expense.create` với `items` (mỗi khoản một mục, tối đa 5).
   - Đọc nguyên văn `summary` và `willBe` từng khoản, cùng mọi `warnings`. Chỉ gọi lượt 2 khi người dùng đồng ý rõ sau khi xem.
   - Không tự chọn hạng mục "Chi khác". Hạng mục không chắc thì hỏi.
   - "Thu …", bỏ cọc, hoàn cọc, hoa hồng, thanh lý, lương, chia lợi nhuận ⇒ không lập phiếu; chỉ đường web.
   - Ảnh bill: nói chưa nhận ảnh qua Zalo; đưa `link` để thêm ảnh trên web.
   - "Duyệt phiếu …" ⇒ `expense.approve`. Đọc rõ phiếu nào chi, phiếu nào chỉ duyệt.
   - (tên báo cáo chốt ở Mốc 3) "Khoản chi lớn nhất / chi trên X triệu / chi ở toà nào (kể cả kho, văn phòng chung)" ⇒ `crm_read_report` `expense_vouchers` (`fromDate`/`toDate`, `minAmount`, `buildingName`); đọc `summary.count`, `totalAmount`, `maxAmount`, không tự cộng các trang. "Phiếu chờ duyệt lâu nhất" ⇒ `expense_vouchers` `status=UNAPPROVED`, `kind=oldest` (`pendingDays`). "Tháng trước trả tiền nhà / điện / nước bao nhiêu" ⇒ `expense_categories`, đọc `summary.categories`. `top_expenses` chỉ cho tab Chi phí của Phân tích tài chính (một tháng, 10 khoản KQKD).
6. Trước khi cấp Hermes cho Quản Lý Tòa (Q7): loại trừ `income_expenses.approve_vouchers` trong kết nối của họ, hoặc làm O2.

## 15. Chưa xác minh

- `spend_decisions` có được chèn cho mọi phiếu do `create_income_expense_v1` lập không, hay chỉ khi bộ máy chi ở chế độ bóng (`zz_spend_shadow_birth`). Nếu không, câu "vì …" dựng từ dữ kiện (mục 5).
- ~~Khoá tư vấn và thời gian chạy thử (tầng 2).~~ Đã đo ở Mốc 2 (mục 16).
- ~~Nguồn ánh xạ hạng mục → `fee_category` của cam kết.~~ Dùng cột `income_expense_types.fee_category` (mỗi khoản phí là duy nhất trong mỗi công ty từ 26/09).
- ~~Cột nhận diện phiếu con định kỳ (Mốc 4).~~ `repeat_parent_id` (mục 19).
- ~~`w2Report` nhận `income_expenses.view`.~~ Đã dùng ở Mốc 3 (khoá đợt 1 dùng lại, đã bật).
- ~~Hàm ghi gọi từ bước DEFINER của Hermes chạy giống như khi web gọi.~~ Đã thấy trên TEST ở Mốc 2: hàm ghi web nhận đúng người dùng của JWT.

## 16. Tiến độ Mốc 2 (22/10/2026)

**Đã làm:**
- Kiểu `list`/`record` trong `HB/action-catalog.mjs` (TC8). Phiên Hợp đồng dùng lại cho gia hạn lô.
- Thêm `category`, `cashbook` vào `NAME_FIELDS`.
- Hai mã lý do `system_voucher`, `evidence_required` vào `action-reasons.mjs` và `host-ownership.mjs`.
- Danh mục `HB/expense-actions-contract.mjs` gồm `expense.create` và `expense.note`; `server.mjs` nạp danh mục này ở production.
- Gỡ họ `crm_expense_*` khỏi connector (TC1). SQL cũ giữ nguyên.
- Đổi nhãn `income_expenses.create` / `.approve`.
- Hai migration, chỉ là file:
  - `20261022024045_ie_quick_entry_shared_rules_v1`: `ie_category_suggest_v1` (port đủ bốn đường của `suggestCategory`), `ie_default_cashbook_v1`, `ie_quick_text_v1`;
  - `20261022024834_hermes_expense_write_v1`: RPC trang, chạy thử để xem trước, lượt 2 cả lô hoặc không gì.

**Kiểm:**
- Offline: danh mục, `list`/`record`, lõi chạy với dịch vụ giả, byte `tools/list` (họ thao tác không đổi; họ cũ đã gỡ).
- PG17: `ie_category_suggest_v1` khớp 610/610 câu của bộ vector vàng do TypeScript sinh (`src/lib/quickEntry/__tests__/fixtures/goi-y-hang-muc-vang.json`).
- PGlite: bước ghi với bản port hàm ghi, 9/9.
- Kiểm đột biến 19/19 bị bắt.
- Hợp đồng duyệt hàm Hermes: ghim băm vỏ, ghim định nghĩa forward, danh sách được cấp EXECUTE, `search_path=''`.

**Tầng 2 trên TEST** (`test-env:thu-sql`, một giao dịch ROLLBACK, không `--ghi`; bật khoá, gia hạn token và cấp giữ sổ chỉ tồn tại trong giao dịch). Ba kết nối Hermes thật:

| Persona | Bản xem trước | Lượt 2 | Độ trễ (xem trước 1 khoản / lô 5 / ghi) |
| --- | --- | --- | --- |
| Quản Lý Tòa, 1.200.000đ | "CHỜ DUYỆT: từ ngưỡng tự duyệt 600.000đ trở lên…" | UNAPPROVED, mã liền số | 1,36 s / 0,91 s / 0,59 s |
| Super Admin, 1.000đ | "VÀO SỔ NGAY khi ghi (dưới ngưỡng tự duyệt 600.000đ) — trừ sổ …" | APPROVED + POSTED, một bút toán sổ | 0,48 s / 0,65 s / 0,63 s |
| Chủ (tài khoản TEST) | `not_allowed` | — | 0,80 s |

- **Đo TC2.** Sau các lần chạy thử, các bảng sau đều đếm bằng trước:
  - phiếu, dòng, bộ đếm mã phiếu;
  - quyết định chi, sổ tiêu cam kết, sổ thao tác canonical, bút toán;
  - chứng từ, audit, thông báo;
  - `net.http_request_queue`;
  - `pg_notification_queue_usage()` = 0.

  Khoá tư vấn của phiên vẫn bằng 0 sau xem trước; lượt ghi thật giữ một khoá tới hết giao dịch, như hàm ghi web vẫn làm. Lượt 2 lấy đúng mã kế tiếp, nghĩa là chạy thử không làm nhảy số. Phát lại cùng `requestId` cho kết quả giống hệt. Ghi chú ghi được.
- **Dấu vết duy nhất:** SEQUENCE `app_private.income_expense_change_log_id_seq`. Mỗi lần chạy thử 1 khoản tốn vài id, lô 5 khoản khoảng 24 id. SEQUENCE không lùi theo savepoint, kể cả theo ROLLBACK của `thu-sql`. Đó chỉ là khe trong id nhật ký thay đổi, không phải dữ liệu nghiệp vụ.
- **Phát hiện 1.** Với tài khoản "chủ" của TEST, guard Hermes cho toà 102LVT vào phạm vi khoá `income_expenses.create`. Nhưng chính `create_income_expense_v1` từ chối: "Không có quyền tạo phiếu thu/chi cho toà này". Bot vì vậy báo `not_allowed` ngay ở bản xem trước, tức là đóng an toàn và không ghi gì. Phạm vi guard (`authorized_scope_v3` ∩ overlay ∩ `buildings.view`) và kiểm quyền của hàm ghi lệch nhau với tài khoản này; cần phiên chính xem lại vai của tài khoản đó.
- **Phát hiện 2.** Trên TEST, bộ máy chi không chèn `spend_decisions` cho các phiếu thử. Câu "vì …" khi đó dựng từ dữ kiện (ngưỡng, hạng mục bắt buộc duyệt); trạng thái vẫn lấy từ hàm ghi.

**Cờ TC5** (phiếu con định kỳ có tính là lập tay không) làm cùng thao tác duyệt ở Mốc 4.

## 17. Tiến độ Mốc 3 (22/10/2026)

Phiên chính đổi thứ tự: đọc bù lên trước vì bot đang chạy production. Năm migration, chỉ là file, chưa áp. Áp theo thứ tự tên, SAU hai file Mốc 2.

| File | Nội dung |
| --- | --- |
| `20261022044120_hermes_name_directory_virtual_v1` | `public.hermes_building_directory_v2` và `hermes_write_name_resolve_v2` (+ lõi): như v1, thêm tham số `p_include_virtual` (bắt buộc). Bản v1 không đổi |
| `20261022044123_hermes_expense_scope_v1` | `app_private.hermes_expense_scope_v1`; thay thân lõi giải tên, bước ghi, vỏ `expense.*` (cùng chữ ký) |
| `20261022044126_hermes_w2_min_amount_param_v1` | Tham số W2 `minAmount` (từ điển + bộ kiểm của nền đợt 2) |
| `20261022051029_hermes_w2b_expense_shared_v1` | Hàm đọc dùng chung CRM `public.ie_expense_vouchers_v1`, `ie_expense_categories_v1` (file không nêu hàm của trợ lý, như `20261018020050`) |
| `20261022051032_hermes_w2b_expense_reports_v1` | Hai mục catalog + một nhánh đọc của gói B. Thân dựng từ bản production (md5 catalog `80e6f676…`, đọc `4cdb4ef8…`) bằng script, chỉ thêm |

### 17.1 Lệch quyền guard ↔ hàm ghi (Phát hiện 1)

- **Nguyên nhân.** `create_income_expense_v1` (production = TEST, md5 `8fc6ec5f…`) kiểm `app_private.authorize_income_expense_on_building(actor, org, 'create', toà)`. Hàm này chỉ đọc `staff_assignments` (vai + người cấp là OWNER + toà/khu/mọi toà) và không có nhánh miễn cho chủ. Guard Hermes đọc `role_bindings` (`authorized_scope_v3`). Tài khoản "chủ" của TEST (`068a3985…`) có 2 role_bindings và 0 phân công, nên guard cho 19 toà còn hàm ghi không cho toà nào.
- Đề giao viết "tài khoản chủ không có `role_bindings`". Thực tế tài khoản thiếu `staff_assignments`. Test bám đúng thực tế.
- **Sửa.** `hermes_expense_scope_v1(binding, action)` lấy ctx của guard. Với `expense.create`, chỉ giữ toà mà `authorize_income_expense_on_building(app_private.current_uid_v1(), org, 'create', toà)` cho — đúng lời gọi của hàm ghi. Vỏ, lõi giải tên và bước ghi (cả hai lượt) cùng dùng tập này. Toà ngoài tập ⇒ `outside_scope` ngay khi giải tên.
- **Ghi chú.** `expense.note` khi phải xem trước cũng chạy thử `append_income_expense_supplement_v1` rồi lùi. Xem trước "được" thì ghi được.
- **Không đổi** guard chung và `hermes_action_capabilities_v1` (dùng chung mọi trang). Danh sách toà của khoá trên trang cài đặt Hermes vì vậy vẫn có thể rộng hơn tập ghi thật.
- **Đếm production** (chỉ đọc, 22/10): OWNER 4 người, 3 không có phân công (1 trong số đó có kết nối Hermes ACTIVE); PARTNER 2, 1 không có; STAFF 7, 5 không có. Những người này cũng không lập được phiếu trên web. Có cho phép hay không là việc của chủ/phiên chính.

### 17.2 Toà ảo

- Đọc: connector dùng `hermes_building_directory_v2(..., true)` cho khoá `income_expenses.view` (`crm_read_income_expenses` và hai báo cáo mới). Khoá khác giữ v1, nên tool dựa phòng vẫn bỏ toà ảo. Cache danh bạ tách theo loại.
- Ghi: lõi giải tên `expense.*` gọi `hermes_write_name_resolve_v2(..., true)`.

### 17.3 Đọc bù W2 (gói B, khoá `income_expenses.view`, không thêm byte `tools/list`)

Cả hai báo cáo lọc như trang Thu chi web: `income_expenses` dưới RLS, chưa xoá, phiếu CHI, ngày phiếu, mặc định đã duyệt + chờ duyệt. Chúng gồm mọi toà của khoá, kể cả toà ảo. Phiếu hạn chế của người khác chỉ hiện khi `restricted_view` của kết nối phủ mọi toà, như `top_expenses`.

- `expense_vouchers`:
  - lọc: `fromDate`/`toDate` (mặc định tháng này), `minAmount`, `status`, `query` (bỏ dấu; tên/mã/hạng mục), `buildingId`/`buildingName`;
  - sắp: `kind=largest` (mặc định) hoặc `oldest` (kèm `pendingDays`);
  - `summary` (`count`, `totalAmount`, `maxAmount`, `buildings`, `byBuilding` ≤ 30) tính trên MỌI phiếu khớp, hàng phân trang.
- `expense_categories`: hàng hạng mục × toà; `summary.categories` là tổng cả phạm vi theo hạng mục (≤ 100).
- `top_expenses` giữ nguyên (tab Chi phí của Phân tích tài chính); tiêu đề chỉ sang `expense_vouchers`.
- **Gợi ý tham số W2 (3c).** Với mã hiện tại, lời gọi của bosshuy (`buildingName` + `fromDate`/`toDate` cho `top_expenses`) ra `invalid_request` không kèm gợi ý; `backend_unavailable` không tái hiện được offline (dữ liệu toà production/TEST sạch, tập khoá đủ). Có thể bản connector đang chạy cũ hơn; cần đối chiếu log connector, tôi không chạm VPS. Nay khi `params` có tên lạ hoặc thiếu tham số bắt buộc, broker từ chối ngay bằng `invalid_request` kèm một câu tĩnh của đúng báo cáo: tên nhận, bắt buộc, và với `top_expenses` thì chỉ sang `expense_vouchers`/`expense_categories`. Danh sách đóng sinh từ sổ báo cáo; `mcp-http` chỉ chuyển câu trong danh sách.
- Mục (d), chưa làm: chi tiết một phiếu.

### 17.4 Kiểm

- **Offline:**
  - giải tên đọc (toà ảo chỉ với khoá thu chi, cache tách);
  - gợi ý tham số W2 (không chặn lời gọi đúng, kể cả `room_detail` với `buildingName` + `roomName`; không lặp giá trị đã gửi);
  - broker từ chối trước mount; sổ báo cáo.
- **PGlite gói B:**
  - parity với truy vấn trang Thu chi cùng vai;
  - toà ảo, ngưỡng, trạng thái, tuổi, chữ tìm bỏ dấu, phiếu hạn chế, theo hạng mục;
  - 5/5 đột biến bị bắt;
  - toàn file 58/58.
- **PGlite bước ghi:** thêm ca lệch quyền hai chiều, chủ không phân công, toà ảo ghi được, ghi chú chạy thử; 10/10; 5/5 đột biến bị bắt.
- **PG17:** danh bạ v2.
- **Hợp đồng hàm Hermes:** forward 23 file (sau khi gộp #267) / 87 định nghĩa; danh sách đọc SQL-standard đã duyệt; `search_path=''`; quyền EXECUTE.
- Đã gộp `main` có #263 (câu 25: người lập không tự duyệt phiếu chi vượt ngưỡng). #263 chỉ sửa đường duyệt; Mốc 5 phải tính đến nó.

**Tầng 2 trên TEST** (`test-env:thu-sql`, một giao dịch ROLLBACK, bốn kết nối thật):

| Kết nối | Tập toà guard / phạm vi mới | Kết quả |
| --- | --- | --- |
| Chủ, 0 phân công (`068a3985`) | 19 / 0 | Xem trước ở toà guard cho và ở Kho ⇒ `needs_input outside_scope` (0,25–0,31 s), không còn "giải được rồi `not_allowed`" |
| joey (`d1862993`) | 9 / 9, có Kho | Xem trước Kho "VÀO SỔ NGAY…", lượt 2 lập phiếu ở Kho Văn Phòng Chung (lùi khi kết thúc) |
| NG TÂM (`8d2beda3`) | 19 / 19, có Kho | Như joey |
| B.Huy (`e0dfbaa2`) | 13 / 13, không có Kho | — |

Danh bạ: v1 không có Kho; v2(true) có; v2(false) không có (cả bốn kết nối, theo RLS từng người).

Đọc W2 qua lối vào thật `public.hermes_w2_read_v1`, so với truy vấn trang Thu chi cùng JWT. Số liệu TEST đồng bộ từ production nên gần bằng production, không bằng tuyệt đối.

| Câu (ma trận lượt 2) | Báo cáo | Kết quả | Web cùng JWT |
| --- | --- | --- | --- |
| joey: tháng này Kho Văn Phòng Chung chi bao nhiêu | `expense_vouchers` buildingId=Kho | 10 phiếu, 304.023.000, lớn nhất 122.407.000 (0,24 s) | 10 / 304.023.000 |
| Các khoản chi trên 10 triệu tháng này | `minAmount=10000000` | 20, lớn nhất 122.407.000 (0,26 s) | 20 |
| Tuần trước khoản chi nào lớn nhất (13–19/10) | `limit=1` | 94.219.000 ở Kho Văn Phòng Chung; 49 phiếu (0,20 s) | 49, lớn nhất 94.219.000 |
| Phiếu chờ duyệt lâu nhất | `status=UNAPPROVED, kind=oldest` | PC2607105, chờ 86 ngày; 157 phiếu (0,24 s) | 157 |
| bosshuy: toà 403, 01–21/10 | `buildingId` (403PVB) | 11 phiếu, lớn nhất 35.900.000 (0,15 s) | 11 |
| Tháng trước trả tiền nhà bao nhiêu | `expense_categories` T9 | Tiền nhà 9 phiếu, 346.552.000 (0,26 s) | 9 / 346.552.000 |

**Còn lại cho phiên chính:**
- phát hành connector rồi áp năm file theo thứ tự qua `migrate:forward`;
- SOUL dùng tên báo cáo ở mục 14;
- ma trận lại các câu đọc trên.

## 18. Mốc 3b — sửa theo review độc lập Mốc 2+3 (22/10/2026)

Kết luận review: APPROVE có điều kiện. Không có lỗi ghi sai, ghi trùng hay vượt quyền.

1. **Ghim thân đang chạy (điều kiện).** Hai file thay thân hàm đã có trên production nay có ghim md5 trong `$requires$`:
   - `20261022044126`: `hermes_w2_param_names_v1`, `hermes_w2_params_v1`;
   - `20261022051032`: `hermes_w2b_catalog_v1`, `hermes_w2b_read_v1`.

   Phép đo là `md5(replace(prosrc,chr(13),''))` của thân đang chạy (production và TEST trùng nhau, đo 22/10) hoặc của chính thân trong file (chạy lại). Lệch ⇒ dừng, không đè mất bản vá của phiên khác.

   | Hàm | Đang chạy | Thân của file |
   | --- | --- | --- |
   | `app_private.hermes_w2_param_names_v1` | `6bcb532c153d7354c29f8ff5fefc409a` | `e150d3aa96b7c7b934ade89454f8b089` |
   | `app_private.hermes_w2_params_v1` | `ea1e5fc60a077a1014f40fd432d6fe99` | `07e0083b0d1e02bf639eceb305b070bc` |
   | `app_private.hermes_w2b_catalog_v1` | `80e6f676997d9330471e8c8dc603f304` | `73e2d106a40067dec256258c1da38ded` |
   | `app_private.hermes_w2b_read_v1` | `4cdb4ef8a8914a34b0aec3e08ddc16e4` | `a4ea14ab90fa72323e24ae8b69e4398a` |

2. **Phát lại trước kiểm.** Lượt 2 (`apply`) có biên nhận cho requestId này ⇒ trả kết quả đã chốt (hoặc `request_conflict` / outcome unknown) TRƯỚC các kiểm phạm vi, hạng mục, sổ. Trước đây, ghi xong rồi mất quyền sổ thì gọi lại cùng requestId ra `cashbook_not_held`. requestId mới vẫn qua đủ kiểm rồi mới mở biên nhận. Sửa ở `20261022024834` và bản sao `20261022044123`.
3. Mô tả `expense_vouchers` dặn dùng `status=UNAPPROVED kind=oldest` cho câu "chờ duyệt lâu nhất / quá N ngày".
4. Dòng rủi ro "hai requestId cùng nội dung chạy song song đều ghi" (mục 11).

**Ghi nhận cho Mốc 4** (chưa làm):
- lỗi lô ở lượt 1 nên nói khoản số mấy;
- gợi ý hạng mục tự nhận khoá cứng `rule` cho `tra_tien_thua_khach` — xem có nên loại khỏi gợi ý tự động;
- ngân sách byte: họ thao tác còn 41 B so với trần 2 000 B, `tools/list` còn 1 394 B so với 64 000 B ⇒ Mốc 4–5 không thêm tool hay khuôn tham số mới vào `tools/list`.

**Thứ tự áp (theo tên, không đổi):** `20261022024045` → `20261022024834` → `20261022044120` → `20261022044123` → `20261022044126` → `20261022051029` → `20261022051032`.

## 19. Mốc 4 — sửa, huỷ, cờ TC5 (22/10/2026)

Nhánh `claude/hermes-thu-chi-moc4-20261022` (gốc `main` sau khi #271 gộp). Migration `20261022075102_hermes_expense_edit_cancel_v1`, **chưa áp**. Bảy migration Mốc 2–3b không đổi.

### 19.1 Hai thao tác

| `id` | Khoá (seed TẮT) | Quyền CRM giao vào | Lớp | Hàm ghi web |
| --- | --- | --- | --- | --- |
| `expense.edit` | `income_expenses.edit` | `income_expenses.create` (TC6) | `money`, `always` | `revise_pending_income_expense_v1` |
| `expense.cancel` | `income_expenses.cancel` | `income_expenses.create` (TC6) | `irreversible`, `always` | `cancel_income_expense_flex_v1` |

Tham số dùng lại khuôn đã có (`name`, `vnd`, `text`, `date`), không thêm byte `tools/list`:

```text
expense.edit    voucherCode*, amount, category, content, payee, voucherDate, cashbook, buildingName, roomName, reason (8–1000)
expense.cancel  voucherCode*, reason* (8–1000)
```

- **Chỉ phiếu CHI lập tay** (`app_private.hermes_expense_manual_v1`, mới): phiếu THU ⇒ `web_only`. Phiếu bị `assert_manual_voucher_v1` của web từ chối ⇒ `system_voucher` (bàn giao ⇒ `period_locked`). Riêng sửa: web cho sửa phiếu hoa hồng / trả khách thanh lý, Hermes thì không.
- **Sửa** (Q9 = a): chỉ phiếu chờ duyệt (hàm web từ chối phiếu khác ⇒ `not_pending`).
  - Đổi tiền, hạng mục, sổ hay toà ⇒ hàm web đòi lý do ⇒ `needs_input reason_required`.
  - Đổi tiền hoặc hạng mục chỉ khi phiếu có đúng một dòng hạng mục (mọi phiếu của Báo chi nhanh và của Hermes); nhiều dòng ⇒ `web_only`.
  - Đổi toà thật ⇒ phòng theo toà mới; không nêu phòng ⇒ bỏ phòng, bản xem trước cảnh báo rõ. Nêu đúng toà hiện tại ⇒ không đổi toà, giữ phòng (Mốc 4b). Chỉ nêu phòng ⇒ phòng trong toà của phiếu.
  - Đổi ngày: dòng hạng mục có kỳ một ngày trùng ngày phiếu cũ thì kỳ đi theo ngày mới (kỳ = ngày phiếu như lúc lập).
  - Bản xem trước: `summary` "Sửa phiếu PC… (chờ duyệt): số tiền A → B; …. Lý do: …", `changes[{field, before, after}]`, `willBe` "Sau khi sửa phiếu vẫn CHỜ DUYỆT…". Không có trường nào đổi thật ⇒ `invalid_params`.
- **Huỷ**: bắt lý do. Bản xem trước:
  - đã vào sổ ⇒ "ĐÃ VÀO SỔ <sổ> ⇒ huỷ sẽ tạo bút toán đảo (cộng lại <tiền> vào sổ), KHÔNG khôi phục được";
  - chưa vào sổ ⇒ "CHƯA VÀO SỔ ⇒ phiếu chuyển sang Đã huỷ, sổ quỹ không đổi";
  - phiếu cha đang lặp ⇒ cảnh báo "các kỳ sau KHÔNG tự lập nữa";
  - đã huỷ trước đó ⇒ `not_pending`; công ty chế độ chặt ⇒ `strict_mode`.
- **Vòng đời** như `expense.create`: xem trước = chạy thử hàm web trong khối con rồi lùi (quyền người lập / người có quyền sửa-huỷ, giữ sổ, kỳ đã chốt đều bắt sớm). Lượt 2 mở biên nhận, so `basis` (ID, `approval_version`, `posting_version`, trạng thái, patch, lý do) rồi ghi trong cùng khối con. Lệch phiên bản (basis, hoặc CAS PT409/40001 của hàm web) ⇒ lùi cả biên nhận, `state_changed`, không chốt. Lỗi khác của hàm web ở lượt 2 (quyền 42501, kỳ chốt, hết chờ duyệt, lỗi lập trình ⇒ `crm_refused`) ⇒ chốt `rejected` với lý do thật + SQLSTATE trong biên nhận (Mốc 4b). Bản đã giải từ connector được kiểm lại: phiếu và toà mới trong phạm vi khoá, phòng thuộc toà, hạng mục dùng được, sổ đang giữ.

### 19.2 Cờ TC5 (câu 55)

- Bảng `app_private.hermes_action_flags(flag, enabled, note)` (RLS, không cấp cho vai API). Dòng `expense.recurring_child_manual` = **false** (TẠM, tới khi chủ trả lời).
- Phiếu con định kỳ = `income_expenses.repeat_parent_id IS NOT NULL` (phiếu do `generate_recurring_vouchers` tự lập). Cờ tắt ⇒ bot coi là không lập tay ⇒ `system_voucher` khi sửa, huỷ, và duyệt (Mốc 5 dùng cùng hàm).
- Chủ trả lời "có" ⇒ `UPDATE app_private.hermes_action_flags SET enabled=true, updated_at=clock_timestamp() WHERE flag='expense.recurring_child_manual'` (qua lane), không sửa mã.
- Câu 55 hỏi về duyệt; cờ áp cho cả sửa/huỷ để "lập tay" có một nghĩa. Nếu chủ muốn bot sửa phiếu con nhưng không duyệt thì tách cờ (thêm một dòng + đổi điều kiện ở `hermes_expense_manual_v1`).
- **Cờ dùng chung toàn hệ thống**: bảng không có cột công ty, nên câu 55 trả lời MỘT lần cho mọi công ty dùng Hermes (hiện chỉ một công ty). Cần khác nhau theo công ty thì thêm `organization_id` vào khoá của bảng.

### 19.3 Ghi nhận review Mốc 2+3

- **Khoản số mấy.** `hermes_expense_create_run_v1` gắn HINT `hermes_item=<i>` vào lỗi của khoản thứ i (giữ SQLSTATE, câu lỗi, ràng buộc). Bản xem trước lô ≥ 2 khoản trả `{kind:'rejected', reason, item}`; sổ không giữ phát hiện lúc giải tên cũng kèm `item`. Connector: lỗi `action_rejected` có `item` (1–20) và `detail` = "Khoản N: " + câu tĩnh; lý do dạng hỏi lại thì `detail` của `needs_input` có "Khoản N: ". `item` sai khuôn ⇒ `backend_unavailable`; `mcp-http` chỉ chuyển `item` khi `detail` khớp đúng câu.
- **`tra_tien_thua_khach`.** Gợi ý hạng mục tự động không nhận hạng mục dòng tiền (`noi_bo`, `bo_sung_hoan_coc`, `tra_tien_thua_khach`, `chia_loi_nhuan` = `c_money_flow` của `ie_category_suggest_v1`; test khoá hai danh sách bằng nhau) dù luật khoá cứng. Ví dụ "tiền phòng 5 ngày" ⇒ hỏi lại, "Trả lại tiền thừa cho khách" đứng đầu ứng viên. Người dùng nêu tên hạng mục thì vẫn nhận.

### 19.4 Ghim thân đang chạy

`$requires$` dừng nếu thân đang chạy khác bản production đo 22/10 bằng `db:query` (production = TEST) và khác thân của chính file:

| Hàm | Đang chạy | Thân của file |
| --- | --- | --- |
| `app_private.hermes_expense_create_run_v1` | `9932d56b97e80fa36cb9e65009663d98` | `b09458a449e47e8cd810341babcdc783` |
| `app_private.hermes_expense_resolve_core_v1` | `59a3a8fddb6ccbdb86fd7ed323025859` | `cddbdbc517ac74329edbf916293c9260` |
| `app_private.hermes_expense_write_step_v1` | `d82b120263632eb4774bf635a9a00cc9` | `5ba3da9c66df803792ab769b29dd24a5` (Mốc 4b) |

Ba thân dựng bằng script từ thân production (chỉ thay các chỗ nêu trên). Vỏ `public.hermes_expense_write_v1` và `hermes_expense_scope_v1` không đổi.

### 19.5 Kiểm

- **Offline:** danh mục 4 thao tác (khuôn ⊆ khuôn đã có, khoá chỉ hiện thao tác của nó), sàn xác nhận sửa/huỷ, `item` qua runtime, broker và `mcp-http`; `tools/list` không đổi byte (kết nối chỉ giữ khoá huỷ cũng đúng ba tool).
- **PGlite** (`expense-write-sql`, bản port hàm sửa/huỷ/allow-list của web): 5 ca Mốc 4 + 10 ca cũ chạy trên thân mới. Gồm: chạy thử không để lại lần sửa, bút toán, dòng huỷ hay biên nhận; lệch phiên bản ⇒ `state_changed`; hàm web từ chối ở lượt 2; bản đã giải giả (phiếu toà khác, toà mới, phòng, hạng mục hệ thống, sổ người khác); THU, phiếu hệ thống (kể cả hoa hồng), phiếu con định kỳ theo cờ; khoản số mấy; hạng mục dòng tiền. **14/14 đột biến bị bắt.**
- **Tầng 2 trên TEST** (`test-env:thu-sql`, ROLLBACK, kết nối thật của chủ và một nhân viên quản lý toà, phiếu thật):
  - `$requires$` qua (thân TEST = thân production đo);
  - sửa tiền không lý do ⇒ `reason_required`; có lý do ⇒ xem trước (0 lần sửa để lại) ⇒ ghi (1 lần sửa, phiên bản 2, vẫn chờ duyệt) ⇒ phát lại y nguyên;
  - huỷ phiếu đã vào sổ ⇒ câu "bút toán đảo" ⇒ ghi: `CANCELLED/REVERSED`, 1 bút toán đảo, tổng bút toán của phiếu = 0, 1 dòng huỷ (đếm bằng quyền chủ DB: RLS che bút toán với kết nối của chủ); xem lại ⇒ `not_pending`;
  - THU ⇒ `web_only`; phiếu hệ thống và phiếu con định kỳ ⇒ `system_voucher`; bật cờ TC5 ⇒ xem trước được;
  - nhân viên huỷ phiếu chờ duyệt của người khác mà không giữ sổ ⇒ `cashbook_not_held` ngay ở bản xem trước (như web);
  - "tiền phòng 5 ngày" ⇒ hỏi hạng mục, ứng viên đầu "Trả lại tiền thừa cho khách";
  - thời gian xem trước sửa 0,3–2,0 s, huỷ 0,3–1,0 s (lần đầu chậm hơn).
- Chưa đo được trên TEST: lô có khoản rơi vào kỳ đã chốt (ngày 15/12/2025 chưa chốt ⇒ xem trước bình thường); sổ "thấy mà không giữ" với nhân viên (RLS không cho thấy ⇒ hỏi lại tên sổ). Hai đường này đã có ở PGlite.

### 19.6 Phát hành (phiên chính)

1. Phát hành connector **trước** migration: SQL mới trả `item` trong `rejected`; connector cũ coi khuôn đó là lệch ⇒ `backend_unavailable`.
2. Áp `20261022075102` qua `migrate:forward` (TEST rồi production), SAU `20261022044123`. Provenance sẽ chuyển `catalog-proven`; hồ sơ `chua-ap-dung-cho-y` thành thừa.
3. Bật `income_expenses.edit` / `.cancel` trên TEST, chạy ma trận ≥ 60 câu (sửa tiền có/không lý do, huỷ phiếu đã vào sổ, THU, phiếu hệ thống, phiếu con định kỳ).
4. SOUL: "Sửa phiếu PC…" ⇒ `expense.edit` (đọc `changes` và `willBe`; hỏi lý do khi đổi tiền/hạng mục/sổ/toà). "Huỷ phiếu PC…" ⇒ `expense.cancel` (luôn hỏi lý do; đọc nguyên văn `willBe`, nhất là "KHÔNG khôi phục được"). Lỗi có `item` ⇒ nói khoản số mấy.

### 19.7 Mốc 4b — sửa theo review độc lập Mốc 4 (22/10/2026)

Kết luận review: APPROVE có điều kiện, không có lỗi chặn. Migration `20261022075102` chưa áp nên sửa thẳng trong file. Hồ sơ `chua-ap-dung-cho-y`, ghim forward và ghim `search_path=''` đã tính lại.

1. **`hermes_expense_manual_v1` chạy `search_path=''`.** Thân chỉ dùng tên đủ schema. Hàm có dòng duyệt trong `REVIEWED_EMPTY_SEARCH_PATH`; `$check$` khoá giá trị này.
2. **Xem trước huỷ** lấy "đã vào sổ / chưa vào sổ" từ `cancellation_kind` mà hàm web trả ở lần chạy thử. Trước đây lấy từ cột `posting_status` của phiếu.
3. **Nêu đúng toà hiện tại** (không nêu phòng) ⇒ không đổi toà, GIỮ phòng. Đổi toà thật mà không nêu phòng ⇒ bỏ phòng, và bản xem trước cảnh báo: "Đổi toà: phiếu BỎ phòng <phòng> (phòng của toà cũ); cần phòng ở toà mới thì nêu roomName".
4. **Lượt 2 sửa/huỷ:**
   - chỉ lệch phiên bản (basis, hoặc CAS PT409/40001 của hàm web) là `state_changed`, không chốt;
   - lỗi khác chốt `rejected` với lý do thật và lưu SQLSTATE + câu lỗi vào biên nhận: quyền (42501 ⇒ `not_allowed`), kỳ chốt, hết chờ duyệt, lỗi lập trình (⇒ `crm_refused`);
   - gọi lại cùng requestId phát lại đúng kết cục;
   - lỗi tạm 40P01/55P03 vẫn ném ra.
5. **Ghi rõ:**
   - Cờ `hermes_action_flags` dùng chung toàn hệ thống (mục 19.2).
   - Mã phiếu trùng giữa các toà (mã cũ trước 25/09) ⇒ `expense.cancel` trả `needs_input` kèm ứng viên "mã · ngày · toà · tiền", không tự chọn. Thao tác chỉ có `voucherCode`, không có tham số để chọn giữa các phiếu cùng mã, nên người dùng phải huỷ trên web. Đây là ngõ cụt có chủ đích: an toàn hơn huỷ nhầm phiếu (sửa cũng vậy).
   - **`expense.cancel` huỷ được phiếu đã duyệt / đã vào sổ** bằng bút toán đảo, giống web (TC6, phiên chính giữ nguyên). Khoá `income_expenses.cancel` đang TẮT. Nếu chủ muốn bot chỉ huỷ phiếu chưa vào sổ: thêm một dòng ở nhánh huỷ của bước ghi, sau `hermes_expense_manual_v1`:

     ```sql
     IF COALESCE(v_voucher.posting_status,'UNPOSTED')='POSTED' THEN RETURN jsonb_build_object('kind','rejected','reason','web_only'); END IF;
     ```

6. **Khoá dòng phiếu NOWAIT** (phiên chính báo từ Hoá đơn #279):
   - Guard dùng chung (`hermes_action_binding_v1` → `hermes_private_command_connection_v1` → `lock_org_for_decision_v1`) khoá dòng CÔNG TY ngay đầu mọi giao dịch Hermes.
   - Thứ tự khoá của hai hàm web (đo thân production):
     - `revise_pending_income_expense_v1` khoá công ty TRƯỚC rồi mới khoá phiếu ⇒ cùng thứ tự Hermes, không vòng;
     - `cancel_income_expense_flex_v1` khoá phiếu `FOR UPDATE` trước, rồi tới công ty: qua `authorize_tenant_action_v3` khi người huỷ không phải chủ / người lập, và qua trigger `rent_support_voucher_lifecycle_guard_v1` trên `income_expenses`.
   - Hệ quả: Hermes sửa/huỷ một phiếu mà web đang huỷ ⇒ Hermes giữ công ty chờ phiếu, web giữ phiếu chờ công ty ⇒ 40P01.
   - Sửa: nhánh sửa/huỷ của bước ghi khoá dòng phiếu `FOR UPDATE NOWAIT` TRƯỚC khi gọi hàm web.
     - Phiếu đang bị giữ ⇒ 55P03 ngay; connector đổi thành `state_changed` (xem trước lại), web làm xong.
     - Đổi thứ tự khoá trong bước ghi không gỡ được, vì khoá công ty đã nằm ở guard.
   - `expense.note` (Mốc 2, đã lên production) có cùng loại rủi ro: hàm bổ sung chèn dòng có khoá ngoại tới phiếu ⇒ cần `KEY SHARE` trên phiếu. Chưa sửa trong #278 vì ngoài phạm vi; ghi vào báo cáo cho phiên chính.

**Kiểm (4b):**
- PGlite `expense-write-sql` 16/16, có thêm các ca:
  - lượt 2 chốt `period_locked` / `crm_refused` (42703) kèm SQLSTATE trong biên nhận, phát lại y nguyên;
  - CAS PT409 ⇒ `state_changed`, không biên nhận;
  - mất quyền sửa/huỷ sau xem trước ⇒ `not_allowed` chốt 42501;
  - toà trùng giữ phòng; đổi toà cảnh báo bỏ phòng;
  - xem trước huỷ theo kết cục chạy thử.
- **19/19 đột biến bị bắt** (14 cũ + 5 cho các sửa trên).
- **PG17 hai kết nối** (`expense-write-race-sql.test.mjs`, fixture dùng chung `expense-write-fixture.mjs`; bản port hàm huỷ khoá phiếu → công ty như hàm thật):
  - web đang huỷ phiếu ⇒ `expense.cancel` / `expense.edit` của Hermes trả 55P03 trong < 1 s, web huỷ xong;
  - không có web chen ⇒ xem trước bình thường;
  - đối chứng bỏ NOWAIT ⇒ đúng một bên 40P01.
- Tầng 2 TEST (ROLLBACK, kết nối thật của chủ và một nhân viên):
  - toà trùng ⇒ chỉ đổi "người nhận", phòng giữ nguyên;
  - sửa/huỷ, phiếu THU / hệ thống / phiếu con như mục 19.5;
  - huỷ phiếu đã vào sổ: 1 bút toán đảo, tổng bút toán = 0.

## 20. Mốc 5 — duyệt / duyệt + chi (23/10/2026)

Nhánh `claude/hermes-thu-chi-moc5-20261023`, xếp chồng trên #278 (`7d365cd45`). Migration `20261023013109_hermes_expense_approve_v1`, **chưa áp**; áp SAU `20261022075102`.

### 20.1 Thao tác

| `id` | Khoá (seed TẮT) | Quyền CRM giao vào | Lớp | Hàm ghi web |
| --- | --- | --- | --- | --- |
| `expense.approve` | `income_expenses.approve_vouchers` | `income_expenses.approve` (Q25) | `money`, `always` | `adopt_voucher_attachments_as_evidence_v2` + `approve_and_post_income_expense_v2`, hoặc `approve_income_expense_v2` |

```text
expense.approve  voucherCodes* list 1–10 của name(voucher), post bool (mặc định true = duyệt và chi)
```

Khuôn `list` và `bool` đã có trong danh mục chung, nên không thêm byte `tools/list`.

- **Giải mã:** từng mã giải như mã phiếu của note/edit/cancel: dưới RLS, trong phạm vi khoá. Mơ hồ, ngoài phạm vi hay không thấy ⇒ `needs_input` có ứng viên. Hai mã cùng một phiếu ⇒ `invalid_params`.
  - Vòng giải nằm ngay trong lõi. Lõi chạy INVOKER dưới `authenticated`, không có USAGE `app_private`, nên không gọi lại chính nó theo tên được.
- **Kế hoạch từng phiếu** (xem trước = chạy thử hàm web rồi lùi):
  - **không làm:**
    - `hermes_expense_manual_v1`: THU ⇒ `web_only`; phiếu hệ thống, hoặc phiếu con định kỳ khi cờ TC5 tắt ⇒ `system_voucher`;
    - hết chờ duyệt ⇒ `not_pending`;
    - Q25 (#263, `ie_self_approve_over_threshold_blocked_v1`, rào thứ hai, cùng hàm của web) ⇒ `not_allowed`;
    - hàm web từ chối khi chạy thử: kỳ sổ chốt ⇒ `period_locked`, quyền ⇒ `not_allowed`, …
  - **duyệt + chi:** `adopt…` rồi `approve_and_post…`. Payload đúng đường "Chi nhanh" của web (`useQuickExpense`): sổ của phiếu, `postedOn` = hôm nay giờ VN, chứng từ = ảnh của phiếu, `expectedExecutionRevision` 0, hai phiên bản.
  - **chỉ duyệt** (TC4, nói rõ lý do): khi
    - `post=false`;
    - phiếu không chi qua sổ quỹ (`posting_mode` ≠ `CASHBOOK`);
    - phiếu chưa chọn sổ;
    - phiếu chưa có ảnh;
    - ảnh không dùng làm chứng từ được (adopt bỏ qua, hoặc hàm web đòi chứng từ `FINALIZED`);
    - người duyệt không giữ sổ của phiếu (CUSTODIAN).
  - Lô không còn phiếu nào làm được ⇒ `rejected` với lý do của phiếu đầu tiên; lô ≥ 2 phiếu thì kèm `item`.
- **Bản xem trước:**
  - `summary` "Duyệt N phiếu: duyệt + CHI x phiếu, tổng …; chỉ duyệt y phiếu (chưa chi); không làm z phiếu." Câu này gom theo kế hoạch, khác mẫu ở mục 5.
  - `items[{stt, code, content, building, category, amount, maker, ageDays, attachments, cashbook, plan}]`, với `plan` là câu tiếng Việt.
  - Có phiếu không làm được ⇒ thêm cảnh báo. Không có UUID.
- **Lượt 2** (plan G4):
  - `basis` = md5 của kế hoạch đã xem. Lệch, hoặc kế hoạch bị sửa ⇒ `state_changed`, trước khi mở biên nhận.
  - Từng phiếu một, mỗi phiếu một khối con, khoá idempotency web `hermes-approve:<requestId>:<i>`:
    - kiểm lại "lập tay" (cờ TC5) và #263 ⇒ nếu sai thì là lý do cuối;
    - lệch `approval_version` / `posting_version` ⇒ phiếu đó `state_changed`;
    - ảnh bị gỡ (adopt rỗng) ⇒ `state_changed`; không tự hạ xuống "chỉ duyệt" khi người dùng chưa xem lại;
    - lỗi hàm web ⇒ lý do thật.
  - Có ít nhất 1 phiếu xong ⇒ chốt `applied` với `{items[{code, outcome: approved_posted | approved | state_changed | rejected, reason?, statusText}], totalPosted, totalPostedText}`. `link`: một phiếu ⇒ trang phiếu; nhiều phiếu ⇒ `/income-expense`.
  - 0 phiếu xong và có lý do cuối ⇒ chốt `rejected` (kèm `item` ở lô ≥ 2, SQLSTATE vào biên nhận). Tất cả đều `state_changed` ⇒ không chốt.
- **Khoá:**
  - Bước ghi khoá các dòng phiếu của lô `FOR UPDATE NOWAIT`, theo thứ tự id, trước khi gọi hàm web.
  - Lý do: hai hàm duyệt web khoá phiếu trước rồi mới khoá công ty (`authorize_tenant_action_v3`), nên có cùng vòng 40P01 như huỷ (19.7 điểm 6).
  - Phiếu đang bị giữ ⇒ 55P03 ⇒ connector trả `state_changed`.
  - Vì đã giữ dòng phiếu và so phiên bản trước khi gọi, hàm web không thể thấy lệch phiên bản.

### 20.2 Khoá Hermes và quyền CRM

Đề của phiên chính ghi "khoá `income_expenses.approve` seed TẮT". Mốc 5 theo thiết kế đã duyệt (mục 2):

- **Khoá Hermes** là `income_expenses.approve_vouchers`. Khoá này đã seed TẮT ở `20261021134531` và có nhãn trong `capability-contract.mjs`.
- **Quyền CRM giao vào** là `income_expenses.approve`, vì hai hàm duyệt web đòi đúng quyền này.
- Khoá Hermes `income_expenses.approve` cũ (đợt 1) vẫn TẮT và không dùng cho thao tác nào.
- Migration không bật khoá nào; test khoá điều này.

### 20.3 Ghim thân đang chạy

| Hàm | Đang chạy (= thân 075102) | Thân của file |
| --- | --- | --- |
| `app_private.hermes_expense_resolve_core_v1` | `cddbdbc517ac74329edbf916293c9260` | `9aaa6cfceb6f30f204feb3da256c0eef` |
| `app_private.hermes_expense_write_step_v1` | `5ba3da9c66df803792ab769b29dd24a5` | `817c4c8346d5a5457db4dad223b32f82` |

Hai thân dựng bằng script từ thân `075102`; chỉ thêm nhánh `expense.approve`. Vỏ, `hermes_expense_scope_v1` và `hermes_expense_manual_v1` không đổi. `$requires$` còn đòi đủ các hàm web: duyệt, duyệt + chi, adopt, rào #263.

### 20.4 Kiểm

- **Offline:**
  - danh mục 5 thao tác; khoá `approve_vouchers` chỉ hiện `expense.approve`; quyền CRM `income_expenses.approve` không phải khoá Hermes;
  - lô 1–10, `post` bool; sàn xác nhận; "Khoản N: …";
  - `tools/list` không đổi byte.
- **PGlite** (`expense-write-sql`, 20/20). Fixture có bản port hai hàm duyệt web, adopt và rào #263, khoá phiếu → công ty như hàm thật. Bốn ca Mốc 5:
  - lô hỗn hợp duyệt + chi / chỉ duyệt / không làm; chạy thử không để lại duyệt, bút toán, chứng từ hay biên nhận; phát lại y nguyên;
  - các đường hạ "chỉ duyệt" và câu từng đường; kỳ sổ chốt ⇒ không làm; hàm web từ chối khi chạy thử;
  - lượt 2: lệch một phiếu, lệch tất cả, basis hoặc kế hoạch bị sửa, ảnh bị gỡ, lỗi cuối có SQLSTATE, lô nói phiếu số mấy, một phiếu xong một phiếu kỳ chốt;
  - THU / hệ thống / phiếu con theo cờ TC5 (cả cờ đổi giữa hai lượt), #263 hai lượt, giải mã (không thấy, ngoài phạm vi, mơ hồ, lặp), bản đã giải giả.
- **22/22 đột biến bị bắt** (21 trên PGlite, 1 trên PG17).
- **PG17 hai kết nối** (`expense-write-race-sql`, 7/7):
  - web đang duyệt phiếu ⇒ lô duyệt của Hermes trả 55P03 trong < 1 s, web duyệt xong;
  - không có web chen ⇒ xem trước bình thường;
  - đối chứng bỏ NOWAIT ⇒ đúng một bên 40P01.
- **Tầng 2 trên TEST** (`test-env:thu-sql`, một giao dịch rồi ROLLBACK; ghép `075102` + `013109` vào giao dịch; kết nối thật của chủ và một nhân viên):
  - `$requires$` của cả hai file qua: thân trên TEST = thân production, hàm #263 có trên TEST;
  - chủ, lô [phiếu chờ duyệt có ảnh, phiếu đã duyệt]:
    - xem trước "duyệt + CHI 450.000đ khỏi sổ <sổ của phiếu>" và "không làm: phiếu không còn chờ duyệt", không có UUID;
    - chạy thử không để lại bút toán, chứng từ hay biên nhận;
    - ghi ⇒ `approved_posted` + `rejected not_pending`; phiếu thành `APPROVED/POSTED`, có 1 bút toán và 1 biên nhận;
    - phát lại y nguyên; xem lại ⇒ `not_pending`;
    - thời gian: xem trước 1,3 s, ghi 1,2 s;
  - người duyệt không giữ sổ của phiếu ⇒ "chỉ duyệt (anh/chị không giữ sổ …)"; ghi ⇒ `APPROVED/UNPOSTED`;
  - `post=false` ⇒ "chỉ duyệt (theo yêu cầu, chưa chi)"; hai mã cùng phiếu ⇒ `invalid_params`;
  - THU ⇒ `web_only`; phiếu hệ thống và phiếu con định kỳ ⇒ `system_voucher`; mã không có ⇒ hỏi lại (`not_visible`);
  - nhân viên không có quyền CRM `income_expenses.approve` ⇒ guard từ chối (42501), dù kết nối giữ khoá.
  - Chưa đo được trên TEST, đã có ở PGlite / PG17: phiếu chờ duyệt không ảnh (trong phạm vi không có phiếu nào như vậy); #263 (chủ có quyền duyệt); web giữ phiếu (cần hai kết nối).

### 20.5 Phát hành (phiên chính)

1. Connector và migration không phụ thuộc thứ tự vì khoá đang TẮT. Theo thói quen, phát hành connector trước.
2. Áp `20261023013109` qua `migrate:forward` (TEST rồi production), SAU `20261022075102`.
   - Provenance xếp file này là `catalog-proven`, nhưng đó là kết quả giả: tên hai hàm thay thân đã có sẵn trong catalog.
   - Vì vậy phải áp đích danh. Áp xong, `$check$` xác nhận dòng chính sách và nhánh duyệt.
3. Trên TEST: bật `income_expenses.approve_vouchers`, rồi chạy ma trận ≥ 60 câu: lô hỗn hợp, phiếu không ảnh, không giữ sổ, #263, phiếu con định kỳ, mã mơ hồ.
4. TC7: tạo lại kết nối "NG TÂM" trước khi bật trên production. Kết nối của Quản Lý Tòa loại trừ `approve_vouchers` (mục 14.6).
5. SOUL:
   - "Duyệt phiếu PC…, PC…" ⇒ `expense.approve` (≤ 10 mã). "Chỉ duyệt" hoặc "chưa chi" ⇒ `post=false`.
   - Đọc nguyên văn `summary` và cột `plan` từng phiếu.
   - Sau lượt 2, đọc `outcome` và `statusText` từng mã. Gặp `state_changed` ⇒ xem trước lại.

Phiên chính giữ cả ba điểm Mốc 5 tự chọn theo đề xuất: kỳ sổ đã chốt ⇒ không làm; ảnh bị gỡ giữa hai lượt ⇒ xem trước lại; ngày chi = hôm nay.

## 21. Lượt 8 — vá vòng 40P01 giữa bước ghi và hàm web (23/10/2026)

Nhánh `claude/hermes-thu-chi-note-nowait-20261023`, xếp chồng trên #289 (`8326a7dcc`). Migration `20261023031258_hermes_expense_row_locks_nowait_v1`, **chưa áp**. Phải áp SAU `20261023013109`.

### 21.1 Lỗi

- Guard dùng chung khoá dòng CÔNG TY ngay đầu mọi giao dịch Hermes (`lock_org_for_decision_v1`, `FOR NO KEY UPDATE`).
- Nhiều hàm web làm ngược thứ tự: khoá một dòng nghiệp vụ trước, rồi mới khoá công ty (`authorize_tenant_action_v3` lấy `FOR SHARE`, hoặc `lock_org_for_decision_v1`).
- Nếu bước ghi của Hermes cần đúng dòng nghiệp vụ đó (do chính nó khoá, hoặc do hàm web nó gọi khoá) ⇒ hai bên chờ nhau ⇒ 40P01.
- Mốc 4b đã vá cho dòng phiếu của sửa/huỷ; Mốc 5 vá cho lô duyệt.
- Rủi ro còn mở ở 19.7 điểm 6 là `expense.note`. Đo thân production: `append_income_expense_supplement_v1` khoá phiếu `FOR UPDATE` (mạnh hơn `KEY SHARE` mà Mốc 4b đoán).

Quét toàn bộ thân hàm production (23/10, chỉ đọc) để tìm hàm khoá ghi dòng nghiệp vụ trước khi khoá công ty:

| Dòng | Hàm web khoá ghi rồi mới khoá công ty (ví dụ) | Bước ghi Hermes cần dòng đó ở mode |
| --- | --- | --- |
| phiếu | `cancel_income_expense_flex_v1`, `approve_income_expense_v2`, `approve_and_post_income_expense_v2` (`FOR UPDATE`) | note: `FOR UPDATE` (hàm bổ sung); sửa/huỷ/duyệt: đã vá ở 4b/5 |
| sổ (`accounts`) | `confirm_cashbook_closing_v1`, `propose_cashbook_closing_v1`, `set_cashbook_access_v2`, `lock_cashbook_period_v1`, `archive_cashbook_v1` (`FOR UPDATE`) | create: `FOR SHARE` (`create_income_expense_v1`); duyệt + chi: `FOR UPDATE`; huỷ phiếu đã vào sổ: `KEY SHARE` (khoá ngoại của bút toán đảo); sửa đổi sổ: `KEY SHARE` (khoá ngoại) |
| phòng (`rooms`) | `create_contract_v2`, `save_room_sale_policy_v1`, `sign_and_checkin_contract_draft_v1` (`FOR UPDATE`); `consume_room_next_claim_v1`, giữ chỗ (`FOR NO KEY UPDATE`) | create: `FOR SHARE`; sửa đổi phòng: `KEY SHARE` (chỉ vướng nhóm `FOR UPDATE`) |
| yêu cầu duyệt (`approval_requests`) | `emergency_approve_financial_v1`, `self_approve_within_limit_v1` (`FOR UPDATE`) | duyệt: hàm duyệt web cập nhật yêu cầu; huỷ: trigger `a75_ie_cancel_close_request` cập nhật |

Toà, hạng mục, thành viên, cờ tính năng cũng bị `create_income_expense_v1` khoá `FOR SHARE`, nhưng không hàm web nào khoá ghi các dòng đó trước công ty. Vì vậy Mốc này không khoá trước chúng, để không sinh `state_changed` thừa.

### 21.2 Sửa

Luật chung: trước khi gọi hàm web, bước ghi khoá NOWAIT mọi dòng ở bảng 21.1 mà hàm web sẽ khoá, đúng mode mạnh nhất. Gặp 55P03 thì connector trả `state_changed` (xem trước lại). Hermes không bao giờ chờ web.

| Thao tác | Khoá thêm (NOWAIT) |
| --- | --- |
| `expense.note` | phiếu `FOR UPDATE` (cả xem trước lẫn ghi) |
| `expense.create` | phòng, sổ của từng khoản `FOR SHARE` (thứ tự id) |
| `expense.edit` / `expense.cancel` | yêu cầu duyệt của phiếu `FOR UPDATE`; sổ của phiếu + sổ mới `KEY SHARE`; phòng mới `KEY SHARE` |
| `expense.approve` | yêu cầu duyệt của các phiếu `FOR UPDATE`; sổ của các phiếu sẽ chi `FOR UPDATE` (xem trước khi `post` ≠ false; lượt 2 theo kế hoạch `approve_post`) |

- Chỉ thay thân `hermes_expense_write_step_v1`, dựng bằng script từ thân của `013109`.
- `$requires$` ghim md5 thân đang chạy `817c4c83…` (= thân `013109`) và thân của chính file `ea3cd4ac…`.
- `$check$` đếm đúng 6 `FOR UPDATE NOWAIT`, 2 `FOR SHARE NOWAIT`, 2 `FOR KEY SHARE NOWAIT`.

### 21.3 Kiểm

- **PG17 hai kết nối** (`expense-write-race-sql`, 18/18): 11 ca đua, mỗi ca một hàm web khoá dòng rồi chờ công ty.
  - Note, sửa, huỷ, duyệt khi web huỷ / duyệt giữ phiếu.
  - Create khi web chốt sổ giữ sổ; create khi web giữ chỗ phòng.
  - Duyệt + chi khi web chốt sổ; duyệt khi web duyệt khẩn giữ yêu cầu duyệt.
  - Huỷ phiếu đã vào sổ khi web chốt sổ; huỷ khi web duyệt khẩn.
  - Sửa đổi phòng khi web lưu chính sách bán phòng giữ phòng `FOR UPDATE`.
  - Kết quả: Hermes trả 55P03 trong < 1 s, web làm xong, dữ liệu không đổi.
  - Không có web chen ⇒ xem trước của cả 11 ca chạy bình thường.
  - 5 ca đối chứng bỏ NOWAIT ⇒ đúng một bên 40P01.
- Fixture có bản port hàm web khoá đúng như thân production:
  - hàm bổ sung khoá phiếu `FOR UPDATE`;
  - hàm lập phiếu khoá phòng và sổ `FOR SHARE`;
  - hàm huỷ phiếu đã vào sổ lấy `KEY SHARE` sổ và đóng yêu cầu duyệt;
  - hàm sửa đổi sổ / phòng lấy `KEY SHARE`;
  - hai hàm duyệt cập nhật yêu cầu duyệt;
  - ba hàm "khoá dòng rồi mới khoá công ty" (chốt sổ, giữ chỗ / chính sách phòng, duyệt khẩn).
- **PGlite** `expense-write-sql` 20/20: các đường thường không đổi.
- **Đột biến:** mỗi vị trí khoá bỏ NOWAIT, cộng hai đột biến xoá hẳn câu khoá ⇒ phải đỏ ở ca đua tương ứng (mục 21.4).

### 21.4 Phát hành (phiên chính)

1. Áp `20261023031258` qua `migrate:forward`, sau `20261022075102` và `20261023013109`. Provenance có thể xếp file là `catalog-proven` giả (hàm đã có tên) ⇒ áp đích danh.
2. Không đổi connector. 55P03 vốn đã được đổi thành `state_changed`.
3. Bản vá này phải lên trước khi bật bất kỳ khoá Thu chi nào (`income_expenses.create` cho note / create, `.edit`, `.cancel`, `.approve_vouchers`).

## 22. Mốc 6 — web Báo chi nhanh dùng hai hàm SQL chung (23/10/2026)

Nhánh `claude/hermes-thu-chi-moc6-20261023`, xếp chồng trên #293 (`1c069ddb6`).

**Không có migration mới.** Web gọi đúng hai hàm mà bot đang dùng: `ie_category_suggest_v1` và `ie_default_cashbook_v1`. Cả hai nằm trong `20261022024045`, đã áp production ở Mốc 2. Đo production 23/10 (chỉ đọc): hai hàm có mặt và `authenticated` được `EXECUTE`.

### 22.1 Đổi gì

- **Gợi ý hạng mục**
  - `compose.ts` nhận `ctx.suggestCategory` thay cho `suggestCategory` TypeScript; hai chỗ gọi giữ nguyên.
  - Feed ghép thẻ hai lượt quanh một lần gọi RPC (`sharedRules.composeWithSuggestions`):
    - lượt 1 gom các câu cần gợi ý;
    - mỗi chiều thu/chi gọi `ie_category_suggest_v1` một lần (≤ 100 câu mỗi lần);
    - lượt 2 ghép thẻ với kết quả.
  - Kết quả RPC được kiểm khuôn: hạng mục phải nằm trong danh sách dùng được của đúng chiều, lý do phải là lý do đã biết. Sai khuôn ⇒ coi như không gợi ý.
  - RPC lỗi ⇒ ghép thẻ không có gợi ý (AI hoặc người dùng chọn), tin vẫn ra thẻ.
  - Đã xoá `categoryRules.ts`, phần đoán của `categorySuggest.ts` (`suggestCategory`, cụm phí, từ dừng), cùng các test chỉ dành cho bản TypeScript.
- **Sổ chọn sẵn**
  - `useQuickEntryRefs` nạp sẵn `ie_default_cashbook_v1` cho thẻ chưa có toà và cho từng toà trong phạm vi, kèm sổ nhớ ở máy. Production có tối đa 19 toà mỗi công ty ⇒ ≤ 20 lời gọi song song lúc mở trang.
  - `defaultAccountFor` vẫn đồng bộ: đọc bảng đã nạp, chỉ nhận sổ trong danh sách sổ đang giữ.
  - Đã xoá `pickDefaultAccount`.
  - Lỗi ⇒ không chọn sẵn sổ (người dùng chọn tay), không chặn trang.
- **Nhãn:** khoá `income_expenses.approve_vouchers` ghi "Duyệt, hoặc duyệt và chi, phiếu CHI lập tay (Hermes, tối đa 10 phiếu, luôn xem trước)", khớp Mốc 5.

### 22.2 Thao tác người dùng

Thao tác giữ nguyên, và kết quả gợi ý giống hệt bản cũ: hàm SQL khớp TypeScript trên cả 610 ca vàng. Có hai khác biệt nhỏ nhìn thấy được:
- thẻ hiện ra sau một lượt RPC thay vì ngay lập tức;
- khung xương lúc mở trang chờ thêm bảng sổ mặc định.

Trên TEST, thẻ hiện cùng lúc với tin gửi đi (vòng RPC khoảng 0,2 s).

### 22.3 Kiểm

- **Bảng đứng thay SQL trong vitest:** `__tests__/fixtures/goi-y-hang-muc-test.json`, gồm 7 bộ hạng mục và 87 câu.
  - Bảng sinh một lần từ bản TypeScript cũ trên chính các câu test, trước khi xoá TypeScript.
  - `infra/hermes-broker/ie-quick-entry-rules-sql.test.mjs` khoá bảng này khớp đúng `ie_category_suggest_v1` trên PostgreSQL 17 (87/87), cùng 610 ca vàng.
  - Nhờ đó, test compose / feed / page chạy trên kết quả thật của database.
- **vitest:** quick entry + Hermes 916 test đạt; thêm `sharedRules.test.ts` và `useQuickEntryRefs.sharedRules.test.tsx` (13 test). Đảo strict 0 lỗi, `typecheck:baseline` khớp, eslint 0 lỗi.
- **Trình duyệt thật trên TEST** (Chromium, vite của worktree trỏ TEST; chặn mọi origin Supabase khác và chặn AI; không bấm Lưu), khổ desktop 1366 px và mobile 390 px:
  - mở trang ⇒ 20 lời gọi `ie_default_cashbook_v1`, tất cả HTTP 200;
  - gửi "102LVT tiền điện tháng 10 1tr2; mua sơn cửa 300k" ⇒ đúng một lời gọi `ie_category_suggest_v1` cho 2 câu, kết quả `rule` / không gợi ý;
  - thẻ: sổ "Tâm Thu" chọn sẵn, dòng 1 "Đóng tiền điện", dòng 2 "Chọn hạng mục" (chờ AI);
  - không cuộn ngang; console chỉ có lỗi của lời gọi AI bị chặn.

### 22.4 Phát hành

1. Web không phụ thuộc migration chưa áp. Mã Mốc 6 cũng không dùng gì của #278 / #289 / #293; PR chỉ xếp chồng để giữ một dòng nhánh.
2. Thứ tự đề xuất: gộp theo dòng nhánh (#278 → #289 → #293 → Mốc 6) sau khi phiên chính áp các migration của từng PR.
3. Muốn phát hành web sớm hơn thì cherry-pick commit Mốc 6 lên `main`: chỉ đụng web, tài liệu và một test SQL.
4. Connector không đổi.

## 23. Lượt 11 — sửa phía máy chủ theo nghiệm thu bot thật trên TEST (24/10/2026)

Nghiệm thu bot thật trên TEST (SOUL v4.15, khoá ghi Thu chi bật trên TEST) tìm ra năm lỗi phía máy chủ / connector. Luật SOUL do phiên chính sửa riêng.

### 23.1 Đổi gì

| Lỗi nghiệm thu | Gốc | Sửa |
| --- | --- | --- |
| "mua vòi nước", "mua ốc vít", "thay ổ cắm" ⇒ "khớp nhiều" với tiền nhà, điện, nước, internet, rác… | (a) `ie_category_suggest_v1` không ra gì cho các món này (cụm "hay nói" của danh mục chuẩn không có; trùng chữ tên hoà); (b) gợi ý không khoá cứng ⇒ lõi giải tên trả **8 hạng mục đầu bảng** làm ứng viên | (a) `20261023210633`: lớp (3b) từ vựng vật tư / sửa chữa / văn phòng phẩm trong hàm dùng chung (web Báo chi nhanh đổi cùng lúc); (b) `20261023210634`: hàm `public.hermes_expense_category_pick_v1`, hỏi lại `why=unspecified` với ≤ 5 ứng viên trùng từ, không trùng gì thì không nêu ứng viên |
| "không thấy hạng mục 'Sửa chữa/bảo trì' trong phạm vi quyền" | tên hạng mục chỉ khớp nguyên chuỗi / chuỗi con | khớp thêm "đủ từ trong tên + nhóm" (cả nhóm "Sửa chữa – bảo trì"); nhiều hạng mục mà gợi ý theo nội dung rơi vào một ⇒ nhận; connector: hạng mục không có ⇒ "không có trong danh mục chi dùng được qua bot", không nói "phạm vi quyền" |
| Bản xem trước tiền nhà / tiền điện không nêu cam kết (Q12) | câu cam kết chỉ nằm trong `warnings` | thêm `commitment` vào từng khoản và vào `summary`: cam kết của kỳ, đã chi/giữ, còn trước khoản này, trong / VƯỢT bao nhiêu, phiếu cùng kỳ; không có cam kết ⇒ nói rõ |
| Tìm phiếu theo mã hỏng khi mã thuộc dãy trùng | mã bị dùng lại giữa các toà (đo production 24/10: 1 788 phiếu chi, 1 059 mã); chỉ có `voucherCode` nên hỏi lại xong vẫn mơ hồ | khớp ĐÚNG mã đầy đủ trước; phần còn lại của `voucherCode` là gợi ý ngày `dd/mm[/yyyy]` và tên toà (chép lại nhãn ứng viên là đủ); mã ngắn / thiếu ⇒ chỉ ứng viên, không tự chọn; connector hướng dẫn gọi lại kèm ngày / toà |
| Toà ngoài phạm vi ⇒ "không tìm thấy, xác nhận tên toà" | đúng thiết kế: thấy dưới RLS mà ngoài phạm vi khoá ⇒ `outside_scope` (câu từ chối tĩnh); RLS không cho thấy ⇒ `not_visible` — hàm INVOKER không phân biệt "không có" với "không có quyền", không được lộ | giữ nguyên |
| "Mở lại phiếu" bị làm thành "đổi sổ" | bot gọi `expense.edit` kèm `cashbook`; máy chủ chỉ biết khi chạy thử hàm web | sửa phiếu đã huỷ ⇒ `web_only`; sửa phiếu đã duyệt / vào sổ, huỷ phiếu đã huỷ ⇒ `not_pending` — cả ba kèm `link` trang phiếu, trước khi khoá / chạy thử |

Lô nhiều khoản: kết quả hỏi lại mang `item` (connector nói "Mục #n: …").

### 23.2 Kiểm

- PGlite `expense-write-sql.test.mjs` 22/22 (hai ca lượt 11: hạng mục — món điện nước / sửa chữa / vệ sinh / văn phòng phẩm, ứng viên đúng nghĩa, tên nhóm, lô; mã phiếu — ba phiếu cùng mã, gợi ý ngày / toà / nhãn, mã ngắn, duyệt, mở lại phiếu; Q12 trong ca tiền nước).
- PG17 `expense-write-race-sql.test.mjs` 18/18 (đối chứng bỏ NOWAIT dựng trên thân bước ghi mới).
- `ie-quick-entry-rules-sql.test.mjs`: 647 ca vàng (đổi đúng 15 ca đã soát tay, thêm 37 câu chi thường gặp), bảng đứng thay của vitest 87/87, ghim md5 (thân lạ ⇒ dừng).
- Tầng 2 trên TEST (một giao dịch ROLLBACK, không đụng kết nối / registry / fixture, không dùng nick chủ / joey / bosshuy): áp hai file lên thân thật (ghim md5 khớp), dưới RLS của một chủ công ty khác — câu nghiệm thu ra đúng hạng mục; mã trùng thật chọn đúng phiếu khi kèm nhãn hoặc ngày + toà; mã ngắn chỉ là ứng viên.

### 23.3 Phát hành

1. Áp `20261023210633` (provenance xếp `catalog-proven` GIẢ ⇒ áp đích danh) rồi `20261023210634` (`$requires$` đòi lớp từ vựng đã có).
2. Connector không cần trước: SQL dùng đúng khuôn kết quả cũ (`why=unspecified` đã có từ trang Công việc, `item`, `link`). Connector mới chỉ đổi hai câu hướng dẫn (mã phiếu trùng, hạng mục không có).
3. Web Báo chi nhanh đổi gợi ý cùng lúc với `20261023210633` (không phát hành web).
4. Sau khi áp, `20261023013109` và `20261023031258` mất khả năng chạy lại (thân bị thay) — cần ngoại lệ pinned nếu cửa idempotent đo lại chúng.

## 24. Lượt 13 — chặn luồng hệ thống ở máy chủ, lọc tuổi phiếu chờ duyệt (24/10/2026)

Nghiệm thu bot thật trên TEST (SOUL v4.19 + connector C1 `f6c8019a`). Luật SOUL do phiên chính sửa riêng.

### 24.1 Đổi gì

| Lỗi nghiệm thu | Gốc | Sửa |
| --- | --- | --- |
| Bot lập được phiếu CHI cho hoa hồng, bỏ / hoàn / trả cọc, thanh lý / trả tiền thừa cho khách, lương; máy chủ còn hỏi lại kèm "Bổ sung hoàn cọc", "Trả lại tiền thừa cho khách", "Bỏ rác phát sinh" ⇒ chọn một là thành phiếu chi lách quy trình (cặp phiếu thanh lý) | Tập hạng mục dùng được của bot chỉ bỏ cờ `system_only` / ẩn / hạn chế / cọc / chuyển nội bộ; "Bổ sung hoàn cọc" và "Trả lại tiền thừa cho khách" không mang cờ nào (web cho lập tay); không lớp nào xét NỘI DUNG | `20261024094809`: `public.hermes_expense_system_flow_v1` (thuần chữ) nhận luồng theo `rule_key` của danh mục chuẩn, rồi theo cụm từ bỏ dấu. `expense.create` / `expense.edit` ⇒ `web_only` + `link` màn gốc, chặn TRƯỚC khi hỏi lại toà / hạng mục; lượt 2 kiểm lại. Luật khoá cứng của web xếp nội dung vào hạng mục luồng hệ thống ("tiền phòng 5 ngày") ⇒ cũng chặn. Hạng mục luồng hệ thống không bao giờ là ứng viên / gợi ý. Sửa phiếu đang mang hạng mục đó (lập trên web) ⇒ `web_only` + link trang phiếu |
| Hỏi "phiếu chờ duyệt quá 7 ngày" ⇒ trả cả 58 phiếu | Không tool nào lọc tuổi: `crm_read_income_expenses` chỉ lọc ngày phiếu; W2 `expense_vouchers` `kind=oldest` chỉ sắp xếp, cửa sổ mặc định là tháng này | `20261024095547`: `expense_vouchers` nhận `days` = phiếu CHI chờ duyệt từ N ngày trở lên (`pendingDays ≥ N`), lâu nhất trước, không nêu ngày ⇒ 366 ngày tới hôm nay, summary chỉ trên các phiếu đó; trạng thái khác UNAPPROVED ⇒ sai tham số. Mô tả `crm_read_income_expenses` và gợi ý gọi nhầm chỉ sang `expense_vouchers days=N` |
| (Kiểm) Thiếu quyền duyệt bị báo "thao tác duyệt chưa bật" | Connector đang chạy loại thao tác khỏi tập dùng được khi thiếu quyền CRM ⇒ `action_disabled` trước khi gọi SQL | Không sửa SQL. Bản sửa `forbidden` ≠ `action_disabled` nằm ở connector của #315 (C2) |

Luồng và link:

| Luồng | Nhận theo | Link |
| --- | --- | --- |
| Hoa hồng / thưởng sale | `hoa_hong_moi_gioi`, `hhmg`, `thuong_nong_sale`; "hoa hồng", "HHMG", "thưởng nóng", "thưởng sale", "môi giới" | `/contracts` |
| Thanh lý / trả tiền thừa cho khách | `tra_tien_thua_khach`; "thanh lý", "tiền thừa", "tiền thối", "thối tiền", "đóng dư", "hoàn tiền phòng", "trả (lại) (tiền) (cho) khách / người thuê" (không "khách sạn") | `/contracts` |
| Cọc | `bo_sung_hoan_coc`; "hoàn / trả / bỏ / mất / cấn / bổ sung … cọc", "cọc phòng / khách / hợp đồng / giữ chỗ", "giữ chỗ" | `/deposits` |
| Lương | `luong_quan_ly`, `ung_luong`, `luong_dieu_hanh`; "tiền / trả / ứng / chi / bảng / phát / quỹ / tăng lương", "lương tháng / quản lý / nhân viên / T10 …" | `/finance/salary` |
| Chia lợi nhuận | `chia_loi_nhuan`; "chia lợi nhuận", "lợi nhuận cổ đông", "cổ tức" | `/finance/shareholder-profit` |
| Chuyển nội bộ | `noi_bo`; "chuyển (tiền) nội bộ", "bàn giao tiền", "chuyển quỹ" | `/finance/cashbooks` |

Không dùng từ đơn đã bỏ dấu vì trùng nghĩa: "coc" = cọc / cốc; "luong" = lương / lượng (số lượng, chất lượng); "hoan tien" = hoàn cho khách / hoàn tạm ứng nhân viên. Đặt cọc cho thợ / nhà cung cấp là khoản chi thật nên không chặn.

**Parity với web:** web chặn lập tay hạng mục CHI `system_only` ở máy chủ (`ie_system_only_manual_blocked`: hoa hồng môi giới, thưởng nóng sale, các mục cọc / thanh lý của hệ thống). Web KHÔNG chặn lập tay ba hạng mục "Bổ sung hoàn cọc", "Trả lại tiền thừa cho khách", "Chuyển tiền nội bộ" (không cờ). Người có `restricted_create` vẫn lập tay được "HHMG", "Lương …", "Chia lợi nhuận cổ đông" (Báo chi nhanh chỉ ẩn ở ô chọn). Hermes chặn cả các mục này; có nên chặn ở web không là câu hỏi cho chủ. Hàm gợi ý dùng chung `ie_category_suggest_v1` giữ nguyên.

### 24.2 Kiểm

- PGlite `expense-write-sql.test.mjs` 23/23 (ca lượt 13: câu đúng / câu trùng chữ, `rule_key` trước chữ của nhóm, lập / sửa bị chặn kèm link, lô nói khoản số mấy, chặn trước khi hỏi toà, không bao giờ là ứng viên, lượt 2, bản đã giải giả). Đột biến 7/7 bị bắt (bỏ từng chỗ chặn), đối chứng không đột biến 23/23.
- PG17 `expense-write-race-sql.test.mjs` 18/18 (đối chứng bỏ NOWAIT dựng trên thân bước ghi mới).
- `wave2-b.test.mjs` 61/61: ca `days`, ghim (thân production = 051032, ghim chéo 051032 ngã đúng câu), hai đột biến mới (bỏ lọc tuổi, bỏ ép UNAPPROVED) bị bắt.
- Tầng 2 trên TEST (một giao dịch ROLLBACK, không đụng kết nối / registry / fixture, không dùng nick chủ / joey / bosshuy): áp hai file lên thân thật, dưới RLS một chủ công ty khác. Câu nghiệm thu ⇒ `web_only` + đúng link; khoản thật ("mua vòi nước", "đặt cọc thợ sửa máy lạnh") như cũ; tập dùng được mất đúng 2 hạng mục × 2 công ty; `days=7` ⇒ 154 phiếu = đếm trực tiếp 154 (không `days`, tháng này: 59).
- Production chỉ đọc: tập dùng được chỉ mất "Bổ sung hoàn cọc", "Trả lại tiền thừa cho khách". 90 ngày qua có 683 phiếu CHI lập tay, trong đó 15 phiếu có nội dung luồng hệ thống, tất cả đúng là luồng hệ thống: 10 phiếu đúng hạng mục, 5 phiếu ghi "Chi khác" (thưởng sale, hoa hồng, trả lại cọc, lương). Không thấy chặn nhầm.

### 24.3 Phát hành

1. Áp `20261024094809` (provenance `unknown`: hàm mới `hermes_expense_system_flow_v1`) và `20261024095547` (thay thân hai hàm gói B ⇒ provenance `catalog-proven` GIẢ ⇒ áp đích danh). Hai file độc lập; thứ tự tên.
2. Connector không cần trước `094809` (`web_only` + `link` đã qua connector đang chạy). Với `095547`: SQL TRƯỚC connector (connector mới quảng bá `days`).
3. Ghim chéo: sau khi áp, `20261023210634` (ghim thân bước ghi `15183dce…`) và `20261022051032` (ghim thân catalog / đọc gói B) mất khả năng chạy lại ⇒ cần ngoại lệ pinned nếu cửa idempotent đo lại chúng.

## 25. Lượt 14 — sửa phần ghi theo nghiệm thu vòng 1 (24/10/2026)

Nghiệm thu vòng 1 trên TEST (SOUL v4.19 + connector C1): phần ghi đạt 25/41 (trước 14/41), có một lần GHI SAI thật. Luật SOUL do phiên chính sửa riêng.

### 25.1 Đổi gì

| Lỗi nghiệm thu | Gốc (đã tra) | Sửa |
| --- | --- | --- |
| GHI SAI: "Mua nệm" phòng 202 vào "Chi khác (ghi rõ)" (`PC2610225`, đã vào sổ) | Biên nhận: chính bot gửi `category: "Chi khác (ghi rõ)"`. Máy chủ không gợi ý "Chi khác" cho câu này, nhưng hàm dùng chung không ra gì (nệm, giường, tủ … không có trong cụm "hay nói"), và bộ chọn của bot chỉ nêu một ứng viên là "Bỏ rác phát sinh" (trùng chữ với cụm "đổ nệm cũ"). Đo 90 ngày production (683 phiếu CHI lập tay): hàm dùng chung trả "Chi khác" theo trùng chữ ở 14 phiếu ("chi phí …", "ghi chú …"); các phiếu người lập chọn "Chi khác" mà đáng ra là nội thất, điện máy, ăn uống, dụng cụ … | `20261024120207` (hàm dùng chung v3, web đổi cùng lúc): từ vựng nội thất / điện máy / ăn uống / bỏ rác, mở rộng dụng cụ / vật tư điện nước; "Chi khác" không bao giờ thắng trùng chữ tên. `20261024120211`: hạng mục "khác" không bao giờ là ứng viên, gợi ý hay tự nhận của bot; chỉ nhận khi người dùng nêu tên có chữ "khác"; "Chi khác" mà nội dung khớp cứng hạng mục khác ⇒ cảnh báo trong bản xem trước |
| "Đóng tiền nước" 1,2 triệu (hạng mục bắt buộc duyệt) vào sổ ngay (`PC2610230`) | ĐÚNG luật web: hạng mục chi theo trần (`spend_mode` TRAN), 1,2 triệu dưới trần 1,5 triệu / phiếu của toà ⇒ bộ máy chi `UNDER_CEILING` ⇒ duyệt + vào sổ; `force_approval` chỉ xét ở hạng mục TỪNG PHIẾU. Web cùng người, hạng mục, số tiền cũng vào sổ ngay | Không đổi luật (phiên chính chỉnh đáp án). Bản xem trước nêu trần: "VÀO SỔ NGAY khi ghi (dưới trần chi 1.500.000đ một phiếu)"; dòng cam kết của hạng mục TRAN đổi thành "chi theo trần, không trừ cam kết: trần … một phiếu — khoản này trong / VƯỢT trần" (trước đây nói "còn … sau khoản này còn 0" dù cam kết không bị trừ) |
| Xác nhận bị `confirmation_invalid` rồi ra bản xem trước mới, lặp | Journal connector TEST: đúng MỘT `confirmation_invalid` (10:22:30 UTC), từ chối ngay ở connector sau 1,75 s, KHÔNG gọi SQL ⇒ basis không đổi (không có `state_changed`); token lệch `params` / `requestId` hoặc đã dùng / hết hạn. Basis của bản xem trước không chứa gì phụ thuộc thời gian | Connector: `confirmation_invalid` mang câu tĩnh nói phần lệch (`requestId` khác bản xem trước, `params` khác, quá 10 phút, đã dùng, thiếu `requestId`) — bot biết gửi lại đúng gì. Không nới rào token |
| Đồng ý "tiền nhà" 158PVC 36,75 triệu ⇒ `action_outcome_unknown`, trạng thái "không tìm thấy" | Journal: hai lượt `action_outcome_unknown` (10:11:42, 10:32:23 UTC) đều dừng ở trần 15 s của lời gọi (`callTimeoutMs`). DB TEST chậm: bước dựng quyền mất 5,6 s / 8,4 s (thường 1–1,5 s), lệnh ghi bị cắt giữa chừng. Lượt 10:11 thật ra ĐÃ ghi (`PC2610236`, biên nhận xong 9 ms sau khi connector cắt); lượt 10:32 (`b9e9148a…`) không ghi | Connector: lượt đồng ý chỉ gửi lệnh ghi khi trần còn ≥ 75 % (15 s ⇒ 11,25 s), không đủ ⇒ `timeout` TRƯỚC khi đổi token (chưa gửi gì, gọi lại y nguyên được); 57014 (statement_timeout, giao dịch đã lùi) ⇒ `state_changed`. SQL: bước ghi đặt `lock_timeout` 3 s (chờ khoá tư vấn của bộ máy chi / dòng không NOWAIT ⇒ 55P03 ⇒ `state_changed`) |
| "Duyệt hết phiếu chờ toà … dưới 1 triệu" ⇒ `invalid_request`; `status=UNAPPROVED` không ngày chỉ ra phiếu tháng này (thấy 1/4) | Khuôn `expense_vouchers` chỉ có `minAmount`; cửa sổ mặc định tháng này | `20261024120208` (nền W2): tham số `maxAmount`. `20261024120210`: `expense_vouchers` nhận `maxAmount` (chỉ phiếu NHỎ HƠN HẲN số này), `status=UNAPPROVED` không ngày ⇒ 366 ngày tới hôm nay. `20261024120211`: `voucherCode(s)` nhận `voucherId` (UUID) của dòng báo cáo — mã phiếu bị dùng lại giữa các toà nên mã trơn có thể mơ hồ |

### 25.2 Kiểm

- PGlite `expense-write-sql.test.mjs` 26/26 (ba ca lượt 14: "Chi khác", `voucherId`, trần TRAN).
- PG17 `expense-write-race-sql.test.mjs` 19/19 (ca `lock_timeout`: chờ khoá tư vấn ngã 55P03 sau ~3 s).
- `ie-quick-entry-rules-sql.test.mjs`: 707 ca vàng (đổi đúng 32 ca đã soát, thêm 60 câu), bảng đứng thay của vitest 87/87, ghim md5.
- `wave2-b.test.mjs` 64/64 (ca `maxAmount` / UNAPPROVED 366 ngày, ghim chéo 044126 / 051032 / 095547, hai đột biến mới bị bắt).
- Connector: `action-runtime` (chốt trần thời gian, câu `confirmation_invalid`), `action-adapter` (57014), `confirm-guard`, `mcp-http`.

### 25.3 Phát hành

1. Thứ tự áp = thứ tự tên: `20261024094809` → `20261024095547` (lượt 13) → `20261024120207` → `20261024120208` → `20261024120210` → `20261024120211`. Ghim bắt buộc thứ tự đó: `120210` đòi thân `095547` và tên `maxAmount` của `120208`; `120211` đòi thân `094809`. `120207` và `120210` chỉ thay thân hàm đã có ⇒ provenance `catalog-proven` GIẢ ⇒ áp đích danh; `120208` cũng vậy.
2. Connector: phát hành SAU `120208` + `120210` (connector mới gửi `maxAmount`). Phần còn lại (chốt thời gian, 57014, câu `confirmation_invalid`) độc lập với SQL.
3. Ghim chéo sau khi áp: `20261022044126` (thân nền W2), `20261024095547` (thân gói B), `20261024094809` (thân bộ chọn + bước ghi), `20261023210634` (thân lõi giải) mất khả năng chạy lại ⇒ cần ngoại lệ pinned nếu cửa idempotent đo lại chúng.

## 26. Lượt 15 — đọc không xếp hàng sau người ghi, khoản THU qua bot (24/10/2026)

Nghiệm thu lượt cuối C3d trên TEST (connector `66df91e7`, SOUL v4.23): vòng 1 phần a đạt 26/34, 0 ghi sai. Hai lỗi máy chủ.

### 26.1 Đổi gì

| Lỗi nghiệm thu | Gốc (đã tra) | Sửa |
| --- | --- | --- |
| `crm_read_income_expenses {status: UNAPPROVED, limit: 50}` không lọc toà ⇒ `backend_unavailable` hai lần (TEST 18:42:44–18:43:12 UTC); có lọc toà thì chạy | Journal connector: `handlerMs` ~110, `finalizeMs` 8457 / 8562 = trần `statement_timeout` 8 s của vai `authenticated` ⇒ câu SQL HẾT GIỜ, không phải bước kiểm khuôn. Lượt trước / sau của cùng kết nối (gồm `crm_read_report`) chạy 1–2 s. Tái hiện tầng 2 (TEST, ROLLBACK, đúng kết nối và phiên): cùng lời gọi 154–899 ms (50 dòng / 162 phiếu, 15 toà), có lọc toà 197 ms; rào khuôn thật của connector nhận cả bốn kết quả ⇒ câu không chậm, dữ liệu không lạ — nó CHỜ. Bộ đọc miền v2 lấy kết nối (đầu hàm và lần kiểm lại cuối hàm) qua hàm lệnh dùng chung, mà hàm đó theo giao thức NGƯỜI GHI: khoá dòng công ty `FOR NO KEY UPDATE` (`lock_org_for_decision_v1`) và `FOR SHARE` phiên / kết nối / token / trợ lý / chính sách ⇒ mọi giao dịch ghi khác của cùng công ty (web, Hermes ghi, lượt đọc Hermes khác, phép đo ROLLBACK dài trên TEST dùng chung công ty fixture) giữ khoá đó thì lượt đọc xếp hàng tới hết 8 s ⇒ 57014 ⇒ `backend_unavailable`. Không xác định được giao dịch nào giữ khoá lúc 18:42 (TEST tắt `track_commit_timestamp`, khoá TEST không lưu lịch sử) | `20261024193001`: bản đọc kết nối MỚI (`app_private`, DEFINER, STABLE) — chép đúng phần kiểm của hàm lệnh (thân `20261019034850`), không khoá dòng nào; bộ đọc miền v2 (income_expenses, receivables, meter_readings, deposits_held, building_profit) gọi bản đọc ở cả hai chỗ, mọi dòng khác byte-identical với thân `20261021185540`. Các thao tác ghi giữ nguyên giao thức người ghi. Bộ đọc v1 / v3 / W2 chưa đổi (ngoài phạm vi Thu chi) |
| "Thu 200k giữ xe" ⇒ bot gọi `expense.create`, máy chủ hỏi hạng mục chi | Bộ phân luồng hệ thống (lượt 13) chỉ nhận luồng CHI | `20261024193002`: bộ phân luồng thêm hai nhánh SAU mọi nhánh cũ — "thu (tiền) cọc" ⇒ luồng cọc (`/deposits`); khoản THU ⇒ `web_only` + link `/income-expense` (phiếu thu lập tay không qua bot). Chữ bỏ dấu "thu" trùng thứ / thử / thủ / thư / thù ⇒ chỉ cụm có ngữ cảnh: ĐẦU nội dung "tiền / khoản / phiếu thu" (trừ thủ tục, thù lao, thủ quỹ, thu hộ, thu gom, thu mua, thu âm …), "thu tiền", "thu <số tiền>" (có đơn vị hoặc ≥ 3 chữ số ⇒ "thứ 7" không dính), "thu phí / nợ / lãi / giữ xe / rác / điện / nước …"; hoặc "thu … giữ xe / rác / điện nước … của khách / phòng" (không sau "chi" / "phí", không phải thu gom / hộ / mua / âm / lao). Bộ chọn hạng mục, bước ghi (hai lượt), kiểm lại hạng mục và sửa phiếu đều gọi bộ phân luồng theo tên ⇒ không dựng lại hàm nào khác |

Đo trên production (chỉ đọc): 1.309 phiếu CHI lập tay (690 trong 90 ngày) và 186 hạng mục chi — 0 dính luật THU; 25 phiếu có chữ "thu" (bỏ dấu) đều là chi thật ("thu chi điện lạnh – vệ sinh máy lạnh", "Hoàn tác thu tiền", "7 phòng thu hộ", "deal thứ 3", sổ quỹ tên người) và không dính. TEST: 717 phiếu CHI lập tay 90 ngày + 186 hạng mục — luồng không đổi ở phiếu / hạng mục nào.

### 26.2 Kiểm

- PG17 `domain-read-nolock-sql.test.mjs` (MỚI): dữ liệu toàn công ty (ba toà, toà công ty khác, phiếu hạn chế / lương / xoá) đọc không lọc toà qua đủ trang = tập web, qua rào khuôn của connector; thân `185540` CHỜ tới 57014 khi giao dịch khác giữ khoá công ty / phiên / kết nối (tái hiện), sau file trả ngay; bản đọc kết nối = hàm lệnh (mã + câu) ở 12 trạng thái × 3 digest; đột biến (thân v2 cũ, thêm lại `FOR SHARE`, bỏ kiểm `revoked_at`) bị bắt; `$requires$` từ chối thân v2 / hàm lệnh / bản đọc lạ; chạy lại `185540` sau file ngã đúng câu kèm md5.
- PGlite `expense-write-sql.test.mjs` 27/27: ca lượt 15 (13 câu THU, 21 câu chi có chữ "thu", lập / lô / lượt 2 / sửa phiếu ⇒ `web_only` + `/income-expense`; sáu đột biến bị bắt; chạy lại `120211` qua, `094809` ngã đúng câu cũ).
- Tầng 2 TEST (ROLLBACK; nghiệm thu đang chạy nên KHÔNG giữ khoá công ty / phiên trên TEST): áp hai file; đọc toàn công ty bằng thân mới = thân cũ (50 dòng, summary, cursor), 166 ms so với 580 ms; bộ chọn trả `web_only` + `/income-expense` cho "Thu 200k giữ xe".

### 26.3 Phát hành

1. Thứ tự áp: sau mọi file Thu chi của C3, theo tên: `20261024193001` (cần thân v2 `cf03a9fc…` = production = TEST, thân hàm lệnh `0a2c941d…`) rồi `20261024193002` (cần thân bộ phân luồng của `094809`). Hai file độc lập nhau.
2. Connector KHÔNG cần lên trước: khuôn đọc không đổi; `web_only` + link đã là lý do của `expense.create` (lượt 13).
3. Provenance: `193001` tạo hàm mới ⇒ `unknown` (hồ sơ "chưa áp"); `193002` thay hàm chưa có trên production (do `094809` chưa áp) ⇒ `unknown`.
4. Ghim chéo sau khi áp: chạy lại `20261021185540` ngã `hermes_receivables_effective_requires_reviewed_v2: af47eb16c1227abfb46c7f16ba6476f5` (ngoài diff ⇒ CI không đỏ). `193002` không làm file nào mất khả năng chạy lại.

## 27. Lượt 16 — requestId theo token, mã phiếu trùng giữa các toà (24/10/2026)

Nghiệm thu C3d trên TEST, vòng 1: 54/75, 0 ghi sai. Hai lỗi máy chủ.

### 27.1 Đổi gì

| Lỗi nghiệm thu | Gốc | Sửa |
| --- | --- | --- |
| Lượt xác nhận gửi `requestId` thiếu một ký tự (35/36) kèm `confirmToken` đúng ⇒ `invalid_request`; `crm_action_status` hỏng theo vì bot dùng lại mã sai | Phong bì kiểm `requestId` theo khuôn UUID TRƯỚC khi xét token ⇒ lỗi chung, không nói phần nào sai; khoá của token gồm `requestId` mô hình gửi | Connector (khung chung `crm_action_*`, mọi trang): lượt có `confirmToken` lấy `requestId` theo bản ghi của token — khoá vẫn là [kết nối, thao tác, params chuẩn hoá, requestId lúc cấp] nên token của kết nối / thao tác / params khác vẫn bị từ chối; `requestId` mô hình gửi thiếu / sai khuôn / khác / bỏ trống ⇒ dùng của token, kết quả trả `requestId` đó, dòng audit prepared ghi `requestIdFix` {action, requestId, supplied: missing / malformed / different} (không ghi chuỗi mô hình gửi). `requestId` sai khuôn ở lượt không có token (xem trước, `crm_action_status`) ⇒ `invalid_request` kèm câu tĩnh "requestId không đúng khuôn UUID (N ký tự, cần 36) — chép NGUYÊN VĂN …" |
| Mã phiếu dùng lại giữa các toà (TEST: PC2609115 ở 1392QT và 950NK; PC2609114 ở 102LVT và 950NK): người dùng đã nêu toà nhưng `expense.approve` vẫn hỏi chọn phiếu | Lõi giải chỉ lấy gợi ý toà từ chính chuỗi mã | `20261024210500` (lõi giải dựng từ thân `120211`): `expense.approve` / `note` / `edit` / `cancel` đọc `buildingName` tuỳ chọn = toà của phiếu (approve: một toà cho cả lô; edit: đã có — toà nêu đúng toà của phiếu ⇒ không chuyển toà). Chọn phiếu cùng mã của toà đó (khớp đúng tên đã bỏ dấu, bỏ "toà"/"nhà"; không có thì tên chứa chuỗi ≥ 3 ký tự), xét trên mọi phiếu thấy được: phiếu của toà nêu chỉ ngoài phạm vi khoá ⇒ `outside_scope` (trước đây mã còn đúng một phiếu trong phạm vi thì lặng lẽ chọn phiếu đó dù người dùng nói toà khác); không khớp toà nào ⇒ như cũ. Connector khai `buildingName` cho approve / note / cancel và nói trong tiêu đề thao tác |

### 27.2 Kiểm

- Connector: `action-runtime.test.mjs` 19/19 (ca lượt 16: chép thiếu / khác / bỏ trống / đúng ⇒ ghi đúng `requestId` của token + `requestIdFix`; `crm_action_status` / xem trước với mã sai khuôn ⇒ `invalid_request` có câu; token của params / thao tác / kết nối khác vẫn bị từ chối; đột biến bỏ lấy theo token ⇒ ca thiếu ký tự đỏ), `action-contract`, `confirm-guard` (khoá dạng hàm), `mcp-http` (chỉ chuyển đúng câu dựng sẵn), `audit-codes` (`requestIdFix` chỉ ở dòng prepared, đúng khuôn).
- PGlite `expense-write-sql.test.mjs` 28/28: ca lượt 16 (mã ở Toà A + toà ảo: không nêu toà ⇒ hỏi; nêu đúng / bỏ dấu / chứa chuỗi / "toà nhà …" ⇒ đúng phiếu; toà lạ ⇒ hỏi lại đủ; duyệt cả lô một toà; huỷ / sửa đúng phiếu, sửa không chuyển toà; toà nêu chỉ ngoài phạm vi khoá duyệt ⇒ `outside_scope`; đột biến thân `120211` ⇒ hỏi lại và lặng lẽ chọn phiếu Toà A; chạy lại `120211` ngã đúng câu).
- Tầng 2 TEST — CHỈ đọc thuần (chuỗi nghiệm thu đang chạy; hàm lệnh / hàm ghi khoá dòng công ty kể cả khi ROLLBACK): dựng lại phép lọc của lõi mới bằng một câu SELECT trên hai mã của đề — "1392QT" / "toà 1392QT" ⇒ phiếu 1392QT, "950NK" / "toà nhà 950NK" ⇒ 950NK, "102LVT" / "102" ⇒ 102LVT, toà không có phiếu ⇒ bỏ qua. KHÔNG áp file trên TEST, không gọi lõi giải thật hay lệnh duyệt trên TEST.

### 27.3 Phát hành

1. `20261024210500` áp SAU `20261024120211` (ghim md5 thân lõi giải `fefd5791…` của 120211 = TEST). Thay hàm đã có trên production ⇒ provenance `catalog-proven` GIẢ ⇒ áp đích danh.
2. Connector độc lập với SQL: `buildingName` gửi tới SQL cũ thì bị bỏ qua (vẫn hỏi chọn phiếu); phần `requestId` theo token không cần SQL.
3. Ghim chéo sau khi áp: chạy lại `20261024120211` ngã `hermes_expense_round1_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)` — 120211 NẰM TRONG diff của C3 ⇒ thiếu ngoại lệ pinned thì CI main đỏ. Câu lỗi của `210634` / `013109` / `075102` không đổi (không kèm md5).

## 28. Lượt 17 (C3l) — ngày phiếu chi nói bằng lời (26/10/2026)

**Vì sao:** nghiệm thu C3d TC-A04 (Chủ nhật 25/10) "Thứ hai tuần trước anh có chi 2 củ sơn lại tường phòng 302 toà 65, ghi bù giúp anh" ⇒ mô hình tự tính 19/10 (đúng là 12/10: Chủ nhật thuộc tuần bắt đầu thứ Hai 19/10). Cùng lớp lỗi với CV-T12 / HD-T22 đã sửa ở C3i cho Công việc / Hợp đồng; phiếu chi chưa có cụm ngày.

| Đổi | Chi tiết |
| --- | --- |
| `expense-actions-contract.mjs` | `voucherDatePhrase` (tuỳ chọn, ≤ 80 ký tự) cho từng mục `expense.create` và cho `expense.edit` |
| `vn-relative-date.mjs` | `DATE_PHRASE_FIELDS`: `expense.create` (từng mục) / `expense.edit` — hướng QUÁ KHỨ ("thứ sáu" trần = thứ Sáu gần nhất tới hôm nay); connector ghi đè `voucherDate`, cụm không xuống SQL, xem trước nêu "Mục #n: Hiểu '…' là …"; cụm không hiểu ⇒ needs_input |

**Phát hành:** chỉ connector (cùng PR với tên sổ trùng tên phòng của Hoá đơn); connector cũ không nhận tham số mới ⇒ SOUL v4.30 (dặn gửi `voucherDatePhrase`) lên CÙNG connector.

**Test:** `vn-relative-date.test.mjs` (Chủ nhật / thứ Hai: "thứ hai tuần trước", "hôm qua", "cuối tháng trước", "thứ sáu", "hôm kia"; cụm không hiểu; `expense.edit`); `expense-actions.test.mjs` (khuôn trường). Đột biến bằng tay: bỏ ánh xạ `expense.create` ⇒ ca đỏ.

## 29. Lượt 18 (C3n) — token xác nhận chép lệch (27/10/2026)

**Vì sao:** nghiệm thu TC c3m vòng 1 (C3m + SOUL v4.33): 3/131 lượt xác nhận của ba trang (TC-E02, TC-A12, HĐ G21) mô hình chép `confirmToken` lệch — thiếu 13 ký tự (33/46), đổi hoa/thường giữa chuỗi, thừa một ký tự — trong khi `action`, `params`, `requestId` y nguyên ⇒ `confirmation_invalid` (unknown) ⇒ bot xem trước lại và hỏi lại ⇒ ca trượt "không ghi". ~2 % mỗi lượt xác nhận ⇒ mỗi trang hơn 100 lượt xác nhận qua 3 vòng ⇒ một mình lỗi này đủ kéo trang dưới 95 %.

| Đổi | Chi tiết |
| --- | --- |
| `confirm-guard.mjs` | Bản ghi chờ giữ 8 ký tự đầu sau `cf_` (chữ thường). `redeemNear(supplied, binding)`: CHỈ sau khi `redeem` trả unknown; nhận khi có ĐÚNG MỘT bản ghi chờ còn hạn mà khoá binding trùng hẳn (kết nối + thao tác + params chuẩn hoá + requestId lúc cấp) VÀ 8 ký tự đầu trùng (không phân biệt hoa/thường); 0 hoặc ≥ 2 ⇒ unknown, bản ghi giữ nguyên. `splitConfirmField` trả thêm `near` cho chuỗi "giống token" sai khuôn (`cf_` + 8–64 ký tự) |
| `action-runtime.mjs` | Chuỗi `near` vẫn là lượt xác nhận; `redeem` unknown ⇒ `redeemNear`; khớp ⇒ ghi bình thường (requestId của bản xem trước, rào `consentText` giữ nguyên) và dòng audit prepared mang `confirmTokenFix` |
| `broker.mjs`, `host-ownership.mjs` | Trường audit `confirmTokenFix = {action, requestId}` chỉ trên dòng `prepared` của `tools/call`; chuỗi token mô hình gửi KHÔNG vào sổ |

**Không nới gì về nội dung:** vẫn phải có bản xem trước thật với đúng params đó của đúng kết nối, token vẫn dùng một lần, hết hạn 10 phút; params / kết nối / 8 ký tự đầu khác ⇒ `confirmation_invalid` như cũ. Rào chữ công khai (`public-text-guard.mjs`) không dùng khớp gần đúng.

**Phát hành:** chỉ connector, không SQL, không đổi SOUL.

**Test:** `confirm-guard.test.mjs` (ba kiểu chép lệch ⇒ khớp một lần; khác khoá / hàm khoá ném / 8 ký tự đầu khác / quá ngắn / không phải token / hết hạn ⇒ unknown, bản ghi giữ nguyên; `splitConfirmField` `near`); `action-runtime.test.mjs` (ba ca nghiệm thu ⇒ applied đúng một lệnh, requestId của bản xem trước, audit `confirmTokenFix`; params khác / kết nối khác / đầu token khác / quá ngắn ⇒ không ghi, bản xem trước còn dùng được bằng token đúng; đột biến bỏ khớp gần đúng ⇒ cả ba ca đỏ); `audit-codes.test.mjs` (sổ thật nhận `confirmTokenFix` chỉ ở dòng prepared tools/call, khuôn khác bị từ chối).

## 30. Lượt 19 (J06) — sổ người dùng nêu được kiểm trước câu hỏi hạng mục (27/10/2026)

**Vì sao:** nghiệm thu bot Thu chi, ca J06 trượt lặp lại. Quản lý toà chỉ "biết sổ" Chung (thấy sổ, không giữ ⇒ không chi được từ sổ đó) nhắn "Chi 300k sửa khoá cửa phòng 201 toà 80, lấy tiền sổ Chung". Bot gọi `expense.create` `{items:[{buildingName:"80", roomName:"201", amount:300000, content:"sửa khoá cửa", cashbook:"Chung"}]}`. Máy chủ trả `name_unresolved` field `category` (chưa nêu hạng mục, kèm gợi ý), không nói gì về sổ ⇒ bot hỏi hạng mục; người dùng (theo kịch bản) đáp "vậy lấy sổ TK939" vì kỳ vọng bot đã báo sổ Chung không chi được.

**Gốc:** lõi giải (thân `210500`) xét toà/phòng → hạng mục → sổ, nên sổ nêu tên chỉ được giải khi hạng mục đã rõ. `list_cashbooks_for_expense_v2` chỉ nhận người GIỮ sổ (CUSTODIAN); "biết sổ" là thấy mà không giữ ⇒ `cashbook_not_held` (đúng luật §4.3) nhưng tới muộn một lượt.

| Đổi | Chi tiết |
| --- | --- |
| `20261027074419` (lõi giải dựng từ thân `210500`, md5 `4e29591f…` ⇒ `9636ab61…`) | `expense.create`, thứ tự mới: toà/phòng → luồng hệ thống / khoản THU của bộ chọn hạng mục (`web_only` + link, vẫn thắng mọi kiểm sau: không làm qua bot dù sổ nào) → sổ NGƯỜI DÙNG NÊU (không giữ ⇒ `cashbook_not_held`; không thấy ⇒ `name_unresolved` field `cashbook` `not_visible`; khớp nhiều ⇒ `ambiguous`, ứng viên = sổ đang giữ khớp tên, như cũ) → câu hỏi hạng mục → sổ mặc định. Không nêu sổ ⇒ như cũ (hỏi hạng mục trước; không giữ sổ nào ⇒ `cashbook_not_held` sau hạng mục). Lô: thứ tự khoản không đổi (khoản trước thiếu hạng mục vẫn được hỏi trước). `expense.edit` / `approve` / `note` / `cancel` và mọi dòng khác byte-identical với thân `210500` |
| Connector | Không đổi: mã và khuôn đã có. `cashbook_not_held` KHÔNG kèm gợi ý sổ đang giữ vì khuôn `rejected` không có ứng viên (`facts` chỉ nhận dữ kiện khuôn đóng, không tên tự do). Muốn bot nêu "vd TK939" ngay lượt đầu cần khuôn mới (vd `needs_input` field `cashbook` với why riêng + câu tĩnh + SOUL) — chưa làm |

**Kiểm:**
- PGlite `expense-write-sql.test.mjs` 29/29. Ca lượt 19: sổ Chung của người khác + sổ TK939 của người hỏi; không nêu sổ ⇒ hỏi hạng mục; nêu "Chung" / "chung" ⇒ `cashbook_not_held` ngay lượt đầu; "TK939" ⇒ mới hỏi hạng mục, đủ hạng mục ⇒ xem trước trừ TK939; sổ lạ ⇒ hỏi sổ `not_visible`; "quỹ" ⇒ `ambiguous` chỉ nêu sổ đang giữ; lô nói khoản số mấy; hoa hồng / "Thu 200k giữ xe" / hạng mục luồng hệ thống theo `rule_key` + sổ không giữ ⇒ vẫn `web_only`; không giữ sổ nào mà không nêu sổ ⇒ như cũ. Đỏ trước (thân `210500`: `needs_input` category `unspecified`, gợi ý "Sửa chữa") — xanh sau. Đột biến trong test: nạp lại thân `210500` ⇒ hỏi hạng mục trước sổ. Chạy lại `210500` sau file ngã đúng câu; thân lạ (`120211`) ⇒ file từ chối.
- Đột biến bằng tay (ngoài repo), mỗi cái bị đúng một ca bắt: bỏ rào `web_only` trước sổ ⇒ ca `rule_key`; hỏi hạng mục trước sổ nêu ⇒ ca nghiệm thu; sổ mặc định đè sổ nêu ⇒ ca TK939; sổ mặc định trước hạng mục khi không nêu sổ ⇒ ca "không giữ sổ nào".
- Chạy lại `075102` / `013109` / `210634` / `120211` sau file: câu lỗi trùng `expectedMessage` của ngoại lệ pinned đã có. `expense-write-race-sql` 19/19, `wave2-b` 64/64, sổ durable (forward 64 file) 100/100, `hermes-private-flow` 131/131.
- Tầng 2 TEST: CHƯA (phiên này không chạy gì trên TEST/production).

**Phát hành:**
1. `20261027074419` áp SAU `20261024210500` (đã áp production 25/10; `$requires$` ghim md5 thân `4e29591f…` hoặc thân của chính file). Thay hàm đã có trên production ⇒ provenance `catalog-proven` GIẢ ⇒ áp đích danh.
2. Connector / SOUL không cần đổi; không phụ thuộc thứ tự phát hành.
3. Ghim chéo sau khi áp: chạy lại `20261024210500` ngã `hermes_expense_voucher_building_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)` ⇒ thêm ngoại lệ pinned `210500` ⇐ `074419` (210500 ngoài diff ⇒ CI không đỏ). Câu lỗi của `120211` / `210634` / `013109` / `075102` không đổi (không kèm md5).
