---
title: "Câu hỏi thường gặp (FAQ)"
description: "Giải đáp các điểm dễ nhầm trong bản hiện hành: duyệt khác ghi sổ, phiếu chờ duyệt và chốt lợi nhuận, cọc, làm tròn, nợ cũ, hoàn tiền, báo cáo legacy, route chuyển hướng và RBAC V3."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: null
status: published
---

# Câu hỏi thường gặp (FAQ)

Trang này trả lời các tình huống dễ bị hiểu sai khi vận hành ptcrm. Nội dung ưu tiên **hành vi của code và cấu trúc dữ liệu hiện hành**, đồng thời nói rõ chỗ nào của ứng dụng vẫn còn dùng nguồn legacy để bạn không lấy một con số chưa canonical làm căn cứ quyết định.

## Phiếu đã duyệt có phải tiền đã vào hoặc ra quỹ chưa?

**Không.** Finance V2 tách bốn trục độc lập:

| Trục | Trả lời câu hỏi |
|---|---|
| `approval_status` | Phiếu đã được phê duyệt workflow chưa? |
| `review_state` | Phiếu chờ duyệt, cần bổ sung hay đang tranh chấp? |
| `posting_mode` | Phiếu có đi qua sổ quỹ hay chỉ là bút toán không tiền? |
| `posting_status` | Posting đã ghi sổ, chưa ghi, đã đảo hay không áp dụng? |

Một phiếu `APPROVED/UNPOSTED` chỉ là **Đã Duyệt - Chưa Thu/Chi**. Chỉ `posting_status=POSTED` mới hiện **Đã Thu** hoặc **Đã Chi** và mới được coi là tiền thật trong sổ. Phiếu `NON_CASH/NOT_APPLICABLE` là **Đã ghi nhận - Không qua sổ**; `REVERSED` là **Đã hoàn tác**.

::: danger Khi đối soát tiền
Không kết luận từ chữ **Đã duyệt**. Hãy mở phiếu, kiểm trạng thái **Đã Thu/Đã Chi**, sổ quỹ, posting và lịch sử hoàn tác. Báo cáo dòng tiền canonical đọc posting line còn hiệu lực, gồm cả dòng `POSTING` và `REVERSAL`.
:::

## Phiếu chờ duyệt có tính vào lợi nhuận không? Vì sao không chốt được tháng?

Có. Báo cáo lợi nhuận hiện **đã tính** phiếu chờ duyệt thuộc kết quả kinh doanh vào tổng và ghi riêng một dòng *"Trong tổng có: n phiếu chờ duyệt (thu … · chi …)"*. Vì vậy số lợi nhuận không nhảy lần nữa khi phiếu được duyệt.

Khi chốt lợi nhuận một tháng của một toà, máy chủ **từ chối** nếu tháng đó (theo ngày phiếu) còn phiếu ở trạng thái chờ duyệt, với thông báo dạng *"Còn N phiếu chờ duyệt trong tháng MM/YYYY của toà …: mã phiếu… — duyệt hoặc huỷ trước khi chốt."* Phiếu **Đã Duyệt - Chưa Chi** không chặn chốt. Xem [Chia lợi nhuận cổ đông](/03-quan-ly-van-hanh/chia-loi-nhuan/) và [Chờ duyệt](/03-quan-ly-van-hanh/cho-duyet/).

## Vì sao cọc không được tính vào doanh thu?

Cọc là khoản đang giữ cho khách, không phải doanh thu vận hành. Nguồn cọc hiện hành nằm ở **hạng mục phiếu thu chi có `is_deposit=true` / accounting class cọc**, gắn với hợp đồng và posting tương ứng. Khi thu chung với hoá đơn, hệ thống vẫn phải tách phần cọc khỏi phần doanh thu.

Trang **Đặt cọc** dùng nguồn canonical này. Riêng báo cáo **Danh sách cọc** hiện vẫn đọc bảng legacy `deposits`; production được đối chiếu ngày 13/08/2026 cho thấy nguồn legacy trả 0 trong khi nguồn canonical còn hơn 1,288 tỷ đồng cọc active. Vì vậy không dùng tổng ở báo cáo legacy để kết luận công ty không giữ cọc. Xem [Danh sách cọc](/04-bao-cao/danh-sach-coc/) để biết giới hạn hiện tại.

## Cọc còn thiếu khi ký hợp đồng được xử lý thế nào?

Contract V2 hỗ trợ đúng hai cách:

