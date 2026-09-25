# Sửa phiếu thu chi — đợt 1

Sửa phiếu chờ duyệt có dấu vết · đổi hình thức thu · mã phiếu duy nhất · khoá tháng lợi nhuận tuyệt đối

- Ngày: 25/09/2026
- Trạng thái: thiết kế đã chốt với chủ qua trao đổi 24–25/09 (hai vòng hỏi); plan thi hành ở
  `docs/superpowers/plans/2026-09-25-sua-phieu-thu-chi-dot-1.md`.
- Nguồn số đo: production, đọc bằng pooler chỉ-đọc ngày 24–25/09/2026 (org THẬT `aaaa0000-…0001`).
- **Ràng buộc cứng của chủ (25/09): không được thay đổi dữ liệu đang tồn tại.** Migration chỉ thêm bảng /
  cấu hình mới và đổi cách xử lý từ nay về sau; không UPDATE/DELETE phiếu, mã phiếu, sổ, khoản thu, hoá đơn
  hay cột nào của dòng đang có. Không thêm cột vào `income_expenses`.

## 0. Vì sao làm

| Vấn đề | Số đo |
|---|---|
| Niêm phong (Phương án A, 18/07) chặn sửa rất ít mà bắt "huỷ + tạo bản sao" | 225/273 phiếu lập tay niêm phong được duyệt và ghi sổ ngay lúc lập; chỉ ~48 phiếu từng nằm Chờ duyệt; ≥5/~10 lần huỷ thật là để sửa lỗi gõ; phiếu bản sao không nối về phiếu cũ |
| Phiếu hệ thống không niêm phong, sửa tiền không cần lý do | 85 phiếu hoa hồng + trả khách thanh lý chờ duyệt (~241tr) lúc đo; vụ PC2608134 bớt 2.050.000 |
| Phiếu thu tiền hoá đơn phải huỷ rồi thu lại để đổi sổ/hình thức | 0/655 đợt thu từng Chờ duyệt; 17 lần huỷ-thu-lại: 8 chỉ đổi sổ/hình thức/ngày, 6 thu trùng, 3 đổi tiền |
| Mã phiếu trùng | `auto_generate_voucher_code` đếm theo (user_id, type, YYMM) ⇒ 1.244 mã dùng cho 3.184 phiếu |
| Luật gắn sổ theo hình thức thu chỉ ở client | `src/lib/cashAccount.ts`; server chỉ kiểm CUSTODIAN/KNOWER. 60 ngày: TM 235/239 đúng sổ riêng (4 nhầm vào sổ ngân hàng); TT 81/81 đúng sổ mặc định toà; TK 302/337 đúng sổ mặc định, **35 vào sổ ngân hàng khác của chính người thu** (NATHAN TKHIEP ×28 ở 102LVT/1392QT/403PVB/405PVB/512TT; JOEY CGIANG8818 ×6 ở 950NK; 1 MBHIEP ở 481NVK — nghi nhầm) |
| Khoá tháng lợi nhuận có cửa vượt | trigger cho chủ/super admin vượt và bỏ qua phiếu hệ thống ngoài KQKD; ~6 phiếu đổi tiền/trạng thái sau chốt; chốt không chặn phiếu chờ duyệt; mở khoá không bắt lý do |

## 1. Quyết định của chủ

1. Bỏ niêm phong với phiếu **Chờ duyệt**: sửa được hết, mọi lần sửa có dấu vết, người duyệt thấy.
2. Đợt 1 chỉ làm phiếu Chờ duyệt. Ngoại lệ duy nhất: **đổi hình thức thu (và sổ nhận trong danh sách cho
   phép)** của phiếu thu tiền hoá đơn (luôn đã ghi sổ) — không đổi số tiền, không đổi nợ hoá đơn.
3. Loại phiếu sửa được khi chờ duyệt: mọi phiếu lập tay, phiếu hoa hồng, phiếu trả khách thanh lý. Không áp:
   cặp bỏ cọc, lương, chia lợi nhuận, phiếu chuyển bàn giao, phiếu gắn hoá đơn/thanh toán, giữ chỗ.
