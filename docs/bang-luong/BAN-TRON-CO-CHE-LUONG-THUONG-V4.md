# Bàn tròn v4 — Hai pool: Chuyên cần 6tr + Streak 3tr = 9tr

> **ĐỔI HOÀN TOÀN cấu trúc tiền** theo yêu cầu chủ: lương = **CHUYÊN CẦN 6.000.000đ** (theo tổng ngày-công) + **CHUỖI STREAK 3.000.000đ** (theo chuỗi liên tiếp) = **9.000.000đ** tối đa. Bỏ cấu trúc "4 cứng + 4 mềm" của v3.
>
> **GIỮ NGUYÊN nền v3** (bạn đã xác nhận): ① bỏ hết lương cơ sở/BHXH/tối thiểu vùng; ② tuần T2–T7, CN nghỉ, 26 ngày-làm; ③ "Khiên dự trữ". Cùng: ngày-công binary qua cổng ảnh + geofence, gain-framing, thu tiền bấm+GPS, kiểm tra nhà = phiếu công việc.
>
> Nền: [BAN-TRON-CO-CHE-LUONG-THUONG-V3.md](BAN-TRON-CO-CHE-LUONG-THUONG-V3.md) · Kỹ thuật: [THIET-KE-BANG-LUONG-KPI-GAMING.md](THIET-KE-BANG-LUONG-KPI-GAMING.md).
>
> Cập nhật: 2026-07-01.
> · **v4.1:** chuyên cần full 6tr = **đủ 26 ngày** (thay 22) — đơn giá ~231k/ngày.
> · **v4.2:** (a) **1 ngày phép có lương/tháng** (12/năm) — tính như ngày công cho chuyên cần + bắc cầu streak; (b) **mốc streak đỉnh nâng 20 → 26 (trọn tháng)** — dùng đúng 1 ngày phép vẫn đạt. Xem §B.2/§B.3/§B.4/§B.5.

---

## ⚠️ v4 đảo ngược một nguyên tắc lớn của v1–v3

Suốt v1→v3, cả hội đồng **chốt "streak phải NHỎ (≤1tr), phi-tiền, không phải tiền-sống"** — chính để chống presenteeism. Yêu cầu v4 (streak = **3tr**, một trụ thu nhập lớn) **phá thẳng** kết luận đó. Hội đồng chỉ đồng ý bật v4 khi có **3 phát minh khoá an toàn**:

| Vấn đề v4 tạo ra | Phát minh khoá |
|---|---|
| Streak 3tr treo trên chuỗi → lỡ 1 ngày bay 3tr → bom presenteeism | **BEST-STREAK / banked-không-rơi:** tiền neo vào chuỗi-dài-nhất-ĐÃ-đạt; đạt mốc rồi đứt **VẪN GIỮ** tiền. Đứt = PAUSE, không LOSS. |
| 9tr treo hết trên hiệu suất → thu nhập dao động 0–9tr = lo âu | **CÓ SÀN 3tr** (nằm trong pool chuyên cần) — người đi-làm-thật đáy ~6tr, không rơi tự do. |
| Chuyên cần + streak cùng suy từ ngày-công → trả 2 lần? | **Tách trục đo:** chuyên cần = `COUNT(ngày)` (khối lượng); streak = `MAX(chuỗi liên tiếp)` + `đứt=0` (độ đều). Hai đại lượng toán độc lập. |

**Đường lui bắt buộc:** nếu vận hành lộ presenteeism vượt ngưỡng → **đảo về v3** (streak nhỏ ≤1tr, dồn tiền sang chuyên cần, giữ tổng 9tr). v4 là canh bạc **có kiểm soát**.

---

# PHẦN A — Tranh luận cốt lõi: Streak 3tr — kỷ luật hay bom presenteeism?

