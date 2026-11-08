---
name: ihome-crm-ghi-chung
description: "Khi ghi CRM: crm_action_list trước, rồi crm_action_run."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official]
    related_skills: [ihome-crm-cong-viec, ihome-crm-hop-dong, ihome-crm-hoa-don, ihome-crm-thu-chi, ihome-crm-phong-sale-nhom, ihome-crm-bai-hoc]
---

# Ghi CRM iHome — quy trình chuẩn

**Thứ tự ưu tiên.** Nhóm skill `ihome-crm-*` là hướng dẫn CHUẨN, phát hành cùng connector CRM, chỉ đọc. Skill tự học, ghi nhớ hay
hội thoại cũ có thể lỗi thời: chỗ nào khác nhóm này thì theo nhóm này. Tên tool và mã thao tác chỉ lấy từ kết quả
`crm_action_list` và nhóm `ihome-crm-*`; không lấy từ trí nhớ, không tự ghép tên. Mở skill: `skill_view` với `name` là ĐÚNG MỘT
tên trần, vd `ihome-crm-hop-dong` — không thêm dấu nháy, ngoặc, tên nhóm (`ihome-crm:`), đường dẫn hay chữ khác; mỗi lệnh một tên.
Không tự sửa skill / bộ nhớ về cách GHI dữ liệu CRM: bài học loại này phải qua duyệt (`ihome-crm-bai-hoc`).

## When to Use

Người dùng muốn tạo, giao, sửa, huỷ, ghi nhận, thu, chi, duyệt, gia hạn, giữ phòng… — mọi việc làm đổi dữ liệu CRM. Chi tiết
từng trang: `ihome-crm-cong-viec`, `ihome-crm-hop-dong`, `ihome-crm-hoa-don`, `ihome-crm-thu-chi`; phòng, Sale, gửi nhóm:
`ihome-crm-phong-sale-nhom`; chủ trả lời tin "Bài học Hermes chờ duyệt" ("duyệt 1,3", "bỏ 2 vì …"): `ihome-crm-bai-hoc`.

## Không kết luận "không làm được" khi chưa hỏi máy chủ

- Tool CRM luôn có sẵn (khi gọi thêm tiền tố `mcp__ihomecrm__` như SOUL). Không dùng `tool_search` để tìm tool ghi CRM: tìm
  không thấy KHÔNG có nghĩa là không ghi được.
- Trước khi trả lời "không có / không hỗ trợ / làm trên web / không có quyền", gọi `crm_action_list` với `page` của việc đang
  làm (task, contract, invoice, expense; một lần mỗi trang mỗi phiên là đủ) — bỏ `page` thì danh sách cả bốn trang rất dài, dễ sót
  thao tác ở cuối. Thao tác nằm trong `items` ⇒ làm; nằm trong `notPermitted` ⇒ "anh/chị chưa có quyền …"; không có ở cả hai ⇒
  mới nói bot chưa làm được việc này.
- Không bao giờ nói "công cụ CRM không có / không xuất hiện trong phiên" khi chưa gọi `crm_action_list`. Gọi mà lỗi thật ⇒ báo lỗi
  kết nối kèm mã lỗi, nói rõ chưa ghi gì.
- Ngoại lệ CHẶN TRƯỚC — chỉ khi việc được nhờ chính là LẬP / GHI khoản tiền dưới đây: không gọi tool nào, kể cả
  `crm_action_list`, trả lời một câu chỉ đúng trang web: chi hoa hồng sale / môi giới; thu / hoàn / trả / bổ sung cọc, bỏ cọc không
  kèm trả phòng; lập thanh lý / quyết toán HĐ, trả tiền thừa cho khách; lương, thưởng; lập / sửa / huỷ phiếu THU; phiếu hệ thống,
  phiếu con định kỳ (trang web từng loại: `ihome-crm-thu-chi`). KHÔNG chặn: khách trả phòng kèm bỏ cọc ⇒ `contract.return`
  `forfeit` = true (`ihome-crm-hop-dong`); ghi chú vào phiếu đã có, kể cả phiếu thu ⇒ `expense.note`; khách trả tiền HOÁ ĐƠN (kể
  cả hoá đơn thanh lý) ⇒ `ihome-crm-hoa-don`.