4. Ai sửa: người lập (phiếu của mình) + người có quyền "sửa thu chi" (+ chủ, quản trị).
5. Lý do bắt buộc (≥ 8 ký tự) khi đổi số tiền, hạng mục, loại thu/chi, sổ quỹ hoặc toà; không bắt khi chỉ
   đổi tên/ảnh/người nhận/ngày.
6. Người duyệt: dấu "Đã sửa N lần", bảng so sánh "trước khi sửa → hiện tại" trong hộp Duyệt, sửa chen giữa
   thì bắt tải lại. **Không** làm luật "người sửa không tự duyệt" và không làm phương án mở rộng nào khác.
7. Hoa hồng / trả khách: cho sửa số tiền + bắt lý do + cảnh báo lệch số hệ thống tính. Không đổi được loại
   hạng mục, toà, phòng, khách, hợp đồng, KQKD, lặp lại của hai loại này.
8. Sửa xong vẫn Chờ duyệt, không tự duyệt.
9. **Sổ nhận tiền theo hình thức (chủ chọn phương án A cho chuyển khoản):**
   - Tiền mặt: đúng một sổ tiền mặt riêng của người thu.
   - Chuyển khoản / Thanh toán: mỗi toà một **danh sách sổ được nhận** = 1 sổ mặc định (`buildings.
     default_account_id_tk/_tt`, giữ nguyên) + các sổ phụ. Người thu chọn trong danh sách (mặc định chọn
     sẵn); máy chủ chặn sổ ngoài danh sách.
   - Luật chuyển vào máy chủ; một màn cài đặt "Sổ nhận tiền" thay cho quy ước tên "…Thu" và thay 2 ô
     sổ CK/TT trong form toà (bỏ khỏi form toà để không còn hai nơi sửa).
   - Khởi tạo: sổ tiền mặt riêng NATHAN → Hiệp Thu, JOEY → Hiển Thu, B.Huy → Huy Thu, NG TÂM → Tâm Thu
     (quy tắc chung: sổ tên "…Thu" không ảo do chính người đó sở hữu, ưu tiên `is_default`); sổ phụ CK:
     102LVT, 1392QT, 403PVB, 405PVB, 512TT → TKHIEP; 950NK → CGIANG8818. Tài khoản chủ công ty không có sổ.
10. Toà/người chưa cài sổ cho hình thức nào thì chặn thu hoặc đổi sang hình thức đó (không rơi về sổ khác).
11. Đổi hình thức thu: người đã thu, chủ, quản trị; lý do mỗi lần; đổi qua lại được (kể cả đổi sổ trong cùng
    hình thức, vd MBHIEP ↔ TKHIEP). Khoản thu có tiền thối thì chặn.
12. Thu trùng: huỷ phiếu thu phải gõ lý do thật; cảnh báo khi thu lặp cùng số tiền trong 30 phút.
13. Mã phiếu đếm chung cả công ty theo loại + tháng; giữ dạng `PT|PC + YYMM + số`; mã cũ giữ nguyên.
14. Khoá tháng lợi nhuận tuyệt đối theo **ngày phiếu**, mọi người, mọi loại phiếu. Ngoại lệ không đổi tiền:
    Bổ sung (bảng riêng), phiếu lặp lại (máy dời lịch / dừng lặp), gắn/nhả phiếu khỏi phiên bàn giao tiền
    mặt, đánh dấu đã kiểm. **Không có công tắc vượt khoá**; migration kỹ thuật buộc phải đụng tháng đã chốt
    thì tự `DISABLE TRIGGER` trong chính transaction của nó và phải qua review.
15. Mở khoá tháng bắt lý do (lưu lại); không cho chốt khi còn phiếu Chờ duyệt trong tháng/toà (lúc đo: tháng
    08 còn 79 phiếu / ~619,6 triệu ở 16 toà).
16. Gộp các lỗi giao diện nhỏ liên quan (mục E). Xoá triệt để phần không dùng nữa; phần còn liên quan / sợ
    ảnh hưởng thì ghi vào danh sách đợt 2 (mục 7).
