---
title: "Thuật ngữ & bảng trạng thái"
description: "Từ điển trạng thái hiện hành cho hợp đồng, phòng, hoá đơn, cọc và Finance V2; phân biệt phê duyệt, review, ghi sổ và bút toán không tiền."
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

# Thuật ngữ & bảng trạng thái

Đây là từ điển tra cứu cho các mã và nhãn đang dùng trong ptcrm. Điểm quan trọng nhất của bản hiện hành là **không gom mọi trạng thái tài chính vào một chữ “Đã duyệt”**: phê duyệt và ghi sổ là hai việc độc lập.

::: tip Cách đọc
- **Mã hệ thống** là giá trị lưu hoặc truyền giữa các lớp; nhãn tiếng Việt là cách UI diễn giải.
- Một đối tượng có thể có nhiều trục trạng thái đồng thời. Ví dụ phiếu thu có thể `APPROVED` nhưng `UNPOSTED`.
- Khi kiểm tiền thật, ưu tiên `posting_status`, posting line, sổ quỹ và reversal; không suy từ `approval_status`.
:::

## Finance V2: bốn trục trạng thái phiếu thu chi

| Trục | Giá trị chính | Ý nghĩa |
|---|---|---|
| Phê duyệt | `approval_status`: `UNAPPROVED`, `APPROVED`, `CANCELLED` | Quyết định workflow; **không tự chứng minh tiền đã ghi sổ**. |
| Review | `review_state`: `PENDING`, `CHANGES_REQUESTED`, `DISPUTED`, `RESOLVED` | Substate trong quá trình xem xét phiếu chưa hoàn tất. |
| Cách hạch toán | `posting_mode`: `CASHBOOK`, `NON_CASH` | Phiếu cần đi qua sổ quỹ hay chỉ ghi nhận nghiệp vụ không tiền. |
| Ghi sổ | `posting_status`: `UNPOSTED`, `POSTED`, `REVERSED`, `NOT_APPLICABLE` | Trạng thái posting; đây là trục quyết định tiền thật. |

### Nhãn phiếu canonical

| Điều kiện | Nhãn hiển thị | Có phải tiền thật đang hiệu lực? |
|---|---|---|
| `UNAPPROVED` + `PENDING` + `UNPOSTED` | **Chờ duyệt** | Không |
| `UNAPPROVED` + `CHANGES_REQUESTED` | **Cần bổ sung** | Không |
| `UNAPPROVED` + `DISPUTED` | **Đang tranh chấp** | Không |
| `APPROVED` + `UNPOSTED`, phiếu thu | **Đã Duyệt - Chưa Thu** | Không |
| `APPROVED` + `UNPOSTED`, phiếu chi | **Đã Duyệt - Chưa Chi** | Không |
| `APPROVED` + `NON_CASH/NOT_APPLICABLE` | **Đã ghi nhận - Không qua sổ** | Không |
| `posting_status=POSTED`, phiếu thu | **Đã Thu** | Có |
| `posting_status=POSTED`, phiếu chi | **Đã Chi** | Có |
| `posting_status=REVERSED` | **Đã hoàn tác** | Posting gốc đã bị đảo; đọc cả cặp posting/reversal |
| `approval_status=CANCELLED` | **Đã hủy** | Không |

Nếu phiếu đã duyệt nhưng chưa được gán đúng sổ, UI có thể thêm hậu tố **· Chờ phân sổ**. “Duyệt và Thu/Chi” là thao tác gộp hai bước trong cùng transaction khi người thao tác vừa có quyền duyệt vừa là người giữ sổ; bản chất hai quyết định vẫn tách biệt.

::: danger Bất biến về tiền
Chỉ `posting_status=POSTED` mới làm `isCash=true`. Báo cáo dòng tiền phải đọc posting line còn hiệu lực, kể cả line `POSTING` và `REVERSAL`, thay vì cộng mọi phiếu `APPROVED`.
:::