1. **Nợ cọc (`DEBT`)** — bắt buộc nhập **lý do** và **hạn bổ sung**.
2. **Thu ở hoá đơn đầu (`FIRST_INVOICE`)** — hoá đơn đầu phải có đúng dòng cọc tương ứng phần thiếu; phần này được theo dõi là cọc, không được lọt vào doanh thu.

Cọc thiếu không còn được tự đẩy vào “nợ cũ” của hoá đơn doanh thu. Nó được theo dõi riêng trên hợp đồng và luồng cọc.

## Ba chỗ làm tròn tiền có giống nhau không?

**Không.** Đây là ba cơ chế khác nhau:

| Ngữ cảnh | Quy tắc hiện hành |
|---|---|
| Tổng hoá đơn | Lấy 3 chữ số cuối: `< 900đ` làm tròn **xuống**, `>= 900đ` làm tròn **lên** bội 1.000. Ví dụ `1.299.500 → 1.299.000`, `1.299.900 → 1.300.000`. |
| Khi thu tiền | Phần còn thiếu dương `< 10.000đ` có thể được ghi nhận là làm tròn để khép hoá đơn, nhưng **không được bỏ qua phần cọc còn thiếu**. |
| Khi kéo nợ cũ | Residual của hoá đơn cũ `< 10.000đ` bị loại khỏi carry-over; cọc thiếu không được cộng vào nợ cũ. |

Vì vậy câu “mọi phần lẻ dưới 1.000đ đều làm tròn lên” là sai.

## Nợ kỳ trước có tự cộng vào hoá đơn mới không?

Có, nhưng hệ thống chỉ lấy các hoá đơn cũ còn residual đủ ngưỡng, tránh cộng trùng nguồn đã carry-over. Các residual dưới 10.000đ không được kéo sang. **Cọc còn thiếu được theo dõi riêng**, không còn nhập chung vào nợ doanh thu.

Các route báo cáo công nợ cũ `/reports/finance/new-contract-debt`, `/reports/finance/debt` và `/reports/finance/customer-debt` hiện đều chuyển hướng về `/thu-tien`. Hãy dùng màn **Thu tiền** để xem số còn phải thu và xử lý thanh toán.

## Hoàn tiền hoá đơn có chi tiền ngay không?

**Không ở bước tạo nghĩa vụ hiện tại.** Core tạo phiếu hoàn ở trạng thái `UNAPPROVED/UNPOSTED`, chưa gán sổ (`account_id=NULL`). Nó chưa phải tiền đã chi. Chỉ khi phiếu được duyệt đúng workflow, gán sổ và posting thành `POSTED` thì mới là **Đã Chi**.

::: warning Kiểm phiếu thật sau khi lập yêu cầu hoàn
Hộp hoàn tiền trên hoá đơn tự ghi rõ: *"Đây là bước lập yêu cầu hoàn tiền. Chưa thực hiện chi; kiểm tra sổ quỹ khi duyệt và chi phiếu."* Sau khi tạo yêu cầu, mở phiếu trong [Thu chi](/03-quan-ly-van-hanh/thu-chi/) và kiểm trạng thái; không suy "đã lập yêu cầu" là tiền đã ra quỹ.
:::

Hoàn **cọc** khi thanh lý hợp đồng đi theo luồng riêng — xem [Hoàn / bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/).

## Báo cáo Tiền thừa có phải số dư credit khách hàng chính xác không?

Chưa. Báo cáo hiện tính `paid_amount - total_amount` trên hoá đơn. Nguồn authoritative của credit còn lại là `customer_credit_lots.remaining_amount`, vì credit có thể đã được áp dụng hoặc hoàn ở bước khác. Dùng báo cáo hiện tại như **chỉ báo reconciliation theo hoá đơn**, không dùng nó làm số dư nghĩa vụ cuối cùng với khách. Xem [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) và tab **Tiền thừa** trong [Trung tâm báo cáo tài chính](/04-bao-cao/hub-tai-chinh/).

## Vì sao phòng chuyển sang Đã cọc/Giữ chỗ dù phiếu chưa duyệt?

Trạng thái giữ phòng là một quy tắc vận hành khác với trạng thái tiền. Khi có phiếu giữ chỗ chưa huỷ, phòng có thể chuyển `RESERVED` và bị loại khỏi danh sách phòng trống trước khi phiếu tiền được duyệt/post. Khi huỷ hoặc chuyển cọc vào hợp đồng, trạng thái phòng được tính lại. **Giữ phòng không chứng minh tiền đã vào sổ.**