**CHRO:** Chủ muốn streak 3tr. Được, nhưng chỉ khi nó là **best-streak** — chuỗi-dài-nhất-đã-đạt-trong-tháng, đạt rồi đứt vẫn giữ tiền. Nếu dùng **current-streak** kiểu game mobile — đứt-là-bay-3tr — tôi **phủ quyết toàn bộ v4**. Chính tôi ở v1 đã ép streak xuống ≤1tr vì presenteeism; treo 3tr lên "chuỗi đang sống" là gắn lại quả bom và tăng thuốc nổ gấp ba.

**Game Designer:** Đồng ý 100% — tôi gọi là **banked-không-rơi**. Mỗi mốc chạm được là tiền "đóng băng vĩnh viễn trong tháng". Đứt = PAUSE, không LOSS. Loss-aversion là chất gây nghiện engagement nhưng cũng là chất độc đẩy người đi làm ốm. Tôi giữ engagement bằng thanh-đang-đầy, giết độc bằng: **đã leo là không tụt**.

**CFO:** Khoan — hai bạn giải presenteeism giỏi nhưng đẻ ra bài của tôi: **đo-trùng**. Nếu banked + CN bắc cầu tự động, người đi làm đều 22 ngày **gần như luôn** có chuỗi 22 liên tiếp → streak thành pool tự-đầy = **lương cứng trá hình**. Tôi cho chủ +12,5% quỹ mà không mua thêm giá trị nào.

**CHRO:** Câu trả lời ở **tách trục đo**. Chuyên cần đếm TỔNG ngày (cardinality). Streak đếm chuỗi-liên-tiếp-dài-nhất (topology). 20 ngày rải rác = full chuyên cần 6tr nhưng streak thấp.

**CFO:** Nhưng CN bắc cầu **xoá** phần lớn sự rải rác — nghỉ CN không đứt thì chỉ cần đi T2–T7 đều là chuỗi chạy suốt. Rải rác thật chỉ khi nghỉ **giữa tuần**. Bạn chắc median độ-đứt đủ lớn để streak không tự-đầy?

**Game Designer:** Đó là câu hỏi Phase 0, không phải triết lý. Một ngày nghỉ giữa tuần vì con ốm — không phép, không khiên — là đứt. Người 22 ngày đứt 1 lần → chuyên cần ~6tr, streak chỉ chạm mốc 14 ≈ 1,6tr. Chênh 1,4tr. Không tự-đầy.

**Quản lý:** Cho tôi chen — tôi **sống bằng đúng bảng lương này**. Với tôi nó là: tháng con nhập viện 3 ngày, tôi mất gì? Tôi chốt phân định: chuyên cần đọc `COUNT(ngày)`, streak đọc `MAX(chuỗi)` **cộng** điều kiện `đứt = 0`. Cái `đứt = 0` là phần **rõ ràng nhất KHÔNG trùng** — chuyên cần hoàn toàn mù với nó. Tách 600k cuối thành thưởng "tháng không đứt".

**CEO:** Ủng hộ, nhưng siết lằn ranh: **cấm all-or-nothing**. Không mốc lẻ nào >600k. Nếu mốc cuối chiếm 1,5tr thì đứt tuần cuối = mất cú lớn = kích tâm lý con bạc gỡ. Chia ≥5 mốc; đứt giữa tháng chỉ tụt một bậc ~600k, khiên vá được. Không vực thẳm.

**CSKH:** Tôi kéo cả phòng khỏi bàn giấy — các bạn quên **người thứ ba: khách hàng**. 3tr treo trên "đừng đứt chuỗi" → người ta đi làm bằng-mọi-giá kể cả khi ốm/cáu, và chính ngày đó họ phục vụ khách **tệ nhất** mà vẫn tick đủ ngày-công.

**Game Designer:** Banked-không-rơi giải cái đó — đã leo là giữ, không còn động cơ lết đi làm ốm để "cứu" chuỗi.

