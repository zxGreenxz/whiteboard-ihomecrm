---
name: ihome-crm-hoa-don
description: "Hoá đơn CRM: thu tiền CK/TT, chỉ số điện nước, điều chỉnh."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official, invoices]
    related_skills: [ihome-crm-ghi-chung, ihome-crm-thu-chi]
---

# Hoá đơn (trang /invoices, /thu-tien)

Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây. Vòng ghi, xem trước, xác nhận, lỗi: `ihome-crm-ghi-chung`.
Mọi thao tác dưới đây đi qua `crm_action_run`; mọi thao tác hoá đơn đều xem trước rồi mới ghi.

## When to Use

Khách (kể cả khách cũ đã trả phòng) trả tiền phòng / điện nước / phí / quyết toán bằng chuyển khoản hay POS, ghi chỉ số điện nước,
điều chỉnh hoá đơn, xác nhận đã kiểm điều chỉnh, huỷ hoặc khôi phục hoá đơn, hỏi nợ / nhắc nợ.

## Thu tiền — `invoice.collect`

- Khách trả tiền hoá đơn ⇒ LUÔN gọi `invoice.collect` trước (máy chủ tự tìm hoá đơn còn nợ, kể cả hoá đơn quyết toán); chỉ khi
  máy chủ báo không có hoá đơn còn nợ mới nói sang phiếu thu trên web. Không phải phiếu chi.
- Một phòng: `roomName`, `month`, `amount`, `datePhrase` ở cấp ngoài (không dùng `items`). Nhiều phòng cùng toà, cùng hình thức
  (≤ 10): `buildingName` + `method` chung + `items` [{roomName, month, invoiceNumber, amount}], một lần đồng ý; khác toà / khác
  hình thức ⇒ tách lô.
- `method`: TK = chuyển khoản; TT = thanh toán / POS / chuyển vào sổ HKD; TM (tiền mặt) bị từ chối ⇒ trang Thu tiền (/thu-tien).
  "CK", "TK", "TT", "POS", "TM" là hình thức, không phải tên toà / phòng.
- Không nêu toà ⇒ bỏ hẳn `buildingName`; không nêu tháng ⇒ bỏ `month` (máy chủ chọn hoá đơn còn nợ, nhiều thì hỏi); "tiền tháng N"
  = `month` YYYY-N, ngày thu mặc định hôm nay. Chữ sau "phòng" là tên phòng kể cả khi giống tên sổ ("phòng MB").
- `cashbookName` chỉ khi người dùng nêu sổ / tài khoản nhận ("vào HKD Tâm", "sổ HKD của anh" ⇒ "HKD"); không ghi tên sổ vào
  `note`. Không nêu sổ ⇒ không gửi, bản xem trước dùng sổ mặc định (đọc như thông tin, không hỏi lại chọn sổ).
- Phòng người dùng nói CHƯA trả ⇒ không gọi cho phòng đó. Máy chủ báo ghi chú nói khoản CHƯA trả ⇒ hỏi lại người dùng phòng đó
  đã trả chưa; không tự bỏ câu "chưa…" rồi gọi lại. Sửa / đổi hình thức lần thu ĐÃ ghi ⇒ web (Hoá đơn › Lịch sử thanh
  toán), không gọi `invoice.collect` lần nữa (thành thu trùng). `period_closed` ⇒ tháng đó toà đã chốt lợi nhuận.

## Chỉ số điện nước — `invoice.meter_record`

{`buildingName`, `readings` [{roomName, value, meterCode}], `meterType` dien / nuoc, `month`, `replace`}. Số không kèm chữ tiền
(đ, k, triệu, tiền, ck…) sau "điện / nước phòng X" là CHỈ SỐ công tơ ⇒ gọi ngay, không hỏi "chỉ số hay tiền", tháng trống = kỳ
hiện tại. Sửa số đã ghi ⇒ `replace` = true. Cảnh báo nhỏ hơn số đầu ⇒ đọc nguyên văn, nêu số đầu kỳ.

## Điều chỉnh, kiểm, huỷ, khôi phục

- `invoice.adjust` {toà, phòng, `month` / `invoiceNumber`, `discount` (giảm thêm) | `addItems` | `setItems`, `reason`}: gọi ngay
  để lấy bản xem trước (tổng cũ → mới); lời người dùng đã nói là lý do; chưa có thì hỏi sau khi máy chủ đòi. Dòng điện nước có chỉ
  số, cọc ⇒ web.
- `invoice.adjustment_check`: xác nhận ĐÃ KIỂM TRA điều chỉnh do người khác làm (không phải duyệt hoá đơn); không bỏ được — lượt
  xác nhận kèm `consentText`. Điều chỉnh do chính người hỏi làm ⇒ web.
- `invoice.cancel` (hoá đơn chưa thu đồng nào) / `invoice.restore`: gọi ngay, lý do chỉ hỏi khi máy chủ trả `reason_required`;
  đọc mọi `warnings`.
- Lập hoá đơn tháng: bot không có thao tác ⇒ web (Hoá đơn › Tạo hoá đơn).

## Đọc hoá đơn, nợ

Chi tiết / link tra hoá đơn một phòng: `crm_read_report` report=invoice_room_detail (đưa nguyên link `/c/…`). Nợ theo phòng:
report=invoice_room_debts. Nhắc nợ: report=invoice_reminders (chép nguyên `messageText`). Phòng chưa có hoá đơn: report=invoice_missing.
Điều chỉnh chờ kiểm: report=invoice_adjustments. Thu theo hình thức: report=collection_by_method. Công nợ tổng: `crm_read_receivables`.
`crm_read_invoice_report` status=unpaid chỉ là hoá đơn chưa thu đồng nào; trả một phần (partial) vẫn là chưa đóng đủ.
