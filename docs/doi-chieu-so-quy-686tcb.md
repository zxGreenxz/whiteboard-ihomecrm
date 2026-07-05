# Quy tắc đối chiếu sổ tay Excel 686‑TCB (Nathan) ↔ sổ quỹ TKHIEP trên web

> Đúc kết từ đợt đối chiếu T5–T7/2026 (02/07/2026): từ lệch ~18 triệu truy về còn **800đ**.
> Script tự động: `node scripts/doi-chieu-thu-tien.mjs [file.xlsx] [YYYY-MM-DD]`

## 1. Phạm vi & mapping quỹ

File Excel: `dataexcel/danh sách thu tiền v2.xlsx` — sổ tay của **Nathan (Hiệp)**, theo dõi **tài khoản ngân hàng vật lý 686‑TCB (+ 061‑BVB)**.

| Kênh trên Excel | Sổ quỹ trên web |
|---|---|
| TM = `khách đưa` − `thối lại` | **Hiệp Thu** (TK000032) |
| `CKH - 686-TCB` (thu) + `061 - BVB` số dương | **TKHIEP** (TK000046) — thu |
| `686-TCB CHI` + `061 - BVB` số âm | **TKHIEP** — chi |
| `937-ACB`, `018-TPB` | Quỹ của Tâm/Huy (Tâm Thu, TK939, Huy Thu…) — **KHÔNG đối chiếu với TKHIEP** |

ID sổ TKHIEP: `df6b5925-845d-48da-8000-c367d55d6c04`.

## 2. Quy tắc đọc Excel (phía sổ tay)

- Mỗi tháng 1 sheet tên `tháng N`. Chỉ cộng từ **tháng 5/2026** trở đi (web bắt đầu có dữ liệu từ T5).
- **Vị trí cột KHÁC NHAU giữa các tháng** (T5 lệch 1 cột so với T6+) → phải dò cột theo **tên header** (`CKH`, `CHI`, `BVB`), không hard‑code index.
- **Dòng phải LOẠI khi cộng** (kẻo đếm đôi):
  - Dòng `Tổng`, `TK TCB + BVB`, `số dư`, `tiền Ihome`, `tiền Hiệp` (dòng tổng kết tay).
  - Dòng `tiền còn lại của T5/T6/...` — carryover **giữa các sheet đang cộng** (số dư cuối tháng trước mang sang).
- **Dòng phải GIỮ**: `tiền còn lại của tháng 4` (8.739.307) — tiền thật mang vào đầu kỳ, web cũng có phiếu thu tương ứng.
- **4 khoản chi ghi ở GÓC sheet T5** (ngoài cột CHI) phải cộng thêm vào tổng chi: lương T4 17.705.000 + 162NVK T4 4.017.800 + 162NVK T5 4.464.800 + sổ quỹ Hiệp chi 7.708.515 (= 33.896.115).
- Công thức "tiền Ihome" của Nathan: `Thu(CKH + BVB dương) − Chi(CHI + BVB âm) − 4 khoản góc`.
- File hay bị Excel lock → **luôn copy ra temp rồi mới đọc**.

## 3. Quy tắc phía web

- Chỉ tính phiếu `approval_status = 'APPROVED'` và `deleted_at is null`.
- ⚠️ **Trang Thu chi trên web đếm cả phiếu CHƯA DUYỆT** → số dư trên UI có thể lệch với sổ quỹ đúng bằng các phiếu đang chờ duyệt. Khi lệch "chẵn" một khoản, kiểm tra phiếu UNAPPROVED trước tiên.
- Query qua Management API (PAT trong `CLAUDE.local.md`), lọc tên tiếng Việt phải làm trong **Node/JS trên JSON đã kéo về** — `ilike` tiếng Việt qua curl/bash bị hỏng encoding, trả kết quả rỗng GIẢ.

## 4. Quy trình đối chiếu (nhanh nhất)

1. **Chạy script với ngày chốt** = ngày cuối cùng Excel đã nhập đủ:
   `node scripts/doi-chieu-thu-tien.mjs "dataexcel/danh sách thu tiền v2.xlsx" 2026-07-31`