**CSKH:** Sai một nửa. Banked cứu người ĐÃ chạm mốc. Nhưng người ở ngày thứ 15, cách mốc 16 đúng **một ngày** — có động cơ khổng lồ lết đi làm để chốt 600k. **Presenteeism không chết, nó dời tới rìa mỗi mốc.** Tôi đòi streak đếm ngày-**SẠCH**: ngày dính khiếu nại thái độ xác minh được → không nối chuỗi. Phạt sự THÔ LỖ, không phạt sự ốm.

**CHRO:** Thích, nhưng cảnh báo: nếu ngày-bẩn làm mất tiền, nhân viên sẽ **giấu khiếu nại**.

**CSKH:** Đã chặn: khiếu nại chỉ chặn phần **at-risk** của ngày đó, KHÔNG động sàn 3tr; kênh khiếu nại về thẳng owner/Zalo, không qua tay người bị khiếu nại.

**CFO:** Vũ khí diệt presenteeism tận gốc là **phép-duyệt miễn phí đóng băng chuỗi**. Ốm mà báo = đóng băng, không tính đứt → **đảo động cơ: báo ốm CÓ LỢI hơn giấu ốm**.

**Quản lý:** ĐÚNG, nhưng nó đổ gánh hành chính lên đầu TÔI. Với 3tr treo, tôi **quên duyệt một lần** = nhân viên hận cả tháng. Đòi hai lớp: phép-duyệt **1-chạm** + best-streak (quên duyệt thì tiền đã chốt vẫn còn). Đừng để cả kiến trúc phụ thuộc việc tôi bấm nút đúng giờ.

**Game Designer (khiên):** Nâng tương xứng 3tr: free 3/tháng, dự trữ tiêu 2/tháng.

**CSKH:** PHẢN ĐỐI nới tiêu lên 2 — khi 1 khiên đáng 600–900k, farm khiên trở nên đáng tiền. Giữ cap tiêu **1**, kiếm 1, tồn 2.

**CEO:** Thoả hiệp: bật cap tiêu 2 trong Phase 0, **monitor "% người chạm mốc nhờ vá khiên"**; vượt 70% → siết về 1. Van hai chiều, quyết bằng dữ liệu không bằng niềm tin.

**CFO:** Điều kiện cuối: 3 tháng **shadow** trả đủ 9tr, đo phân bố **best-streak thực** trước khi khoá mốc. Trung vị <12 ngày → 3tr thành **bánh vẽ** → HẠ mốc. NÂNG thì không.

**CHRO:** Cùng dữ liệu, cảnh báo ngược: >60% full streak → **lương cứng trá hình** → siết full. Dải an toàn nằm GIỮA "bánh vẽ" và "lương cứng".

**➤ ĐỒNG THUẬN:** best-streak/banked (cấm current-streak); reset theo tháng; ≥5 mốc bậc thang, mốc lẻ ≤600k, trần cứng 3tr; tách trục đo COUNT vs MAX; phép-duyệt miễn phí = vũ khí #1; khiên free 3/tháng + dự trữ (cap tiêu mở Phase 0); shadow ≥3 tháng; gain-framing tuyệt đối.

**➤ CÒN MỞ:** bộ mốc chính xác (5 đề xuất lệch nhau); ngày-điểm-danh vs ngày-SẠCH (cổng chất lượng); cap tiêu khiên 1/2; **presenteeism-ở-rìa-mốc** (chưa có lớp riêng ngoài phép/khiên); pro-rate Tết.

*(Hai điểm căng còn lại — "có sàn không" và "cơ chế 2 pool" — hội đồng chốt: **CÓ SÀN 3tr bắt buộc** (CFO/CHRO/QuanLy/GameDesigner đều phủ quyết 9tr all-at-risk); và **COUNT vs MAX-run** là bằng chứng toán chống đo-trùng, xác nhận bằng worked example ② vs ①.)*

---

# PHẦN B — CƠ CHẾ v4 (bản chốt, sẵn build)

## B.1 — Cấu trúc 9tr

