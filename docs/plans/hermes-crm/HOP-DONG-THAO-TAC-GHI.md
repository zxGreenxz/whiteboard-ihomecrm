# Thao tác ghi của Hermes — trang HỢP ĐỒNG (Đợt 2: thiết kế ĐÃ DUYỆT, đang hiện thực)

Ngày 22/10/2026 (giờ Việt Nam). Tài liệu này cắm các thao tác ghi của trang Hợp đồng vào khung chung đã có trên `main` ([NEN-CHUNG-THAO-TAC-GHI.md](NEN-CHUNG-THAO-TAC-GHI.md)). Phiên chính đã duyệt thiết kế, chốt D-HĐ1–D-HĐ10 theo mặc định và chốt D-HĐ11 (22/10). Tiến độ ở mục 15 (Mốc 2–5 xong; Mốc 5 xếp chồng trên #270). Migration chỉ là file, chưa áp; production chưa đổi.

Căn cứ, theo thứ tự ưu tiên:
1. Đáp án 40 câu chủ chốt ngày 21/10: Q2, Q3, Q7, Q20–Q23, Q26. Khi đáp án và plan mâu thuẫn, đáp án thắng.
2. Plan chi tiết trang Hợp đồng ngày 21/10 (§1, §2, §4–§7, §9). Plan nằm ở máy làm việc, không có trong repo. Phần "một tool riêng" của plan thay bằng thao tác trong danh mục chung.
3. Lượt đo nền ngày 22/10: bot production chạy trên TEST, 28 ca đọc và từ chối của trang Hợp đồng, 11 ca đạt.
4. Mã trên `origin/main` `2d0a0099a`.
5. Các truy vấn chỉ đọc, chỉ đếm, chạy trên production ngày 22/10 (mục 6 và 7).

## 0. Kết luận

1. **Mười thao tác, một RPC trang, 0 byte `tools/list` cho phần ghi.** Cả mười thao tác đi qua ba tool `crm_action_*`. RPC của trang là `public.hermes_contract_action_v1`, có cùng chữ ký với `hermes_action_probe_v1`. RPC này gồm ba tầng:
   - vỏ INVOKER, thân SQL-standard;
   - hàm tra cứu INVOKER, chạy dưới RLS của người hỏi;
   - bước ghi DEFINER, gọi **đúng** hàm ghi mà web đang dùng.

   Sáu khoá Action của trang đã seed TẮT (M2) và đã có trong `capability-contract.mjs`, nên không cần thêm khoá mới.
2. **Mọi hàm ghi web của trang đều là SECURITY DEFINER và tự kiểm `auth.uid()`.** Đó là `set_contract_move_out_notice_v1`, `renew_contract_with_notice_v1`, `confirm_contract_return_v1`, `lock_room_for_sale_v1`, `release_room_sale_lock_v1`, `reconcile_contract_customers_v1` và `save_contract_draft`. Vì vậy bước ghi DEFINER gọi thẳng chúng được mà không bỏ qua RLS: các hàm này vốn không dựa vào RLS. Không có hàm DEFINER nào chép policy.
3. **Xem trước theo Q2 = a.** Thao tác dính tiền hoặc không lùi được thì luôn xem trước: gia hạn, gia hạn hàng loạt, ghi nhận trả phòng. Các thao tác khác ghi thẳng, trừ khi máy chủ đòi xác nhận cho từng lần gọi: báo trả, huỷ báo trả, khoá tạm, gỡ khoá, thêm/bớt người ở, soạn nháp. Điểm này khác plan §9 Q2 (plan cho báo trả xem trước) và cần phiên chính chốt (D-HĐ1).
4. **Ngày gia hạn do máy chủ tính bằng hàm dùng chung mới `public.contract_renewal_end_date_v1(end_date, months)`.** Hiện máy chủ không tính ngày, còn web để người dùng tự chọn ngày. Luật "ngày cuối tháng thì giữ cuối tháng, còn lại giữ số ngày" khớp 82/112 lần gia hạn thật. Phép cộng tháng thuần của Postgres chỉ khớp 49/112. Web cũng dùng hàm này qua nút "+N tháng" trong hộp Gia hạn (luật 17/10).
5. **Đọc bù đi qua sổ W2, gần như không thêm byte.** Báo cáo mới nằm trong kết quả `crm_read_report_list`. Hai chỗ đổi byte (đo lại theo review #270, mục 6): mô tả `crm_available_rooms` +48 B; kết nối CHỈ có `contracts.view` thấy thêm hai tool báo cáo. Phần đọc gồm:
   - thêm 3 báo cáo: HĐ kết thúc trong khoảng ngày, báo trả theo khoảng ngày, hồ sơ trả phòng chờ quyết toán;
   - sửa tiêu đề 2 báo cáo: `re_terminations` (kỳ đúng tháng, đếm bỏ cọc), `held_deposits` ("chưa thu đủ cọc" = `SHORT` + `FIRST_INVOICE`, không có status `OWING`);
   - Mốc 3: báo cáo `rooms_occupancy` (số phòng theo toà, khoá `rooms.view`) và ba báo cáo hợp đồng chuyển sang khoá `contracts.view`, để Quản lý toà hỏi được;
   - `publicLink` của chi tiết HĐ: chưa làm (mục 6).

   Nguyên nhân của (d) và (e) đã đo được (mục 6). Đáp án "2 HĐ thiếu cọc" của ma trận đúng với TEST: `SHORT` 1 + `FIRST_INVOICE` 1, đo ở tầng 2 ngày 22/10. Production lúc đo có 17 HĐ ACTIVE chưa thu đồng cọc nào, cộng 1 HĐ ở chế độ `FIRST_INVOICE`; chênh lệch là dữ liệu production khác bản chép TEST, không phải đáp án sai. Đo lại trên TEST ở Mốc 3 (D-HĐ11): tổ chức chính có 282 HĐ hiệu lực, đúng 2 HĐ còn thiếu ≥ 10.000đ (= `SHORT` ∪ `FIRST_INVOICE`), 0 HĐ thiếu trong khoảng 0–10.000đ, 9 HĐ cọc 0; 16 HĐ "chưa thu đồng nào" khác thuộc tổ chức thử thứ hai.
6. **Rào bất biến nằm trong bước ghi.**
   - Trả phòng DEFERRED: trong giao dịch không được có phiếu thu/chi hay hoá đơn mới của HĐ. Có thì lùi về savepoint.
   - Migration của trang đòi P0a đã áp, kiểm bằng dấu `[TERMINATION_CONTRACT_CLOSED]` trong thân `approve_contract_termination_v1`.
   - Không bỏ được người đại diện. Hàm web `reconcile_contract_customers_v1` **không** chặn việc này, nên wrapper chặn.
7. **Ước công Mốc 2–6: 9–12 ngày kỹ sư.** Gồm 3–4 migration (chỉ là file), một module contract connector, fixture PGlite, kịch bản SQL trên TEST, và một thay đổi web nhỏ (nút "+N tháng").

## 1. Phạm vi

| Trong (theo đáp án) | Ngoài: bot từ chối và chỉ đường web (mục 12) |
| --- | --- |
| Báo trả, dời ngày, huỷ báo trả; khoá tạm và gỡ khoá phòng (Q2 = a: ghi thẳng) | Quyết toán, hoàn cọc; cặp phiếu bỏ cọc; cọc giữ chỗ |
| Gia hạn giữ nguyên giá (Q21 = a), có lý do hoặc câu cố định | Sửa giá không qua gia hạn; gia hạn đổi giá (Q21) |
| Ghi nhận khách trả phòng, quyết toán sau (Q20 = a, DEFERRED) | Xoá HĐ; chuyển phòng (plan P6); nhập Excel; hoa hồng |
| Thêm/bớt người ở; soạn nháp HĐ mới, người ký trên web (Q22 = a) | Tạo HĐ thẳng; ký nháp |
| Gia hạn hàng loạt ≤ 20 HĐ một lô, đồng ý một lần (Q23 = a, xong trước 01/2027) | Siết quyền máy chủ (Q26: PR riêng của phiên chính) |
| Đọc: hồ sơ chờ quyết toán, báo trả theo khoảng, `publicLink`, đọc bù (a)–(e) | SOUL (phiên chính sửa; mục 13 chỉ là đề xuất) |

## 2. Kiến trúc SQL của trang

Khuôn lấy từ `hermes_action_probe_v1` (M1, `20261021133823`). Vai `authenticated` không có USAGE trên `app_private`, nên vỏ gắn OID của các hàm nó gọi ngay lúc tạo.

```text
public.hermes_contract_action_v1(p_binding, p_action, p_phase, p_request_id, p_params, p_resolved, p_expected_basis)
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public BEGIN ATOMIC
  g: app_private.hermes_action_guard_v1(binding, action)        -- binding, khoá, quyền CRM, tập toà (DEFINER, M1)
  r: public.hermes_write_name_resolve_v1(org, toà[], {building, room})   -- chỉ ở lượt preview/auto (INVOKER, D7)
  l: public.hermes_contract_action_lookup_v1(org, toà[], action, params, r)  -- INVOKER, STABLE, search_path='' (mới)
     dưới RLS người hỏi: HĐ hiện hành của phòng thấy được (contracts RLS), tên khách đại diện (customers RLS),
     khách khớp SĐT/tên, khoá tạm đang mở, danh sách HĐ của lô
  → app_private.hermes_contract_action_step_v1(…, r, l)          -- DEFINER (mới)
```

**Bước ghi** (`app_private.hermes_contract_action_step_v1`, plpgsql DEFINER):
1. Kiểm NULL. Chạy lại guard. Kiểm toà đã giải nằm trong `ctx.buildingIds` và phòng thuộc đúng toà, như probe.
2. Tra lại bản thật theo id mà `l` đưa: `contracts` khoá `FOR UPDATE` ở lượt apply. Đòi HĐ khớp `room_id`, `status='ACTIVE'`, `actual_end_date IS NULL`, `deleted_at IS NULL`. Tham số mô hình gửi không bao giờ được tin thành id.
3. Tính `basis` (mục 3, cột cuối). Lượt apply mà lệch thì trả `state_changed` và không mở biên nhận.
4. Lượt preview, hoặc auto khi cần xác nhận: trả `{kind:'preview', preview, basis, resolved, confirm, warnings}`. Lượt auto với thao tác reversible, chính sách `never`, máy chủ không đòi xác nhận: ghi luôn.
5. Ghi theo khuôn M1:
   - `receipt_begin` (phát lại / xung đột / chưa rõ);
   - `BEGIN … EXCEPTION` quanh lời gọi hàm ghi web, kèm hậu điều kiện;
   - lỗi tạm `40001/40P01/55P03/PT409` thì `RAISE` lại;
   - còn lại ánh xạ lý do (mục 5), rồi `receipt_finish` + audit `HERMES_ACTION_*`.
6. Truyền `p_expected_updated_at = contracts.updated_at` vừa khoá, để hàm ghi web tự kiểm thêm một lớp.

Khoá idempotency của hàm ghi web lấy từ requestId của connector:
- gia hạn: `p_request_id = requestId`;
- trả phòng: `p_idempotency_key = 'hermes:' || requestId`;
- nháp: `p_request_id = requestId`, `p_draft_id = md5('draft:' || requestId)::uuid`;
- dòng con của lô: `md5(requestId || contractId)::uuid`.

Vì sao có hàm tra cứu INVOKER riêng: tên khách và việc "thấy HĐ" phải theo RLS của người hỏi. Ví dụ, người có `contracts.renew` nhưng không có `customers.view` thì không được thấy tên khách. Bước ghi DEFINER chỉ tin id do tra cứu đưa sau khi tự đối chiếu lại; nó không trả thêm dữ liệu cá nhân nào mà tra cứu không thấy.

## 3. Danh mục thao tác (`infra/hermes-broker/contract-action-contract.mjs`)

Mọi thao tác: `page: 'contract'`, `rpc: 'hermes_contract_action_v1'`, `private_only = true` (Q3). Quyền CRM giao vào trùng tên khoá. Hàm ghi web vẫn tự kiểm thêm `contracts.edit`, và sau Q26 kiểm cả khoá riêng.

| id | Khoá Action = quyền CRM | Lớp / chính sách | Tham số (`*` = bắt buộc) | Hàm ghi web | basis |
| --- | --- | --- | --- | --- | --- |
| `contract.notice_set` | `contracts.terminate` | reversible / never | `buildingName*`, `roomName*`, `date*`, `note` (3–500) | `set_contract_move_out_notice_v1` | md5(HĐ, `updated_at`, `expected_move_out_date`) |
| `contract.notice_cancel` | `contracts.terminate` | reversible / never | `buildingName*`, `roomName*`, `reason*` (8–500) | như trên, ngày = NULL | như trên |
| `contract.room_lock` | `sale_phong.lock_room` | reversible / never | `buildingName*`, `roomName*`, `hours*` (6/12/24), `note` (≤ 300) | `lock_room_for_sale_v1` | md5(phòng, khoá đang mở, trạng thái bán) |
| `contract.room_unlock` | `sale_phong.lock_room` | reversible / never | `buildingName*`, `roomName*` | `release_room_sale_lock_v1` (wrapper tìm khoá đang mở) | như trên |
| `contract.renew` | `contracts.renew` | irreversible / always | `buildingName*`, `roomName*`, `months` (1–60) hoặc `newEndDate`, `reason` (8–1000) hoặc `noReason`, `keepMoveOutNotice`, `newRentPrice`, `newDeposit` | `renew_contract_with_notice_v1` (giá, cọc = NULL) | md5(HĐ, `updated_at`, `end_date`, giá, cọc, báo trả) |
| `contract.renew_batch` | `contracts.renew` | irreversible / always | `buildingName`, `endMonth*` (YYYY-MM), `months*` (1–24), `reason` hoặc `noReason` | như trên, từng HĐ | md5(danh sách (HĐ, `updated_at`), danh sách loại) |
| `contract.return` | `contracts.terminate` | irreversible / always | `buildingName*`, `roomName*`, `date*`, `note*` (3–1000, nội dung thanh lý), `forfeit` | `confirm_contract_return_v1` DEFERRED, `p_settlement = NULL`, `p_meter_boundary = NULL` (MISSING) | như renew |
| `contract.occupant_add` | `contracts.edit` | reversible / never | `buildingName*`, `roomName*`, `customerPhone` (6–20) hoặc `customerName` | `reconcile_contract_customers_v1` | md5(HĐ, `updated_at`, danh sách (khách, đại diện)) |
| `contract.occupant_remove` | `contracts.edit` | reversible / never | như trên | như trên | như trên |
| `contract.draft` | `contracts.create` | reversible / never | `buildingName*`, `roomName*`, `rentPrice*`, `deposit*` (≥ 0), `startDate*`, `months` hoặc `endDate`, `customerPhone` hoặc `customerName`, `note` | `save_contract_draft` | md5(phòng, HĐ hiện hành + `updated_at`, nháp gần nhất) |

Ghi chú:
- **Một khoá phục vụ nhiều thao tác.** `hermes_action_capabilities_v1` lấy quyền CRM theo thao tác đầu của khoá, nên mọi thao tác cùng khoá phải cùng quyền CRM (đúng như bảng). Khoá `contracts.terminate` mở cả báo trả lẫn trả phòng. Muốn phát hành báo trả trước trả phòng thì danh mục connector của bản đó **không** khai `contract.return`.
- **Hàm ghi web gọi bằng tham số nào.** `set_contract_move_out_notice_v1` không có requestId: biên nhận Hermes và `p_expected_updated_at` thay vào. `renew_contract_with_notice_v1` luôn cần `p_notice_choice`: HĐ không có báo trả thì gửi `KEEP`, như web.
- **Không thao tác nào khai `attachments`.**

## 4. Từng thao tác: luồng, xem trước, kết quả, trùng lặp

Câu xem trước và câu kết quả do SQL dựng bằng tiếng Việt, ở trường `preview.text` / `result.text`. Kèm theo là các trường có cấu trúc: `buildingName`, `roomName`, `contractNumber`, `representativeName` (null khi không được xem khách), ngày dạng `YYYY-MM-DD`, tiền là chuỗi số nguyên VND. Ngày trong câu có thứ và khoảng cách tới hôm nay theo giờ tổ chức (`org_today_v1`), ví dụ "thứ Sáu 31/10/2026 (còn 9 ngày)". Mục đích là để người dùng bắt lỗi khi mô hình tính sai ngày tương đối. `link` của kết quả là `/contracts/<id>`; mục 3.1 của nền chung cho phép UUID nằm trong link.

### 4.1 Báo trả / dời ngày / huỷ báo trả (Mốc 2)
- **Lấy HĐ.** `l` lấy HĐ hiện hành của phòng. Không có ⇒ `room_has_no_active_contract` (needs_input). HĐ đã ghi trả phòng và đang chờ quyết toán ⇒ `already_returned`.
- **Ngày.** Ngày < hôm nay ⇒ `notice_date_past` (needs_input), kèm câu "khách đã dọn thì dùng ghi nhận trả phòng". Hàm ghi web vẫn cho ngày quá khứ, nhưng qua bot thì đó gần như luôn là nhầm sang trả phòng. Ngày < `start_date` ⇒ `date_out_of_range`. Ngày > `end_date` thì vẫn ghi, kèm cảnh báo "sau ngày hết hạn HĐ, nhớ gia hạn".
- **Kết quả.** "Đã ghi báo trả phòng 302 toà A (HĐ …, khách …): dự kiến dọn đi thứ Sáu 31/10/2026 (còn 9 ngày); trước đó: chưa báo / 15/11/2026."
- **Trùng lặp.** Cùng ngày với giá trị đang có thì hàm web không ghi; kết quả nói "đã có báo trả ngày này, không đổi". Huỷ khi không có báo trả ⇒ `no_notice`.

### 4.2 Khoá tạm / gỡ khoá (Mốc 2)
- **Giờ.** `hours` ngoài {6, 12, 24} ⇒ `invalid_params`.
- **Lỗi của hàm web.** `55000 Phòng không còn trên danh sách bán` ⇒ `room_not_lockable`. `55000 Phòng đang được lock tạm` ⇒ `room_already_locked`.
- **Trùng lặp.** Cùng người, cùng giờ, cùng ghi chú trong 2 phút thì hàm web trả lại khoá cũ; kết quả nói "đã khoá trước đó".
- **Gỡ khoá.** `l` tìm khoá mở chưa hết hạn của phòng. Không có ⇒ `no_open_lock`. Không phải người khoá và không có `deposits.create` ⇒ 42501 ⇒ `not_allowed`.
- **Kết quả.** "Đã khoá tạm phòng 205 toà B 12 giờ, tới 22:15 thứ Tư 22/10/2026" / "Đã gỡ khoá tạm phòng 205 toà B."

### 4.3 Gia hạn giữ giá (Mốc 3)
- **Ngày mới.** `months` ⇒ `contract_renewal_end_date_v1(end_date, months)` (mục 7). `newEndDate` ⇒ phải > `end_date`, không thì `date_out_of_range`. Gửi cả hai hoặc không gửi cái nào ⇒ `invalid_params`.
- **Lý do (Q21).**
  - Không có `reason` và không có `noReason` ⇒ `renew_reason_ask` (needs_input): "hỏi MỘT câu; người dùng nói không có thì gọi lại với `noReason=true`".
  - `noReason=true` ⇒ máy chủ ghi câu cố định "Gia hạn theo yêu cầu qua Hermes, không nêu lý do." (≥ 8 ký tự cho trigger `z98_commission_basis`). Mô hình không tự bịa lý do.
- **Giá và cọc.** `newRentPrice`/`newDeposit` khác giá/cọc hiện tại ⇒ `renew_price_change_web_only` (rejected), câu tĩnh chỉ đường web. Bằng giá/cọc hiện tại thì chấp nhận. Hàm ghi luôn nhận giá, cọc = NULL.
- **Báo trả.** HĐ đang có báo trả mà thiếu `keepMoveOutNotice` ⇒ `notice_choice_required` (needs_input).
- **Xem trước.** "Gia hạn HĐ … phòng 302 toà A (khách …): ngày kết thúc 28/02/2027 → thứ Ba 31/08/2027 (+6 tháng). Giá thuê giữ 4.500.000đ/tháng, cọc giữ 4.500.000đ. Báo trả 15/02/2027: GIỮ / HUỶ (hoặc: không có báo trả). Lý do ghi vào HĐ: '…'. Không phát sinh hoá đơn hay phiếu."
- **Cảnh báo trùng.** HĐ có `contract_extensions` trong 24 giờ qua ⇒ cảnh báo "HĐ vừa được gia hạn lúc … (… → …)". Lý do: mô hình gửi lại với requestId mới sẽ gia hạn chồng thêm N tháng; cảnh báo này và bước xác nhận là rào chính.
- **Hậu điều kiện.** `end_date` = ngày mới, `status='ACTIVE'`, giá và cọc không đổi, báo trả đúng lựa chọn, không có phiếu hay hoá đơn mới. Lệch thì `RAISE` trong khối, lùi về savepoint, chốt `crm_refused`.
- **Đã làm (Mốc 3).** `months` 1–60; ngày mới phải > `end_date` và ≤ `end_date` + 3 660 ngày. HĐ không có báo trả ⇒ gửi `KEEP` như web; chọn GIỮ ⇒ cảnh báo "khách vẫn dọn đi ngày đó". Kết quả có `endDate {from,to}`, `months`, `rentPrice`, `totalDeposit`, `moveOutNotice` (`none` / `kept` / `cancelled`).
- **Phát lại sớm (sửa khi viết Mốc 3).** Biên nhận đã chốt cùng requestId được trả lại TRƯỚC khi tính lại basis. Lần ghi trước đã đổi HĐ nên basis tính lại sẽ lệch: không phát lại sớm thì lần gọi lại nhận `state_changed`, mô hình xem trước lại và có thể gia hạn chồng. Khác thao tác hoặc khác params ⇒ `request_conflict`. Áp cho mọi thao tác của trang.

### 4.4 Ghi nhận trả phòng, quyết toán sau (Mốc 4)
- **Rào trước khi áp.** Migration đòi P0a đã áp (`$requires$` đọc dấu `[TERMINATION_CONTRACT_CLOSED]`).
- **Ngày.** `date` > hôm nay ⇒ `date_out_of_range`, câu gợi ý dùng báo trả. `date` < `start_date` ⇒ `date_out_of_range`.
- **Loại.** Máy chủ suy loại, người dùng không phải chọn:
  - `forfeit=true` ⇒ `FORFEIT`;
  - `date ≥ end_date` ⇒ `NATURAL_EXPIRY`;
  - còn lại ⇒ `EARLY_RETURN`.

  Xem trước nêu rõ loại. Đổi loại về sau làm trên web.
- **Xem trước.** "Ghi nhận khách TRẢ PHÒNG 302 toà A, HĐ … (khách …), ngày trả thứ Tư 22/10/2026, loại: hết hạn / trả sớm / bỏ cọc. Sau khi ghi: HĐ chuyển **Đã thanh lý**, phòng thành **trống**, **KHÔNG lùi được**. Quyết toán (hoàn cọc, trừ tiền, chỉ số chốt) làm trên web. Cọc đã thu …; hoá đơn chưa thu: N (…đ); chỉ số điện nước khi trả: chưa ghi. Nội dung thanh lý: '…'."
- **Hậu điều kiện.**
  - Có đúng một `contract_exit_cases` PENDING, `settlement_mode='DEFERRED'`, khoá `hermes:<requestId>`.
  - HĐ `TERMINATED`, `actual_end_date = date`.
  - Đếm và tổng `income_expenses` + `invoices` gắn HĐ **không đổi** trong giao dịch. Lệch thì lùi.
- **Trùng lặp.**
  - Đã có hồ sơ trả phòng ⇒ `already_returned`.
  - Cùng requestId ⇒ phát lại.
  - Hàm web có khoá `(org, người, key)` cộng băm nội dung.
- **Kết quả.** Có `nextStep: 'Quyết toán trên web: /contracts/<id>'`.
- **Đã làm (Mốc 4, file MỚI `20261022061813_hermes_contract_return_v1`).**
  - Không sửa `20261022022951`: file mới `CREATE OR REPLACE` tra cứu + bước ghi, dựng từ thân của file đó (sẽ là thân đang chạy khi áp), ghim `md5(prosrc)` ở `$requires$`; vỏ giữ nguyên OID.
  - Ngày tương lai ⇒ lý do riêng `return_date_future` (needs_input, hướng sang báo trả), khác thiết kế ban đầu (`date_out_of_range`) để câu tĩnh chỉ đúng đường.
  - `note` (nội dung thanh lý) bắt buộc 3–1000 ký tự vì hàm web đòi; `forfeit` chỉ nhận `true`/`false`.
  - Cảnh báo: trả trước ngày hết hạn ⇒ "loại TRẢ SỚM, bỏ cọc chỉ khi người dùng nói rõ"; báo trả khác ngày trả thực tế ⇒ nêu cả hai ngày.
  - Hoá đơn chưa thu: tra cứu INVOKER tính dưới RLS `invoices`, chỉ khi người hỏi có quyền xem hoá đơn ở toà (`can_do_on_building('invoices','view')`); còn nợ theo hàm dùng chung `invoice_effective_outstanding_v1` (như thẻ "Phải thu"), bỏ hoá đơn huỷ. Không có quyền ⇒ câu xem trước nói "không xem được".
  - Đã có hồ sơ thanh lý cũ (`contract_terminations`) hay hồ sơ trả phòng ⇒ `already_returned` trước khi gọi hàm web.
  - Kết quả có `exitCaseId`, `roomStatus` (phòng về `AVAILABLE` nhờ trigger `trigger_update_room_status` khi HĐ rời ACTIVE), `nextStep`.

### 4.5 Thêm / bớt người ở (Mốc 5)
- **Tìm khách.** Ưu tiên SĐT: chuẩn hoá còn chữ số, khớp đúng trong công ty, dưới RLS `customers`. Có tên thì chỉ nhận khi khớp đúng một khách. Không khớp hoặc khớp nhiều ⇒ `name_unresolved` (`field: 'customer'`). Ứng viên dạng "Nguyễn V. B · …123" (≤ 8), không lộ đủ SĐT. Khách chưa có thì tiêu đề thao tác nhắc tạo trước bằng `crm_customer_create`.
- **Thêm.** Khách đã có trong HĐ ⇒ kết quả "đã có, không đổi". Người mới luôn `is_representative=false`.
- **Bớt.** Người không có trong HĐ ⇒ `occupant_not_on_contract` (needs_input). Người đang là đại diện ⇒ `cannot_remove_representative` (rejected). Hàm web không chặn việc bỏ người đại diện; đổi đại diện làm trên web.
- **Ghi.** `p_expected` = danh sách lúc tra (PT409 nếu đổi). Kết quả liệt kê người ở sau thay đổi (tên theo RLS).
- **Đã làm (Mốc 5, file MỚI `20261022074815_hermes_contract_party_draft_v1`).**
  - Tìm khách bằng hàm INVOKER mới `public.hermes_contract_party_lookup_v1` dưới RLS `customers` (khoá web `customers.view`): SĐT chỉ còn chữ số, `+84`/`84` đầu số ⇒ `0`, khớp đúng; không có SĐT thì tên khớp đúng sau khi gấp dấu. Ứng viên "tên · …3 số cuối" (≤ 8). Bớt người ở chỉ tìm trong khách của HĐ.
  - Vỏ dựng lại (thân `022951` + một nhánh gọi hàm tra khách, kết quả ghép vào khoá `party` của tra cứu); bước ghi dựng từ thân `061813`, ghim md5.
  - `p_expected` đúng khuôn hàm web dựng (`customer_id`, `is_representative`, `notes`, sắp theo `customer_id`) và nằm trong basis; người mới `is_representative=false`, ghi chú của người khác giữ nguyên.
  - Hậu điều kiện: danh sách sau ghi = danh sách mong muốn, tập người đại diện không đổi; lệch ⇒ `crm_refused`.
  - Phòng không có HĐ hiện hành ⇒ `room_has_no_active_contract` trước mọi câu hỏi về khách.
- **Sửa theo review #277 (Mốc 5b, sửa thẳng trong `074815` vì chưa áp ở đâu).**
  - **Phạm vi = guard ∩ quyền.** Hàm tra khách nhận thêm tập toà guard trả cho khoá (`p_building_ids`, chữ ký mới `(uuid,uuid,uuid[],text,jsonb)`). Khách thuộc phạm vi khi có HĐ (mọi trạng thái, chưa xoá) ở toà trong tập — như đọc khách theo toà (`20261021063453`) — hoặc không có HĐ nào ở toà ngoài tập (khách chưa gắn toà, vd vừa tạo trên web). Khách chỉ có HĐ ở toà ngoài tập ⇒ `name_unresolved` `why: outside_scope`, không nêu tên; ứng viên tên trùng chỉ lấy khách trong phạm vi. RLS có thể giấu HĐ ở toà người hỏi không xem, nên bước ghi DEFINER kiểm lại cùng luật trên mọi HĐ ở cả hai lượt.
  - **Lượt 2 kiểm lại khách.** Vỏ gọi lại hàm tra khách theo `customerId` của bản đã giải (dưới RLS người hỏi, trong tập toà); không còn thấy / ra khách khác ⇒ `state_changed`. Basis người ở và nháp có thêm `customerId` (đổi khách ở lượt 2 ⇒ lệch basis).
  - **Bớt người có ghi chú.** Ghi chú nằm trên dòng thành viên nên mất khi bớt, thêm lại không khôi phục ⇒ máy chủ đòi xác nhận; cảnh báo "Ghi chú của … trên HĐ sẽ mất (thêm lại không khôi phục)" và câu xem trước/kết quả nêu nội dung ghi chú (≤ 200 ký tự). Không có ghi chú thì ghi thẳng như cũ.
  - **Biên nhận không giữ SĐT.** `input.params` lưu `customerPhoneSha256` = sha256(tổ chức + ":" + SĐT đã chuẩn hoá như hàm tra khách) thay cho `customerPhone`; phép so phát lại dùng cùng dạng nên cùng SĐT (kể cả khác cách viết) ⇒ phát lại, SĐT khác ⇒ `request_conflict`. Băm chỉ để biên nhận không chứa SĐT dạng chữ: SĐT có ~10⁹ giá trị nên ai đọc được bảng biên nhận (`app_private`, chỉ chủ hàm) vẫn dò được — người đó cũng đọc được `customers.phone`.
  - **HĐ `EXTENDED` / `EXPIRED` chưa kết thúc: giữ tra cứu `ACTIVE` cho thao tác người ở.** Đo production 22/10 (chỉ đếm): `ACTIVE` 298, `TERMINATED` 151, không HĐ nào `EXTENDED`/`EXPIRED`; không hàm ghi hiện hành nào đặt hai trạng thái này (chỉ migration cũ 008/012/015/`20250710000001`/`20260510000012`). Mở rộng thì phải thay bằng file mới hàm tra cứu + bước ghi Mốc 2–4 đang chạy, và hàm ghi web của Mốc 2–4 có luật trạng thái riêng ⇒ không đáng khi production không có dòng nào. Test ghim hành vi: HĐ `EXTENDED` ⇒ `room_has_no_active_contract`.

### 4.6 Soạn nháp HĐ mới (Mốc 5)
- **Payload theo đúng allowlist của `save_contract_draft`.** `form` đủ 12 khoá:
  - `payment_cycle='MONTHLY'`;
  - giảm giá = 0;
  - ngày kết thúc từ `months` hoặc `endDate`;
  - ngày tính tiền và dịch vụ mặc định lấy **như form web**. Phải tra ở Mốc 5; nếu web tự tính ở trình duyệt thì đưa công thức đó vào hàm SQL dùng chung.

  `customers` có 0 hoặc 1 khách đã có sẵn. Không giữ phòng, không có tiền.
- **Máy chủ đòi xác nhận** khi phòng đang có HĐ mà ngày hết hạn / báo trả ≥ `startDate`, hoặc khi đã có nháp của phòng này trong 24 giờ qua.
- **Kết quả.** "Đã soạn nháp HĐ phòng 205 toà C … — mở nháp trên web để kiểm, xuất và ký". Link nháp: đường dẫn web của nháp tra ở Mốc 5.
- **Đã làm (Mốc 5).**
  - **Ngày kết thúc do người dùng nói (`endDate` bắt buộc), không có `months`.** Form web không tự tính ngày kết thúc; đo production (449 HĐ, 18 tháng): "+N tháng" khớp 19, "+N tháng − 1 ngày" khớp 54, cuối tháng 158 — không có luật nào chiếm đa số nên không tự đặt luật.
  - Mặc định như form web: ngày ký = hôm nay, kỳ hằng tháng, giảm giá 0, ngày bắt đầu/kết thúc tính tiền để trống (= theo ngày bắt đầu). Dịch vụ: `services: []` + `use_custom_services: false` ⇒ lúc ký `sign_and_checkin_contract_draft_v1` truyền `services: []` cho `create_contract_v2`, tức dịch vụ mặc định của toà như form web; không chép công thức dịch vụ.
  - Khách: 0 hoặc 1 khách đã có (người đại diện), lấy đúng 6 khoá của allowlist từ bảng `customers`.
  - `p_draft_id = md5('draft:'||requestId)::uuid`, `p_request_id = requestId`, mẫu = NULL.
  - Máy chủ đòi xác nhận (lượt auto trả bản xem trước dù chính sách ghi thẳng) khi phòng còn HĐ có (báo trả hoặc) ngày hết hạn ≥ ngày bắt đầu, hoặc phòng đã có nháp EDITABLE soạn trong 24 giờ.
  - Ngày: bắt đầu trong ±366 ngày quanh hôm nay, kết thúc > bắt đầu và ≤ bắt đầu + 3 660 ngày.
  - Hậu điều kiện: đúng một nháp mới (id theo requestId) EDITABLE đúng phòng + ngày + giá; số HĐ của phòng và trạng thái phòng không đổi.
  - Web không có đường riêng cho nháp (mở bằng tab Nháp ở `/contracts`) ⇒ `link: '/contracts'`, `nextStep` "Mở Hợp đồng → tab Nháp để kiểm, xuất và ký".
  - Mốc 5b: cảnh báo "phòng đang có HĐ" tính HĐ `ACTIVE` + `EXTENDED` như web coi là còn khách (`20261010114500`, giữ chỗ phòng); khách nêu trong nháp theo cùng luật phạm vi và kiểm lại ở lượt 2 như mục 4.5.

### 4.7 Gia hạn hàng loạt (Mốc 6, xong trước 01/2027)
- **Chọn HĐ.** `l` chọn HĐ ACTIVE thấy được, có `end_date` trong `endMonth`, trong tập toà của khoá (∩ `buildingName` nếu có), sắp theo toà rồi phòng, lấy 21 dòng để biết còn dư. **Loại** HĐ đang có báo trả, vì không quyết hộ việc giữ hay huỷ báo trả; cảnh báo liệt kê các HĐ bị loại. Lô tối đa 20 HĐ.
- **Xem trước.** Bảng ≤ 20 dòng "toà / phòng / HĐ / ngày cũ → ngày mới", giá giữ nguyên, lý do chung. Còn dư thì có câu "còn N HĐ, làm lô sau".
- **Ghi.** Mỗi dòng nằm trong một savepoint riêng. Lỗi nghiệp vụ của dòng ⇒ dòng `rejected` + lý do, các dòng khác vẫn ghi. Lỗi tạm ⇒ cả lô lùi (`state_changed`). Kết quả trả từng dòng.
- **Gọi lại sau khi xong.** HĐ đã gia hạn rời khỏi `endMonth`, nên lần chọn sau tự bỏ chúng. Không bao giờ gia hạn chồng một HĐ trong cùng lô.
- **Thời gian.** Lô 20 dòng phải xong dưới `statement_timeout` của `authenticated`; đo trên TEST ở Mốc 6. Hàm ghi gia hạn khoá cả tổ chức (`lock_org_for_decision_v1`) suốt giao dịch.
- **Đã làm (Mốc 6, file MỚI `20261023030305_hermes_contract_renew_batch_v1`, chưa áp).**
  - Thao tác `contract.renew_batch` (khoá + quyền CRM `contracts.renew` như `contract.renew`; irreversible / always): `endMonth*` (YYYY-MM, từ 12 tháng trước tới 24 tháng sau tháng hiện tại), `months*` (1–24), `buildingName` tuỳ chọn, `reason` hoặc `noReason`.
  - Chọn HĐ bằng hàm INVOKER MỚI `public.hermes_contract_batch_lookup_v1` dưới RLS người hỏi, trong tập toà guard trả (∩ toà đã nêu): 20 HĐ đầu không có báo trả + 10 HĐ đầu có báo trả + hai số đếm; chỉ id, không tên hay dữ liệu khách.
  - Bước ghi lô là hàm DEFINER MỚI `app_private.hermes_contract_batch_step_v1`; vỏ dựng lại từ thân `074815` + nhánh lô (giải tên toà, tra lô, chuyển sang bước ghi lô). Bước ghi chung của trang KHÔNG đổi; md5 thân `074815` ghim ở `$requires$`.
  - Bước ghi lô đọc lại từng id với đủ điều kiện (ACTIVE chưa kết thúc, không báo trả, đúng tháng, toà thuộc khoá) nên id lạ do bất kỳ đường nào đưa vào cũng bị bỏ.
  - Thứ tự: khoá công ty → phát lại biên nhận theo requestId (TRƯỚC basis) → tham số → khoá mọi dòng HĐ của lô `FOR UPDATE NOWAIT` (lượt có thể ghi) → đọc lại → basis = md5(tháng, số tháng, toà, danh sách (HĐ, `updated_at`, `end_date`), danh sách HĐ bị loại) → xem trước hoặc ghi.
  - Xem trước luôn có, kể cả lượt auto: `preview.rows` (toà / phòng / HĐ / ngày cũ → ngày mới), `count`, `more` (HĐ còn lại ngoài lô), câu `text` liệt kê đủ lô. Cảnh báo: HĐ bị loại vì báo trả (D-HĐ7), còn N HĐ làm lô sau, HĐ vừa gia hạn trong 24 giờ.
  - Ghi: mỗi dòng một khối `BEGIN … EXCEPTION` (savepoint), gọi `renew_contract_with_notice_v1` với `KEEP` và khoá idempotency `md5('renew_batch:'||requestId||':'||HĐ)`. Hậu điều kiện như `contract.renew`.
    - Lỗi nghiệp vụ ⇒ dòng `renewed=false` + `reason`, dòng khác vẫn ghi.
    - Lỗi tạm ⇒ cả lô lùi (`state_changed`).
    - Không dòng nào ghi được ⇒ cả lô `rejected` với lý do dòng đầu.
    - Một biên nhận cho cả lô; kết quả có `rows`, `renewed`, `failed`, `more`.
  - Lô rỗng ⇒ needs_input mới `renew_batch_empty` (khối Hợp đồng của `action-reasons.mjs`; dạng needs_input nên không vào `host-ownership`).
  - Đo (23/10): `statement_timeout` của `authenticated` là 8 giây trên TEST lẫn production. Tầng 2 trên TEST: lô 20 HĐ qua hàm ghi web thật mất 0,86–1,47 giây.

## 5. Lý do riêng trang (thêm vào danh sách đóng)

Thêm vào `action-reasons.mjs`. Các mã dạng `rejected` thêm cả vào `REASONS` của `infra/hermes-runtime/host-ownership.mjs`, trong cùng commit. Mỗi file gom thành **một khối "Trang Hợp đồng"** ở cuối danh sách, để phiên Thu chi gộp không đụng.

| Mã | Dạng | Câu tĩnh (tóm tắt) |
| --- | --- | --- |
| `room_has_no_active_contract` | needs_input | Phòng này không có HĐ đang hiệu lực (trống hoặc đã trả); hỏi lại phòng/toà |
| `notice_date_past` | needs_input | Ngày báo trả đã qua; khách đã dọn thì dùng `contract.return`, không thì hỏi lại ngày |
| `renew_reason_ask` | needs_input | Hỏi MỘT câu lý do gia hạn; người dùng nói không có thì gọi lại với `noReason=true` |
| `notice_choice_required` | needs_input | HĐ đang có báo trả; hỏi người dùng gia hạn thì GIỮ hay HUỶ báo trả (`keepMoveOutNotice`) |
| `occupant_not_on_contract` | needs_input | Người này không có trong HĐ của phòng; hỏi lại tên/SĐT |
| `already_returned` | rejected | Phòng đã ghi nhận trả phòng, chờ quyết toán trên web; không ghi lại |
| `renew_price_change_web_only` | rejected | Gia hạn qua bot chỉ giữ nguyên giá và cọc; đổi giá/cọc làm trên web (Hợp đồng → Gia hạn) |
| `no_notice` | rejected | HĐ này chưa có báo trả để huỷ |
| `room_not_lockable` | rejected | Phòng không khoá tạm được: đã cọc, đang giữ chỗ hoặc đang có khách ở |
| `room_already_locked` | rejected | Phòng đang được khoá tạm; gỡ khoá cũ trước nếu muốn khoá lại |
| `no_open_lock` | rejected | Phòng này không có khoá tạm nào đang mở |
| `return_date_future` | needs_input | Ngày trả phòng ở tương lai: khách chưa dọn thì dùng báo trả; đã dọn thì hỏi lại ngày trả thực tế (Mốc 4) |
| `cannot_remove_representative` | rejected | Không bỏ được người đại diện HĐ qua bot; đổi người đại diện trên web trước |

Dùng lại mã chung: `name_unresolved` (toà, phòng, khách), `date_out_of_range`, `invalid_params`, `reason_required` (trigger `z98` khi lý do không đạt), `not_allowed` (42501 của hàm web, kể cả `[THIEU_QUYEN:…]` sau Q26), `state_changed`, `crm_refused`.

Ánh xạ trong bước ghi:
- Bước ghi tự kiểm trước các điều kiện có lý do riêng: HĐ hiện hành, ngày, khoá đang mở, người đại diện. Làm vậy để không phải dựa vào câu chữ lỗi của hàm web.
- Riêng hai câu `55000` của khoá tạm thì ánh xạ theo tiền tố thông điệp, vì trạng thái bán (`room_sale_workflow_fact_v1`) do hàm web tính.
- Mọi câu khác đi qua `hermes_action_reason_v1`. **Không** sửa hàm chung đó.

## 6. Đọc (mục 1 và đọc bù (a)–(e) của lượt đo nền)

Báo cáo W2 mới không thêm tool: chúng nằm trong kết quả `crm_read_report_list`; mô tả `crm_read_contract_detail` giữ nguyên. Đo lại `tools/list` (review #270):
- kết nối đủ quyền: mô tả `crm_available_rooms` +48 B ⇒ 63 849 / 64 000 B (`tool-argument-shape`); như production 21/10 (không `income_expenses.create`, `tasks.delete`): 61 716 B;
- kết nối CHỈ có `contracts.view` (khoá dùng lại mới của W2): thêm `crm_read_report_list` + `crm_read_report`, 3 217 → 4 802 B (+1 585 B);
- kết nối quản lý đã có `rooms.view` (khoá dùng lại sẵn có): đã thấy hai tool đó từ trước ⇒ không đổi.

| # | Câu (đo nền 22/10) | Nguyên nhân (đã tra) | Sửa |
| --- | --- | --- | --- |
| 1 | Hồ sơ trả phòng chưa quyết toán | Chưa có báo cáo. Bảng `contract_exit_cases` bị REVOKE khỏi `authenticated`, chỉ đọc qua hàm web `list_contract_exit_cases_v1` (DEFINER, kiểm `contracts.view` theo toà) | Báo cáo W2 `re_exit_cases_pending` (`buildingId`) gọi **đúng** hàm web đó. Dòng: toà, phòng, HĐ, ngày trả, loại, số ngày chờ; tên khách chỉ khi có `customers.view`. Summary: total, chờ lâu nhất |
| (b) | "Phòng nào báo sắp dọn đi?" | Bot đọc ngày hết hạn. `re_expiring` / `contract_search` không lọc theo ngày báo trả | Báo cáo W2 `re_move_out_notices` (`buildingId`, `fromDate`, `toDate`; mặc định mọi báo trả còn hiệu lực) trên hàm INVOKER dùng chung mới `public.contract_move_out_notices_v1`. Summary: total, quá ngày báo mà chưa trả, trong 30 ngày |
| (a) | "HĐ hết hạn trong tháng X", đếm theo toà | `re_expiring` chỉ có `days` tính từ hôm nay; `contract_search` không lọc ngày | Báo cáo W2 `re_contracts_ending` (`buildingId`, `fromDate`, `toDate`; mặc định tháng này), gồm cả HĐ đã quá hạn chưa thanh lý, trên hàm INVOKER dùng chung mới `public.real_estate_contracts_ending_v1`. Summary: total, quá hạn, có báo trả, toà nhiều nhất + số. Tiêu đề `re_expiring` nói rõ "N ngày tới tính từ hôm nay" |
| (c) | Cọc của MỘT phòng | Dữ liệu đã có: `crm_read_contract_detail` trả `totalDeposit`, `depositPaid`, `depositRemaining`. Bot dùng nhầm tổng theo toà | SOUL (mục 13). Không đổi mã |
| (d) | HĐ thiếu cọc nhỏ bị sót | Đo: HĐ đó ở chế độ `FIRST_INVOICE` (thu ở hoá đơn đầu), nên nằm ngoài lọc `SHORT`. TEST có `SHORT` 1 + `FIRST_INVOICE` 1, khớp đáp án | **Đã làm (Mốc 2):** chỉ sửa tiêu đề báo cáo, theo cách 0 SQL: "HĐ chưa thu đủ cọc" = `SHORT` + `FIRST_INVOICE`; gọi mỗi status một lần, số = `shortCount` + `firstInvoiceCount`. Bỏ `status=OWING`, vì phải dựng lại reader gói A (vùng của phiên Thu chi), trong khi summary đã đủ số |
| (e) | "Tháng trước bao nhiêu phòng trả phòng": bot ra ít hơn web | Đo: tiêu chí của `re_terminations` (HĐ `TERMINATED/EXPIRED` có `COALESCE(actual_end_date, end_date)` trong kỳ) cho tháng 9 ra đúng số của web, gồm cả bỏ cọc; tầng 2 trên TEST ra 28. Reader tự đặt kỳ "đầu tháng này → hôm nay" khi thiếu ngày, nên bot quên truyền kỳ, hoặc đếm bằng trang `contract_search`, sẽ ra sai | **Đã làm (Mốc 2):** chỉ sửa tiêu đề, theo cách 0 SQL: "tháng trước" ⇒ truyền `fromDate`/`toDate` đúng tháng; số phòng trả = `summary.total`, bỏ cọc = các dòng `terminationType FORFEIT`. Không đổi khuôn summary, vì khuôn bị kiểm khít: connector lên trước migration sẽ làm vỡ báo cáo. Cộng SOUL |
| (f) | Quản lý toà: "toà X còn phòng trống?", "đang cho thuê bao nhiêu phòng?" (ma trận lượt 2) | `re_vacant_rooms` cần khoá báo cáo BĐS ⇒ `forbidden`; `crm_read_occupancy` cần `reports_real_estate.occupancy`, kết nối quản lý không có tool này, mà mô tả `crm_available_rooms` lại chỉ sang nó. Web: Quản lý toà xem trang Phòng bằng `rooms.view` theo toà | **Đã làm (Mốc 3):** báo cáo W2D `rooms_occupancy` (`rooms.view`, nguồn `crm.rooms_list_v1` như trang Phòng): mỗi toà một dòng tổng / đang cho thuê (OCCUPIED + EXPIRING_SOON) / sắp hết hạn / trống / giữ chỗ / bảo trì. Danh sách phòng trống = báo cáo `rooms` có sẵn (`displayStatus AVAILABLE`). Mô tả `crm_available_rooms` chỉ thêm đường "không quyền BĐS: `rooms_occupancy` / `rooms`" (+48 B `tools/list`) |
| (g) | "Tháng 2 năm sau toà 80 có mấy HĐ hết hạn?" (quản lý; bot ra 13, đúng 11) | Bot tự lọc tay danh sách; `re_contracts_ending` dùng khoá báo cáo BĐS nên quản lý không gọi được | **Đã làm (Mốc 3):** ba báo cáo hợp đồng (`re_contracts_ending`, `re_move_out_notices`, `re_exit_cases_pending`) chuyển sang khoá `contracts.view`, thêm vào tập khoá dùng lại của W2. `re_contracts_ending` vốn nhận tháng tương lai + `buildingId`; tầng 2 ra đúng 11 |
| (h) | "Còn HĐ nào chưa ký / nháp chờ ký?" (Mốc 5) | Chưa có báo cáo | **Đã làm (Mốc 5):** báo cáo W2D `contract_drafts` (`contracts.view`, file `20261022075119`, dựng từ thân `043617`, ghim md5) gọi đúng RPC web `list_contract_drafts`; chỉ nháp EDITABLE trong tập toà; KHÔNG trả dữ liệu khách của nháp (chỉ số khách, có đại diện chưa, số bản đã xuất, số ngày chờ). Không phụ thuộc file trang Mốc 5 |
| — | Link công khai tra hoá đơn | `hermes_domain_read_v3` cố ý không trả `public_code` | **Chưa làm (không gọn, xem "Chỗ nối `publicLink`" ngay dưới).** Phải dựng lại `hermes_domain_read_v3` (thân ~300 dòng, ghim md5 thân production), đổi khuôn kiểm khít của connector và thêm cấu hình host; SQL lên trước connector thì mọi lần đọc chi tiết HĐ hỏng |

**Chỗ nối `publicLink` (D-HĐ9; dùng chung với phiên Hoá đơn — chưa hiện thực).**
- **Đường web:** `/c/:code` (`src/app/routes/publicRoutes.tsx`) là trang công khai của HĐ, liệt kê cả hoá đơn của HĐ đó; `code` = `contracts.public_code` (6–8 ký tự, unique). Link hoá đơn công khai của phiên Hoá đơn cũng là `/c/<public_code của HĐ>`, không có đường riêng cho từng hoá đơn.
- **SQL** chỉ trả đường tương đối `publicPath` (`'/c/'||public_code`, chỉ khi HĐ ACTIVE), không bao giờ trả URL tuyệt đối: nhánh `contract_detail` của `hermes_domain_read_v3` (file mới, ghim md5 thân production như các bản dựng lại khác); báo cáo hoá đơn của phiên kia thêm cùng trường từ HĐ của hoá đơn.
- **Cấu hình host:** khoá tuỳ chọn `publicWebOrigin` cạnh `actionPages` trong `infra/hermes-runtime/host-config.mjs` (`new URL(x).origin === x`, chỉ `https:`); `infra/hermes-broker/server.mjs` thêm vào danh sách `optional` và truyền vào broker. Vắng ⇒ không có link, hành vi như cũ.
- **Connector:** một hàm nhỏ dùng chung (vd `infra/hermes-broker/public-link.mjs`: `publicLink(origin, path)` ⇒ `origin + path` khi `path` khớp `^/c/[A-Za-z0-9]{6,8}$` và có origin, còn lại `null`). `full-read-contract.mjs` thêm `publicLink` vào `CONTRACT_DETAIL_FIELDS`, ánh xạ `publicPath` → `publicLink` trước khi kiểm khuôn; nhận cả item thiếu `publicPath` (SQL cũ) bằng cách điền `null`.
- **Thứ tự phát hành:** connector chịu được cả hai khuôn ⇒ áp migration SQL ⇒ khai `publicWebOrigin` ở host. Ngược lại (SQL trước) thì connector cũ từ chối khoá lạ `publicPath` ⇒ `crm_read_contract_detail` hỏng tới khi deploy connector.

**Đã làm ở Mốc 2.**
- Hai hàm INVOKER dùng chung mới: `public.real_estate_contracts_ending_v1` và `public.contract_move_out_notices_v1`.
  - `search_path=''`; từ chối khi `current_user <> 'authenticated'`; tự kiểm khoá web của màn Sắp hết hạn.
  - Nhận `p_building_ids` để Hermes thu hẹp phạm vi, luôn giao với RLS.
  - Đặt ở file riêng không chứa hàm của trợ lý, theo lệ hàm dùng chung của gói D.
- Hồ sơ chờ quyết toán gọi đúng RPC web `list_contract_exit_cases_v1`, không trả tên khách.
- Ba báo cáo vào gói W2D, dùng khoá sẵn có:
  - `re_contracts_ending`, `re_move_out_notices`: khoá `reports_real_estate.expiring`;
  - `re_exit_cases_pending`: khoá `reports_real_estate.terminations`.

  Mốc 3 đổi cả ba sang `contracts.view` (xem dưới).

**Đã làm ở Mốc 3.**
- `contracts.view` vào tập khoá dùng lại của W2 (`20261022043540`, dựng từ thân đang chạy, ghim `md5(prosrc)`): loại khoá `company`, phạm vi = quyền CRM theo toà ∩ overlay kết nối ∩ tập toà web, như các khoá dùng lại khác. Hai hàm dùng chung đổi cổng web sang `can_access_org_entity('contracts','view')`.
- Báo cáo `rooms_occupancy` (mục (f)). Tiêu đề `re_vacant_rooms` nói rõ cần quyền báo cáo BĐS, không có thì dùng `rooms_occupancy` / `rooms`.
- File bảng báo cáo gói D đổi tên `20261022032214` → `20261022043617`, để xếp SAU file khoá dùng lại. Ba file đọc (`032205`, `043540`, `043617`) **không** phụ thuộc file trang `20261022022951`, nên phát hành sớm cùng connector được.

## 7. Hàm dùng chung tính ngày gia hạn

`public.contract_renewal_end_date_v1(p_end_date date, p_months integer) RETURNS date`: `LANGUAGE sql IMMUTABLE`, `SECURITY INVOKER`, `search_path=''`. NULL hoặc `p_months` ngoài 1–120 ⇒ NULL, bên gọi từ chối.
- `p_end_date` là ngày cuối tháng ⇒ ngày cuối của tháng đích. Ví dụ 28/02/2027 + 6 = 31/08/2027; 30/09 + 1 = 31/10.
- Còn lại ⇒ cùng số ngày, kẹp về cuối tháng nếu tháng đích ngắn hơn. Ví dụ 15/03 + 6 = 15/09; 30/01 + 1 = 28/02 (29/02 năm nhuận).

Đo production (chỉ đọc, 112 lần gia hạn trong `contract_extensions`):
- luật này khớp 82 lần: 39 lần giữ số ngày, 43 lần cuối tháng → cuối tháng;
- phép cộng tháng thuần của Postgres khớp 49 lần;
- khoảng 30 lần còn lại là ngày người dùng tự chọn không theo khuôn nào.

Bản xem trước luôn hiện ngày mới, nên người dùng sửa được bằng `newEndDate`.

**Web dùng cùng hàm** (luật 17/10): hộp Gia hạn (`src/components/contracts/RenewDialog.tsx`) có thêm nút "+6 tháng" / "+12 tháng". Nút gọi hàm qua một service/hook có kiểu, không gọi RPC trong component, rồi điền vào ô ngày; người dùng vẫn sửa được. Đây là thay đổi web có thêm hành vi, nên cần test component và Playwright ở viewport có hộp Gia hạn. Bộ vector ngày đặt ở `infra/hermes-broker/contract-renewal-vectors.json`, dùng chung cho test PGlite và test web.

## 8. Migration dự kiến và file chung

Tên migration lấy qua `scripts/tao-ten-migration.mjs` lúc viết. Mỗi migration chỉ là file; phiên chính áp qua lane.

| Mốc | Migration (tên tạm) | Nội dung |
| --- | --- | --- |
| 2 ✓ | `20261022022951_hermes_contract_action_v1` | Seed `hermes_action_policies` cho bốn thao tác Mốc 2. Vỏ, tra cứu, bước ghi (nhánh báo trả + khoá tạm). `$requires$` đòi M1, M2, giải tên, P0a. Mốc 3–4 nối tiếp vào file này (D-HĐ10) |
| 2 ✓ | `20261022032205_hermes_w2d_contract_shared_v1` | Hai hàm dùng chung mới (file không chứa hàm của trợ lý) |
| 2–3 ✓ | `20261022043617_hermes_w2d_contract_reads_v1` (tên cũ `20261022032214`) | Bảng báo cáo + reader gói D dựng từ thân đang chạy. `md5(prosrc)` = production = TEST = repo, ghim ở `$requires$`. Ba báo cáo hợp đồng (khoá `contracts.view` từ Mốc 3) + `rooms_occupancy` |
| 3 ✓ | `20261022042822_contract_renewal_end_date_v1` | Hàm dùng chung tính ngày gia hạn (web + Hermes). Lane xếp SAU file trang; hàm trang chỉ gọi nó lúc chạy |
| 3 ✓ | `20261022043540_hermes_w2_contracts_view_reused_v1` | `contracts.view` vào tập khoá dùng lại của W2. Phải áp TRƯỚC `043617` (thứ tự tên đảm bảo) |
| 3 ✓ | (nối vào `20261022022951`) | Nhánh gia hạn + phát lại biên nhận sớm; policy `contract.renew` (irreversible / always) |
| 4 ✓ | `20261022061813_hermes_contract_return_v1` (MỚI) | Thay tra cứu + bước ghi của trang (dựng từ thân `022951`, ghim md5): nhánh `contract.return` + hoá đơn chưa thu; policy `contract.return`. Áp SAU `022951` |
| 5 ✓ | `20261022074815_hermes_contract_party_draft_v1` (MỚI) | Hàm tra khách INVOKER mới; thay vỏ (thân `022951` + tra khách) và bước ghi (thân `061813`, ghim md5); 3 dòng chính sách người ở + nháp. Áp SAU `061813` |
| 5 ✓ | `20261022075119_hermes_w2d_contract_drafts_v1` (MỚI) | Báo cáo `contract_drafts` (dựng từ thân `043617`, ghim md5). Tách phát hành sớm được |
| 6 ✓ | `20261023030305_hermes_contract_renew_batch_v1` (MỚI) | Hàm tra lô INVOKER + bước ghi lô DEFINER mới; thay vỏ (thân `074815` + nhánh lô); 1 dòng chính sách `contract.renew_batch`. md5 bước ghi chung `074815` ghim ở `$requires$`. Áp SAU `074815` |
| — | `hermes_contract_detail_public_link_v1` (tạm) | `publicLink` của chi tiết HĐ: chưa làm (mục 6, "Chỗ nối `publicLink`") |
| 4–6 | (gộp vào migration trang nếu chưa merge, hoặc `_v2` mới) | Nhánh trả phòng; người ở + nháp; lô |

Nếu phát hành Mốc 2–4 cùng một lần thì gộp thành một migration trang (D-HĐ10). Migration đã merge là bất biến, nên mốc sau phải dùng migration mới.

**File chung phải đụng.** Mỗi file một khối nhỏ gắn nhãn "Hợp đồng", không sửa dòng của trang khác. Ai gộp sau thì rebase.

| File | Thay đổi |
| --- | --- |
| `infra/hermes-broker/action-reasons.mjs` | 12 mã (mục 5) |
| `infra/hermes-runtime/host-ownership.mjs` | 7 mã dạng `rejected` vào `REASONS` |
| `infra/hermes-broker/server.mjs` + `infra/hermes-runtime/host-config.mjs`, `host-service.mjs` | cấu hình host `actionPages` (vd `["contract"]`). Vắng thì danh mục production rỗng: không gọi `hermes_action_capabilities_v1`, `tools/list` không đổi |
| `infra/hermes-broker/CONNECTOR.md` | một dòng cho thao tác Hợp đồng |
| `scripts/hermes-task-function-contract.mjs` | băm vỏ `hermes_contract_action_v1` (`externalStandard`) |
| `scripts/hermes-read-function-specs.mjs` / `scripts/test-hermes-private-flow.mjs` | hàm `search_path=''` mới (tra cứu, ba hàm đọc, hàm ngày) |
| `scripts/__tests__/hermes-durable-forward-fixture.mjs` | `FORWARD_FUNCTIONS` của các hàm `hermes_*` mới |
| `supabase/migration-unknown-review.json`, provenance | hồ sơ `chua-ap-dung-cho-y` cho từng migration chưa áp |
| `infra/hermes-broker/web-parity.json` | nếu báo cáo W2 mới có màn web tương ứng |

Không đổi: `capability-contract.mjs` (khoá đã có), `action-catalog.mjs`, `action-runtime.mjs`, các hàm SQL nền.

## 9. Kế hoạch test

**Tầng 1, offline (`node:test`).**
- `contract-action.test.mjs`:
  - danh mục nạp được; khoá ⊆ `HERMES_ACTION_CAPABILITIES`; lý do ∈ danh sách đóng;
  - kiểm tham số và gợi ý tĩnh từng thao tác;
  - lớp và sàn: renew, return, batch luôn xem trước dù chính sách ghi `never`;
  - luồng qua `action-runtime` với service giả: needs_input (5 mã riêng) không phải lỗi MCP; rejected đi qua `mcp-http` đúng câu tĩnh.
- `audit-codes.test.mjs` xanh với 7 mã mới; test này đỏ nếu quên `host-ownership.mjs`.
- `action-tools-budget.test.mjs`: danh mục production có thao tác Hợp đồng ⇒ `tools/list` bằng đúng khi chỉ có danh mục thử. Kết quả `crm_action_list` của trang ≤ 8 KB.
- Test component cho `RenewDialog`: nút "+N tháng" gọi service, có mock client.

**Tầng 1b, PGlite / PG17 dùng một lần.** Fixture tái dùng `finance-fixture.mjs` (binding, phiên, chính sách thật của Hermes) cộng **bản port tối giản** của bảy hàm ghi web. Bản port giữ đúng chữ ký, tác dụng chính và các câu lỗi, như cách M1 port hàm ghi phiếu chi. Fixture chứng minh logic của trang, không chứng minh hàm web.
- Mọi nhánh mục 4: HĐ hiện hành, ngày, lý do, `noReason`, giá khác ⇒ từ chối, `keepMoveOutNotice`, đại diện, khoá mở, lô (loại báo trả, trần 20, dòng lỗi riêng, lỗi tạm lùi cả lô).
- basis lệch ⇒ `state_changed`; phát lại theo requestId; `request_conflict`.
- Hậu điều kiện tiền: port trả phòng chèn một phiếu ⇒ lùi + `crm_refused`.
- Toà ngoài phạm vi khoá ⇒ `outside_scope` không tên; lượt 2 đưa id ngoài phạm vi ⇒ `not_allowed`.
- Tra cứu INVOKER: không có `customers.view` ⇒ `representativeName = null`.
- Vector ngày gia hạn chạy trên hàm thật.
- **Kiểm đột biến** (Contract §8; ghi băm file trước và sau, khôi phục theo CODEBASE_STRUCTURE). Gỡ từng rào sau đây thì phải có test đỏ:
  - kiểm phạm vi toà/phòng;
  - đối chiếu id của tra cứu;
  - chặn bỏ người đại diện;
  - hậu điều kiện tiền;
  - so basis;
  - sàn `always` của renew/return;
  - trần 20 của lô;
  - `$requires$` P0a;
  - vỏ quay về plpgsql;
  - tra cứu chuyển sang DEFINER.

**Tầng 2, SQL thật trên TEST, không model.** Chạy `npm run test-env:thu-sql -- <kịch bản>.sql`, ROLLBACK mặc định, không `--ghi`.
- Kịch bản ghép: thân migration của trang (bỏ BEGIN/COMMIT) + fixture kết nối Hermes trong giao dịch + `set_config('request.jwt.claims', …, true)` + `SET ROLE authenticated`.
- Persona:
  - chủ;
  - quản lý toà trong phạm vi;
  - quản lý toà ngoài phạm vi;
  - vai có `contracts.edit` mà thiếu `contracts.renew` / `contracts.terminate`;
  - vai không có `customers.view`.

  ID chọn lúc chạy bằng truy vấn. Không ghi ID thật vào repo.
- Chấm bằng `SELECT` trong cùng giao dịch:
  - `contracts`, `contract_move_out_notice_events`, `contract_notice_transition_events`, `contract_extensions`, `contract_exit_cases`, `rooms.status`, `room_sale_locks`, `contract_customers`, `contract_drafts`;
  - biên nhận, audit;
  - đếm và tổng `income_expenses` / `invoices` trước và sau.
- Ca P0a sau khi trả phòng qua bot: INSERT `contract_terminations` DRAFT qua REST và `approve_contract_termination_v1` đều ra `55000`.

**Tầng 3, bot thật trên TEST (phiên chính).**
- Ma trận độc lập ≥ 60 câu, mỗi ca 3 lần. Đạt khi 0 ghi sai và ≥ 95 % ca đạt cả 3 lần.
- Ca phát triển của phiên con nằm trong file `hop-dong-ca-phat-trien.json` ở scratchpad của phiên chính (≤ 20 ca).
- Ca phá huỷ (trả phòng, gia hạn) xếp cuối vòng, rồi `test-env:sync`.

## 10. Rủi ro

| Rủi ro | Mức | Giảm |
| --- | --- | --- |
| Mô hình gửi lại gia hạn với requestId mới ⇒ gia hạn chồng | Cao | Luôn xem trước; cảnh báo "vừa gia hạn trong 24 giờ"; lô tự loại HĐ đã rời tháng; ca N10 của nền chung |
| Ghi thẳng báo trả / người ở khi người dùng chỉ hỏi | Vừa | Q2 = a; kết quả nêu rõ cũ → mới để sửa ngay; SOUL "câu hỏi không phải lệnh"; D-HĐ1 |
| `contracts.updated_at` bị trigger khác đổi giữa hai lượt ⇒ `state_changed` giả | Thấp | Xem trước lại; đo tần suất trên TEST |
| Câu lỗi của hàm web đổi ⇒ `crm_refused` | Thấp, an toàn | Bước ghi tự kiểm trước các điều kiện có lý do riêng |
| Lô 20 HĐ vượt `statement_timeout` / giữ khoá tổ chức lâu | Vừa | Đo trên TEST; hạ trần lô nếu cần |
| Trả phòng trên TEST không lùi được | Chắc chắn | Tầng 2 chỉ ROLLBACK; tầng 3 xếp cuối, sync sau |
| Nháp thiếu dịch vụ / ngày tính tiền so với form web | Vừa | Mốc 5 tra form web; người ký trên web vẫn kiểm |
| Khoá `contracts.terminate` mở cả báo trả và trả phòng | Vừa | Danh mục connector theo bản phát hành; chỉ bật khoá khi đủ cả hai thao tác hoặc bản connector chỉ khai báo trả |
| Cấp Hermes cho Quản Lý Tòa (Q7) khi khoá đã bật | Vừa | Điều kiện của nền chung: O2 hoặc loại trừ khoá trước khi cấp |
| Xung đột file chung với phiên Thu chi | Thấp | Khối riêng mỗi file (mục 8); ai gộp sau rebase |

## 11. Quyết định cần chốt (kèm mặc định)

| # | Câu | Mặc định đề xuất |
| --- | --- | --- |
| D-HĐ1 | Báo trả / dời / huỷ báo trả: ghi thẳng (Q2 = a) hay xem trước (plan §9)? | **Ghi thẳng**; kết quả nêu ngày cũ → mới |
| D-HĐ2 | Thêm/bớt người ở: ghi thẳng? Bỏ người đại diện? | **Ghi thẳng**; **không** cho bỏ đại diện qua bot |
| D-HĐ3 | Nháp: ghi thẳng, máy chủ đòi xác nhận khi phòng còn khách hoặc trùng nháp 24 giờ? | **Có** |
| D-HĐ4 | Luật cộng tháng (mục 7), web thêm nút "+6 / +12 tháng" | **Có** |
| D-HĐ5 | Câu cố định khi không có lý do gia hạn | "Gia hạn theo yêu cầu qua Hermes, không nêu lý do." |
| D-HĐ6 | Loại trả phòng do máy chủ suy từ ngày; bỏ cọc chỉ khi người dùng nói | **Có** |
| D-HĐ7 | Lô gia hạn loại HĐ đang có báo trả | **Có** (liệt kê trong cảnh báo) |
| D-HĐ8 | Báo trả ngày đã qua: từ chối và hướng sang ghi nhận trả phòng | **Có** |
| D-HĐ9 | `publicLink` tuyệt đối: origin web lấy ở đâu (cấu hình host connector hay hằng số trong SQL)? | Cấu hình host connector `publicWebOrigin`; SQL trả `/c/<code>` |
| D-HĐ10 | Phát hành: Mốc 2–4 một lần, Mốc 5–6 lần sau | **Có**; bật `contracts.terminate`, `contracts.renew`, `sale_phong.lock_room` cùng lúc sau Mốc 4 |
| D-HĐ11 | Đáp án ma trận "HĐ chưa thu đủ cọc" (mục 6 (d)) | **Chốt 22/10:** như trang Quản lý cọc — còn thiếu = COALESCE(`deposit_remaining`, cọc − đã thu) ≥ 10.000đ trên HĐ ACTIVE, trạng thái `SHORT` hoặc `FIRST_INVOICE`; nêu cả hai. Tầng 2 Mốc 3: khớp |

## 12. Từ chối có chỉ đường web (câu tĩnh, đưa vào SOUL)

- Quyết toán, hoàn cọc, trừ tiền, bỏ cọc (cặp phiếu): "Quyết toán làm trên web: Hợp đồng → mở HĐ → Quyết toán (hoặc hàng đợi Chờ quyết toán). Em chỉ ghi nhận khách đã trả phòng."
- Gia hạn đổi giá; sửa giá thuê/cọc: "Đổi giá/cọc làm trên web: Hợp đồng → Gia hạn (hoặc Sửa HĐ). Qua em chỉ gia hạn giữ nguyên giá."
- Cọc giữ chỗ: "Giữ chỗ có cọc làm trên web: Phòng trống → Giữ chỗ / Quản lý cọc."
- Xoá HĐ, chuyển phòng, nhập Excel, ký nháp, in HĐ/CT01: "Việc này làm trên web: Hợp đồng → mở HĐ → <nút tương ứng>."

## 13. Đề xuất SOUL (phiên chính quyết)

1. "Hết hạn trong tháng X" ⇒ `re_contracts_ending` với `fromDate`/`toDate` của tháng X. Không dùng EXPIRING/EXPIRED. Đếm theo toà từ summary.
2. "Báo trả / báo dọn đi / sắp chuyển đi" là **ngày báo trả**, khác ngày hết hạn ⇒ `re_move_out_notices`.
3. Cọc của một phòng ⇒ `crm_read_contract_search`, rồi `crm_read_contract_detail`; nêu cọc phải đóng / đã đóng / còn thiếu. "HĐ nào chưa thu đủ cọc" ⇒ `held_deposits` gọi `status=SHORT` rồi `status=FIRST_INVOICE` (không có status `OWING`); nêu CẢ HAI nhóm, nhóm sau nói "thu vào hoá đơn đầu".
4. "Tháng trước / tháng X bao nhiêu phòng trả phòng" ⇒ `re_terminations` với kỳ đúng tháng; số = `summary.total`, nêu thêm số bỏ cọc.
5. Trước khi ghi nhận trả phòng, nếu người dùng nói ngày đã qua lâu, đọc trạng thái phòng/HĐ trước. Ca đo nền HD-X11: HĐ cũ đã trả, phòng đã có khách mới.
6. Lệnh ghi Hợp đồng chỉ nhận trong chat riêng. Câu hỏi ("302 báo trả chưa?") không phải lệnh. Thao tác xem trước thì đọc `preview.text` nguyên văn và chờ "đồng ý"; `needs_input` thì hỏi đúng một câu theo `detail`.
7. Gia hạn ⇒ `contract.renew` với `months` (hoặc `newEndDate` nếu người dùng nói ngày). Không có lý do ⇒ hỏi MỘT câu; người dùng nói không có ⇒ `noReason=true`. HĐ có báo trả ⇒ hỏi giữ hay huỷ (`keepMoveOutNotice`). Đổi giá/cọc ⇒ chỉ đường web. Luôn đọc `preview.text` nguyên văn và chờ "đồng ý"; có cảnh báo "HĐ vừa được gia hạn" thì nói rõ trước khi hỏi.
8. Quản lý toà (không có `crm_read_occupancy` / `re_vacant_rooms`): "toà X còn phòng trống?" ⇒ `crm_read_report rooms` với `buildingName`, lấy phòng `displayStatus AVAILABLE`; "đang cho thuê bao nhiêu phòng" ⇒ `rooms_occupancy`, số = `rented` (từng toà) hoặc `summary.rented` (cả phạm vi). Không lấy trang Sale (`crm_available_rooms`) làm trạng thái phòng.
9. "Tháng X (năm sau) toà Y có mấy HĐ hết hạn" ⇒ `re_contracts_ending` với `buildingName` + `fromDate`/`toDate` đúng tháng; số = `summary.total`, không tự lọc tay danh sách.
10. "Khách phòng X đã dọn đi / trả phòng rồi" ⇒ `contract.return` với `date` (ngày thực tế, không phải tương lai) + `note` (nội dung thanh lý; thiếu thì hỏi một câu). Chỉ `forfeit=true` khi người dùng nói rõ bỏ cọc. Đọc `preview.text` nguyên văn (có "KHÔNG lùi được") và chờ "đồng ý"; sau khi ghi nhắc quyết toán trên web theo `nextStep`. `needs_input return_date_future` ⇒ hỏi khách đã dọn chưa: chưa thì dùng báo trả.
11. "Thêm / bớt người ở phòng X" ⇒ `contract.occupant_add` / `contract.occupant_remove` với SĐT (ưu tiên) hoặc tên khách đã có trong CRM; ghi thẳng, đọc lại `result.text`. Khách chưa có thì tạo trước bằng `crm_customer_create`. Không bỏ được người đại diện qua bot (đổi đại diện trên web).
12. "Soạn HĐ cho phòng X" ⇒ `contract.draft` với `startDate`, `endDate` (người dùng nói; chỉ nói số tháng thì hỏi ngày kết thúc), `rentPrice`, `deposit`, khách tuỳ chọn. Nhắc rằng đây là NHÁP, ký và hoàn tất trên web (Hợp đồng → tab Nháp). Có bản xem trước (phòng còn khách / trùng nháp) thì đọc cảnh báo và chờ "đồng ý".
13. "Còn HĐ nào chưa ký / nháp chờ ký" ⇒ `crm_read_report contract_drafts`; số = `summary.total`.
14. "Gia hạn hết các HĐ hết hạn tháng X (toà Y) thêm N tháng" ⇒ `contract.renew_batch` với `endMonth` = tháng X (YYYY-MM), `months` = N, `buildingName` nếu người dùng nêu toà.
    - Không có lý do ⇒ hỏi MỘT câu; người dùng nói không có ⇒ `noReason=true`.
    - Đọc `preview.text` nguyên văn và nói rõ từng cảnh báo (HĐ có báo trả bị loại thì gia hạn lẻ bằng `contract.renew`; còn N HĐ thì làm lô sau), rồi chờ "đồng ý" một lần cho cả lô.
    - Sau khi ghi đọc `result.text`; dòng `renewed=false` thì báo kèm lý do và chỉ đường web.
    - Còn `more` > 0 thì gọi lại lô mới với requestId mới; HĐ đã gia hạn tự ra khỏi tháng.
    - Đổi giá/cọc khi gia hạn ⇒ chỉ đường web. Một HĐ lẻ ⇒ dùng `contract.renew`, không dùng lô.

## 14. Việc phiên chính phải làm

1. Duyệt thiết kế này, chốt D-HĐ1–D-HĐ11.
2. Sau mỗi mốc:
   - áp migration lên TEST rồi production qua lane;
   - chạy `gen:types` (có hàm public mới);
   - promote web khi Mốc 3 đổi `RenewDialog` (nút "+6 / +12 tháng" chỉ chạy khi `contract_renewal_end_date_v1` đã áp; chưa áp thì nút báo "Chưa tính được ngày mới, hãy chọn ngày bằng tay.");
   - sau `gen:types` có `contract_renewal_end_date_v1` thì bỏ bộ gọi hẹp trong `src/lib/contractRenewalEndDate.ts`.
3. Phát hành connector có danh mục Hợp đồng **trước** khi bật khoá. Connector chịu được thiếu hàm: PGRST202 ⇒ `action_disabled`.
4. Bật khoá trên TEST bằng script TEST; bật trên production bằng migration riêng sau nghiệm thu: `contracts.terminate`, `contracts.renew`, `sale_phong.lock_room`, rồi `contracts.edit`, `contracts.create`. Không bật `contracts.transfer`.
5. Chạy ma trận ≥ 60 câu trên TEST; xếp ca trả phòng cuối, rồi `test-env:sync`.
6. Đưa mục 12 và mục 13 vào SOUL.

## 15. Tiến độ

**Mốc 2, 22/10.** Hai lát, mỗi lát một commit:

*Lát A — thao tác ghi.*
- `contract.notice_set`, `contract.notice_cancel`, `contract.room_lock`, `contract.room_unlock`.
- Connector chỉ nạp khi cấu hình host khai `actionPages: ["contract"]`. Lý do: danh mục production không rỗng sẽ thêm một lời gọi `hermes_action_capabilities_v1` vào chuỗi phân quyền của MỌI lời gọi; mặc định giữ đúng hành vi Đợt 1.
- 12 lý do của trang vào khối `contract` (`ACTION_PAGE_REASON_BLOCKS`); 7 mã dạng `rejected` vào sổ audit host.

*Lát B — đọc bù.*
- Ba báo cáo W2D (mục 6).
- Sửa tiêu đề `re_expiring`, `re_terminations`, `held_deposits`.

*Kiểm.*
- PGlite trang: 11/11; đột biến 13/13.
- W2 + hợp đồng duyệt hàm Hermes: 352/352.
- Tầng 2 trên TEST, ROLLBACK, 4 kết nối thật:
  - báo trả / trùng ngày / ngày đã qua / huỷ / huỷ khi không có báo trả: đạt với 3 kết nối có quyền;
  - khoá tạm: ca có khách bị từ chối đúng câu của hàm web; khoá rồi gỡ đạt với kết nối có quyền khoá tạm;
  - toà ngoài phạm vi ⇒ `name_unresolved`;
  - không phát sinh phiếu hay hoá đơn;
  - báo cáo đọc khớp số đối chiếu (2 / 1 / 1; tháng 9 = 28).


**Mốc 3, 22/10.** Một commit.

*Gia hạn giữ nguyên giá/cọc (mục 4.3).*
- `contract.renew` (khoá `contracts.renew`, irreversible / always) gọi `renew_contract_with_notice_v1` với giá, cọc = NULL.
- Hàm dùng chung `contract_renewal_end_date_v1` + 14 vector dùng chung; web: nút "+6 tháng" / "+12 tháng" trong hộp Gia hạn qua service `src/lib/contractRenewalEndDate.ts`.
- Phát lại biên nhận sớm cho mọi thao tác của trang (lỗi thật tìm thấy khi viết test phát lại).

*Đọc cho vai quản lý (mục 6 (f), (g)).*
- `rooms_occupancy`; ba báo cáo hợp đồng sang `contracts.view`; mô tả `crm_available_rooms` thêm đường cho người không có quyền báo cáo BĐS.

*Kiểm.*
- PGlite trang: 13/13; đột biến 23/23 (thêm 10 đột biến gia hạn / phát lại); đột biến phụ 4/4 (hàm ngày, `rooms_occupancy`).
- W2: 296/296; broker + mô tả tool: 62/62 (`tools/list` 63 849 B, trần 64 000 B); hợp đồng duyệt hàm Hermes: 241/241; web: 5/5.
- Tầng 2 trên TEST, ROLLBACK, 4 kết nối thật:
  - gia hạn trên hàm ghi web thật (3 kết nối có quyền): lượt auto vẫn chỉ xem trước; ghi đúng ngày theo luật dùng chung (30/08 → 28/02, 29/02 năm nhuận; cuối tháng → cuối tháng), giá/cọc giữ, 1 dòng `contract_extensions`, biên nhận + audit; phát lại cùng requestId không gia hạn lần hai; đổi giá ⇒ `renew_price_change_web_only`; có báo trả ⇒ `notice_choice_required`; chọn huỷ ⇒ báo trả được gỡ, có cảnh báo gia hạn chồng 24 giờ; không phát sinh phiếu/hoá đơn;
  - đọc vai quản lý: joey (tài khoản thử `testquanly`) cho thuê 102 phòng (8 toà), 111PVC trống L04; kết nối quản lý thứ hai: 15KV cho thuê 8; 80DS3 hết hạn 02/2027 = 11 (đếm thẳng = 11);
  - `held_deposits`: `SHORT` 331PHI/303 4.400.000 + `FIRST_INVOICE` 102LVT/505 74.000 (D-HĐ11).

**Sửa theo review #270, 22/10 (`1b8a49297`, migration chưa áp, sửa tại chỗ theo phiên chính).**
- Bước ghi gọi `lock_org_for_decision_v1` tường minh ngay sau guard, trước lần kiểm biên nhận và mọi khoá dòng; lượt preview không còn `FOR UPDATE`. Đo thân trước sửa: guard đã khoá tổ chức qua `hermes_private_command_connection_v1`, nên thứ tự cũ không deadlock và lời gọi cùng requestId đang chờ vẫn thấy biên nhận; bản sửa bỏ phụ thuộc vào nội tình guard.
- `real_estate_contracts_ending_v1`: chỉ mặc định tháng khi cả hai đầu khoảng rỗng; một đầu ⇒ để mở (TEST: chỉ `fromDate` 01/02/2027 ⇒ 259 HĐ, trước đây rỗng).
- `re_exit_cases_pending`: `summary.total` = tổng thật của nguồn.
- Đo lại `tools/list` và sửa câu "0 byte" (mục 0, mục 6).

**Mốc 4, 22/10.** Migration MỚI `20261022061813_hermes_contract_return_v1` (không sửa 5 file trước).

*Ghi nhận trả phòng, quyết toán sau (mục 4.4).*
- `contract.return` (khoá `contracts.terminate`, irreversible / always) gọi `confirm_contract_return_v1` chế độ DEFERRED, khoá idempotency `hermes:<requestId>`.
- Tra cứu thêm hoá đơn chưa thu (quyền xem hoá đơn theo toà + hàm dùng chung `invoice_effective_outstanding_v1`); lý do mới `return_date_future`.
- `publicLink`: chưa làm, chỗ nối ở mục 6.

*Kiểm.*
- PGlite trang 21/21 (thêm test Mốc 4 + test `$requires$`: thân lạ bị từ chối, thân `022951` được nhận — md5 Postgres khớp số ghim); đột biến Mốc 4 14/14, trang 23/23, review 4/4.
- Connector: `contract-action` 7/7, broker + runtime 1 924 đạt (1 đỏ môi trường Windows sẵn có, không đụng nhánh); hợp đồng duyệt hàm Hermes 241/241; security-gate tĩnh 10/10; `gate:truoc-push` 46/48 (2 cửa đỏ sẵn có trên Windows; các ca PG đỏ khi đầy tải chạy riêng xanh).
- Tầng 2 trên TEST, ROLLBACK, kết nối thật, hàm ghi web thật (3 kết nối có quyền):
  - lượt auto chỉ xem trước, câu có "KHÔNG lùi được", nêu loại + cọc đã thu + hoá đơn chưa thu;
  - ghi: HĐ `TERMINATED` đúng ngày, đúng một hồ sơ PENDING DEFERRED khoá `hermes:<requestId>`, phòng về `AVAILABLE`, biên nhận + audit; đếm và tổng phiếu thu chi + hoá đơn của HĐ không đổi;
  - phát lại cùng requestId y nguyên; requestId mới ⇒ `already_returned`;
  - rào P0a: chèn hồ sơ thanh lý nháp qua đường REST sau đó ⇒ 55000 `[TERMINATION_CONTRACT_CLOSED]`.

**Mốc 5, 22/10 (nhánh `claude/hermes-hop-dong-moc5-20261022`, xếp chồng trên #270).** Hai migration MỚI, không sửa 6 file của #270.

*Người ở + nháp (mục 4.5–4.6):* `contract.occupant_add`, `contract.occupant_remove` (khoá `contracts.edit`), `contract.draft` (khoá `contracts.create`), đều ghi thẳng; nháp đòi xác nhận theo từng lần gọi khi phòng còn HĐ hoặc trùng nháp 24 giờ. Hàm tra khách INVOKER mới; vỏ + bước ghi thay bằng file mới ghim md5.

*Đọc:* báo cáo `contract_drafts` (mục 6 (h)).

*Kiểm.*
- PGlite trang 29/29 (thêm test Mốc 5: tìm khách SĐT/+84/tên trùng/không thấy/mất quyền xem khách; thêm/bớt; không bỏ đại diện; hậu điều kiện; nháp phòng trống / trùng / còn HĐ / ngày sai; `$requires$`); W2 297/297; connector 102/102; hợp đồng duyệt hàm Hermes 241/241 (23 file / 82 hàm). Đột biến Mốc 5 18/18.
- `tools/list` đủ quyền giữ 63 849 / 64 000 B (thao tác nằm trong kết quả `crm_action_list`, báo cáo trong `crm_read_report_list`).
- Tầng 2 trên TEST (đã có 6 migration #270; chỉ chạy hai file mới, ROLLBACK, hàm ghi web thật, 3 kết nối có quyền): `$requires$` nhận đúng thân đang chạy thật; thêm / thêm lại (không đổi) / bớt người ở; bỏ người đại diện ⇒ từ chối; nháp phòng trống ghi thẳng (không sinh HĐ, phòng giữ trạng thái); nháp trùng 24 giờ và phòng còn HĐ ⇒ đòi xác nhận; báo cáo `contract_drafts` thấy nháp vừa soạn, không có tên khách.

**Mốc 5b, 22/10 (sửa #277 theo review độc lập; `074815` sửa tại chỗ vì chưa áp, `075119` không đổi).** Mục 4.5 "Sửa theo review #277": phạm vi khách = guard ∩ quyền (chữ ký hàm tra khách thêm `uuid[]`), lượt 2 kiểm lại khách, basis có khách đã chọn, bớt người có ghi chú đòi xác nhận, biên nhận lưu băm SĐT, cảnh báo nháp tính HĐ `EXTENDED`; thao tác người ở giữ tra cứu `ACTIVE` (production không có HĐ `EXTENDED`/`EXPIRED`).
- PGlite trang 34/34 (thêm: khách ngoài phạm vi kết nối ⇒ `outside_scope` không tên, ứng viên chỉ trong phạm vi, HĐ cũ ở toà trong phạm vi vẫn nhận, RLS giấu HĐ toà ngoài ⇒ bước ghi vẫn chặn; lượt 2 mất quyền xem / ra ngoài phạm vi / khách bị xoá / đổi khách ⇒ `state_changed`; basis người ở lệch ⇒ `state_changed`; phát lại người ở cùng / khác cách viết SĐT ⇒ y nguyên, SĐT khác ⇒ `request_conflict`; biên nhận không có SĐT; bớt người có ghi chú; HĐ `EXTENDED`); hợp đồng duyệt hàm Hermes 241/241 (ghim băm mới của ba hàm).

**Soát deadlock 40P01, 23/10 (sửa tại chỗ `074815`; theo lỗi Hoá đơn #279).**
- *Vòng.* Guard khoá dòng công ty trước mọi việc. Đo production 23/10: nhiều hàm ghi web khoá dòng nghiệp vụ TRƯỚC rồi mới khoá công ty.
  - Dòng HĐ: `create_new_contract_extension`, `terminate_contract_move_out`.
  - Dòng phòng:
    - `create_contract_v2` / `sign_and_checkin_contract_draft_v1` (`FOR UPDATE`);
    - `lock_room_for_sale_v1` / `release_room_sale_lock_v1` (`FOR NO KEY UPDATE`);
    - các hàm giữ chỗ, chính sách bán, tin pass.
  - Khi đó bước ghi đang giữ công ty mà chờ đúng dòng ấy (HĐ: Mốc 2–5; phòng: khoá tạm / gỡ khoá / trả phòng / soạn nháp qua khoá ngoại) thì thành vòng.
  - Không hàm web nào khoá khách, khoá tạm, tin pass hay hồ sơ trả phòng trước công ty.
- *Sửa.* File này thay cả bước ghi, nên sửa cho mọi thao tác của trang, kể cả Mốc 2–4.
  - Ở lượt có thể ghi: dòng HĐ và dòng khoá tạm lấy `FOR UPDATE NOWAIT`.
  - Dòng phòng lấy trước, `NOWAIT`, đúng mức cao nhất mà hàm web phía sau sẽ xin (không nâng khoá giữa chừng):
    - `NO KEY UPDATE` cho khoá tạm / gỡ khoá / trả phòng;
    - `KEY SHARE` cho nháp.
  - Đang bị giữ ⇒ 55P03, cả giao dịch lùi, connector đổi thành `state_changed` (đã có từ #253). Đổi thứ tự trong bước ghi không gỡ được vòng vì khoá công ty nằm ở guard.
- *Kiểm.*
  - Test hai phiên trên PostgreSQL 17 cục bộ (`contract-action-sql.test.mjs`):
    - phiên web giữ dòng trước ⇒ thêm người ở / báo trả / nháp / khoá tạm / trả phòng đều báo 55P03 ngay, rồi phiên web lấy được khoá công ty;
    - chiều ngược lại (bước ghi giữ trước) ⇒ phiên web chờ rồi chạy tiếp.
  - Đột biến bỏ `NOWAIT` tái hiện đúng `40P01 deadlock detected`; 5/5 đột biến bị bắt.

**Mốc 6, 23/10 (nhánh `claude/hermes-hop-dong-moc6-20261023`, xếp chồng trên #277).** Gia hạn hàng loạt `contract.renew_batch` (mục 4.7 "Đã làm"), migration MỚI `20261023030305`, chưa áp.
- *Kiểm.*
  - PGlite trang 51/51 (thêm 8 ca Mốc 6):
    - xem trước bảng / loại báo trả / ngoài toà của khoá / khác tháng / đã thanh lý; toà nêu tên, toà ngoài phạm vi;
    - ghi 20 + lô sau 2 + lô rỗng; phát lại y nguyên; basis lệch;
    - một dòng lỗi; lỗi tạm lùi cả lô; mọi dòng lỗi ⇒ rejected;
    - tham số; bước ghi lô đọc lại id lạ; `$requires$`.
  - Thứ tự khoá của bước ghi lô; test hai phiên PG thêm ca lô (hàm web giữ dòng HĐ ⇒ 55P03 ngay).
  - Đột biến 14/14.
  - Connector: `contract-action` + `action-reasons` + `action-tools-budget` + `tool-argument-shape` 30/30; `tools/list` không đổi.
- *Tầng 2 TEST* (ROLLBACK, hàm ghi web thật):
  - chủ (2 kết nối) và joey: xem trước 20 dòng; ghi 20/20 HĐ (đúng ngày mới theo hàm dùng chung, không phiếu / hoá đơn mới) trong 0,86–1,47 giây, dưới trần 8 giây;
  - phát lại y nguyên; lô sau không lặp HĐ; một biên nhận;
  - B.Huy không có khoá ghi.

## 16. Chưa xác minh

- RLS thật của `contracts` / `customers` với vai không có `customers.view`: kết luận từ đọc mã. Tầng 2 sẽ đo.
- Cổng W2 `hermes_w2_read_v1` có cần đổi khi thêm báo cáo vào W2D không. Mốc 2 đọc.
- Cách form web dựng dịch vụ và ngày tính tiền mặc định cho HĐ mới; đường dẫn web của nháp. Mốc 5 tra.
- ~~`statement_timeout` thật của `authenticated` qua PostgREST, và thời gian lô 20 HĐ~~: Mốc 6 đo, 8 giây (TEST và production), lô 20 HĐ 0,86–1,47 giây trên TEST. Chưa đo qua PostgREST thật (cộng thời gian guard + mạng) — ca tầng 3.
- ~~Cột liên kết HĐ của `invoices` cho hậu điều kiện tiền~~: Mốc 4 xác minh `invoices.contract_id NOT NULL`, `income_expenses.contract_id`, tiền ở `total_amount` cả hai bảng.
- Playwright hộp Gia hạn trên TEST: chưa chạy được đường có ngày, vì `contract_renewal_end_date_v1` chưa áp lên TEST (đường lỗi + bố cục kiểm bằng test component).
- `rooms_occupancy` so với Báo cáo lấp đầy của web khi công tắc "Hoạt động" ghi đè trạng thái phòng (phòng có HĐ mà `AVAILABLE`): báo cáo theo `displayStatus` như trang Phòng, có thể lệch Báo cáo lấp đầy ở các phòng đó.
