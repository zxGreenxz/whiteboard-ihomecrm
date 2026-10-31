---
name: ihome-crm-phong-sale-nhom
description: "Phòng trống, trang Sale, tin pass, gửi nhóm Zalo CRM."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official, rooms, sale, zalo]
    related_skills: [ihome-crm-ghi-chung, ihome-crm-hop-dong]
---

# Phòng, trang Sale, gửi nhóm

Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây. requestId của các tool ghi ở đây: `crm_new_request_id` một lần
cho mỗi lệnh mới, thử lại / tra trạng thái dùng lại mã cũ (xem `ihome-crm-ghi-chung`). Không đăng SĐT / CCCD khách vào nhóm.

## When to Use

Hỏi phòng trống / sắp trống / một phòng, trang Sale công khai, đăng hoặc sửa tin pass phòng ("khách nhờ sale"), sửa thông tin
phòng trên Sale, xem trước hoặc gửi danh sách phòng vào nhóm Zalo, gửi ảnh phòng trống, lịch gửi.

## Phòng trống — đọc

- Trạng thái CRM thật: số phòng trống `crm_read_occupancy`; danh sách có giá `crm_read_report` report=re_vacant_rooms; không có
  quyền BĐS ⇒ report=rooms (phòng AVAILABLE) / report=rooms_occupancy; sắp trống N ngày `crm_read_occupancy_report`; một phòng
  (ai ở, trống không) `crm_room_lookup` {buildingName, roomCode}. Phòng có HĐ đang hiệu lực là đang có người ở.
- Trang Sale công khai `crm_available_rooms`: phòng ĐANG RAO (trống, sắp trống, pass) và giá rao — không phải trạng thái CRM.
  Đọc hết các trang trước khi nói tổng; tách rõ phòng trống ngay, sắp trống (kèm ngày), pass; nhóm theo toà; không đoán diện tích
  hay số liệu thiếu. `listing` = no_sale_page là chưa có link Sale, không phải hết phòng.

## Tin pass phòng ("khách nhờ sale")

`crm_room_lookup` (toà + phòng như người dùng viết) lấy `roomId` → `crm_new_request_id` → `crm_room_pass_upsert` chỉ với trường
người dùng nêu (không gửi = giữ nguyên). Có tên / SĐT / chính sách ⇒ lần đầu trả `confirmation_required`: cho người dùng xem
nguyên văn, đồng ý rõ mới gọi lại kèm `confirmToken`. Giờ xem phòng là chính sách, không phải ngày trống. Ẩn / hiện lại tin:
`crm_room_pass_observe` (revision) → `crm_room_pass_set_active`. Mất phản hồi ⇒ `crm_room_pass_status` cùng requestId. Báo rõ
`contactSource` (provided / representative / unchanged).

## Sửa phòng trên trang Sale — `crm_sale_action`

Chỉ để sửa thông tin phòng / ảnh / chính sách trên trang Sale (room_options, room_observe, room_patch, policy_*, bulk_patch):
operation=list trước để xem operation và khuôn input được cấp, rồi gọi đúng operation / input đó (requestId từ
`crm_new_request_id`; `confirmation_required` ⇒ chỉ gửi lại kèm `confirmToken` khi người dùng đồng ý; kết quả chưa rõ ⇒ tra
operation trạng thái tương ứng, không tạo mã mới).

- KHÔNG gọi reservation_create, reservation_update, reservation_topup, reservation_assign (báo cọc, sửa / thu thêm / gán cọc).
  Cọc có tiền và ghi thẳng: cọc, thu thêm cọc, hoàn / bỏ cọc làm trên web, trang Quản lý cọc (hoặc thanh lý HĐ) — kể cả khi list có.
- KHÔNG gọi room_lock / room_release: giữ / bỏ giữ phòng dùng `crm_action_run` action `contract.room_lock` /
  `contract.room_unlock` (`ihome-crm-hop-dong`). Giữ phòng không phải đã nhận cọc.

## Gửi danh sách phòng vào nhóm

1. Xem trước: `crm_group_directory` (nhóm của nick gửi, khớp đúng tên) + `crm_available_rooms` (roomIds) →
   `crm_group_room_preview`; trả nguyên văn bản xem trước, ghi rõ "chưa gửi". Không gửi khi người dùng chưa bảo gửi.
2. Gửi: đọc lại danh sách phòng + nhóm mới nhất → `crm_new_request_id` → `crm_group_room_send` → `crm_group_send_status`
   (dispatchId). Đã xếp hàng chưa phải đã gửi. Nội dung khác bản người dùng đã duyệt ⇒ nêu chỗ khác, xin đồng ý lại.

## Gửi ảnh phòng trống, lịch gửi

- Gửi ngay: `crm_zalo_broadcast_recipients` (lọc đúng tên nhóm / phân loại, lấy `conversationId`; không dùng tên tự do) →
  `crm_new_request_id` → `crm_zalo_broadcast_send` bỏ trống `runAt` (mode mặc định full); yêu cầu đã rõ thì không hỏi lại. Bị
  từ chối ngoài khung giờ ⇒ báo khung giờ, hỏi có hẹn lúc `suggestedRunAt` không (đồng ý ⇒ requestId mới, gửi kèm `runAt`).
- Lịch định kỳ (bật / tắt, giờ, ngày, nhóm nhận): `crm_zalo_broadcast_status` (lấy `version`) → `crm_zalo_broadcast_update`
  (`expectedVersion`). Huỷ lượt hẹn chưa chạy: `crm_zalo_broadcast_cancel`. Đây là bộ lập lịch DUY NHẤT: không tạo cron Hermes.
- Lịch chữ cũ của Hermes chỉ còn xem / thu hồi: `crm_room_schedule_list`, `crm_room_schedule_revoke`, `crm_room_schedule_issues`,
  `crm_room_schedule_reconcile` (chỉ khi người dùng đã tự kiểm và nói rõ).
