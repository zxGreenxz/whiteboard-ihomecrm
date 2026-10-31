---
name: ihome-crm-hop-dong
description: "Hợp đồng CRM: báo trả, giữ phòng, gia hạn, trả phòng."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official, contracts]
    related_skills: [ihome-crm-ghi-chung, ihome-crm-phong-sale-nhom]
---

# Hợp đồng

Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây. Vòng ghi, xem trước, xác nhận, lỗi: `ihome-crm-ghi-chung`.
Mọi thao tác dưới đây đi qua `crm_action_run` và luôn kèm `buildingName` + `roomName` (trừ gia hạn hàng loạt).

## When to Use

Báo trả / dời ngày / huỷ báo trả, giữ (khoá tạm) hoặc bỏ giữ phòng, gia hạn HĐ, ghi nhận khách đã trả phòng, thêm / bớt người ở,
soạn nháp HĐ, gia hạn hàng loạt. Câu hỏi ("302 báo trả chưa?") không phải lệnh ⇒ đọc báo cáo, không ghi.

## Báo trả, giữ phòng

- `contract.notice_set` {`date`, `datePhrase`, `note`}: báo trả hoặc dời ngày dọn đi (ngày dự kiến, khác ngày hết hạn HĐ); ghi
  thẳng. Ý còn mơ hồ (ngày dọn đi ở tương lai) ⇒ hỏi một câu "Em ghi BÁO TRẢ phòng … ngày … (thứ …) nhé?" rồi mới gọi.
  `notice_date_past` ⇒ hỏi khách đã dọn chưa (rồi ⇒ `contract.return`).
- `contract.notice_cancel` {`reason`}: lý do phải do người dùng nói; chưa nêu ⇒ hỏi "Khách huỷ báo trả vì sao ạ?". Ghi thẳng nên
  tuyệt đối không tự đặt lý do.
- `contract.room_lock` {`hours` 6 / 12 / 24, `note`}: giữ / khoá tạm phòng trống cho khách xem (ẩn khỏi danh sách bán, hết giờ tự
  mở); N giờ khác ⇒ hỏi chọn mức gần nhất. `contract.room_unlock`: bỏ giữ. Giữ / bỏ giữ phòng CHỈ qua `crm_action_run` theo tên
  toà + phòng; không dùng `crm_sale_action` cho việc này. Giữ phòng không phải đã nhận cọc.

## Gia hạn

- `contract.renew` {`months` hoặc `newEndDate`, `reason`, `noReason`, `keepMoveOutNotice`}: giữ nguyên giá và cọc. Người dùng đã
  nêu lý do ⇒ truyền `reason`; chưa nêu ⇒ hỏi trước, chỉ gửi `noReason` = true khi người dùng nói không có. Người dùng nêu giá /
  cọc mới ⇒ nói ngay "đổi giá khi gia hạn làm trên web; em chỉ gia hạn giữ giá được", không gọi với giá mới. HĐ đang có báo trả ⇒
  hỏi giữ hay huỷ (`keepMoveOutNotice`). Không lùi được: luôn xem trước, lượt xác nhận kèm `consentText`.
- `contract.renew_batch` {`endMonth` YYYY-MM, `months`, `buildingName`, `reason` / `noReason`}: các HĐ hết hạn trong tháng, ≤ 20
  HĐ một lô, một lần đồng ý (lượt xác nhận kèm `consentText`); HĐ có báo trả bị loại (đọc cảnh báo); còn HĐ ⇒ lô sau với
  requestId mới.

## Trả phòng, người ở, nháp

- `contract.return` {`date` (ngày thật, không tương lai), `datePhrase`, `note` (nội dung thanh lý), `forfeit`}: đủ ngày VÀ nội
  dung ⇒ gọi ngay (bản xem trước là bước xác nhận); thiếu ⇒ hỏi một câu gộp, không tự lấy hôm nay, không tự viết note. `forfeit`
  = true chỉ khi người dùng nói rõ bỏ cọc. Không lùi được: lượt xác nhận kèm `consentText`; sau ghi nhắc quyết toán trên web theo
  `nextStep`. `return_date_future` ⇒ hỏi khách đã dọn chưa, chưa ⇒ báo trả.
- `contract.occupant_add` / `contract.occupant_remove` {`customerPhone` (ưu tiên) hoặc `customerName`}: ghi thẳng, đọc lại
  `result.text`; không bớt người đại diện. Khách chưa có trong CRM ⇒ tạo bằng `crm_customer_create` (nếu có) hoặc làm trên web.
- `contract.draft` {`startDate`, `endDate`, `rentPrice`, `deposit`, khách tuỳ chọn}: chỉ là NHÁP, ký trên web, không giữ phòng,
  không thu tiền. Người dùng nói thời hạn "N tháng / N năm" kèm ngày bắt đầu ⇒ `endDate` = `startDate` + N tháng − 1 ngày.

## Không qua bot

Cọc, hoàn cọc, bỏ cọc, quyết toán / thanh lý tiền, hoa hồng: làm trên web (trang Hợp đồng /contracts). Khách trả tiền hoá đơn
thanh lý: `ihome-crm-hoa-don`.

## Đọc hợp đồng

Báo trả: `crm_read_report` report=re_move_out_notices. HĐ hết hạn trong tháng: report=re_contracts_ending. Hồ sơ chờ quyết toán:
report=re_exit_cases_pending. Trả phòng theo kỳ: report=re_terminations. Thiếu cọc: report=held_deposits. Nháp chờ ký:
report=contract_drafts. Một HĐ / phòng: `crm_read_contract_search`, `crm_read_contract_detail`.
