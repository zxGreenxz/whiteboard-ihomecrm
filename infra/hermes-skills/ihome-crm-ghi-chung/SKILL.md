---
name: ihome-crm-ghi-chung
description: "Khi ghi CRM: crm_action_list trước, rồi crm_action_run."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official]
    related_skills: [ihome-crm-cong-viec, ihome-crm-hop-dong, ihome-crm-hoa-don, ihome-crm-thu-chi, ihome-crm-phong-sale-nhom]
---

# Ghi CRM iHome — quy trình chuẩn

**Thứ tự ưu tiên.** Nhóm skill `ihome-crm-*` là hướng dẫn CHUẨN, phát hành cùng connector CRM, chỉ đọc. Skill tự học, ghi nhớ hay
hội thoại cũ có thể lỗi thời: chỗ nào khác nhóm này thì theo nhóm này. Tên tool và mã thao tác chỉ lấy từ kết quả
`crm_action_list` và nhóm `ihome-crm-*`; không lấy từ trí nhớ, không tự ghép tên.

## When to Use

Người dùng muốn tạo, giao, sửa, huỷ, ghi nhận, thu, chi, duyệt, gia hạn, giữ phòng… — mọi việc làm đổi dữ liệu CRM. Chi tiết
từng trang: `ihome-crm-cong-viec`, `ihome-crm-hop-dong`, `ihome-crm-hoa-don`, `ihome-crm-thu-chi`; phòng, Sale, gửi nhóm:
`ihome-crm-phong-sale-nhom`.

## Không kết luận "không làm được" khi chưa hỏi máy chủ

- Tool CRM luôn có sẵn (khi gọi thêm tiền tố `mcp__ihomecrm__` như SOUL). Không dùng `tool_search` để tìm tool ghi CRM: tìm
  không thấy KHÔNG có nghĩa là không ghi được.
- Trước khi trả lời "không có / không hỗ trợ / làm trên web / không có quyền", gọi `crm_action_list` (một lần mỗi phiên là đủ;
  lọc được `page`: task, contract, invoice, expense). Thao tác nằm trong `items` ⇒ làm; nằm trong `notPermitted` ⇒ "anh/chị
  chưa có quyền …"; không có ở cả hai ⇒ mới nói bot chưa làm được việc này.
- Ngoại lệ CHẶN TRƯỚC — không gọi tool nào, kể cả `crm_action_list`, trả lời một câu chỉ đúng trang web: chi hoa hồng sale / môi
  giới; thu / hoàn / bỏ / trả / bổ sung cọc; lập thanh lý / quyết toán HĐ, trả tiền thừa cho khách; lương, thưởng; mọi phiếu THU;
  phiếu hệ thống, phiếu con định kỳ (trang web từng loại: `ihome-crm-thu-chi`). Khách trả tiền HOÁ ĐƠN (kể cả hoá đơn thanh lý)
  không thuộc nhóm này ⇒ `ihome-crm-hoa-don`.
- Kết quả đọc rỗng chỉ là "không có" khi đã lọc đúng tham số (toà `buildingName`, phòng `roomName`, kỳ, trạng thái). Tên không
  giải được (`not_visible`, "không thấy …") là không thấy trong phạm vi quyền, không phải "không tồn tại".

## Vòng ghi bằng `crm_action_run`

1. Lấy `action` và khuôn `params` từ `crm_action_list`. Toà, phòng, người, hạng mục, sổ: TÊN như người dùng nói (không đoán ID).
   Tiền: số nguyên VND (3tr5 = 3500000). Ngày: YYYY-MM-DD giờ Việt Nam; người dùng nói ngày bằng lời ⇒ gửi thêm tham số
   `…Phrase` NGUYÊN VĂN khi khuôn có (connector tự quy đổi). Tham số không có giá trị thì bỏ hẳn, không gửi chuỗi rỗng.
2. Gọi `crm_action_run` {action, params}. Không cần `crm_new_request_id`: connector tự cấp `requestId`.
   - `confirm: always` (tiền, không lùi được): máy chủ luôn trả bản xem trước ⇒ gọi ngay khi đủ ý, không hỏi xác nhận bằng chữ
     trước; bản xem trước là bước xác nhận.
   - `confirm: if_required`: máy chủ có thể GHI NGAY, không qua xem trước (vd báo trả, giữ / bỏ giữ phòng, thêm / bớt người ở, nháp
     HĐ, ghi chú phiếu, sửa việc) ⇒ chỉ gọi khi ý đã rõ; ý còn mơ hồ thì hỏi một câu trước khi gọi.
