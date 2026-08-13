---
title: "Kênh hỗ trợ"
description: "Quy trình tự kiểm tra và báo lỗi có đủ route, id, trạng thái posting, sổ quỹ, quyền và dữ liệu tái hiện — không bịa thông tin liên hệ."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Kênh hỗ trợ

Repo hiện không công bố một số điện thoại, email hay endpoint hỗ trợ cố định để tài liệu có thể dẫn chính xác. Vì vậy hãy dùng **kênh hỗ trợ nội bộ/nhà cung cấp đã được đơn vị bạn thống nhất**, và gửi một bộ bằng chứng đủ để người xử lý đi thẳng vào đúng route, dữ liệu và thời điểm.

## Phân loại trước khi gửi

| Nhóm | Dấu hiệu | Người xử lý đầu tiên |
|---|---|---|
| **Quyền/phạm vi** | Không thấy trang/nút/toà/sổ; người khác thấy nhưng tài khoản bạn không thấy. | Chủ tổ chức hoặc người quản trị vai trò/thành viên. |
| **Dữ liệu nghiệp vụ** | Chỉ một hợp đồng/hoá đơn/phòng có vấn đề; sandbox hoặc dữ liệu khác chạy đúng. | Quản lý nghiệp vụ/kế toán để kiểm lịch sử và nguồn dữ liệu. |
| **Lỗi giao diện/runtime** | Trang trắng, lỗi đỏ, thao tác không phản hồi, console/network lỗi. | Nhóm kỹ thuật/nhà cung cấp phần mềm. |
| **Sai lệch tiền** | Số dư, posting, reversal, hoàn tiền, bàn giao hoặc báo cáo không khớp. | Kế toán + quản trị sổ trước; chuyển kỹ thuật kèm bằng chứng đầy đủ. |
| **Sai tài liệu** | Route, nhãn, quyền hoặc bước trong docs khác app/code hiện hành. | Nhóm duy trì tài liệu, kèm cả URL docs và URL app. |

## Tự kiểm tra an toàn

### Nếu không thấy trang hoặc nút

1. Sao chép URL hiện tại.
2. Kiểm tài khoản có membership active trong đúng tổ chức.
3. Kiểm vai trò, role binding, scope và override `DENY` ở `/settings/members`.
4. Đối chiếu key tại [Bảng tra quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/).
5. Kiểm route có phải đường cũ đã redirect không; ví dụ `/settings/staff` đã chuyển sang `/settings/members`.
6. Với OpenClaw/Network Center, kiểm runtime flag của đúng deployment; có quyền nhưng runtime `off` thì route vẫn không xuất hiện. Production ngày 13/08/2026 đang hiển thị OpenClaw Zalo.

### Nếu số tiền không khớp

1. **Dừng thao tác lặp lại.** Không bấm Thu/Chi/Hoàn/Bàn giao nhiều lần để “thử”.
2. Ghi id hoá đơn, payment, phiếu thu chi, hợp đồng, termination hoặc phiên bàn giao liên quan.
3. Kiểm bốn trục của phiếu: `approval_status`, `review_state`, `posting_mode`, `posting_status`.
4. Xác định sổ quỹ và người giữ sổ; kiểm có posting `POSTED` hay reversal `REVERSED`.
5. Đối chiếu Sổ quỹ/Dòng tiền dựa trên posting. **Không chỉ nhìn chữ Đã duyệt.**
6. Nếu là hoàn tiền hoá đơn, nhớ rằng bước tạo nghĩa vụ hiện tại có thể chỉ tạo `UNAPPROVED/UNPOSTED`, chưa gán sổ và chưa phải tiền đã chi.
7. Nếu là cọc hoặc tiền thừa, kiểm cảnh báo nguồn dữ liệu: báo cáo cọc và tiền thừa hiện chưa phải nguồn canonical cuối cùng.

::: danger Không “F5 rồi bấm lại” với giao dịch tiền
Tải lại trang có thể hữu ích cho lỗi hiển thị, nhưng không phải cách xác định giao dịch đã ghi hay chưa. Trước khi thử lại, phải kiểm id giao dịch, posting, sổ quỹ và lịch sử idempotency/reversal. Nếu chưa xác định được, dừng và báo lỗi.
:::

## Một báo lỗi đầy đủ cần gì?

- **Tiêu đề ngắn:** chức năng + triệu chứng, ví dụ “Thu tiền HĐ 2026-08/B101 tạo nghĩa vụ nhưng chưa vào sổ”.
- **URL đầy đủ:** cả route app và route docs nếu báo sai tài liệu.
- **Môi trường:** production hay sandbox; trình duyệt, thiết bị, thời điểm và múi giờ.
- **Tài khoản nghiệp vụ:** vai trò, organization, toà và scope liên quan; không gửi mật khẩu/token.
- **Đối tượng:** id và mã dễ đọc của phòng, khách, hợp đồng, hoá đơn, phiếu, sổ hoặc phiên bàn giao.
- **Các bước tái hiện:** đánh số, bắt đầu từ màn hình nào, bấm gì, nhập gì.
- **Kết quả mong đợi / thực tế:** viết riêng hai dòng.
- **Ảnh/video:** chụp cả thông báo và URL; che CCCD, số điện thoại, tài khoản ngân hàng nếu không cần cho việc xử lý.
- **Bằng chứng tài chính:** bốn trạng thái phiếu, sổ quỹ, số tiền, posting/reversal và lịch sử liên quan.
- **Console/Network:** chỉ gửi khi biết cách lấy; không dán secret, cookie, authorization header hoặc toàn bộ response chứa PII.

### Mẫu báo lỗi

```text
Tiêu đề:
Môi trường + thời điểm:
URL app:
URL tài liệu (nếu có):
Vai trò / tổ chức / toà:
Đối tượng và id:

Các bước:
1.
2.
3.

Mong đợi:
Thực tế:

Trạng thái tài chính (nếu có):
- approval_status:
- review_state:
- posting_mode:
- posting_status:
- sổ quỹ / posting hoặc reversal liên quan:

Đính kèm:
```

## Tái hiện trên sandbox

Chỉ tái hiện trên sandbox nếu thao tác an toàn và dữ liệu demo cho phép. Nếu lỗi liên quan tiền:

1. Ghi lại trạng thái ban đầu và id đối tượng.
2. Thực hiện **một lần** theo đúng bước.
3. Kiểm phiếu và sổ sau thao tác, không chỉ toast.
4. Thu thập ảnh/URL/id rồi dừng.
5. Reset sandbox theo hướng dẫn của môi trường demo nếu bạn đã tạo dữ liệu.

Không thử một lỗi production bằng cách ghi vào tổ chức thật chỉ để lấy bằng chứng.

## Không gửi những gì

- Mật khẩu, OTP, access token, refresh token, cookie hoặc service key.
- Toàn bộ file cấu hình môi trường.
- Ảnh chứa PII không liên quan.
- Câu “hệ thống lỗi” không có URL, thời điểm và bước tái hiện.
- Kết luận “đã mất tiền” chỉ dựa trên badge **Đã duyệt** mà chưa kiểm posting/sổ.

## Quy trình liên quan

- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/)
- [Thuật ngữ & bảng trạng thái](/07-thong-tin-khac/thuat-ngu/)
- [Bảng tra quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/)
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/)
- [Ghi chú phiên bản](/07-thong-tin-khac/ghi-chu-phien-ban/)
