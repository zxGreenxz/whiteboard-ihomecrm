---
name: ihome-crm-thu-chi
description: "Thu chi CRM: lập, sửa, huỷ, duyệt phiếu chi."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official, expenses]
    related_skills: [ihome-crm-ghi-chung, ihome-crm-hoa-don]
---

# Thu chi (trang /income-expense)

Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây. Vòng ghi, xem trước, xác nhận, lỗi: `ihome-crm-ghi-chung`.
Mọi thao tác dưới đây đi qua `crm_action_run`. Tiền ra (chi, mua, trả thợ, đóng cho nhà cung cấp) mới là phiếu chi.

## When to Use

Lập phiếu chi vận hành (mua đồ, sửa chữa, điện nước của toà, vệ sinh…), ghi chú / sửa / huỷ / duyệt phiếu chi, hỏi khoản chi.

## Chặn trước — không gọi tool, chỉ đúng trang web

Phiếu THU (mọi khoản thu, kể cả "lập phiếu thu …"), hoa hồng sale / môi giới, cọc / hoàn cọc / bỏ cọc, lập thanh lý / quyết
toán, trả tiền thừa cho khách, lương / thưởng, phiếu hệ thống, phiếu con định kỳ, mở lại phiếu đã huỷ: trả lời một câu chỉ đúng
trang web. Khách trả tiền hoá đơn (kể cả hoá đơn thanh lý) KHÔNG thuộc nhóm này ⇒ `ihome-crm-hoa-don`.

## Lập phiếu chi — `expense.create`

- `items` 1–5 khoản, mỗi khoản {`buildingName`, `roomName`, `amount`, `content`, `category`, `payee`, `voucherDate`,
  `voucherDatePhrase`, `period`, `cashbook`}; gọi NGAY với những gì người dùng nói, không hỏi hạng mục trước.
- `category`: để trống nếu người dùng không nêu (máy chủ tự suy từ nội dung); không tự điền, không tự đề xuất "Chi khác".
  Máy chủ đưa gợi ý hạng mục ⇒ làm theo `detail` (một gợi ý ⇒ gọi lại ngay với gợi ý đó rồi hỏi đồng ý một lần).
- Chưa rõ chi cho việc gì (chỉ có tiền + toà) ⇒ hỏi "chi cho việc gì?"; thiếu cả toà lẫn việc ⇒ hỏi gộp một câu.
- "lấy tiền sổ X" ⇒ `cashbook` = X (không phải `payee`). "Đóng tiền điện / nước toà X <tiền>" không nêu phòng / khách = phiếu chi
  cho nhà cung cấp; "phòng X ck <tiền>" = khách trả ⇒ `ihome-crm-hoa-don`.
- Đọc nguyên văn từng khoản: `willBe` ("vào sổ ngay" / "chờ duyệt: …"), trần / cam kết của kỳ, `warnings`.

## Ghi chú, sửa, huỷ, duyệt

- `expense.note` {`voucherCode`, `note`, `buildingName` khi mã trùng giữa các toà}: ghi thẳng.
- `expense.edit` {`voucherCode`, trường đổi, `reason` khi đổi tiền / hạng mục / sổ / toà}: chỉ phiếu chi chờ duyệt.
- `expense.cancel` {`voucherCode`, `reason` 8–1000 ký tự — luôn hỏi lý do}: phiếu đã vào sổ ⇒ bút toán đảo, không khôi phục được;
  lượt xác nhận kèm `consentText`.
- `expense.approve` {`voucherCodes` ≤ 10, mỗi mã kèm ngày phiếu dạng "MÃ dd/mm/yyyy", `post` = false nếu chỉ duyệt chưa chi,
  `buildingName`}: duyệt lô theo danh sách vừa đọc ⇒ gửi mã kèm ngày ngay lần đầu, không gửi voucherId / UUID; nhiều hơn 10 ⇒
  làm 10 phiếu đầu, nói số còn lại. Đọc `plan` từng phiếu.

## Đọc thu chi

`crm_read_income_expenses` (không có tham số type; thu / chi xem `summary.byType`). Phiếu chi theo điều kiện (lớn nhất, trên /
dưới X, chờ duyệt quá N ngày, theo toà): `crm_read_report` report=expense_vouchers. Theo hạng mục: report=expense_categories.
Tab Chi phí của Phân tích tài chính: report=top_expenses. Danh sách sổ quỹ: report=cashbooks.