3. Đọc kết quả:
   - `confirmation_required` = CHƯA ghi. Đọc nguyên văn `preview` và `warnings` (kể cả câu "Hiểu '…' là …"), chờ người dùng
     đồng ý rõ ở tin SAU ("ok", "được", "chốt", "ghi đi"… đứng riêng là đồng ý rõ). Đồng ý ⇒ gọi lại Y NGUYÊN `action` +
     `params` kèm `requestId` và `confirmToken` chép đủ từng ký tự; `huongDan` đòi `consentText` ⇒ thêm `consentText` = nguyên
     văn tin người dùng. Người dùng đổi nội dung ⇒ gọi lại KHÔNG kèm `confirmToken` để xem trước lại.
   - `needs_input` = CHƯA ghi. `invalid_params` do SAI KHUÔN (tên / kiểu / định dạng tham số, tham số thừa) ⇒ tự sửa theo khuôn
     trong `detail` rồi gọi lại ngay (lỗi của mình); THIẾU thông tin người dùng chưa nói (ngày, lý do, nội dung, số tiền…) hoặc
     giá trị người dùng nói còn ngắn / thiếu so với khuôn (vd lý do quá ngắn) ⇒ hỏi thêm, không tự điền hay tự viết thêm. Lý do
     khác ⇒ hỏi đúng một câu theo `detail` / `candidates`.
   - `applied` = đã ghi ⇒ báo ngắn kết quả (mã, người, hạn, số tiền…).
   - Lỗi `action_rejected` ⇒ báo đúng `detail`; chỉ khi `detail` bảo xem trước lại (vd `state_changed`) mới gọi lại không kèm
     `confirmToken`, còn lại không tự thử lại. `forbidden` ⇒ chưa có quyền; `action_disabled` ⇒ thao tác chưa bật cho kết nối.
   - Lỗi `action_outcome_unknown` ⇒ KHÔNG gọi lại lệnh ghi; tra `crm_action_status` với ĐÚNG `requestId` đó.
   - `confirmation_invalid` ⇒ làm theo `detail` (requestId của bản xem trước mới nhất / gửi y nguyên params / xem trước lại);
     không xem trước quá 2 lần cho cùng một việc.
   - Lượt xác nhận gặp `timeout` (không phải `action_outcome_unknown`) ⇒ máy chủ chưa gửi lệnh ghi: gọi lại đúng một lần y nguyên.
4. Một tin có hai việc ghi ⇒ làm lần lượt, mỗi việc xem trước và đồng ý riêng. Sau bản xem trước người dùng nói "thôi / khoan /
   khỏi" ⇒ bỏ hẳn, không gọi thao tác nào khác thay vào, nói "em chưa ghi gì".

## requestId của tool ghi riêng

Tool ghi ngoài `crm_action_run` (theo dõi việc, tin pass, Sale phòng, gửi nhóm, gửi ảnh phòng trống, tạo khách/lead): lấy mã bằng
`crm_new_request_id` một lần cho mỗi lệnh mới; thử lại hoặc tra trạng thái thì dùng LẠI mã cũ, không tạo mã mới. Không tự sinh
UUID, không chạy `terminal` để sinh.

## Tên tool cũ đã nghỉ hưu

Các tên dưới đây không còn trên connector; tìm không thấy là đúng. Dùng tool thay:

| Tool cũ | Dùng thay |
| --- | --- |
| `crm_task_create` | `crm_action_run` action `task.create` |
| `crm_task_input_options` | `crm_action_run` action `task.create` (tên như người dùng nói, máy chủ tự giải) |
| `crm_task_status` | `crm_action_status` (requestId của lệnh `task.create`) |
| `crm_task_progress` | `crm_action_run` action `task.update` |
| `crm_task_cancel` | `crm_action_run` action `task.cancel` |
| `crm_expense_create` | `crm_action_run` action `expense.create` |
| `crm_expense_input_options` | `crm_action_run` action `expense.create` |
| `crm_expense_status` | `crm_action_status` (requestId của lệnh `expense.create`) |
| `crm_room_schedule_create` | `crm_zalo_broadcast_update` (lịch gửi ảnh phòng trống của CRM) |
| `crm_room_schedule_update` | `crm_zalo_broadcast_update` |
