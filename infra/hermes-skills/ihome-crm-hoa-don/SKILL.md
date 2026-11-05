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
  = `month` YYYY-N, ngày thu mặc định hôm nay — không hỏi "khách chuyển ngày nào". Chữ sau "phòng" là tên phòng kể cả khi giống
  tên sổ ("phòng MB").
- "ck X trước, còn lại <cuối tuần / sau>" = thu MỘT PHẦN X hôm nay ("trước" = trả trước một phần, KHÔNG phải ngày): không gửi
  `datePhrase`, phần còn lại không ghi, không hỏi ngày.
- `cashbookName` chỉ khi người dùng nêu sổ / tài khoản nhận: chép NGUYÊN tên họ nói ("vào HKD Tâm" ⇒ "HKD Tâm", "vào TK Hiệp" ⇒
  "TK Hiệp"); "sổ HKD của anh" (không tên riêng) ⇒ "HKD". Không ghi tên sổ vào `note`. Không nêu sổ ⇒ không gửi, bản xem trước
  dùng sổ mặc định (đọc như thông tin, không hỏi lại chọn sổ).
- Phòng người dùng nói CHƯA trả ⇒ không gọi cho phòng đó. Máy chủ báo ghi chú nói khoản CHƯA trả ⇒ hỏi lại người dùng phòng đó
  đã trả chưa; không tự bỏ câu "chưa…" rồi gọi lại. Sửa / đổi hình thức lần thu ĐÃ ghi ⇒ web (Hoá đơn › Lịch sử thanh
  toán), không gọi `invoice.collect` lần nữa (thành thu trùng). `period_closed` ⇒ tháng đó toà đã chốt lợi nhuận.

## Chỉ số điện nước — `invoice.meter_record`

{`buildingName`, `readings` [{roomName, value, meterCode}], `meterType` dien / nuoc, `month`, `replace`}. Số không kèm chữ tiền
(đ, k, triệu, tiền, ck…) sau "điện / nước phòng X" là CHỈ SỐ công tơ ⇒ gọi ngay, không hỏi "chỉ số hay tiền", tháng trống = kỳ
hiện tại. Sửa số đã ghi ⇒ `replace` = true. Cảnh báo nhỏ hơn số đầu ⇒ đọc nguyên văn, nêu số đầu kỳ.

## Điều chỉnh, kiểm, huỷ, khôi phục

- `invoice.adjust` {toà, phòng, `month` / `invoiceNumber`, `discount` (giảm thêm) | `addItems` | `setItems`, `reason`}: gọi ngay
  để lấy bản xem trước (tổng cũ → mới); lời người dùng nêu VÌ SAO ("anh tính nhầm", "khách xin giảm") là lý do ⇒ `reason` nguyên
  văn, không ghép câu yêu cầu hay tên thao tác cho đủ ký tự; chưa có thì hỏi sau khi máy chủ đòi. Dòng điện nước có chỉ số, cọc ⇒ web.
- `invoice.adjustment_check`: xác nhận ĐÃ KIỂM TRA điều chỉnh do người khác làm (không phải duyệt hoá đơn); không bỏ được — lượt
  xác nhận kèm `consentText`. Điều chỉnh do chính người hỏi làm ⇒ web.
- `invoice.cancel` (hoá đơn chưa thu đồng nào) / `invoice.restore`: gọi ngay, lý do chỉ hỏi khi máy chủ trả `reason_required`;
  đọc mọi `warnings`.
- Lập hoá đơn tháng: bot không có thao tác ⇒ web (Hoá đơn › Tạo hoá đơn).

## Đọc hoá đơn, nợ

Chi tiết hoá đơn một phòng: `crm_read_report` report=invoice_room_detail. Nợ theo phòng:
report=invoice_room_debts. Nhắc nợ: report=invoice_reminders (chép nguyên `messageText`). Phòng chưa có hoá đơn: report=invoice_missing.
Điều chỉnh chờ kiểm: report=invoice_adjustments. Thu theo hình thức: report=collection_by_method. Công nợ tổng: `crm_read_receivables`.
`crm_read_invoice_report` status=unpaid chỉ là hoá đơn chưa thu đồng nào; trả một phần (partial) vẫn là chưa đóng đủ.

- Link tra cho khách (`/c/…`) là link của HỢP ĐỒNG, không theo kỳ: lấy trong invoice_room_detail; không có (kỳ này chưa có hoá
  đơn…) ⇒ `crm_read_contract_search` (toà + phòng như người dùng nói, status ACTIVE) lấy `contractId` của HĐ đang hiệu lực ⇒
  `crm_read_contract_detail` {contractId} lấy `publicLink`. Đưa nguyên link; `publicLink` null ⇒ nói chưa lấy được link, không tự
  ghép `/c/…`. Phòng không có HĐ hiệu lực ⇒ mới nói không có link.
- "Phòng X đóng tiền kỳ này chưa?" mà kỳ này chưa có hoá đơn ⇒ nói rõ chưa lập hoá đơn kỳ này, kèm nợ cũ theo
  report=invoice_room_debts (còn nợ bao nhiêu, hoặc không còn nợ).
- invoice_missing ⇒ kể ĐỦ từng toà kèm số phòng (tối đa 20 toà; quá 20 ⇒ 20 toà nhiều nhất + số toà còn lại), không chỉ vài toà đầu.
- Hỏi số THU (thu được bao nhiêu, CK / tiền mặt bao nhiêu) ⇒ chỉ nêu khoản thu theo câu hỏi; không kèm tổng phiếu CHI hay số khác
  không được hỏi.