17. "Đã sửa N lần" chỉ đếm từ ngày áp dụng; lần sửa cũ vẫn xem ở "Lịch sử phiếu".

**Ngoài phạm vi (đợt 2):** xem mục 7.

## 2. Thiết kế

### A. Sửa phiếu Chờ duyệt

**A1. Writer** `public.revise_pending_income_expense_v1(p_voucher uuid, p_expected_approval_version bigint,
p_patch jsonb, p_items jsonb DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
returns jsonb` — SECURITY DEFINER, VOLATILE, `REVOKE … FROM PUBLIC, anon, authenticated, service_role`,
`GRANT EXECUTE … TO authenticated`.

- Khoá org (`lock_org_for_decision_v1`) rồi dòng phiếu `FOR UPDATE`. Điều kiện: `approval_status =
  'UNAPPROVED'`, `posting_status <> 'POSTED'`, `active_posting_id_v2 IS NULL`, `deleted_at IS NULL`; CAS
  `approval_version = p_expected_approval_version` (lệch ⇒ `40001`).
- Loại nhận: `flow_kind` NULL hoặc `CANONICAL_INCOME_EXPENSE`; `system_source` ∈ {NULL,
  `contract.commission`, `termination.refund`}; không gắn `payment_id`/`payment_collection_id`/`invoice_id`,
  `salary_staff_id`, `shareholder_id`/`profit_manager_id`, `handover_id`/`handover_transfer_id`,
  `reversal_of_income_expense_id`, giữ chỗ chi lợi nhuận, xử lý cọc giữ chỗ; `assert_no_engine_request_v1`.
- Quyền: super admin; chủ tổ chức; người lập (`coalesce(ie.maker_user_id, flow_ownership.maker_user_id,
  ie.user_id)`); hoặc `ie_can_edit_money_axis_v1` trên toà cũ. Đổi toà: không phải chủ thì cần
  `income_expenses.edit` (hoặc người lập: `income_expenses.create`) trên toà mới. Đổi sổ:
  `assert_cashbook_access_v2(…, 'CUSTODIAN', …)` cho sổ cũ (nếu có) và sổ mới (nếu có). Hạng mục hạn chế:
  luật hiện hành; thêm hạng mục hạn chế mới cần `restricted_create`. Hạng mục `system_only` không được thêm
  mới vào phiếu tay.
- Kiểm dữ liệu: cùng giới hạn với `create_income_expense_v1` (tên ≤ 500, text ngắn ≤ 255, ảnh ≤ 20 URL
  https ≤ 2048, hạng mục 1..200, số lượng nguyên ≥ 1, đơn giá 0..9 999 999 999 999,99, kỳ hạng mục trong
  2000..2100 và ≤ 3660 ngày, loại hạng mục đúng tổ chức và đúng chiều thu/chi).
- Chỉ ghi khi có thay đổi thật (so từng trường + danh sách hạng mục đã chuẩn hoá); không có gì đổi ⇒ trả
  `changed=false`, không tăng phiên bản, không ghi lịch sử.
- Lý do: server tự tính; đổi `type`, `building_id`, `account_id` hoặc số/loại/đơn giá/kỳ của hạng mục mà
  lý do < 8 ký tự ⇒ `22023`.
- Ghi: `begin_ie_flex_write_v1(p_voucher, 'REVISE')`, UPDATE cột được phép + `approval_version + 1`, thay
  hạng mục nếu đổi, `end_ie_flex_write_v1`. Không đụng `birth_*`, `source_payload_hash`,
  `flow_ownership.payload_hash_value` (`assert_committed_birth_boundary_v2` so hash đã lưu, không tính lại —
  đã kiểm 25/09; `finance_v2_birth_provenance_bridge` chỉ chạy khi `birth_operation_id IS NULL`).
