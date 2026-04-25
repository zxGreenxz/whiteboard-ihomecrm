# Tài liệu chi tiết: Thu chi & Tài khoản

> Tổng hợp từ tài liệu chính thức Resident:
> - https://docs.resident.vn/quan-ly-and-van-hanh/tai-chinh/thu-chi
> - https://docs.resident.vn/cai-dat-he-thong/danh-muc-khac/tai-chinh/tai-khoan

---

## Mục lục

- [PHẦN 1 — THU CHI](#phần-1--thu-chi)
  - [1.1. Giới thiệu](#11-giới-thiệu)
  - [1.2. Lập phiếu Thu/Chi đơn lẻ](#12-lập-phiếu-thuchi-đơn-lẻ)
  - [1.3. Lập nhiều phiếu Thu/Chi từ file mẫu](#13-lập-nhiều-phiếu-thuchi-từ-file-mẫu)
  - [1.4. Lọc phiếu Thu/Chi](#14-lọc-phiếu-thuchi)
  - [1.5. Thống kê Thu chi](#15-thống-kê-thu-chi)
  - [1.6. Quy tắc trạng thái & ràng buộc](#16-quy-tắc-trạng-thái--ràng-buộc)
- [PHẦN 2 — TÀI KHOẢN](#phần-2--tài-khoản)
  - [2.1. Giới thiệu](#21-giới-thiệu)
  - [2.2. Thêm Tài khoản](#22-thêm-tài-khoản)
  - [2.3. Sửa, xoá Tài khoản](#23-sửa-xoá-tài-khoản)
  - [2.4. Khoá sổ](#24-khoá-sổ)
- [PHẦN 3 — MỐI LIÊN HỆ THU CHI ↔ TÀI KHOẢN](#phần-3--mối-liên-hệ-thu-chi--tài-khoản)
- [Hỗ trợ](#hỗ-trợ)

---

## PHẦN 1 — THU CHI

### 1.1. Giới thiệu

Trong phần mềm quản lý Bất động sản **Resident**, màn **Thu chi** hỗ trợ chủ nhà quản lý **toàn bộ các khoản thu và khoản chi tại Căn hộ**, bao gồm:

- Các khoản **Thu/Chi từ hoá đơn** (sinh ra tự động khi khách thanh toán hoá đơn dịch vụ, tiền thuê,…).
- Các khoản **Thu/Chi phát sinh ngoài hoá đơn** (chi phí bảo trì, mua sắm, hoàn tiền cọc, các khoản thu/chi đột xuất,…).

Đối với các khoản Thu/Chi phát sinh ngoài hoá đơn, người dùng có thể **lập Phiếu thu / Phiếu chi** thủ công để hệ thống thống kê và ghi nhận đầy đủ.

**Đường dẫn truy cập:** Thanh công cụ → **Thu chi**

---

### 1.2. Lập phiếu Thu/Chi đơn lẻ

#### Các bước chung

| Bước | Thao tác |
|------|----------|
| **Bước 1** | Tại thanh công cụ, chọn mục **Thu chi** |
| **Bước 2** | Tại màn hình danh sách phiếu Thu chi, ấn nút **(+)** để **Thêm Thu/Chi** |
| **Bước 3** | Tại màn chi tiết Thêm phiếu thu/chi, hệ thống hiển thị 2 loại phiếu: **Phiếu thu** hoặc **Phiếu chi** |

> **Quy ước chung:** Những trường đánh dấu **(\*)** là **bắt buộc phải điền**.

#### a. Lập Phiếu thu

1. Ấn chọn ô **Phiếu thu**.
2. Điền các thông tin liên quan đến phiếu thu:
   - **Căn hộ** (\*)
   - **Phòng**
   - **Giường**
   - **Khách hàng**
   - **Tên phiếu thu** (\*)
   - **Ngày thu** (\*)
   - …và các trường thông tin khác hệ thống yêu cầu.
3. Ấn nút dấu **(+)** ở khu vực **Hạng mục** để **Thêm hạng mục thu**.
4. Tại popup **Chọn hạng mục**:
   - **Tích chọn hạng mục** phù hợp trong danh sách có sẵn.
   - Nếu hạng mục cần dùng chưa có, ấn nút **Thêm** để tạo hạng mục mới.
   - Khi chọn xong, hạng mục sẽ được hiển thị tại màn chi tiết Thu/Chi.
5. Điền các thông tin còn lại của hạng mục (số tiền, tài khoản nhận tiền, ghi chú,…).
6. Ấn **Lưu** để hoàn thành.

➡️ Khi thành công, phiếu thu được hiển thị tại **Danh sách Thu chi**.

#### b. Lập Phiếu chi

Quy trình tương tự Phiếu thu:

1. Ấn chọn ô **Phiếu chi**.
2. Điền và thêm thông tin liên quan đến phiếu chi:
   - **Căn hộ** (\*)
   - **Phòng**
   - **Giường**
   - **Khách hàng**
   - **Tên phiếu chi** (\*)
   - **Ngày chi** (\*)
   - **Hạng mục chi** (\*)
   - …
3. Ấn nút **Lưu** để hoàn thành.

➡️ Phiếu chi vừa tạo sẽ xuất hiện tại **Danh sách Thu chi**.

#### c. Cập nhật / Xoá phiếu

- Tại cột **Thao tác** trong danh sách, ấn:
  - **Cập nhật** → chỉnh sửa thông tin → **Lưu**.
  - **Xoá** → xác nhận xoá phiếu.
- ⚠️ **Ràng buộc:** *Chỉ có thể Sửa hoặc Xoá khi Phiếu đang ở trạng thái **Bỏ duyệt**. Nếu phiếu đã duyệt, cần **Bỏ duyệt** trước khi thao tác.*

---

### 1.3. Lập nhiều phiếu Thu/Chi từ file mẫu

Tính năng này giúp **nhập hàng loạt** phiếu thu/chi qua file Excel.

| Bước | Thao tác |
|------|----------|
| **Bước 1** | Tại màn hình chính, ấn chọn mục **Thu chi** |
| **Bước 2** | Ấn nút **Thêm dữ liệu** (icon mũi tên đi lên) |
| **Bước 3** | Tại màn nhập dữ liệu, ấn vào **"Tải file mẫu tại đây"** để tải file Excel mẫu |
| **Bước 4** | Mở file mẫu, kiểm tra các cột thông tin có sẵn và điền đầy đủ thông tin còn thiếu. *Các cột có (\*) là bắt buộc.* |
| **Bước 5** | Đẩy file lên hệ thống bằng nút **Chọn file** hoặc **Kéo thả** vào màn Chi tiết nhập dữ liệu, sau đó ấn **Nhập dữ liệu** |

➡️ Khi thành công, hệ thống thông báo **"Dữ liệu đã được TẠO thành công"** và toàn bộ phiếu thu/chi sẽ xuất hiện tại **Danh sách Thu chi**.

---

### 1.4. Lọc phiếu Thu/Chi

Tính năng **Lọc** giúp tìm kiếm thông tin nhanh và xem các chỉ số tổng hợp theo nhu cầu.

**Cách dùng:**

1. Ấn nút **Lọc dữ liệu** (icon 3 gạch màu đen).
2. Chọn các tiêu chí lọc cần thiết, ví dụ:
   - **Căn hộ**
   - **Phòng**
   - **Sổ quỹ / Tài khoản**
   - **Loại phiếu** (Phiếu thu / Phiếu chi)
   - **Thời gian** (khoảng ngày)
   - **Trạng thái duyệt** (Đã duyệt / Bỏ duyệt)
   - **Khách hàng**, **Hạng mục**…
3. Ấn **Áp dụng** để hệ thống trả kết quả phù hợp.

---

### 1.5. Thống kê Thu chi

Phía trên danh sách Thu chi, hệ thống hiển thị **bảng thống kê tổng hợp** theo các tiêu chí lọc đang áp dụng:

- **Tổng thu** đã ghi nhận tại Căn hộ.
- **Tổng chi** đã ghi nhận tại Căn hộ.
- Số liệu được tính theo các trường lọc: **Căn hộ, Phòng, Sổ quỹ, Loại phiếu, Thời gian, …**

➡️ Mục đích: theo dõi nhanh dòng tiền vào – ra theo từng kỳ và từng đơn vị quản lý.

---

### 1.6. Quy tắc trạng thái & ràng buộc

| Trạng thái phiếu | Có thể Sửa? | Có thể Xoá? | Ghi chú |
|-------------------|-------------|-------------|---------|
| **Bỏ duyệt** | ✅ Có | ✅ Có | Trạng thái mặc định khi mới tạo, hoặc sau khi bỏ duyệt phiếu đã duyệt |
| **Đã duyệt** | ❌ Không | ❌ Không | Phải thực hiện **Bỏ duyệt** trước khi sửa/xoá |

> Phiếu Thu/Chi nằm trong **Tài khoản đã khoá sổ** sẽ bị **chặn** thao tác chỉnh sửa nếu **ngày phát sinh ≤ ngày khoá sổ** (xem [Phần 2.4 – Khoá sổ](#24-khoá-sổ)).

---

## PHẦN 2 — TÀI KHOẢN

### 2.1. Giới thiệu

**Tài khoản** (trước đây gọi là **Sổ quỹ** hay **Báo cáo dòng tiền**) là một trong những báo cáo tài chính quan trọng, thể hiện **toàn bộ luồng tiền ra – vào** của đơn vị kinh doanh trong một khoảng thời gian nhất định.

**Đặc điểm trong vận hành cho thuê căn hộ:**

- Dòng tiền vào: chủ yếu đến từ **thanh toán tiền thuê** và **phí dịch vụ** của khách hàng.
- Trên thực tế, mỗi đơn vị kinh doanh thường có **nhiều nguồn quỹ** khác nhau:
  - 💵 **Tiền mặt**
  - 🏦 **Tài khoản ngân hàng**
  - 📱 **Ví điện tử**

**Lợi ích của module Tài khoản trên Resident:**

- Theo dõi **số dư đầu kỳ**, **số dư cuối kỳ** của từng tài khoản.
- Theo dõi các **phát sinh thu/chi** trong từng tài khoản.
- Quản lý tài chính **minh bạch** và **chính xác** hơn.

**Đường dẫn truy cập:** Màn hình chính → **Danh mục khác → Tài chính → Tài khoản**

---

### 2.2. Thêm Tài khoản

| Bước | Thao tác |
|------|----------|
| **Bước 1** | Tại màn hình chính, ấn chọn **Danh mục khác → Tài chính → Tài khoản** |
| **Bước 2** | Ấn nút **(+)** để **Thêm tài khoản / Tiền mặt** mới |
| **Bước 3** | Tại màn chi tiết Thêm Tài khoản/Tiền mặt, **chọn loại tài khoản** và **điền thông tin** theo yêu cầu |
| **Bước 4** | Ấn nút **Lưu** để xác nhận |

> **Lưu ý:** Những trường đánh dấu **(\*)** là **bắt buộc**.

#### Loại tài khoản hỗ trợ

- **Tiền mặt** — quỹ tiền mặt vật lý tại căn hộ/văn phòng.
- **Tài khoản ngân hàng** — số tài khoản mở tại ngân hàng (kèm chủ tài khoản, số TK, ngân hàng, chi nhánh,…).
- **Ví điện tử** — Momo, ZaloPay, ViettelPay, VNPay,…

#### Thông tin thường có khi tạo tài khoản

- **Loại tài khoản** (\*)
- **Tên tài khoản** (\*)
- **Số tài khoản** (với loại Ngân hàng / Ví điện tử)
- **Tên chủ tài khoản**
- **Ngân hàng** / **Nhà cung cấp ví**
- **Chi nhánh**
- **Số dư đầu kỳ**
- **Ghi chú**

➡️ Khi thành công, hệ thống hiển thị thông báo **"Thông tin đã được cập nhật lưu trữ thành công"** và tài khoản mới sẽ xuất hiện tại **Danh sách Tài khoản**.

---

### 2.3. Sửa, xoá Tài khoản

#### a. Sửa Tài khoản

1. Tại màn hình **Danh sách Tài khoản**, ấn nút **Cập nhật** ở dòng tài khoản cần chỉnh.
2. Chỉnh sửa thông tin theo nhu cầu.
3. Ấn **Lưu** để hoàn thành.

#### b. Xoá Tài khoản

| Bước | Thao tác |
|------|----------|
| **Bước 1** | Tại màn hình danh sách tài khoản, ấn nút **Xoá** |
| **Bước 2** | Hệ thống hỏi xác nhận: *"Bạn đang thực hiện thao tác xoá tài khoản ngân hàng/tiền mặt. Bạn có chắc chắn muốn xoá không?"* |

- Ấn **Huỷ** → huỷ thao tác.
- Ấn **Xoá** → xác nhận xoá.

➡️ Nếu thành công, hệ thống thông báo **"Dữ liệu đã được XOÁ thành công"** và quay về **Danh sách Tài khoản**.

> ⚠️ **Cảnh báo:** Việc xoá tài khoản có thể ảnh hưởng đến dữ liệu Thu/Chi đã ghi nhận trên tài khoản đó. Nên cân nhắc kỹ hoặc liên hệ hỗ trợ trước khi thao tác trên tài khoản đang sử dụng.

---

### 2.4. Khoá sổ

**Khoá sổ** là thao tác **"chốt số liệu"** tại một thời điểm nhất định. Khi chọn **ngày khoá sổ**, hệ thống sẽ **không cho phép lập thêm các chứng từ Thu – Chi có ngày phát sinh ≤ ngày đã khoá**.

#### Lợi ích

- ✅ Giúp chủ nhà / kế toán **chốt sổ theo từng kỳ** (tháng, quý, năm).
- ✅ **Ngăn chặn sai sót** hoặc nhập dữ liệu muộn gây lệch số liệu đã báo cáo.
- ✅ **Đảm bảo tính chính xác và minh bạch** khi đối chiếu dòng tiền.
- ✅ Dữ liệu trước ngày khoá sổ được **cố định**, không thể chỉnh sửa về sau.

#### Các bước thực hiện

| Bước | Thao tác |
|------|----------|
| **Bước 1** | Tại màn hình **Danh sách Tài khoản**, ấn icon **Khoá sổ** tại dòng tài khoản cần khoá |
| **Bước 2** | Tại màn chi tiết Khoá sổ, chọn **Ngày khoá sổ** |
| **Bước 3** | Ấn **Lưu** để hoàn thành |

> 📌 Sau khi khoá sổ, mọi thao tác sửa/xoá/lập mới phiếu Thu Chi với ngày ≤ ngày khoá sổ đều bị **chặn**. Muốn chỉnh sửa, cần **mở lại sổ** (nếu hệ thống cho phép).

---

## PHẦN 3 — MỐI LIÊN HỆ THU CHI ↔ TÀI KHOẢN

```
┌──────────────────────┐         ┌──────────────────────┐
│      TÀI KHOẢN       │         │       THU CHI        │
│  (Danh mục cấu hình) │         │  (Phát sinh thực tế) │
│                      │         │                      │
│  - Tiền mặt          │ ◄────── │  Phiếu thu (+)       │
│  - Ngân hàng         │ ◄────── │  Phiếu chi (-)       │
│  - Ví điện tử        │         │                      │
│                      │         │  Mỗi phiếu gắn với   │
│  Số dư đầu kỳ        │         │  1 tài khoản          │
│  Số dư cuối kỳ       │         │                      │
│  Ngày khoá sổ        │ ──────► │  Chặn lập phiếu      │
│                      │         │  trước ngày khoá     │
└──────────────────────┘         └──────────────────────┘
```

**Tóm tắt:**

1. **Tài khoản** là **danh mục cấu hình** (master data) — định nghĩa các nguồn quỹ.
2. **Thu chi** là **phát sinh thực tế** — mỗi phiếu thu/chi sẽ ghi nhận biến động vào một tài khoản cụ thể.
3. **Số dư cuối kỳ** của tài khoản = **Số dư đầu kỳ** + **Tổng thu** − **Tổng chi** (trong kỳ).
4. **Khoá sổ** trên tài khoản trực tiếp ảnh hưởng đến khả năng lập/sửa phiếu Thu Chi tại tài khoản đó.

---

## Hỗ trợ

Mọi thắc mắc xin liên hệ:

- ☎️ **Hotline:** 0355.430.074
- 📧 **Email:** Contact@resident.vn

> Tài liệu tổng hợp từ các trang:
> - [docs.resident.vn — Thu chi](https://docs.resident.vn/quan-ly-and-van-hanh/tai-chinh/thu-chi)
> - [docs.resident.vn — Tài khoản](https://docs.resident.vn/cai-dat-he-thong/danh-muc-khac/tai-chinh/tai-khoan)
