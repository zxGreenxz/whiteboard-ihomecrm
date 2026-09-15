---
title: "Đăng ký tạm trú trên Cổng DVC Bộ Công an"
description: "Lưu ảnh CT01, hợp đồng đã ký và giấy chỗ ở hợp pháp trên CRM, rồi một nút mở Cổng DVC và điền sẵn hồ sơ Đăng ký tạm trú để bạn kiểm tra và bấm Nộp."
routes: ["/customers/:id", "/buildings"]
permissions: [{module: customers, action: print}, {module: buildings, action: edit}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-09-15"
  commit: "ad5e7193"
  account: nguyentam
status: published
---

# Đăng ký tạm trú trên Cổng DVC Bộ Công an

Trước đây, mỗi lần đăng ký tạm trú cho một khách bạn phải mở CRM, chép tay từng ô (họ tên, ngày sinh, CCCD, địa chỉ) sang form của Cổng dịch vụ công `dichvucong.dancuquocgia.gov.vn`, rồi tải lên ba loại ảnh: tờ khai CT01 đã ký, hợp đồng thuê đã ký và giấy tờ chứng minh chỗ ở hợp pháp của toà. Nay CRM giữ sẵn ảnh và có nút **Đăng ký tạm trú trên DVC**: extension Chrome *iHome Tạm trú* mở cổng và điền toàn bộ form, bạn chỉ kiểm tra, tick "chịu trách nhiệm" và bấm **Nộp hồ sơ**.

::: info Điều kiện tiên quyết
- Quyền **Cư dân => In** (`customers.print`) để lưu ảnh CT01/hợp đồng và bấm nút; quyền **Toà nhà => Sửa** (`buildings.edit`) để lưu giấy tờ chỗ ở hợp pháp của toà.
- Hồ sơ khách đủ **họ tên, ngày sinh, giới tính, CCCD 12 số**. Toà nhà có **địa chỉ chi tiết chứa phường/xã mới** (ví dụ `950/65 Nguyễn Kiệm, Khu Phố 14, Phường Hạnh Thông, TP Hồ Chí Minh`) — cổng dùng đơn vị hành chính mới, không có quận.
- Chrome đã cài extension **iHome Tạm trú** (một lần mỗi máy, xem cuối trang) và tài khoản VNeID của người nộp.
:::

::: danger Dữ liệu cá nhân nhạy cảm
Ảnh CT01, hợp đồng và giấy chủ quyền chứa CCCD, chữ ký, địa chỉ. Chỉ tải lên và mở khi có mục đích nghiệp vụ; ảnh lưu ở kho riêng tư, chỉ người có quyền trên toà đó mới xem được.
:::

## Hướng dẫn từng bước

**Bước 1 — Giấy tờ chỗ ở hợp pháp của toà (làm một lần)**: vào **Toà nhà**, bấm sửa toà, kéo xuống khối **Giấy tờ chứng minh chỗ ở hợp pháp**, bấm **Chọn tệp** (hoặc **Chụp ảnh** trên điện thoại) để tải ảnh sổ hồng/giấy tờ chủ quyền. Ảnh này được đính kèm cho mọi hồ sơ tạm trú của toà về sau.

**Bước 2 — In và ký giấy**: mở chi tiết khách, bấm **Bản khai nhân khẩu / Mẫu CT01** để tải tờ khai và hợp đồng, in ra, đem cho khách và chủ nhà ký.

**Bước 3 — Lưu ảnh giấy đã ký**: trong chi tiết khách, khối **Hồ sơ tạm trú (Cổng DVC Bộ Công an)** có hai hàng **Tờ khai CT01 đã ký** và **Hợp đồng thuê đã ký**. Trên điện thoại bấm **Chụp ảnh** để chụp thẳng, trên máy tính bấm **Chọn tệp**. Ảnh gắn với hợp đồng đang ở; khách ở nhiều phòng thì chọn phòng ở ô **Phòng kê khai**. Dòng trạng thái bên dưới cho biết toà đã có ảnh chỗ ở hợp pháp chưa.

::: tip Tên ảnh được đặt lại cho dễ đối chiếu
Hệ thống bỏ tên gốc của máy ảnh và đặt lại theo đối tượng: ảnh chủ quyền thành `chuquyen950nk1.jpg`, `chuquyen950nk2.jpg`; ảnh của khách thành `nguyengiabinhct011.jpg`, `nguyengiabinhhopdong1.jpg`. Tên này hiện đúng trong cột Đính kèm của cổng nên nhìn là biết ảnh của toà nào, khách nào.

Chỉ nhận **JPG và PNG**: cổng từ chối WebP. Ảnh được giữ nguyên byte gốc, không nén lại, để chữ trên giấy tờ không bị mờ.
:::

**Bước 4 — Gửi sang Cổng DVC**: chọn **Thời hạn tạm trú** (12 hoặc 24 tháng, mặc định 24 để khớp tờ CT01 đã in) rồi bấm **Đăng ký tạm trú trên DVC**. Nếu thiếu dữ liệu, CRM báo đúng thứ thiếu (ví dụ "Toà nhà chưa có ảnh giấy tờ chứng minh chỗ ở hợp pháp") và không mở cổng. Nếu chưa cài extension, CRM hiện hướng dẫn cài.

**Bước 5 — Trên Cổng DVC**: tab mới mở form Đăng ký tạm trú. Cổng có thể yêu cầu đăng nhập VNeID (CCCD, mật khẩu, OTP) — đăng nhập xong form tự hiện. Bảng nổi **iHome Tạm trú** ở góc phải dưới tóm tắt khách, toà, phòng, hạn tạm trú và số ảnh; bấm **Điền ngay**. Extension lần lượt: chọn tỉnh và phường (cơ quan Công an phường tự hiện), chọn thủ tục lập hộ mới và khai hộ, điền thông tin khách và địa chỉ, mở mục đính kèm "do thuê, mượn, ở nhờ", gắn ảnh CT01, hợp đồng và thêm dòng "Giấy tờ, tài liệu chứng minh chỗ ở hợp pháp" với ảnh của toà.

Bảng nổi hiện **ảnh thu nhỏ của từng tệp sắp đính kèm**, xếp theo loại và kèm tên. Bấm vào ảnh để xem to. Nhìn đó là biết ngay có gắn nhầm ảnh hay không, trước khi nộp.

**Bước 6 — Kiểm tra và nộp**: rà lại từng mục (đặc biệt giới tính, ngày sinh, địa chỉ, số ảnh), tick **Tôi xin chịu trách nhiệm trước pháp luật về lời khai trên**, bấm **Nộp hồ sơ** hoặc **Lưu nháp**. Extension không bao giờ tự bấm hai nút này.

## Điều gì được điền, điều gì không

| Mục trên cổng | Nguồn từ CRM |
|---|---|
| Tỉnh/Thành phố, Xã/Phường, Cơ quan thực hiện | Tỉnh của toà; phường lấy từ địa chỉ chi tiết của toà |
| Thủ tục, Đăng ký tạm trú lập hộ mới, Trường hợp, Khai hộ | Cố định theo cách chủ đang nộp (mỗi khách một hộ, khách là chủ hộ) |
| Họ tên, Định dạng ngày, Ngày sinh, Giới tính, CCCD, SĐT, Email | Hồ sơ khách (giới tính "Nam"/"MALE" đều được quy về mã của cổng) |
| Địa chỉ đăng ký tạm trú | Phần số nhà, đường, khu phố đứng trước phường trong địa chỉ toà |
| Chủ hộ tạm trú, quan hệ, CCCD chủ hộ | Chính khách, quan hệ "Chủ hộ" |
| Thời hạn tạm trú đề nghị đến | Hôm nay + 12/24 tháng |
| Đính kèm | Ảnh CT01, hợp đồng của khách; ảnh chỗ ở hợp pháp của toà; hình thức "Bản gốc" |
| Bảng xin ý kiến VNeID, thành viên cùng thay đổi, ô chịu trách nhiệm, nút Nộp | **Không điền** — bạn tự làm nếu cần |

## Cài extension iHome Tạm trú (một lần mỗi máy)

1. Mở Chrome, vào `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `extensions/tam-tru` trong mã nguồn CRM.
3. Tải lại trang CRM. Khi cập nhật phiên bản, bấm nút tải lại ở thẻ extension.

Extension không giữ mật khẩu hay khoá CRM. Gói dữ liệu đi thẳng từ trang CRM sang đúng extension này, không phát ra cho phần mềm khác trên trang; extension chỉ nhận ảnh từ kho của CRM. Trang mở lại từ hồ sơ nháp (`?id=`) không tự điền.

## Lỗi thường gặp

- **"Địa chỉ chi tiết của toà chưa có phường/xã mới"**: sửa toà nhà, ghi địa chỉ đầy đủ dạng `…, Phường X, TP Hồ Chí Minh`.
- **"Không thấy phường … trên cổng"**: tên phường trong địa chỉ toà không khớp danh sách cổng (sau sáp nhập). Sửa lại đúng tên phường mới.
- **"Extension iHome Tạm trú không phản hồi"**: extension chưa bật hoặc trang CRM chưa tải lại sau khi cài.
- **Bảng nổi không hiện trên cổng**: gói dữ liệu chỉ giữ 1 giờ; bấm lại nút trên CRM. Tab mở từ hồ sơ nháp không tự điền.