## Hợp đồng gia hạn sao vẫn là ACTIVE?

Gia hạn hiện sửa tiếp hợp đồng đang hiệu lực; hợp đồng vẫn `ACTIVE`, còn dấu “đã gia hạn” đến từ lịch sử gia hạn. `EXTENDED` là mã legacy, không phải trạng thái mới cần chọn.

## Khi không thấy một nút hoặc trang, kiểm gì trước?

Kiểm lần lượt:

1. Membership của tài khoản có active trong đúng tổ chức không.
2. Tài khoản đang mang vai trò nào.
3. Role binding có scope đúng organization/khu vực/toà/sổ không.
4. Có override `DENY` hay không — `DENY` thắng `ALLOW`.
5. Tính năng có bị cờ phát hành tắt không. Ví dụ [Trung tâm mạng](/03-quan-ly-van-hanh/trung-tam-mang/) chỉ có route khi bản build bật chế độ `production`/`demo` (bản production hiện bật), và mỗi toà còn có chế độ riêng **Đã tắt / Chỉ đọc / Được thực thi** — có quyền chưa chắc thao tác được.

Route quản trị thành viên hiện hành là `/settings/members`; `/settings/staff` chỉ chuyển hướng. Xem [Bảng tra quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/).

## Vì sao sửa vai trò lại ảnh hưởng nhiều người?

RBAC V3 dùng vai trò thật trong `organization_roles`, không còn là “mẫu chỉ sao chép một lần”. Khi sửa một vai trò tự tạo, quyền của **mọi người đang mang vai trò đó đổi ngay**; màn hình hiển thị số người bị ảnh hưởng trước khi lưu. Vai trò hệ thống chỉ đọc, có thể nhân bản thành vai trò mới để chỉnh.

## Trang Lịch sử cập nhật có phải release log đầy đủ không?

Không. Liên kết **Lịch sử** ở chân menu mở `/changelog` (*Lịch sử cập nhật*), hiện chỉ là một danh sách tĩnh gồm ba mục v0.8.0–v1.0.0 năm 2024–2025. Nó không tự đồng bộ commit, migration hay deployment và không phải nguồn phát hành chính thức. Dùng [Ghi chú phiên bản](/07-thong-tin-khac/ghi-chu-phien-ban/) để xem các thay đổi gần đây.

Tương tự, hai liên kết **FAQ** (`/faq`, *Câu hỏi thường gặp* — 10 câu hỏi cơ bản) và **Hướng dẫn App** (`/app-guide`, nói về ứng dụng di động Resident) ở chân menu là nội dung tĩnh cũ trong app. Tài liệu đầy đủ và cập nhật là site hướng dẫn này.

## "Hôm nay" và "Việc của tôi" trên điện thoại khác nhau thế nào?

- Ô **Hôm nay** (`/my-day`) là màn ngày công: toà nên ghé, kiểm tra nhà, việc đang làm được giao và chuyên cần tháng — dữ liệu nằm trên hệ thống. Xem [Hôm nay — ngày công & việc trong ngày](/02-theo-doi-nhanh/viec-cua-toi/).
- Ô **Việc của tôi** (`/viec-cua-toi`) là sổ ghi việc cá nhân, **chỉ lưu trên điện thoại đang dùng**, không đồng bộ và không giao được cho người khác. Xem [Việc của tôi (việc cá nhân)](/02-theo-doi-nhanh/viec-ca-nhan/).
- Công việc vận hành giao cho nhân viên nằm ở [Công việc](/03-quan-ly-van-hanh/cong-viec/).

## Tôi nên làm gì khi nghi giao dịch tiền bị lỗi?

1. Dừng bấm lại để tránh yêu cầu trùng.
2. Ghi lại URL, thời điểm, người thao tác, toà/phòng/hợp đồng/hoá đơn liên quan.
3. Kiểm phiếu theo mã/id ở **Thu chi**, kiểm `posting_status`, sổ quỹ và lịch sử reversal.
4. Kiểm **Sổ quỹ** hoặc báo cáo dựa trên posting; không chỉ nhìn badge duyệt.
5. Gửi báo lỗi theo mẫu tại [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/), không gửi mật khẩu hay dữ liệu nhạy cảm không cần thiết.

## Quy trình liên quan

- [Thuật ngữ & bảng trạng thái](/07-thong-tin-khac/thuat-ngu/)
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/)
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/)
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/)
- [Danh sách cọc](/04-bao-cao/danh-sach-coc/)
- [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/)