- Lưu vết: bảng **`public.income_expense_revisions`** (id, organization_id, income_expense_id, revision_no,
  kind `EDIT_PENDING`/`COLLECTION_METHOD`, actor_id, actor_name, reason, changed_fields text[],
  before_snapshot jsonb, after_snapshot jsonb, idempotency_key, created_at). RLS: đọc theo
  `app_private.ie_supplement_can_read_v1(income_expense_id)` (cùng tầm nhìn phiếu) + policy
  `_hide_sandbox_admin`; `org_boundary` do event trigger tự gắn; authenticated chỉ SELECT; không UPDATE
  được. Ảnh chụp chứa sẵn tên toà/phòng/khách/hợp đồng/sổ/hạng mục để hiển thị không cần tra thêm. Kèm
  `append_income_expense_event_v1(…, 'REVISED', …)`.
- Trả `{id, changed, revision_no, approval_version, changed_fields}`. Idempotency theo `(voucher, key)`.

**A2. Guard.** `guard_income_expense_owned_payload`: nhánh scope `REVISE` (cạnh CASHBOOK_MOVE/ANNOTATE/
LINK_CONTRACT/HANDOVER, trước kiểm flow-owned): OLD và NEW đều `UNAPPROVED`, OLD chưa `POSTED`; chỉ được đổi
cột nội dung (type, name, building_id, room_id, tenant_id, contract_id, payer_name, receive_bank_account,
receive_bank_name, account_id, attachments, voucher_date, business_result_accounting, repeat_*), cột suy ra
do trigger (total_amount, kqkd_amount, counts_in_business_result, has_restricted_item, commission_kind),
`approval_version`, `updated_at`. `guard_income_expense_owned_items`: cho INSERT/DELETE/UPDATE hạng mục khi
scope `REVISE` của đúng phiếu. Thêm `'REVISE'` vào CHECK `ie_flex_writer_xids_scope_chk`.

**A3. Đóng kênh sửa cũ (sau khi web mới lên).** `ie_compat_update_pending_v2` chỉ còn đổi tên / ghi chú /
ảnh; khoá tiền và `p_items` bị từ chối. Caller chuyển sang A1: form sửa (`useUpdateIncomeExpense`), "Đổi sổ
quỹ cả đợt" (`hooks/income-expenses/batch.ts`), "sửa người nhận" (`hooks/useSettlementActions.ts`).

**A4. Duyệt.** `approve_income_expense_v2` / `approve_and_post_income_expense_v2` đã CAS `approval_version`
⇒ sửa chen giữa làm duyệt lỗi; UI dịch lỗi và tải lại. Danh sách nhúng `income_expense_revisions(revision_no)`
qua khoá ngoại để hiện "Đã sửa N lần". Hộp Duyệt (desktop, mobile, "Duyệt và Chi") hiện bảng so sánh
`before_snapshot` của lần sửa đầu → `after_snapshot` của lần cuối, kèm từng lần sửa (ai, lúc nào, lý do).

**A5. Cảnh báo lệch (chỉ UI).** Hoa hồng: so với bậc đã công bố (`commission_autopay_check_v1` trả
`expected`). Trả khách thanh lý: so với số tính lại (`buildTerminationCard` trong
`src/lib/terminationRefundNote.ts`).

**A6.** Sửa xong giữ `UNAPPROVED`/`PENDING`; không chạy lại luật tự duyệt lúc lập.

### B. Phiếu thu tiền hoá đơn

**B1. Cấu hình sổ nhận tiền.**
- `app_private.personal_cash_books(id, organization_id, membership_id, account_id, valid_from, valid_to,
  created_by, created_at)`; tối đa 1 dòng còn hiệu lực mỗi membership; sổ phải thật (không ảo) và người đó
  đang GIỮ sổ (CUSTODIAN).
- `app_private.building_receiving_cashbooks(id, organization_id, building_id, payment_method TK|TT,
  account_id, created_by, created_at)` — sổ PHỤ; sổ mặc định vẫn ở `buildings.default_account_id_tk/_tt`.
- `app_private.receiving_cashbook_ids_v1(org, building, method, collector_membership) → uuid[]` (mặc định
  đứng đầu) và `receiving_cashbook_allowed_v1(…, account) → boolean`: TM = sổ riêng của người thu; TK/TT =
  {mặc định} ∪ sổ phụ, **giao với sổ người thu đang giữ hoặc biết** (luật possession hiện hành của thu tiền).
