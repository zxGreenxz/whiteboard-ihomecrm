# Quy tắc đối chiếu bảng chốt NABUBU (Hiển) ↔ sổ quỹ Hiển Thu trên web

> Đúc kết từ đợt đối chiếu chốt LẦN 1 T7/2026 (10/07/2026): chênh 2.835.823đ truy ra **đủ 100% nguyên nhân, khớp đến từng đồng**.
> Script tự động: `node scripts/doi-chieu-nabubu-hienthu.mjs [file.xlsx] [YYYY-MM-DD]`

## 1. Phạm vi & mapping quỹ

File Excel: `dataexcel/NABUBU T7-N.xlsx` — bảng chốt **tiền mặt** của **Hiển (Joey)**, cụm toà NABUBU
(32PVC, 158PVC, 80DS3, 111PVC, 162NVK, 417LVT, 65NTG).

| Trên Excel | Trên web |
|---|---|
| Cột `TIỀN MẶT` theo phòng | Phiếu THU sổ **Hiển Thu** (TK000031, id `dc45114c-734f-45aa-9946-bed05e0c9051`) |
| Khu `ỨNG TIỀN` (chi từ tiền đã thu) | Phiếu CHI sổ **Hiển Thu** (không tính phiếu Bàn giao) |
| Bảng mệnh giá × số tờ (góc phải) | = tiền đếm thực tế trong két |
| Phần khách chuyển khoản | Sổ **HKDHIEN / HKDHUY / TK939**… — KHÔNG nằm trong bảng này |

**Kỳ đối chiếu** = từ sau phiếu "Bàn giao tiền mặt → NG TÂM" gần nhất trong sổ Hiển Thu đến ngày chốt.
(Bàn giao quét đúng số dư luỹ kế — 01/07/2026 bàn giao 283.191.333 = chính xác net T5+T6.)

## 2. Quy tắc đọc Excel (phía bảng chốt)

- 1 sheet duy nhất, header `TÒA NHÀ | PHÒNG | TIỀN MẶT | THỐI TIỀN | GHI CHÚ`; tên toà chỉ ghi ở dòng đầu mỗi cụm (carry-down).
- `NGÀY/GIỜ CHỐT` là serial Excel bị **US-locale**: Hiển gõ `10/7` (10 tháng 7) → Excel hiểu `Oct 7`. Đừng tin cell này, hỏi ngày chốt thật.
- Khu `ỨNG TIỀN`: số tiền nằm ở **cột PHÒNG**, diễn giải ở cột GHI CHÚ. 1 khoản ứng có thể = nhiều phiếu chi trên web (vd 6tr công an = 6 phiếu 1tr).
- Dòng `TỔNG` (cột trái) = tổng phòng − tổng ứng = tổng bảng mệnh giá. Script tự kiểm cả 3 số này với nhau.
- Hiển ghi số **khách đưa**, thường KHÔNG trừ thối và hay làm tròn nghìn → lệch lẻ ≤ vài nghìn/phòng là bình thường (xem mục 5).
- File hay bị Excel lock → luôn copy ra temp rồi mới đọc (script đã làm).

## 3. Quy tắc phía web

- Chỉ tính phiếu `approval_status='APPROVED'` và `deleted_at is null`; loại phiếu Bàn giao (`handover_transfer_id`/tên `Bàn giao%`) khỏi tổng chi.
- `total_amount` phiếu thu là **số ròng đã trừ thối** (`change_amount` ghi riêng) → két của Hiển sẽ DƯ đúng bằng tiền thối chưa thối cho khách.
- ⚠ `income_expenses.code` **KHÔNG unique toàn cục** — `PT2607100` tồn tại ở cả sổ TKHIEP (Nathan) lẫn Hiển Thu (Joey). Tra phiếu phải kèm `account_id`.
- ⚠ `invoices.billing_month` là **TEXT `'YYYY-MM'`** — lọc `= '2026-07'`, đừng so `>= '2026-07-01'` (so chuỗi sẽ loại oan hết).
- 1 hoá đơn hay được đóng **2 kênh**: CK vào HKDHIEN/HKDHUY + TM vào Hiển Thu (vd 202/111PVC tháng nào cũng 3,6tr CK + 2tr TM). Phần TM lẻ (1.999.500…) là "phần còn lại sau CK", khách đưa chẵn.

## 4. Quy trình (nhanh nhất)