## Trạng thái hợp đồng

| Nhãn | Mã | Ý nghĩa |
|---|---|---|
| **Nháp** | `DRAFT` | Hợp đồng đang soạn, chưa có hiệu lực. |
| **Còn hạn / Đang ở** | `ACTIVE` | Hợp đồng đang hiệu lực. Hợp đồng đã gia hạn vẫn giữ mã này. |
| *(legacy)* | `EXTENDED` | Không còn là trạng thái ghi mới; dấu đã gia hạn được suy từ lịch sử. |
| **Đã chuyển nhượng** | `TRANSFERRED` | Hợp đồng đã được chuyển theo luồng chuyển nhượng/chuyển phòng. |
| **Đã thanh lý** | `TERMINATED` | Hợp đồng đã kết thúc qua luồng thanh lý. |
| **Hết hạn** | `EXPIRED` | Đã qua ngày kết thúc mà không được gia hạn. |

### Xử lý thiếu cọc khi tạo hợp đồng V2

| Mã | Nghĩa |
|---|---|
| `DEBT` | Cho phép nợ cọc; bắt buộc có lý do và hạn bổ sung. |
| `FIRST_INVOICE` | Đưa đúng phần cọc thiếu vào hoá đơn đầu dưới dòng cọc riêng. |

Phần cọc thiếu không được nhập chung vào “nợ cũ” của hoá đơn doanh thu.

## Trạng thái phòng

| Nhãn | Mã | Ý nghĩa |
|---|---|---|
| **Trống** | `AVAILABLE` | Sẵn sàng cho thuê. |
| **Đang thuê** | `OCCUPIED` | Có hợp đồng còn hiệu lực. |
| **Đã cọc / Giữ chỗ** | `RESERVED` | Có giữ chỗ chưa huỷ; phòng bị loại khỏi nguồn phòng trống. Trạng thái này không chứng minh tiền đã POSTED. |
| **Bảo trì** | `MAINTENANCE` | Tạm dừng khai thác để sửa chữa. |
| **Không khai thác** | `UNAVAILABLE` | Chủ động không cho thuê. |

`AVAILABLE ⇄ OCCUPIED` và `AVAILABLE ⇄ RESERVED` phần lớn được hệ thống tính theo hợp đồng/cọc. Chỉ đặt tay trạng thái vận hành như bảo trì hoặc không khai thác khi luồng màn hình cho phép.

Trên [Sơ đồ toà nhà](/02-theo-doi-nhanh/so-do-toa-nha/) có thêm nhãn hiển thị **Sắp trống** (hợp đồng còn hiệu lực nhưng chỉ còn 1–30 ngày) — đây không phải mã lưu trong dữ liệu. `MAINTENANCE` hiện thành **Ngừng hoạt động**; căn `UNAVAILABLE` không hợp đồng hiện như **Trống** trên sơ đồ.

## Trạng thái hoá đơn

| Nhãn | Mã | Ý nghĩa |
|---|---|---|
| **Nháp** | `DRAFT` | Đang soạn. |
| **Chờ duyệt** | `PENDING_APPROVAL` | Chờ phát hành/duyệt theo luồng hoá đơn. |
| **Đã duyệt** | `APPROVED` | Hoá đơn đã phát hành và còn phải thu. |
| **Đã thanh toán** | `PAID` | Số được ghi nhận thanh toán đã phủ đủ tổng phải thu. |
| **Thu một phần** | `PARTIAL_PAID` | Đã thu một phần, còn residual. |
| **Quá hạn** | `OVERDUE` | Qua hạn và chưa thu đủ. |
| **Đã huỷ** | `CANCELLED` | Hoá đơn bị huỷ. |

Trạng thái hoá đơn và trạng thái phiếu thu là hai lớp khác nhau. Khi điều tra sai lệch, đi từ hoá đơn sang danh sách payment/voucher rồi kiểm posting của từng phiếu.

## Trạng thái cọc giữ chỗ