- RPC: `get_receiving_cashbooks_v1(p_organization_id, p_building_id, p_collector_user_id)` (đọc cho người
  thu/chủ/quản trị); `list_receiving_cashbook_settings_v1(p_organization_id)`,
  `set_personal_cash_book_v1(p_membership_id, p_account_id)`,
  `set_building_receiving_cashbooks_v1(p_building_id, p_method, p_default_account_id, p_extra_account_ids)`
  — cài đặt chỉ cho chủ tổ chức / quản trị.

**B2. Máy chủ bắt luật khi thu (sau khi web mới lên).** `record_invoice_collection_v5`: mỗi dòng TM/TK/TT
phải có `account_id` nằm trong `receiving_cashbook_ids_v1(org, toà hoá đơn, hình thức, membership người
thu)`. Hàm ~950 dòng: dựng bản mới từ `pg_get_functiondef` production bằng chèn đúng một chỗ, md5 trước/sau
ghim trong preflight.

**B3. Writer đổi hình thức thu** `public.change_collection_tender_method_v1(p_tender_id uuid, p_new_method
text, p_new_account_id uuid, p_reason text, p_idempotency_key text) returns jsonb`:
- Đợt thu `ACTIVE`; phiếu của dòng `APPROVED` + `POSTED`, chưa huỷ; `change_amount = 0`; (hình thức, sổ) mới
  khác hiện tại; sổ mới ∈ danh sách cho phép của (toà, hình thức mới, người đã thu); không truyền sổ ⇒ lấy sổ
  mặc định; lý do ≥ 8 ký tự.
- Quyền: `invoice_payment_collections.actor_id = auth.uid()`, chủ tổ chức, super admin.
- Khoá: `assert_period_open_for_edit_v1(voucher, 'đổi hình thức thu của')` (sổ đã chốt, bàn giao, tháng lợi
  nhuận) + trigger sổ đã chốt xét sổ mới.
- Ghi: `app_private.move_posted_income_cashbook_v1` (lõi tách từ `move_income_voucher_cashbook_v1`: scope
  `CASHBOOK_MOVE` để cầu a85 đảo bút toán sổ cũ và ghi thế hệ mới + hậu kiểm triệt tiêu), cập nhật
  `invoice_payment_tenders.payment_method/account_id` và `payments.payment_method` (trong
  `begin_accounting_chain_write_v1`), ghi `income_expense_revisions` kind `COLLECTION_METHOD` và sự kiện
  `CASHBOOK_MOVED`.

