---
title: "Ghi chú phiên bản"
description: "Những thay đổi chính của ứng dụng từ 14/08 đến 07/10/2026, cách xác định tài liệu khớp bản hiện hành và giới hạn của trang /changelog."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Ghi chú phiên bản

Bộ hướng dẫn này được rà soát theo code, route, catalog quyền và database production hiện hành tại thời điểm ghi trong `captured.date`. Ngày này là **mốc đối chiếu tài liệu**, không phải số phiên bản sản phẩm. Mỗi trang có `captured.date` riêng; trang nào ghi ngày cũ hơn là trang chưa được chụp lại ở lần đồng bộ gần nhất.

## Đợt đồng bộ 07/10/2026

Toàn bộ site được đối chiếu lại với bản production `81c5a3cd` (phát hành 06/10/2026) và chụp lại ảnh thao tác trên tổ chức **DEMO** (dữ liệu giả, chỉ xem — không lưu, không duyệt, không ghi sổ). Lần đồng bộ trước là 13–14/08/2026. Những thay đổi chính người dùng sẽ thấy trong khoảng này:

| Mảng | Thay đổi chính (14/08 → 07/10/2026) | Đọc ở trang |
|---|---|---|
| Báo chi nhanh | Trang `/chi-tieu`: gõ, nói hoặc chụp bill để tạo thẻ nháp phiếu chi; tự nhận toà/phòng đọc bằng lời và tự chọn hạng mục theo **danh mục chi chuẩn**; có ô Báo chi nhanh trên màn hình chính điện thoại. | [Báo chi nhanh](/03-quan-ly-van-hanh/bao-chi-nhanh/) |
| Ví cá nhân | Ví riêng theo chủ sở hữu, sổ thu chi cá nhân, báo cáo và bốn nút nhập nhanh trên điện thoại. | [Ví cá nhân](/03-quan-ly-van-hanh/vi-ca-nhan/) |
| Phiếu thu chi | Sửa phiếu **chờ duyệt** có lưu vết, duyệt kèm phiên bản, sổ nhận tiền theo hình thức thu, đổi hình thức thu; chi tiết phiếu mở ngay từ dòng danh sách; ảnh chứng từ tải chịu được mạng chập chờn; bộ máy **chi theo cam kết** bật từ 27/09. | [Thu chi](/03-quan-ly-van-hanh/thu-chi/), [Chờ duyệt](/03-quan-ly-van-hanh/cho-duyet/) |
| Sổ quỹ & lợi nhuận | Chốt lợi nhuận theo từng nhà; khoá tháng tuyệt đối và chặn chốt khi còn phiếu chờ duyệt; phiếu thu của hoá đơn tháng đã chốt cũng bị khoá sửa/huỷ. | [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/), [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/) |
| Hợp đồng | Màn chi tiết hợp đồng desktop một trang; bản nháp hợp đồng và ký; luồng trả phòng bắt buộc ghi chú và hiện trên phiếu hoàn; lịch hỗ trợ tiền thuê; in CT01 + hợp đồng lưu trú. | [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/), [Chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) |
| Cọc & thanh lý | Xử lý cọc giữ chỗ theo mẫu, hạn bổ sung cọc, ảnh + sổ quỹ trên phiếu cọc; mục "Hoàn lại khách" khi thanh lý; bỏ hẳn đường hoàn khách thứ hai. | [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/), [Thanh lý](/03-quan-ly-van-hanh/thanh-ly-move-out/) |
| Hoá đơn | Một bộ nhập liệu chung cho sửa hoá đơn nháp và tạo hoá đơn lẻ; ô Nợ cũ do máy tính; luồng điều chỉnh hoá đơn đã duyệt/đã thanh toán có duyệt; chỉ còn nút **Huỷ** (không xoá). | [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/), [Chi tiết hoá đơn](/03-quan-ly-van-hanh/hoa-don-chi-tiet/) |
| Khách hàng & tạm trú | Quét CCCD bằng camera, địa chỉ hành chính mới; hồ sơ tạm trú, tải CT01 theo mẫu Word, tiện ích điền sẵn Cổng DVC. | [Cư dân](/03-quan-ly-van-hanh/cu-dan/), [Đăng ký tạm trú DVC](/03-quan-ly-van-hanh/dang-ky-tam-tru-dvc/) |
| Lương | Màn Lương & thu nhập mới, khoản định kỳ theo phiên bản, hoa hồng tính theo sổ. | [Bảng lương](/03-quan-ly-van-hanh/bang-luong/) |
| Tài khoản | Ghi nhớ công ty đã chọn theo tài khoản; khi đăng xuất hoặc đổi tài khoản, trình duyệt xoá trạng thái của tài khoản trước. | [Đăng nhập](/01-bat-dau/dang-nhap/) |
| Giao diện | Lúc chờ dữ liệu hiện khối xám thay cho chữ "Đang tải…"; quyền giao diện tính theo công ty và toà nhà. | [Làm quen giao diện](/01-bat-dau/lam-quen-giao-dien/) |
| Tạm ngưng | Chat Zalo tự động và trợ lý AI Copilot đang **tạm ngưng**; các trang liên quan chỉ mô tả trạng thái hiện hành. | [Chat Zalo](/03-quan-ly-van-hanh/chat-zalo/), [Trợ lý AI](/05-cai-dat/tro-ly-ai/) |