| Nhãn | Mã | Ý nghĩa vận hành |
|---|---|---|
| **Chờ xác nhận** | `PENDING` | Phiếu giữ chỗ mới tạo. |
| **Đã xác nhận** | `CONFIRMED` | Phiếu được xác nhận theo lifecycle cọc. |
| **Đã lên hợp đồng** | `CONVERTED` | Cọc đã được liên kết/chuyển vào hợp đồng. |
| **Đã hoàn cọc** | `REFUNDED` | Lifecycle đánh dấu đã hoàn. |
| **Đã bỏ cọc** | `FORFEITED` | Lifecycle đánh dấu khách mất cọc. |

Các nhãn này không phải nguồn authoritative cho số tiền cọc còn giữ. Số cọc canonical phải truy từ các hạng mục cọc trên `income_expenses`, trạng thái posting, liên kết hợp đồng và các bút toán hoàn/bỏ tương ứng. Báo cáo Danh sách cọc hiện vẫn đọc bảng `deposits` legacy nên có thể khác nguồn canonical.

## Hình thức thanh toán

| Mã | Nghĩa | Tác động sổ |
|---|---|---|
| `TM` | Tiền mặt | Đi qua sổ tiền mặt phù hợp. |
| `TK` | Chuyển khoản/tài khoản | Đi qua sổ ngân hàng/tài khoản phù hợp. |
| `TT` | Hình thức thanh toán khác được hệ thống hỗ trợ | Phải kiểm sổ được chọn và posting. |
| `CT` | Cấn trừ/gạch nợ | Thường là bút toán không tiền; không được hiểu là tiền mặt vào/ra. |

## Thuật ngữ nghiệp vụ

