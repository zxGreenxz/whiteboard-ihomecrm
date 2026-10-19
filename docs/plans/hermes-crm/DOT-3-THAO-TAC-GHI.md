# Đợt 3 — Thao tác ghi cho Hermes (ĐỀ XUẤT, chưa chốt)

Đề xuất ngày 19/10/2026 (giờ Việt Nam), **chờ chủ chọn nhóm**; chưa có nhóm nào bắt đầu, chưa có ô nghiệm thu nào đạt. Đây không phải quyết định đã chốt của [PLAN.md](PLAN.md): các ô tương ứng ở PLAN P8.07–P8.13 đều để mở. Trạng thái thực tế ở [STATUS.md](STATUS.md#cập-nhật-1910); hướng dẫn chủ/vận hành ở [BAN-GIAO.md](BAN-GIAO.md).

## 1. Hiện trạng: 11 quyền thao tác

Kết nối Hermes của chủ có 48 quyền Đọc và 11 quyền Thao tác (Toàn tổ chức). Mọi thao tác ghi đi qua quyền CRM thật của người chủ kết nối ∩ quyền Thao tác của kết nối ∩ phạm vi toà ∩ registry; điều kiện nghiệp vụ (trạng thái, thang duyệt) vẫn do backend áp.

| Nhóm | Thao tác Hermes làm được | Ghi chú |
| --- | --- | --- |
| Công việc | Tạo, sửa (tiến độ), xoá (huỷ) | Theo dõi/nhắc hạn đi kèm; mất phản hồi thì đối soát bằng tool `status`, không tự làm lại |
| Khách | Tạo khách (Cư dân), tạo khách hẹn (lead) | Kết nối phải có phạm vi Toàn tổ chức |
| Thu chi | Tạo phiếu thu chi; quyền duyệt | Theo [CONNECTOR.md](../../../infra/hermes-broker/CONNECTOR.md), thang duyệt CRM quyết trạng thái phiếu và quyền duyệt chỉ áp khi người lập có quyền duyệt; chưa có tool duyệt phiếu của người khác hay vào sổ |
| Tin pass phòng | Đăng/sửa tin "Khách nhờ sale" | Chữ công khai (tên, SĐT, chính sách bán) luôn qua xác nhận hai bước |
| Zalo | Gửi Zalo; quản lý tự động hoá Zalo | Gồm gửi ảnh phòng trống (gửi ngay, hẹn, sửa lịch, huỷ lượt chưa chạy) |
| Ghi nhớ | Ghi nhớ công việc (work memory CRM) | Xem/sửa/quên ở Trợ lý của tôi |

Các miền ghi khác (hợp đồng, cọc, hoá đơn, lương/cổ đông, tài sản/dịch vụ…) chủ hoãn từ 16/10; Hermes nói không có công cụ và người dùng làm trực tiếp trên CRM.

## 2. Vì sao cần nền trước: trần `tools/list`

Connector production `b023563a` có 65 tool. `tools/list` đo gần nhất 63.872 B, trần test 64.000 B, tức còn khoảng 130 B (chưa đo lại riêng cho `b023563a`; #217 không thêm tool). Mỗi thao tác ghi thêm theo cách hiện tại là thêm ít nhất một tool, nên đợt 3 không thể mở rộng bằng cách thêm tool riêng cho từng thao tác. Trần 64.000 B giữ nguyên vì chưa kiểm giới hạn kích thước `tools/list` của client MCP Hermes (connector tự cho phép tới 192 KiB cho `tools/list`, #192). Đợt 2 đã giải bài toán tương tự cho phần đọc bằng hai tool meta (`crm_read_report_list`, `crm_read_report`).

## 3. Các nhóm thao tác

| Nhóm | Thao tác | Phụ thuộc / lưu ý |
| --- | --- | --- |
| **3-0 nền** | Hạ tầng chung cho mọi thao tác ghi mới (mục 4) | Bắt buộc trước mọi nhóm |
| **3A** | Thu tiền hoá đơn; chốt chỉ số điện nước | Tiền. Dùng chung bảng hoá đơn với 3B |
| **3B** | Lập, sửa, huỷ hoá đơn; nhận, hoàn, bỏ cọc; giữ chỗ | Tiền. Sau 3A vì cùng bảng hoá đơn |
| **3C** | Hợp đồng: tạo, gia hạn, chuyển phòng, thanh lý, quyết toán | Cần hoá đơn/cọc của 3B |
| **3D** | Tài chính nội bộ: chốt sổ quỹ, bàn giao tiền, chốt/chi lợi nhuận, chi lương, hoa hồng | Nhạy cảm; **cân nhắc có giao Hermes làm không**, chủ quyết |
| **3E** | Phòng/toà/giá; tạm trú CT01; nhập/xuất kho; lệnh Network Center | Nhiều miền nhỏ, độc lập nhau |
| **3-Z** | Tích hợp đợt 3: review độc lập, TEST so web bằng phiên thật, production theo lane | Sau các nhóm đã chọn |

## 4. Nền 3-0 (bắt buộc)

1. **Gom thao tác ghi vào hai tool meta**, ví dụ `crm_action_list` (danh mục thao tác theo quyền hiệu lực, kèm tham số) và `crm_action_run` (chạy một thao tác theo tên). Số tool không tăng theo số thao tác, `tools/list` không vượt trần. Tên chỉ là tạm.
2. **Soạn trước, xác nhận hai bước gắn nội dung.** Lần gọi đầu chỉ soạn và trả bản xem trước kèm mã xác nhận dùng một lần, có hạn, gắn đúng kết nối + thao tác + nội dung; chỉ lần gọi lại kèm mã mới ghi. Mở rộng khuôn đã có cho chữ công khai của tin pass phòng (`confirmation_required` + `confirmToken`) thành khuôn chung.
3. **Idempotency và tra trạng thái khi mất phản hồi.** `requestId` cố định cho mỗi lệnh, bảng biên nhận, tool tra trạng thái; mất phản hồi thì báo "chưa rõ kết quả" và không tự làm lại (như 11 thao tác hiện có).
4. **Khoá quyền thao tác + registry.** Mỗi thao tác một khoá Action trong registry năng lực, mặc định tắt, bật bằng migration riêng sau khi kiểm. Kết nối chỉ thu hẹp nên mỗi nhóm mở ra cần kết nối mới (quy trình ở BAN-GIAO phần 3).
5. **Chỉ nhận lệnh trong chat riêng.** Thao tác ghi không chạy từ nhóm Zalo.
6. **Người thao tác ghi nhận là chủ kết nối.** Audit và dữ liệu ghi nhận người làm là chủ kết nối (actor/connection), không phải một danh tính riêng của Hermes.

## 5. Thứ tự và phụ thuộc

```text
3-0 nền  →  ( 3A  ∥  3D  ∥  3E )  →  3B  →  3C  →  3-Z tích hợp
                 3A ──(cùng bảng hoá đơn)──► 3B ──(hoá đơn, cọc)──► 3C
```

- 3A, 3D, 3E độc lập nhau, làm song song được sau 3-0 (nếu chủ chọn nhóm nào thì chỉ làm nhóm đó).
- 3B chờ 3A vì dùng chung bảng hoá đơn; 3C chờ 3B vì hợp đồng cần hoá đơn và cọc đã có thao tác.
- Mỗi nhóm đi đủ lane: hàm SQL → TEST so web bằng phiên thật → review một lượt → áp production qua `migrate:forward` → deploy connector → (có khoá mới thì promote web cùng lúc, bài học 19/10) → kết nối mới + liên kết Zalo → canary.

## 6. Nguyên tắc

- **Mọi thao tác gọi ĐÚNG hàm SQL mà web đang dùng**, nên quyền và công thức giống web. Theo quy tắc "công thức dùng chung đặt trong database" ([CODEBASE_STRUCTURE](../../CODEBASE_STRUCTURE.md#công-thức-dùng-chung)): chỗ nào web chưa có hàm chung thì tách hàm chung trước, web và Hermes cùng gọi; chuông `check-hermes-web-parity` giữ hai bên không lệch.
- **Không `SECURITY DEFINER` chép policy.** Hàm thao tác chạy bằng quyền và RLS của chính người gọi; helper DEFINER chỉ cho phần kiểm quyền (mô hình INVOKER + RLS đã dùng ở đợt 2).
- Quyền hiệu lực vẫn là quyền CRM thật ∩ quyền Thao tác của kết nối ∩ phạm vi toà ∩ registry; không cấp quyền riêng cho Hermes.
- Thao tác tiền phải qua kiểm đối soát v1/v2, vòng đời và đồng thời của nghiệp vụ (PLAN P8.03).

## 7. Chủ cần chọn

| Câu hỏi | Gợi ý mặc định (chủ đổi được) |
| --- | --- |
| Nhóm nào làm trước? | 3-0 rồi 3A, vì 3A mở đường cho 3B và 3C |
| 3D (lương, lợi nhuận, sổ quỹ, hoa hồng) có giao Hermes không? | Chưa giao cho tới khi chủ nói rõ |
| Nhóm 3E gồm miền nào trước? | Chủ chọn theo nhu cầu |
| Thao tác tiền có luôn đòi xác nhận hai bước không? | Có |

## 8. Chưa xác minh

- Số ~130 B còn lại là suy ra từ số đo gần nhất, chưa đo lại; giới hạn `tools/list` của client MCP Hermes chưa thử thật.
- Chưa khảo sát từng hàm SQL web cho mọi thao tác ở bảng mục 3; danh sách hàm cụ thể làm trong 3-0 và từng nhóm.
- Hai tool meta chưa thiết kế schema và chưa đo độ chính xác khi model gọi (trước đây connector đã phải chịu lỗi tham số model: #176, #179, #180, #181).
- Thao tác "duyệt phiếu" hiện theo mô tả trong CONNECTOR.md; chưa kiểm lại trên production.