```
                        LƯƠNG THÁNG (trần 9.000.000đ)
        ┌──────────────────────────────────┬──────────────────────────┐
        │      POOL CHUYÊN CẦN = 6tr        │     POOL STREAK = 3tr      │
        │      (đo TỔNG ngày = COUNT)       │  (đo MAX chuỗi liên tiếp) │
        ├──────────────────┬───────────────┤                           │
        │  SÀN MỀM 3tr     │  LEO 3tr      │   BẬC THANG banked         │
        │  (tuỳ chọn,      │  (~231k/ngày, │   6 mốc, best-of-month,    │
        │   khi ≥13 ngày)  │   đủ 26 = 6tr)│   reset mỗi tháng, ≤600k/mốc│
        │  ← chống turnover│  ← at-risk    │   ← at-risk, KHÔNG sàn      │
        └──────────────────┴───────────────┴──────────────────────────┘
              ↑ tiền-để-SỐNG                    ↑ thưởng ĐỘ-BỀN đã chứng minh
              (nhìn hiện tại)                    (nhìn quá khứ, đã khoá)

Rủi ro: ~1/3 (3tr sàn) CHỦ gánh (bảo hiểm chống turnover) · ~2/3 at-risk theo hành vi
Dải dao động THỰC của người đi làm đều = 6–9tr (KHÔNG phải 0–9tr)
```

> **Một câu:** *Chuyên cần mua "đủ số buổi"; streak mua "đều đặn không ngắt quãng". Sàn giữ tiền-sống an toàn để nhân viên chơi phần thưởng thoải mái, không phòng thủ độc hại.*

## B.2 — CHUYÊN CẦN → 6tr

**Tham số** (config `salary_bonus_rules.rules.attendance`, KHÔNG hard-code):

| Tham số | Giá trị | Ghi chú |
|---|---|---|
| `DENOM` | 26 | ngày-làm T2–T7, CN không tính |
| `FULL_DAYS` | **26** | **đủ 26 ngày-công = full 6tr** — chuyên cần THẬT = đi làm đủ (chủ chốt, thay 22) |
| `RATE_PER_DAY` | **230.769đ** (~231k) | = 6.000.000 / 26 |
| `FLOOR_SOFT` | 3.000.000đ khi ngày-công ≥ 13 | sàn MỀM tuỳ chọn (linear đã cho đúng 3tr tại 13 ngày; sàn chỉ nâng người 8–12 ngày) |

```
attend_pay = 6.000.000 × clamp(ngày_công_THẬT / 26, 0, 1)
             [+ tuỳ chọn sàn: max(.., 3.000.000) nếu ngày_công ≥ 13]   ← chống turnover
```

- **Đủ 26 ngày → full 6tr.** Mỗi ngày đi làm thật ≈ **231k**; thiếu ngày nào bớt ngày đó (chuyên cần = tiền TRẢ THEO NGÀY ĐI LÀM).
- **Nghỉ CÓ PHÉP — 1 ngày/tháng có lương (12/năm):** ngày phép-duyệt (tối đa 1/tháng) tính **NHƯ ngày công** → KHÔNG trừ ~231k. Tức "đủ 26" = ngày-công-thật + ngày-phép-có-lương (≤1/tháng). Đi làm 25 ngày + 1 phép = 26 → **full 6tr**. Đồng thời phép bắc cầu STREAK (không đứt chuỗi). Nghỉ **quá** 1 ngày/tháng → trừ ~231k/ngày như thường. *(Chọn: 12 ngày/năm cho DỒN chưa dùng hay hết-tháng-mất? Mặc định 1/tháng không dồn để tránh dồn 12 vào 1 tháng.)*

| ngày-công | 8 | 10 | **13** | 16 | 18 | 20 | 22 | 24 | **26** |
|---|---|---|---|---|---|---|---|---|---|
| **chuyên cần** | 1,85tr | 2,31tr | **3,00tr** | 3,69tr | 4,15tr | 4,62tr | 5,08tr | 5,54tr | **6,00tr** |