1. `node scripts/doi-chieu-nabubu-hienthu.mjs "dataexcel/NABUBU T7-1.xlsx" 2026-07-10`
2. Script tự: đọc Excel + tự kiểm nội bộ (danh sách − ứng = bảng mệnh giá) → tìm bàn giao gần nhất → kéo phiếu kỳ đó → khớp THU theo (toà, phòng) multiset + khớp ỨNG/CHI theo tiền.
3. Đọc bảng `LỆCH THU theo phòng`: mỗi dòng là 1 nguyên nhân phải gọi tên được. Dòng `KIỂM CHỨNG` cuối phải khớp (tồn web − tiền đếm = −Net THU).
4. Với từng khoản lệch: tra hoá đơn phòng đó (`billing_month='YYYY-MM'`) + phiếu mọi sổ của phòng đó trước khi kết luận.

## 5. Bẫy thường gặp (đúc kết 10/07/2026)

| Hiện tượng | Nguyên nhân thật | Cách xử lý |
|---|---|---|
| Web có phiếu TM tiền to, két không có | Phiếu **tháng đầu (cọc + tiền nhà)** tạo lúc chốt HĐ, tiền thật có thể là CK hoặc Hiển giữ ngoài két | Check sao kê + hỏi người thu; nếu CK → đổi phiếu sang đúng sổ bank |
| Excel có 1 phòng ghi 2 dòng cùng tiền | HĐ phòng đó đã PAID đủ trên web → dòng 2 là **phòng khác gõ nhầm số phòng** (tiền có thật trong két) | Dò các phòng cùng cụm **chưa có phiếu thu nào** + còn nợ HĐ, hỏi người thu rồi tạo phiếu cho đúng phòng |
| Phiếu web > Excel đúng cỡ trăm nghìn, hoá đơn hiện **dư âm** (paid > total) | Người tạo phiếu gõ số **làm tròn từ tổng hoá đơn** (6.273.000 → gõ 6.300.000) trong khi khách đưa số khác (6.000.000) | Sửa phiếu về số thực nhận; hoá đơn tự về PARTIAL/nợ |
| Excel > web vài nghìn ở phòng có `thối=` | Web đã net tiền thối, Hiển chưa thối cho khách (tiền còn trong két) | Thối khách là khớp; không sửa web |
| Lệch ±500đ | Khách đưa chẵn, phần-còn-lại-sau-CK của hoá đơn lẻ 500đ (1.999.500 / 2.000.500 / 4.152.500) | Chấp nhận, đã định danh; hoặc dùng cơ chế "Làm tròn tiền thiếu" |

## 6. Lịch sử chốt

| Ngày chốt | Kỳ | Tiền đếm (Excel) | Số dư web Hiển Thu | Chênh | Phân rã |
|---|---|---:|---:|---:|---|
| 10/07/2026 | sau BG 01/07 (283.191.333) | 105.133.000 | 107.968.823 | **2.835.823** | −4.540.323 (101/80DS3 PT2607100 tháng đầu, két không có) +2.000.000 (dòng "202/111PVC" thứ 2 — nghi 203/111PVC nợ 4.003.500 chưa có phiếu) −300.000 (301/65NTG phiếu 6,3tr vs HĐ 6.273.000 vs khách đưa 6tr — HĐ đang dư ảo −27.000) +5.000 (thối 162NVK 301/402 chưa thối) −500 (lẻ 500đ ×3) |

### Việc cần chốt với Hiển sau đợt 10/07/2026

1. **PT2607100 — 4.540.323 (101/80DS3 tháng đầu, 09/07)**: tiền đâu? Khách cọc giữ chỗ trước đó CK 1,5tr vào TK939 (29/06) → khả năng tháng đầu cũng CK. Nếu CK: đổi phiếu sang sổ bank nhận tiền. Nếu TM Hiển giữ riêng: nộp két + bổ sung dòng Excel.
2. **Dòng "202/111PVC" 2.000.000 thứ 2**: phòng nào đưa? Ứng viên chưa có phiếu + còn nợ: **203/111PVC (nợ 4.003.500)**, 202/65NTG (4.269.500), 203/158PVC (4.241.500). Xác định xong tạo phiếu thu TM cho đúng phòng.
3. **PT2607074 — 301/65NTG**: khách đưa 6.000.000 hay 6.300.000? HĐ chỉ 6.273.000 (đang dư ảo −27.000). Nếu 6tr: sửa phiếu = 6.000.000, khách nợ 273.000 (khách này T6 cũng từng đóng thiếu rồi bù 63.000 sau).
4. Thối khách 162NVK: 301 thối 4.000, 402 thối 1.000.