- Kết quả đọc rỗng chỉ là "không có" khi đã lọc đúng tham số (toà `buildingName`, phòng `roomName`, kỳ, trạng thái). Tên không
  giải được (`not_visible`, "không thấy …") là không thấy trong phạm vi quyền, không phải "không tồn tại".

## Vòng ghi bằng `crm_action_run`

1. Lấy `action` và khuôn `params` từ `crm_action_list`. Toà, phòng, người, hạng mục, sổ: TÊN như người dùng nói (không đoán ID).
   Lý do, nội dung, ghi chú: dùng NGUYÊN VĂN cụm người dùng nói VỀ chính giá trị đó (lý do = vì sao, vd "khách ở tiếp"; ghi chú
   trả phòng, vd "quyết toán sau"), ghép được nhiều cụm như vậy. Cụm họ tự nói có sẵn tên thao tác ("khách gia hạn ở tiếp") ⇒ gửi
   nguyên văn, không cắt, không hỏi lại. Bot KHÔNG tự ghép thêm câu yêu cầu, tên thao tác ("huỷ báo trả", "gia hạn"), chủ ngữ hay
   từ đệm cho đủ ký tự. Không tự đếm ký tự trước khi gọi: gửi nguyên cụm, máy chủ báo ngắn thì mới hỏi. Tiền: số nguyên VND (3tr5 = 3500000).
   Ngày: YYYY-MM-DD giờ Việt Nam; người dùng nói NGÀY bằng lời ("hôm qua", "thứ hai tuần trước") ⇒ gửi thêm tham số `…Phrase`
   NGUYÊN VĂN khi khuôn có (connector tự quy đổi). Ngày thu của `invoice.collect` không nói ⇒ bỏ (máy chủ lấy hôm nay); ngày bắt
   buộc khác (trả phòng, báo trả, nháp HĐ) không nói ⇒ hỏi, không tự lấy hôm nay. "trước" / "sau" đứng sau số tiền ("ck 2 củ
   trước") là trả trước / trả sau, không phải ngày. Tham số không có giá trị thì bỏ hẳn, không gửi chuỗi rỗng.
2. Gọi `crm_action_run` {action, params}. Không cần `crm_new_request_id`: connector tự cấp `requestId`.
   - `confirm: always` (tiền, không lùi được): máy chủ luôn trả bản xem trước ⇒ gọi ngay khi đủ ý, không hỏi xác nhận bằng chữ
     trước; bản xem trước là bước xác nhận.
   - `confirm: if_required`: máy chủ có thể GHI NGAY, không qua xem trước (vd báo trả, giữ / bỏ giữ phòng, thêm / bớt người ở, nháp
     HĐ, ghi chú phiếu, sửa việc) ⇒ lời người dùng đã đủ thì gọi luôn. Hỏi trước khi gọi khi: nói "trả phòng" kèm ngày dọn đi
     TƯƠNG LAI (đó là báo trả — `ihome-crm-hop-dong`); thiếu giá trị bắt buộc người dùng chưa nói; và các ca hỏi riêng của từng
     trang (giá trị có khuôn đóng: giờ giữ phòng khác 6 / 12 / 24 ⇒ hỏi chọn mức gần nhất; người nhận "anh/chị" trơn ⇒ hỏi giao cho
     ai…). Lý do, nội dung, ghi chú đã nói thì gửi nguyên cụm, không hỏi trước. Ngoài các ca đó, không hỏi lại điều người dùng đã nói.
3. Đọc kết quả:
   - `confirmation_required` = CHƯA ghi. Đọc nguyên văn `preview` và `warnings` (kể cả câu "Hiểu '…' là …"), chờ người dùng
     đồng ý rõ ở tin SAU ("ok", "được", "chốt", "ghi đi"… đứng riêng là đồng ý rõ). Đồng ý ⇒ gọi lại Y NGUYÊN `action` +
     `params` kèm `requestId` và `confirmToken` chép đủ từng ký tự; `huongDan` đòi `consentText` ⇒ thêm `consentText` = nguyên
     văn tin người dùng. Người dùng ĐỔI hoặc BỔ SUNG nội dung (thêm / sửa ghi chú, lý do, loại, ngày, người, sổ / tài khoản nhận,
     số tiền, phương thức…) ⇒ gọi lại NGAY trong lượt đó, KHÔNG kèm `confirmToken`, đưa bản xem trước mới — không hỏi xác nhận bản
     cũ bằng chữ; đồng ý ở tin sau mới gọi lượt ghi. Tin sau bản xem trước mà nêu giá trị mới (vd "ck vào TK Hiệp") là SỬA dù không
     có chữ "đổi" ⇒ lượt đó không gửi `confirmToken`, gọi lại xem trước với giá trị mới.
   - `needs_input` = CHƯA ghi; làm theo `huongDan`. `invalid_params`: sửa phần MÌNH chọn (tên / kiểu tham số, định dạng ngày,
     tham số thừa) theo khuôn trong `detail`; cụm người dùng nói về chính giá trị đó ⇒ dùng / ghép nguyên văn rồi gọi lại (không
     tự thêm câu yêu cầu, tên thao tác, từ đệm). Máy chủ báo giá trị người dùng nói còn ngắn / sai khuôn (vd lý do chỉ "đổi ý", giữ phòng 8 giờ), hoặc
     họ chưa nói ⇒ hỏi lại, không tự đổi, không bịa. `huongDan` bảo hỏi lại người dùng (vd ghi chú thu tiền nói khoản CHƯA trả) ⇒
     hỏi, không tự sửa params rồi gọi lại. Lý do khác ⇒ hỏi đúng một câu theo `detail` / `candidates`.
   - `applied` = đã ghi ⇒ báo ngắn kết quả (mã, người, hạn, số tiền…).
   - Lỗi `action_rejected` ⇒ báo đúng `detail`; chỉ khi `detail` bảo xem trước lại (vd `state_changed`) mới gọi lại không kèm
     `confirmToken`, còn lại không tự thử lại. `forbidden` ⇒ chưa có quyền; `action_disabled` ⇒ thao tác chưa bật cho kết nối.
   - Lỗi `action_outcome_unknown` ⇒ KHÔNG gọi lại lệnh ghi; tra `crm_action_status` với ĐÚNG `requestId` đó.
   - `confirmation_invalid` ⇒ làm theo `detail` (requestId của bản xem trước mới nhất / gửi y nguyên params / xem trước lại);
     không xem trước quá 2 lần cho cùng một việc.
   - Lượt xác nhận gặp `timeout` (không phải `action_outcome_unknown`) ⇒ máy chủ chưa gửi lệnh ghi: gọi lại đúng một lần y nguyên.
4. Một tin có hai việc ghi ⇒ nói làm việc nào trước rồi làm lần lượt NGAY trong lượt đó: việc ghi thẳng mà lời đã đủ thì gọi luôn
   rồi sang việc sau; việc cần xem trước thì đưa bản xem trước và chờ đồng ý riêng (lời đồng ý chỉ xác nhận bản xem trước người
   dùng đã thấy). Sau bản xem trước người dùng nói "thôi / khoan / khỏi" ⇒ bỏ hẳn bản xem trước đó, không gọi thao tác nào khác
   thay vào; nói rõ việc nào ĐÃ ghi (vd báo trả đã ghi thẳng trong cùng tin) và việc nào CHƯA ghi — chỉ nói "em chưa ghi gì" khi
   chưa ghi việc nào.

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
