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
- **Dòng số liệu KHÔNG có nhãn toà lẫn nhãn phòng = dòng tổng kết tay → LOẠI** (án lệ 15/07:
  R185 sheet T7 mang "tiền Ihome" 20.799.001 tràn vào cột CKH, không tên — script đã tự skip).
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
6. **Khi residual còn "chi vặt" lắt nhắt không định danh được**: đừng kết luận vội — thường là
   nhiễu phiếu-con-cụm che dòng khác cùng mức tiền. Cách xử: (a) kiểm tổng từng CỤM bằng SQL
   (`sum(...) where name ilike 'cụm%'`) so với dòng gộp Excel; (b) cụm nào bằng nhau thì LOẠI
   cả 2 phía rồi multiset-diff lại theo mức tiền → residual còn lại sẽ định danh được từng dòng
   (án lệ 15/07: ±2tr "chi vặt" tan hết sau khi loại 3 cụm điện lạnh, chốt CHI phân rã 100%).

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
| 15/07/2026 | thu 1.064.224.748 / chi 1.043.425.747 | thu 1.062.123.948 / chi 1.038.067.947 | thu −2.100.800 / chi −5.357.800 | **THU** phân rã 100%: 2,1tr cọc 105-44TL web mới ghi 2tr/4,1tr + 800đ lẻ (406/1392 Excel dư 1.000; L03/405 +400; 403/403 −600). Cọc web tên chung chung khớp cụm phòng: "Khách cọc phòng"=403/1392 3,4tr; "Cọc phòng 3tr9"=306/102LVT; "renthouse"=103/1392 4tr; "HK house"=102/102LVT 4tr; "tiền cọc các nhà" 4 phiếu = L01 2,7tr + 401 1,9tr + 104 5tr + 10-481NVK 1,5tr. **CHI phân rã 100%** (loại cụm điện lạnh đã chứng minh bằng nhau rồi multiset lại — "±2tr chi vặt" chỉ là nhiễu phiếu con che nhau): +4.157.800 hoàn cọc TL 205/1392 nằm sổ CỌC (PC2607070); +2,6tr hoàn cọc 103/1392 CHƯA có phiếu (khách mới HD-2026-00027 chưa TL HĐ cũ); +1,2tr HH L03-417LVT = PC2605015 UNAPPROVED (duyệt là khớp); −2,4tr HH 00027 (PC2607017 15/07, Excel chưa ghi); −200k Thưởng deal (PC2607007 02/07, Excel không ghi). Kiểm: 4.157.800+2.600.000+1.200.000−2.400.000−200.000 = 5.357.800 ✓. Điện lạnh T4/T5/T6 (25/26/18 phiếu con = 5,3tr/8,52tr/5,66tr) + tiền nhà (72tr=46+26 ×2 đợt, 132tr=2×66tr) + mọi cụm HH+thưởng (HH tách thưởng nóng 500k) khớp từng đồng. |

## 8. Kênh TM ↔ sổ Hiệp Thu (TK000032)

Script riêng: `node scripts/doi-chieu-tm-hiepthu.mjs [file.xlsx] [YYYY-MM-DD]` — so cột
`khách đưa` − `thối lại` (T5 dùng cột `khách đưa TM` ĐÃ ròng) với sổ **Hiệp Thu**
(`e564eb1e-e47c-4c8f-92a1-76873b5bfb0e`).

Quy tắc riêng kênh TM (khác kênh 686):

- **Web ghi ĐỦ số hoá đơn, Excel ghi ròng-nghìn** (lẻ vào sổ "Làm tròn tiền thiếu") →
  script có vòng khớp dung sai <1.000đ; tổng lệch lẻ vài nghìn đ là bình thường.
- **Dòng ÂM ở cột khách đưa** = chi/bàn giao TM (bàn giao a Tâm/Huy, đóng điện nước…) →
  so với phiếu CHI của Hiệp Thu, không trộn vào thu.
- **Khoản nội bộ web có mà Excel không ghi (hợp lệ)**: nhận bàn giao TM từ quỹ khác
  (BG từ Huy/Tâm — có phiếu chi đối ứng trả lại), đổi tiền mặt↔CK (đối ứng chi TKHIEP),
  thu hộ người khác ("Thu dùm…", "…thu hộ" — người đó lấy lại bằng phiếu chi cùng cỡ tiền).