## Nguồn nào đáng tin khi có khác biệt?

Ưu tiên theo thứ tự:

1. Hành vi đang chạy và route trong code hiện hành.
2. Contract/schema, catalog và inventory đo từ database production.
3. Quyền/RLS/RPC đang kiểm ở server.
4. Markdown hướng dẫn và ảnh minh hoạ.
5. Trang `/changelog` trong ứng dụng.

Tài liệu phải được sửa khi lệch các nguồn phía trên; không dùng một ảnh cũ hoặc một dòng changelog để phủ nhận hành vi và dữ liệu đang chạy.

## Giới hạn của `/changelog`

Trang **Lịch sử cập nhật** hiện render một mảng tĩnh nằm trong source `ChangelogPage.tsx`, gồm ba mục:

| Phiên bản hiển thị | Ngày trong mảng tĩnh |
|---|---|
| `v1.0.0` | 15/01/2025 |
| `v0.9.0` | 01/12/2024 |
| `v0.8.0` | 01/11/2024 |

Trang này **không tự đọc commit, migration, deployment, Vercel hay database**, nên không phải release log authoritative và không phản ánh đầy đủ các thay đổi năm 2026. Nội dung tĩnh còn nhắc những cấu trúc cũ như `SUMMARY.md`; hãy xem nó như lịch sử giao diện được đóng gói trong build, không phải bằng chứng về trạng thái hiện tại.

::: warning Không lấy `/changelog` làm mốc “bản mới nhất”
Việc mục trên cùng ghi `v1.0.0 — 15/01/2025` không có nghĩa hệ thống production đang dừng ở bản đó. Khi cần điều tra một thay đổi nghiệp vụ, dùng route/code/schema và lịch sử triển khai nội bộ, rồi đối chiếu tài liệu có `captured.date` mới hơn.
:::

## Cách nhận biết một trang hướng dẫn đã cũ

- Route trong bài tự chuyển sang một route khác, ví dụ `/settings/staff → /settings/members`.
- Bài nói **Đã duyệt** là tiền thật, trong khi Finance V2 yêu cầu `posting_status=POSTED`.
- Bài mô tả báo cáo cọc từ bảng `deposits` như số cọc authoritative, dù nguồn canonical là hạng mục cọc của `income_expenses`.
- Bài mô tả báo cáo Tiền thừa như credit còn lại, dù credit authoritative nằm trong `customer_credit_lots.remaining_amount`.
- Bài suy trạng thái Network Center chỉ từ mặc định code. Runtime phải đối chiếu đúng deployment.
- Bài coi khu **08 — Kế hoạch phát triển** là tính năng đã phát hành.

Khi gặp một trong các dấu hiệu này, ưu tiên trang hướng dẫn mới có cảnh báo rõ và báo lại theo [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/).

## Phân biệt ba loại nội dung trên site docs

| Loại | Có thể dùng để thao tác production? | Cách nhận biết |
|---|---|---|
| **Hướng dẫn hiện hành** | Có, sau khi kiểm quyền và điều kiện nghiệp vụ. | Nằm trong các nhóm bắt đầu, vận hành, báo cáo, cài đặt, tài khoản; mô tả route và trạng thái hiện hành. |
| **Cảnh báo giới hạn hiện tại** | Có, để tránh tin sai một bề mặt chưa canonical. | Nêu rõ nguồn legacy, route redirect, runtime-off hoặc khoảng trống verification. |
| **Kế hoạch/đề xuất** | Không tự dùng làm chỉ dẫn production. | Nằm ở khu `08-ke-hoach-phat-trien`; phải có banner proposal và chỉ trở thành runtime khi được triển khai/kiểm chứng. |

## Cách báo một sai lệch tài liệu

Gửi đủ:

- URL của trang docs và URL màn hình app.
- Tên mục/câu đang sai.
- Ảnh hoặc video ngắn thể hiện hành vi thật.
- Vai trò, tổ chức/toà và thời điểm kiểm tra.
- Nếu liên quan tiền: id hoá đơn/phiếu, trạng thái phê duyệt, trạng thái posting và sổ quỹ — không gửi mật khẩu.

## Xem trang lịch sử tĩnh trong sandbox

<SandboxTry account="demo.chunha" app-path="/changelog" app-label="Mở Lịch sử cập nhật" view-only>

Bạn có thể mở `/changelog` để xem ba mục tĩnh kể trên. Kết quả mong đợi là hiểu đây là nội dung của build, **không phải danh sách đầy đủ mọi lần phát hành**.

</SandboxTry>

## Quy trình liên quan

- [Giới thiệu hệ thống](/01-bat-dau/gioi-thieu/)
- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/)
- [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/)
- [Kế hoạch phát triển](/08-ke-hoach-phat-trien/)