2. Nhìn dòng **CHÊNH** tổng hợp: tách riêng chênh **thu** và chênh **chi** (đừng chỉ nhìn chênh số dư — 2 chiều có thể bù nhau).
3. Đọc 2 danh sách **EXCEL-only / WEB-only**: phần lớn cặp lệch sẽ tự lộ (cùng phòng, cùng cỡ tiền, khác vài trăm đ hoặc khác ngày). Chỉ tin **dòng Net** — matcher tham lam có thể ghép nhầm cặp, nhưng tổng Net luôn đúng.
4. Với từng khoản EXCEL-only: **tra khắp các sổ khác** (theo phòng + số tiền ±5%) trước khi kết luận "web thiếu" — 80% trường hợp tiền nằm ở sổ khác (xem mục 5).
5. Sau khi sửa: chạy lại script đến khi Net thu/chi về ~0 (chấp nhận số lẻ <1.000đ đã định danh).

## 5. Bẫy thường gặp (đúc kết thực tế)

| Hiện tượng | Nguyên nhân thật | Cách xử lý |
|---|---|---|
| 1 khoản Excel không thấy trên web | Web tách thành **phiếu tổng nhiều phiếu con** (điện lạnh 25 phiếu, tiền nhà 102LVT = 2×66tr, rò rỉ điện = 3 phiếu 200+200+400) | Cộng cụm phiếu con cùng ngày/cùng tên gốc rồi so |
| Cọc khách Excel ghi ở 686 nhưng TKHIEP không có | Web để cọc ở sổ **CỌC (giữ hộ khách)** / **Chung** / TK939 | Chuyển phiếu về TKHIEP nếu tiền thật vào 686 |
| Web TKHIEP có khoản thu Excel không có | **"Doanh thu thanh lý"** tự sinh khi cấn cọc — tiền KHÔNG chảy qua bank | Hợp lệ, không sửa; ghi chú 1 dòng ở Excel nếu muốn khớp tuyệt đối |
| Web có phiếu chi Excel không có, hoặc ngược lại, số tiền = tiền hoàn khách | Phòng có khách mới nhưng **chưa chạy thanh lý HĐ cũ** trên web → thiếu phiếu hoàn cọc | Chạy thanh lý/tạo phiếu hoàn cọc trên web |
| Chênh đúng bằng 1 phiếu "chẵn" | Phiếu **chưa duyệt** (UNAPPROVED) hoặc **phiếu trùng** (2 phiếu giống hệt cùng ngày cùng tiền) | Duyệt phiếu / xoá bản trùng |
| Tháng này web cao, tháng sau Excel cao cùng cỡ tiền | **Lệch thời điểm**: web ghi ngày nhận tiền, Nathan ghi theo tháng bill (nhất là phiếu ngày 30–31 và thu trước tháng sau) | Gộp 2 tháng lại sẽ tự triệt tiêu — không phải sai |
| Cột 686‑TCB âm cuối tháng | Phần Ihome "mượn" tiền riêng có sẵn trong tài khoản — TK vật lý vẫn dương | Bình thường, là công nợ nội bộ |
| Khoản chi 2 bên lệch vài trăm nghìn | HH môi giới web tách **HH + thưởng nóng Sale** (vd 2.300.000 = 1.800.000 + 500.000) | So tổng theo hợp đồng |
| Lệch 200k kiểu cọc | 2 bên ghi số cọc khác nhau (1tr vs 1,2tr) | Check sao kê bank ngày đó |

## 6. Checklist chốt

- [ ] Chạy script với ngày chốt → Net CHI = 0, Net THU ≤ 1.000đ
- [ ] Không còn phiếu TKHIEP nào UNAPPROVED (`approval_status <> 'APPROVED'`)
- [ ] Các khoản "lệch hợp lệ vĩnh viễn" đã biết: doanh thu thanh lý (cấn cọc, không qua bank) + tiền để ở sổ CỌC/Chung — liệt kê rõ, không tính là sai
- [ ] Ghi lại số dư chốt + ngày chốt vào sheet (dòng `tiền còn lại của TX` cho tháng sau)

## 7. Lịch sử chốt

| Ngày chốt | Excel | Web TKHIEP | Chênh | Ghi chú |
|---|---:|---:|---:|---|
| 02/07/2026 | 75.322.263 | 75.321.463 | 800đ | Chi khớp 100%. 800đ = 1.000đ cọc lock 406 (sổ Chung) + 400đ lẻ L03 − 600đ Excel gõ thiếu 403PVB 403 |
