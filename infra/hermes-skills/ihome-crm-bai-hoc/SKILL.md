---
name: ihome-crm-bai-hoc
description: "Chủ đáp tin bài học Hermes: duyệt N / bỏ N."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official, learning]
    related_skills: [ihome-crm-ghi-chung]
---

# Bài học Hermes chờ duyệt

Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây. Vòng ghi, xem trước, xác nhận, lỗi: `ihome-crm-ghi-chung`.

## When to Use

Mỗi tối 21:00 bot gửi chủ tin "Bài học Hermes chờ duyệt": các đề xuất bài học về cách GHI dữ liệu CRM mà trợ lý tự học, đánh số
#N (cùng số với trang web Cài đặt › Hermes › Bài học chờ duyệt). Chủ trả lời "duyệt N", "duyệt 1,3", "duyệt 4-6", "bỏ N vì …",
"không duyệt N" ⇒ quyết định bằng `learning.decide`. Tin tối do job cron gửi ở phiên riêng: phiên chat có thể không thấy tin đó,
vẫn làm theo skill này khi câu trả lời đúng khuôn trên — TRỪ khi phiên này vừa đưa ra một danh sách đánh số KHÁC (phiếu thu chi,
việc, hoá đơn, hợp đồng…): khi đó "duyệt N" / "bỏ N" không kèm chữ "bài học" là mơ hồ ⇒ hỏi lại "bài học #N hay phiếu / việc số N
trong danh sách vừa gửi?", không gọi `learning.decide` hay thao tác duyệt của trang khác tới khi người dùng nói rõ.

## Duyệt / bỏ theo số

- `crm_action_run` action `learning.decide` {`numbers` = các số N người dùng nói (dải "4-6" ⇒ 4, 5, 6; tối đa 20 số), `decision` =
  `approve` khi "duyệt" / "đồng ý" / "ok", `reject` khi "bỏ" / "không duyệt" / "từ chối", `note` = NGUYÊN VĂN phần sau chữ "vì"
  (không có thì bỏ)}. Không đoán số, không tự thêm số. Câu mơ hồ (không có số, trộn duyệt và bỏ trong một câu, "duyệt hết") ⇒ hỏi
  lại số nào, không gọi.
- Máy chủ luôn trả bản xem trước: đọc từng "#N … → DUYỆT / BỎ", `warnings` (số đã quyết định trước đó, số không có) và `effect`;
  chủ đồng ý rõ ("ok", "chốt") ⇒ gọi lại y nguyên kèm `confirmToken`. `needs_input` lý do `learning_not_pending` ⇒ các số đó
  không còn chờ duyệt: báo chủ, hỏi lại số.
- "Duyệt" chỉ ghi nhận bài học đúng; "Bỏ" cũng chỉ ghi nhận — gỡ bài học khỏi trợ lý do điều phối viên làm tay. Quyết định một lần,
  không đổi được, không xoá. Xem kỹ hay tra lịch sử: trang web /settings/hermes?tab=bai-hoc.

## Tin tối 21:00

`learning.digest` CHỈ do job cron 21:00 của hồ sơ chủ gọi: nó đánh dấu "đã báo" các đề xuất mới của cả công ty. Job gửi NGUYÊN VĂN
`result.message`; `message` null (không có đề xuất mới) ⇒ không gửi gì.

- CRM chỉ nhận lượt này trong khung 20:55–21:10 giờ Việt Nam (theo đồng hồ máy chủ CRM; không tham số nào mở được khung). Ngoài
  khung ⇒ lỗi `action_rejected` lý do `learning_digest_outside_window`: CRM KHÔNG đánh dấu gì. Không gọi lại, không đổi tham số,
  không tự soạn tin thay.
- Gặp lỗi đó trong job tối ⇒ trả đúng `[SILENT]`. Gặp trong chat ⇒ nói: tin Bài học Hermes tự gửi lúc 21:00 mỗi tối; muốn xem ngay
  thì mở trang web /settings/hermes?tab=bai-hoc.
- Người dùng hỏi "có bài học nào chờ duyệt không?" hay bảo "gửi lại tin bài học" ⇒ chỉ trang web, không gọi `learning.digest`.

## Không tự sửa cách ghi CRM

Không tự sửa skill / bộ nhớ về cách GHI dữ liệu CRM (tên tool, mã thao tác, tham số, quy trình): bài học loại này phải qua duyệt
(tin tối hoặc trang web). Sở thích, cách nói chuyện, việc ngoài CRM thì tự học như thường.