**B4. Thu trùng.** Mọi hộp huỷ/hoàn tác khoản thu bắt gõ lý do ≥ 8 ký tự (bỏ câu điền sẵn "Hoàn tác thu tiền
từ giao diện hóa đơn"). Trước khi thu: hoá đơn có khoản thu còn hiệu lực cùng số tiền trong 30 phút ⇒ hỏi
xác nhận (nêu giờ và người thu).

**B5. Nút "Đổi hình thức thu"** ở: hộp "Các lần thanh toán" của hoá đơn (thay nút đổi phương thức đang
chết), danh sách/chi tiết Thu chi (phiếu thu hoá đơn). Khoản thu kiểu cũ (trước 28/07) không đổi được.

### C. Mã phiếu duy nhất

- **C1.** `app_private.voucher_code_counters(organization_id, prefix, yymm, last_value)`.
- **C2.** `auto_generate_voucher_code`: UPDATE … RETURNING; chưa có dòng thì khởi tạo bằng số đuôi lớn nhất
  của **cả tổ chức** trong tháng rồi UPDATE lại. Dạng `prefix || YYMM || LPAD(n, 3, '0')`, ngày theo
  `org_today_v1(NULL)` như cũ.
- **C3.** Chỉ mục duy nhất `(organization_id, code) WHERE code IS NOT NULL AND created_at >= <thời điểm chạy
  migration>` (dựng bằng `EXECUTE format` trong khối DO). Không writer nào tự đặt `code` (đã rà 25/09).
- **C4.** Tìm theo mã: danh sách Thu chi vốn hiện ngày + người lập ⇒ không cần đổi giao diện.

### D. Khoá tháng lợi nhuận tuyệt đối

- **D1.** `app_private.profit_month_locked_v1(p_building uuid, p_date date) returns boolean` (STABLE) và
  `app_private.assert_profit_month_open_v2(p_building, p_date, p_action text)`.
- **D2.** Viết lại `income_expenses_check_profit_lock` và `income_expense_items_check_profit_lock`: bỏ nhánh
  chủ/super admin, bỏ lọc KQKD/nguồn, bỏ `RETURN` sớm khi `auth.uid()` NULL; xét (toà, ngày) cũ và mới ở mọi
  INSERT/UPDATE/DELETE; ngoại lệ chỉ khi thay đổi nằm gọn trong {`repeat_remaining`, `repeat_next_date`,
  `handover_id`, `verified_*`, `updated_at`} (+ chiều NULL→giá trị của posting_mode/posting_status/
  review_state), hoặc scope `STOP_RECURRING` tắt lặp (`repeat_cycle='NONE'`). ANNOTATE không còn là ngoại lệ.
- **D3.** `assert_period_open_for_edit_v1`: bước lợi nhuận dùng hàm chung, bỏ lọc KQKD; **bỏ** bước 4 (tháng
  hoá đơn) và 5 (kỳ hạng mục).
- **D4.** `lock_profit_month_v1`: từ chối khi còn phiếu `UNAPPROVED` trong tháng/toà, nêu số phiếu + mã.
- **D5.** `unlock_profit_month_v1(p_period_month, p_building_ids, p_reason)` (DROP chữ ký cũ, giữ ACL):
  lý do 8..1000 ký tự, ghi `app_private.profit_month_unlock_log`.
- **D6. Hệ quả chấp nhận:** mọi việc ghi lùi ngày vào tháng đã chốt lỗi `[PROFIT_LOCKED]` với mọi người ⇒
  phải mở khoá trước. Job phiếu lặp lại bỏ qua (NOTICE) phiếu con rơi vào tháng đã chốt — vốn có
  `EXCEPTION WHEN OTHERS` từng phiếu.

### E. Lỗi giao diện đi kèm

- **E1.** `AttachmentUpload`: nút X chỉ xoá file khỏi kho khi file do CHÍNH lần mở form này tải lên; ảnh có
  sẵn (form Sửa, Tạo bản sao, hộp Duyệt) chỉ gỡ khỏi form.
- **E2.** Hộp Thu/Chi (`IncomeExpensePostingDialog`): thêm/gỡ ảnh gom lại, chỉ ghi lên phiếu khi bấm xác
  nhận; bấm Huỷ bỏ thì xoá file vừa tải, không đổi phiếu.
- **E3.** Ẩn "Sửa phiếu (Super Admin)" khi phiếu không ở Chờ duyệt (giữ chế độ KQKD phiếu bỏ cọc).
- **E4.** Chú thích nút Mở lại: bỏ "sửa được".
- **E5.** Bỏ toast "Phiếu canonical không sửa được…" ở luồng sửa (giữ ở Huỷ duyệt/Khôi phục — đợt 2).

### F. Xoá phần không dùng nữa

- `src/hooks/useUpdatePaymentMethod.ts` + RPC `update_invoice_payment_method_v1` (đổi phương thức kiểu cũ,
  đang chết với mọi khoản thu từ 28/07).
- `src/hooks/income-expenses/incomeVoucherCashbook.ts` + RPC `move_income_voucher_cashbook_v1` (không nút nào
  gọi; lõi chuyển thành `app_private.move_posted_income_cashbook_v1`).
- `ownCashAccountId`, `resolveTmAccountId`, `resolveAccountIdForMethod` trong `src/lib/cashAccount.ts` (+ test)
  — thay bằng dữ liệu từ `get_receiving_cashbooks_v1`.
- 2 ô "Sổ quỹ mặc định CK/TT" trong `BuildingFormDialog` (chuyển sang màn "Sổ nhận tiền").
- Nhánh sửa tiền trong `ie_compat_update_pending_v2`.
- Quyền gọi `record_invoice_payment_v4` của `authenticated` (giao diện không dùng).

## 3. Thông báo lỗi chính

| Tình huống | Câu hiện |
|---|---|
| Sửa trục tiền thiếu lý do | "Đổi số tiền, hạng mục, loại, sổ quỹ hoặc toà phải ghi lý do (ít nhất 8 ký tự)." |
| Sửa chen giữa | "Phiếu vừa được người khác sửa — tải lại để xem thay đổi." |
| Tháng đã chốt | "[PROFIT_LOCKED] Tháng MM/YYYY của toà X đã chốt lợi nhuận — mọi phiếu của tháng này bị khoá, không … được. Nhờ chủ công ty mở khoá tháng." |
| Chưa cài sổ | "Toà X chưa cài sổ nhận tiền cho hình thức Chuyển khoản." / "Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền." |
| Sổ ngoài danh sách | "Sổ … không nằm trong danh sách sổ nhận tiền <hình thức> của toà X." |
| Có tiền thối | "Khoản thu có tiền thối nên không đổi hình thức được." |
| Chốt còn phiếu chờ duyệt | "Còn N phiếu chờ duyệt trong tháng MM/YYYY: … — duyệt hoặc huỷ trước khi chốt." |

## 4. Kiểm thử

- Unit (vitest): diff + nhãn tiếng Việt, `requiresRevisionReason`, `canReviseVoucher`; test tĩnh từng migration.
- Môi trường TEST: áp migration (`test-env:thu-sql --ghi`), sinh types từ TEST, E2E vai thật trên web
  test-env — quản lý toà sửa phiếu chờ duyệt, chủ duyệt thấy bảng so sánh; người thu đổi TM↔CK và MBHIEP↔TKHIEP;
  chốt tháng bị chặn khi còn phiếu chờ duyệt; mở khoá bắt lý do; thu lặp hiện cảnh báo.
- Gate: `gate:truoc-push`, 15 gate security chạy tay, `gate:reconcile-money` + `v2`, `org-inventory`.

## 5. Triển khai

- Migration đi lane `migrate:forward`; mỗi file một backup. Thứ tự: M1 (mã) → M2 (khoá tháng) → M3 (sửa phiếu,
  máy chủ) → M4 (sổ nhận tiền, máy chủ) → web → M5 (đóng đường cũ: compat chỉ metadata, thu tiền bắt danh sách
  sổ, xoá RPC cũ).
- Trước khi web lên: chủ xem lại màn "Sổ nhận tiền" (seed ở mục 1.9).

## 6. Rủi ro còn lại

- `record_invoice_collection_v5` là hàm tiền lớn: sửa bằng bản prod + md5 ghim + test.
- Khoá tuyệt đối làm lỗi các việc ghi lùi ngày; đây là chủ ý, cần báo nhân viên.

## 7. Ghi lại cho đợt 2 (không làm bây giờ)

- Sửa phiếu đã duyệt / đã ghi sổ ("mở lại để sửa"); sửa số tiền phiếu thu hoá đơn; đổi ngày thu.
- `useUploadPaymentReceipt` (thêm ảnh cho khoản thu từ 28/07) đang chết — tạm dùng "Bổ sung".
- Huỷ khoản thu chưa gỡ ngày công chấm theo GPS (`v5_lock_assert` join phiếu thu không lọc phiếu đã huỷ).
- `SettlementLifecycleModal` (hợp đồng & quyết toán) cũng ghi ảnh ngay khi dán như hộp Thu/Chi cũ.
- Huỷ duyệt / Khôi phục phiếu niêm phong vẫn báo "canonical" — xử lý cùng "mở lại để sửa".
- 4 khoản thu tiền mặt vào sổ ngân hàng (60 ngày) để nguyên (không đổi dữ liệu cũ); người thu tự sửa bằng
  "Đổi hình thức thu" nếu muốn.