*(Sàn mềm bật: cột 8→3,00tr, 10→3,00tr; ≥13 giữ nguyên như trên.)*

## B.3 — STREAK → 3tr (best-of-month, banked, reset tháng)

- **Đơn vị:** chuỗi ngày-làm liên tiếp **DÀI NHẤT trong tháng** (best-of-month), CN bắc cầu tự động.
- **Banked-không-rơi:** chạm mốc → tiền đóng băng vĩnh viễn trong tháng. Đứt = PAUSE (dừng leo), KHÔNG rớt về mốc thấp. Chuỗi mới có thể leo lại mốc cao hơn.
- **Reset theo THÁNG** (không tích luỹ liên-tháng — giới hạn "nỗi đau tối đa" trong 1 chu kỳ). Dedup `(staff, mốc, YYYY-MM)`. Trần cứng 3tr enforce ở RPC LOCK.

**Mốc bậc thang — đỉnh = TRỌN THÁNG 26 (v4.2, nâng từ 20; khớp full-month của chuyên cần):**

| Mốc (chuỗi ngày-làm liên tiếp) | 4 ngày | 8 ngày | 13 ngày | 18 ngày | 23 ngày | **26 = Trọn tháng** |
|---|---|---|---|---|---|---|
| **Delta** | +300k | +500k | +600k | +600k | +500k | **+500k** |
| **Cộng dồn** | 300k | 800k | 1.400k | 2.000k | 2.500k | **3.000k = FULL** |

- **Mốc "Trọn tháng" (+500k = full 3tr)**: trả khi số lần đứt-**KHÔNG-phép** trong tháng = **0** (CN + 1 ngày phép/tháng bắc cầu, KHÔNG tính đứt). Tức đi làm cả tháng T2–T7 đều đặn, **dùng đúng 1 ngày phép của mình vẫn đạt trọn tháng**. Đây là phần **rõ nhất KHÔNG trùng chuyên cần** — thưởng cho đại lượng `đứt=0`, thứ COUNT(ngày) hoàn toàn mù.
- **Vì sao đỉnh 26 (không phải 20):** hội đồng để 20 làm đệm chống presenteeism; nhưng khi đã có **1 ngày phép/tháng + best-streak-banked + khiên** bảo vệ nghỉ chính đáng, đòi trọn tháng KHÔNG còn ép đi-làm-ốm → đỉnh 26 mới đúng nghĩa "thưởng kỷ luật thật".
- Đứt giữa tháng chỉ tụt tối đa 1 bậc ~600k, khiên vá được → **không có vực thẳm**.

**Chống đo-trùng (volume vs consistency):**

| | CHUYÊN CẦN | STREAK |
|---|---|---|
| Đại lượng toán | `COUNT(ngày)` | `MAX(chuỗi liên tiếp)` + `đứt=0` |
| Ý nghĩa | KHỐI LƯỢNG có mặt | TÍNH ĐỀU ĐẶN |
| 26 ngày RẢI RÁC (nhiều đứt) | full 6tr | mốc thấp ~0,8tr |
| 26 ngày LIỀN MẠCH (trọn tháng) | full 6tr | full 3tr |

Cùng `COUNT=26`, streak chênh ~2,2tr vì `MAX-run` khác → 2 truy vấn khác biến, không ngày nào ghi sổ 2 lần. 2 dòng `salary_adjustments` source riêng (`ATTENDANCE` / `STREAK_v4`).

## B.4 — Chống presenteeism khi streak = 3tr (6 lớp)