| Thuật ngữ | Định nghĩa hiện hành |
|---|---|
| **Posting / ghi sổ** | Sự kiện đưa phiếu vào một sổ quỹ. Posting `POSTED` là nguồn tiền thật; reversal đảo tác động thay vì xoá lịch sử. |
| **Approval / phê duyệt** | Quyết định chấp nhận phiếu về workflow. Approval không tự ghi tiền. |
| **Người giữ sổ (custodian)** | Người có quyền thực hiện posting trên sổ được giao; khác với người lập và người duyệt. |
| **Bút toán không tiền** | Phiếu `NON_CASH/NOT_APPLICABLE`, dùng ghi nhận nghiệp vụ như cấn trừ nhưng không làm tăng/giảm số dư sổ tiền thật. |
| **KQKD** | Kết quả kinh doanh/lãi lỗ; phân loại doanh thu và chi phí theo hạng mục, loại cọc và các khoản được đánh dấu không vào KQKD. |
| **Dòng tiền** | Tổng tiền vào/ra theo posting. Có thể khác KQKD vì gồm cọc, chuyển nội bộ và khác kỳ ghi nhận. |
| **Cọc canonical** | Hạng mục phiếu thu chi được đánh dấu cọc (`is_deposit=true`/class cọc), không phải chỉ dòng trong bảng `deposits` legacy. |
| **Cọc gộp hoá đơn đầu** | Dòng cọc riêng trong hoá đơn đầu khi chọn `FIRST_INVOICE`; khi thu phải tách khỏi doanh thu. |
| **Nợ cũ / carry-over** | Residual đủ ngưỡng từ hoá đơn trước được kéo sang kỳ mới; residual `<10.000đ` bị loại, cọc thiếu không được kéo chung. |
| **Làm tròn tổng hoá đơn** | Ba chữ số cuối `<900đ` làm xuống; `>=900đ` làm lên bội 1.000. |
| **Làm tròn khi thu** | Residual dương `<10.000đ` có thể khép, trừ khi vẫn còn nghĩa vụ cọc chưa thu. |
| **Credit khách hàng** | Quyền lợi tiền thừa authoritative nằm ở `customer_credit_lots.remaining_amount`; không đồng nhất với phép trừ trên một hoá đơn. |
| **Bàn giao tiền mặt** | Chuyển trách nhiệm giữ tiền giữa hai người/sổ theo một phiên có đối soát; phải kiểm posting ở cả hai phía. |
| **Chốt sổ** | Khoá mốc số dư và tạo bằng chứng bàn giao/đối soát; các quyền `cashbooks.close` và `cashbooks.close_confirm` tách riêng. |
| **Vai trò** | Gói quyền dùng lại trong RBAC V3. Sửa vai trò tự tạo ảnh hưởng ngay mọi thành viên đang mang nó. |
| **Binding** | Liên kết một membership với vai trò và scope. |
| **Scope** | Phạm vi organization, khu vực, toà hoặc sổ mà binding/override áp dụng. |
| **Override** | Ngoại lệ `ALLOW`/`DENY` cho thành viên; `DENY` thắng khi cùng áp dụng. |
| **Runtime-off / cờ phát hành** | Tính năng có code/quyền trong catalog nhưng route không được dựng khi cờ của bản build là `off`. [Trung tâm mạng](/03-quan-ly-van-hanh/trung-tam-mang/) dùng cơ chế này; bản production hiện **bật**, và mỗi toà còn có chế độ riêng **Đã tắt / Chỉ đọc / Được thực thi**. |
| **Danh mục chi chuẩn** | Danh sách hạng mục chi thống nhất của công ty (từ 03/10/2026); chỉ chủ công ty thêm/sửa/xoá, quản lý chỉ chọn. Xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/). |
| **Cam kết chi / luật chi theo hạng mục** | Cấu hình ở `/settings/finance/cam-ket-chi` (menu **Tài chính** => **Cam kết chi**, chỉ chủ công ty sửa được). Mỗi hạng mục chi đi theo một luật: **Theo cam kết** (so với số tiền đã ký của tháng — tiền nhà, internet, quản lý…), **Theo trần** (so với trần đã công bố — điện, nước) hoặc **Từng phiếu** (như cũ: người có quyền duyệt tự duyệt, phiếu từ 600.000đ của người khác chờ duyệt). Máy chỉ quyết thay khi bộ máy ở chế độ **đang áp dụng**; ở chế độ **đang chạy thử** mọi phiếu vẫn duyệt như cũ. Luật này chỉ quyết việc **duyệt**; tiền thật vẫn chỉ tính khi phiếu **Đã Chi**. |
| **Báo chi nhanh** | Màn `/chi-tieu`: gõ, nói hoặc chụp bill để tạo **thẻ nháp** phiếu chi. Xem [Báo chi nhanh](/03-quan-ly-van-hanh/bao-chi-nhanh/). |
| **Ngày công (v5)** | Ngày có ít nhất một việc thật (kiểm tra nhà, thu tiền kèm check nhà, sửa chữa) — tính trên màn [Hôm nay](/02-theo-doi-nhanh/viec-cua-toi/); số tiền hiển thị là TẠM TÍNH tới khi khoá sổ cuối tháng. |

## Route canonical thường bị nhầm

| Chức năng | Route hiện hành | Route cũ / ghi chú |
|---|---|---|
| Thành viên | `/settings/members` | `/settings/staff` chuyển hướng. |
| Sổ quỹ | `/finance/cashbooks` | `/settings/finance/cashbooks`, `/setting/finance/cashbooks`, `/cashbooks` chuyển hướng. |
| Phân bổ lợi nhuận | `/reports/finance/profit-distribution` | `/finance/shareholder-profit` chuyển hướng. |
| Công nợ/thu tiền | `/thu-tien` | Ba route báo cáo debt cũ chuyển hướng về đây. |
| Bảng lương | `/finance/salary` | Route chỉ bọc đăng nhập; trang tự tách admin/self-view, dữ liệu vẫn bị quyền và RLS giới hạn. |

## Quy trình liên quan

- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/)
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/)
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)
- [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/)
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/)
- [Bảng tra quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/)