- **Excel T5 không ghi chi TM** (Nathan chỉ itemize chi từ T6) → chi T5 chỉ so 1 chiều web.
- Kiểm chứng vàng: **sheet đếm tiền mặt** (`Sheet2`/`kết tiền TX`, "ngày giờ chốt…") phải =
  tồn web Hiệp Thu (thu − chi APPROVED) tại thời điểm chốt. Sheet2 có thể có NHIỀU bảng đếm
  (nhiều túi/nhiều lần) — tổng các bảng mới là tồn TM.
- **Cuối mỗi sheet tháng có 2 dòng tổng tay KHÔNG nhãn** (dòng tổng cột khách đưa/thối lại +
  dòng net ghi thối lại số ÂM → net bị nhân đôi). Script đã loại theo luật mục 2 ("không nhãn
  toà lẫn nhãn phòng"); T6 thoát nạn nhờ chữ "tiền Hiệp" ở cột xa, T7/T8 thì không — đừng bỏ luật này.
- **Tồn TM theo sổ tay = dư tháng trước + thu − chi của sheet hiện hành** (dòng net cuối sheet),
  KHÔNG phải exThu − exChi cộng dồn từ T5 (Excel không itemize chi T5 nên hiệu cộng dồn vô nghĩa).

### Lịch sử chốt TM

| Ngày chốt | Đếm TM Excel | Tồn web Hiệp Thu | Chênh | Ghi chú |
|---|---:|---:|---:|---|
| 13/07/2026 13:20 | 129.991.000 | 129.991.000 | **0đ** | Thu khớp 100% (22 cặp lệch lẻ tổng 8.400đ + 303/405PVB lệch 2.600đ). T7 thu khớp tuyệt đối 408.160.000. Excel ghi "bàn giao a Tâm 129.991.000" (T7) — web CHƯA có phiếu bàn giao này; tạo phiếu thì quỹ về 0. Còn 4tr "Thu dùm Hiển 305+103/111PVC" (27/05) chưa có phiếu chi trả Hiển. 15 phiếu Hiệp Thu UNAPPROVED chờ xử lý (nghi trùng 3×1tr INV-2026-00055). |
| 11/08/2026 | 145.617.000 (đếm 06–07/08: 111.558.000 + 34.060.000 = 145.618.000, dư 1.000đ đếm) | 153.480.000 | **+7.863.000** | Phân rã 100% = 4 khoản: **+13.000.000** web thiếu phiếu chi "bàn giao a Huy" (Excel T8); **−6.053.000** web thiếu phiếu thu "thu dùm Hiển 302/111PVC" (Excel T8: 6.204.000 − thối 151.000); **+860.000** 101/403PVB INV-202606-651630 — web cộng đúng 1 lần (5 phiếu tạo 29/07: TKHIEP thu+hoàn tác, Hiệp Thu thu+hoàn tác, giữ lại Hiệp Thu 30/06) nhưng nằm SAI SỔ: Excel ghi CK cột `CKH - 686-TCB` sheet T7 (khớp phiếu TKHIEP gốc đã bị hoàn tác) → lệch đối xứng Hiệp Thu +860k / TKHIEP −860k; chốt bằng sao kê 686 quanh 30/06, nếu có CK thì trả phiếu về TKHIEP; **+56.000** INV-2026-00570 201/1392QT web ghi đủ 5.544.000, thực nhận 5.488.000 (thối 56k). Kiểm: 13.000.000−6.053.000+860.000+56.000 = 7.863.000 ✓. T8 thu còn lại khớp từng khoản (INV-00569 4tr = 106/1392QT, Excel có). Nước 15/22kv 1.642.000: web ghi 31/07, Excel ghi T8 — lệch thời điểm, tự triệt tiêu. BG a Tâm 129.991.000 đã có phiếu (BG2607003, 15/07). Vẫn treo: 4tr thu dùm Hiển T5 chưa có phiếu chi trả; 16 phiếu UNAPPROVED (thu 46.106.800 / chi 2.502.000 — duyệt hết thì web tồn +43.604.800, phải rà trùng trước khi duyệt). Sửa script: loại dòng tổng tay không nhãn cuối sheet (T7/T8 từng lọt, thổi phồng thu Excel 302tr). |