| # | Lớp | Cơ chế |
|---|---|---|
| 1 | **BEST-STREAK (mạnh nhất)** | Tiền neo vào chuỗi-dài-nhất-ĐÃ-đạt. Chốt mốc rồi đứt KHÔNG mất tiền → triệt gốc "đi làm ốm giữ chuỗi". |
| 2 | **SÀN 3tr** | Mất toàn bộ streak vẫn còn sàn. Người đi-làm-thật đáy ~6tr. "Mất chuỗi" ≠ "mất sống". |
| 3 | **KHIÊN generous** | Miễn phí **3/tháng** (v3: 2). Khiên dự trữ cap tồn 3, kiếm 1/tháng (2 CN→+1 / off ≤1→+1). **Cap tiêu = mở ở Phase 0** (bật 2, siết về 1 nếu >70% chạm mốc nhờ vá). |
| 4 | **PHÉP CÓ LƯƠNG 1 ngày/tháng (vũ khí #1)** | **1 ngày phép có lương/tháng (12/năm)**: xin phép + duyệt (1-chạm) → ngày đó (a) **tính NHƯ ngày công cho chuyên cần** (KHÔNG trừ ~231k) + (b) **bắc cầu chuỗi** (không đứt). **Báo ốm CÓ LỢI hơn giấu ốm.** Nghỉ quá 1 ngày/tháng: trừ chuyên cần bình thường, chuỗi cần khiên/best-streak. best-streak bảo hiểm khi quản lý quên duyệt. |
| 5 | **KHÔI PHỤC trong tháng** | Đứt → "chuỗi mới 🔥" từ 0; mốc đã chốt GIỮ + leo lại mốc cao hơn (best-of-month). Mất không vĩnh viễn. |
| 6 | **CỔNG CHẤT LƯỢNG (CSKH — Phase 2)** | Ngày-SẠCH: kiểm-tra-nhà điền "Tình trạng nhà"; ngày dính khiếu nại thái độ (owner duyệt) → không nối chuỗi + không at-risk, NHƯNG **KHÔNG động sàn 3tr** (chống giấu khiếu nại). |

**Chống farm khiên:** cap kiếm 1/tháng bất-khả-thương-lượng; nguồn CN chặn ở CẶP (2 CN→+1, CN 3-4=0); banner "CN là ngày nghỉ, không làm CN KHÔNG mất gì"; monitor "% làm ≥3 CN/tháng" >25% → gỡ nguồn CN.
**Chống cờ-bạc:** reset tháng + banked + mốc rời rạc (thông tin đầy đủ) = progression, KHÔNG gambling. Push 19:00, tắt 21h–7h.

## B.5 — Worked example (5 chân dung, tháng 26 ngày-làm)

| Chân dung | ngày-công | chuỗi dài nhất | **Chuyên cần** | **Streak** (mốc 4/8/13/18/23/26) | **TỔNG** |
|---|---|---|---|---|---|
| **① SIÊNG** — đủ 26 ngày (hoặc 25 + 1 phép) liền mạch | 26 | 26, đứt=0 | 6,00tr | 3,00tr (trọn tháng, đủ mốc) | **9,00tr** |
| **② BÌNH THƯỜNG** — 22 ngày, đứt 1–2 lần | 22 | 16 | 5,08tr | 1,40tr (mốc 4+8+13) | **6,48tr** |
| **③ ĐỦ-SỐNG** — 18 ngày, ngắt quãng | 18 | 8 | 4,15tr | 0,80tr (mốc 4+8) | **4,95tr** |
| **④ ĐI-CHO-CÓ** — 13 ngày, rải rác | 13 | 4 | 3,00tr | 0,30tr (mốc 4) | **3,30tr** |
| **⑤ ỐM-CÓ-PHÉP** — 13 làm + 1 phép, chuỗi được freeze | 14 (13+phép) | 12 | 3,23tr | 0,80tr (mốc 4+8) | **4,03tr** |

- **Xuất sắc = 9tr** chỉ khi đi **đủ 26 ngày liền mạch** (①) — dùng đúng 1 ngày phép/tháng vẫn đạt trọn tháng nhờ bắc cầu. Đúng ý "trần cho người xuất sắc".
- **Bình thường ~6,5tr** (②): 22 ngày ngắt quãng, thiếu 4 ngày chuyên cần + streak chỉ tới mốc 13 (chưa trọn tháng) → **bằng chứng chống đo-trùng** (streak phân biệt độ-đều).
- **Lười rớt RÕ**: ④ ~3,3tr (13 ngày); ③ 4,95tr — tín hiệu sớm.
- **Không ai rơi tự do**: ⑤ ốm-có-phép vẫn 4,4tr nhờ sàn mềm + best-streak được freeze bảo vệ (phép giữ streak 3tr, chỉ mất tiền-công những ngày nghỉ).

## B.6 — Tích hợp kỹ thuật

> Đọc lại schema thật trước khi viết migration (`salary_streak_state`, `salary_attendance_day`, `salary_adjustments`, `salary_monthly`, `salary_bonus_rules`). RPC sinh mã phải SECURITY DEFINER + search_path + advisory lock (mẫu `generate_job_code`, xem memory `project_code_generator_secdef_rls`).

| Bảng | Cột / thay đổi | Vai trò |
|---|---|---|
| `salary_bonus_rules` | `rules` jsonb ← khối `attendance_v4` + `streak_v4` (mốc, FLOOR_DAY, FULL_DAYS, sàn, delta) | Config-driven |
| `salary_attendance_day` | (giữ) `staff_id, work_date, is_valid_day, source_gate` | Nguồn ngày-công BINARY cho CẢ 2 pool |
| `salary_streak_state` | thêm `best_streak_in_month, current_streak, breaks_count, shields_free_used, shields_reserve, shields_reserve_used, frozen_days` | Trạng thái best-of-month + khiên/freeze |
| `salary_adjustments` | `source` ∈ {`ATTENDANCE`, `STREAK_v4`}; dedup `(staff, milestone_code, period_month)` | **2 dòng source riêng** — chống trùng ở tầng LOCK |
| `salary_monthly` | `attend_pay, streak_pay, floor_applied, streak_full` | Snapshot chốt khi LOCK |

**RPC:**
- `salary_compute_attendance_v4(staff, month)` — COUNT ngày → sàn + leo. **Chỉ đọc COUNT.**
- `salary_compute_streak_v4(staff, month)` — MAX(chuỗi) qua CN-bridge + freeze/khiên → best-of-month → duyệt mốc, dedup, trần 3tr. **Chỉ đọc MAX + breaks.**
- `salary_lock_month_v4(staff, month)` — gọi cả 2, ghi 2 dòng `salary_adjustments`, snapshot, enforce trần streak ≤3tr.
- `salary_apply_shield` / `salary_freeze_leave` — vá 1 ngày (cap) / đóng băng qua phép-duyệt. `award_*` PHẢI log lỗi.

## B.7 — Phase 0 + Còn mở

**Phase 0 (BẮT BUỘC trước khi bật công tắc tiền):**
- **Shadow ≥3 tháng:** trả đủ 9tr bất kể điểm, chỉ hiện thanh tiến trình.
- **Geofence ≥90% chuẩn** trước khi bật tiền.
- **Đo phân bố thực:** trung vị ngày-công, phân bố **best-streak**, độ-đứt-chuỗi, % dùng khiên.
- **Van hai chiều (chỉ HẠ, KHÔNG NÂNG trên dữ liệu):**
  - `FULL_DAYS = 26` là **chủ chốt** (chuyên cần thật = đủ 26 ngày). Phase 0 chỉ HẠ nếu trung vị người-làm-thật quá thấp khiến "đủ 26" thành bất khả (kẻo cắt lương ngầm) — cân với ý "phải đủ mới full".
  - Trung vị best-streak < 12 → HẠ mốc streak (kẻo 3tr thành "bánh vẽ").
  - >60% full streak → siết mốc (kẻo lương cứng trá hình).
  - >70% chạm mốc nhờ vá khiên → siết cap tiêu về 1.

**Còn mở (cần chủ quyết / Phase 0 chốt):**

| # | Vấn đề | Phương án | Ai quyết |
|---|---|---|---|
| 1 | **Mức sàn** | 2tr / 2,4tr / **3tr (tạm)** / 4,5tr | Chủ (khẩu vị chi phí cố định × N) |
| 2 | **Sàn mềm bật/tắt + ngày kích** | tắt (pure linear) / bật @ 13 ngày **(tạm bật)** | Chủ |
| 3 | **Đơn giá chuyên cần** | **230.769đ (~231k)** = 6tr/26 — CHỐT theo FULL=26 | (hệ quả FULL=26) |
| 4 | **FULL_DAYS** | **26 (CHỦ CHỐT — chuyên cần thật)**; chỉ hạ nếu Phase 0 cho thấy median bất khả | Chủ |
| 4b | **Phép có lương (CHỦ CHỐT v4.2)** | **1 ngày/tháng, 12/năm** — tính như ngày công + bắc cầu streak. Mở: cho DỒN trong năm hay hết-tháng-mất (mặc định không dồn) | Chủ |
| 5 | **Bộ mốc streak (CHỦ CHỐT đỉnh 26)** | **4/8/13/18/23 + trọn-tháng-26** (delta 300/500/600/600/500/500); tinh chỉnh vị trí mốc theo Phase 0 phân bố best-streak | Phase 0 |
| 6 | **Ngày-công thường vs SẠCH** | MVP thường / Phase 2 cổng chất lượng | Đồng thuận (CSKH đòi) |
| 7 | **Cap tiêu khiên** | 1 / **2 (van Phase 0)** | Dữ liệu |
| 8 | **Presenteeism-ở-rìa-mốc** | chưa có lớp riêng ngoài phép/khiên | Thiết kế thêm |
| 9 | **Pro-rate tháng lễ/Tết** | scale DENOM/mốc, hoặc phép-duyệt-full thủ công | Chưa có công thức |

**Đường lui:** nếu presenteeism vượt ngưỡng (metric "% ngày-công có phép-duyệt bị bỏ", "% làm ≥3 CN/tháng", đơn khiếu nại sức khoẻ) → **đảo về v3** (streak ≤1tr phi-tiền, chuyển tiền streak sang chuyên cần, giữ tổng 9tr).

---

## Tóm tắt cho chủ doanh nghiệp (v4)

*"Chuyên cần **~231k mỗi ngày đi làm**, **đủ 26 ngày = full 6tr** (được 1 ngày phép/tháng không bị trừ) → **cộng tối đa 3tr** thưởng nếu đi làm ĐỀU liền mạch cả tháng (mốc 4/8/13/18/23 + **trọn tháng 26**). **Đã leo mốc nào là khoá mốc đó** — đứt sau đó KHÔNG mất. Tối đa 9tr."*

- **Người siêng (đủ 26 ngày liền, hoặc 25 + 1 phép) = 9tr.** Bình thường (22 ngày) ~6,5tr. Đi-cho-có (13 ngày) ~3,3tr.
- **1 ngày phép/tháng (12/năm):** ngày phép tính như ngày công (không trừ chuyên cần) + bắc cầu chuỗi → nghỉ đúng ngày phép của mình vẫn đủ 9tr. Nghỉ quá mới trừ.
- **Đỉnh streak = trọn tháng 26** (không phải 20) vì nghỉ chính đáng đã được phép + best-streak-banked + khiên bảo vệ → thưởng cho kỷ luật thật.
- **Streak an toàn nhờ "best-streak banked"** (đạt rồi giữ) + sàn + phép-duyệt đóng băng → không biến 3tr thành áp lực đi-làm-ốm.
- **Bắt buộc 3 tháng shadow** (trả đủ 9tr, chỉ hiện thanh) để đo phân bố ngày-công + chuỗi thực rồi mới chốt mốc/ngưỡng. Có **đường lui về v3** nếu lộ presenteeism.

Thư mục `docs/bang-luong/`: kỹ thuật · bàn tròn v1 · v2 · v3 · **v4** (bản này).
