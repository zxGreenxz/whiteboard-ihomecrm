# Bàn tròn v3 — "LEO 4 LÊN 8" bản thuần lương + Khiên dự trữ streak

> **DELTA v3** theo 3 yêu cầu chủ doanh nghiệp:
> 1. **Bỏ hoàn toàn** lương cơ sở / BHXH / lương tối thiểu vùng / pháp lý HĐLĐ — chủ làm **cá nhân**, chỉ tối ưu lương thuần. Đáy cứng = **4tr phẳng**, SOFT_CAP = **4tr phẳng**.
> 2. Tuần làm **Thứ 2 → Thứ 7 (6 ngày)**, **Chủ Nhật nghỉ** (tháng off 4 CN) → tháng chuẩn **26 ngày-làm**.
> 3. Thêm **cơ chế bù điểm streak** ("Khiên dự trữ"): làm 2 CN → +1 khiên; off ≤1 ngày cả tháng → +1 khiên; dùng để vá chuỗi đứt.
>
> File này **thay thế v2** ở các điểm trên (v2 §🚨 pháp lý + §B.4 công thức cũ đã bỏ). Phần còn lại của v2 giữ nguyên. Nền: [BAN-TRON-CO-CHE-LUONG-THUONG-V2.md](BAN-TRON-CO-CHE-LUONG-THUONG-V2.md) · Kỹ thuật: [THIET-KE-BANG-LUONG-KPI-GAMING.md](THIET-KE-BANG-LUONG-KPI-GAMING.md).
>
> Cập nhật: 2026-07-01.

---

## Thay đổi so với v2 (bảng tổng)

| Loại | Nội dung |
|---|---|
| **BỎ** | Toàn bộ lương cơ sở / BHXH / lương tối thiểu vùng / "phụ cấp năng suất" / mọi tham chiếu HĐLĐ pháp lý khỏi thiết kế. |
| **BỎ** | SOFT_CAP scale theo vùng — không còn tham số vùng trong P&L mềm. |
| **ĐỔI** | Đáy cứng: "= tối thiểu vùng" → **4.000.000đ PHẲNG**. SOFT_CAP → **4.000.000đ PHẲNG**. |
| **ĐỔI** | `FLOOR_DAY`: 8 → **10**. `FULL_DAYS`: 18 → **20**. Đơn giá vùng dốc → **400.000đ/ngày** (tròn, 10 bậc). |
| **ĐỔI** | Mẫu số ngày-công: **CỐ ĐỊNH 26 ngày-làm (T2–T7)**; CN KHÔNG nằm trong công thức, nghỉ CN không kéo tỉ lệ. |
| **ĐỔI** | Mốc STREAK: 3/7/14/26 → **3/7/13/20 ngày-làm** (20 khớp FULL_DAYS); CN **bắc cầu tự động** (không đứt chuỗi). |
| **THÊM** | **KHIÊN DỰ TRỮ** (earned shield): khiên kiếm bằng nỗ lực, tích luỹ + carry-over + cap, chỉ vá chuỗi. |
| **THÊM** | 2 nguồn kiếm khiên: làm 2 CN hợp-lệ, hoặc off ≤1 ngày cả tháng. |
| **THÊM** | Banner "**CN là ngày nghỉ — không làm CN bạn KHÔNG mất gì**" cạnh badge CN. |
| **GIỮ** | 4tr cứng + 4tr mềm = 8tr; tuyến tính không cliff; 2 khiên miễn phí + phép-duyệt; ngày-công binary; điểm hoạt động phi-tiền; streak cap 1tr/tháng; gain-framing tuyệt đối; thu tiền bấm-tại-chỗ + GPS; kiểm tra nhà = phiếu công việc. |

---

## PHẦN A — Tranh luận: Thưởng làm Chủ Nhật để kiếm khiên — ghi nhận nỗ lực hay xói mòn ngày nghỉ?

**Quản lý:** Nói thẳng: Chủ Nhật ở khu tôi VẪN có việc thật. Khách dọn vào cuối tuần, vỡ ống nước không đợi tới thứ Hai, chốt cọc gấp. Anh em bỏ ngày nghỉ ra làm mà không được gì thì lần sau ai thèm nghe điện thoại? Cho 2 CN đổi 1 khiên là công bằng — mồ hôi đổi bảo hiểm chuỗi.

**CFO:** Tôi không cãi "công bằng", tôi cãi HỆ QUẢ. Khiên cứu được mốc streak = +400k. Một khi anh em nhẩm ra "2 CN → 1 khiên → giữ chuỗi → +400k", họ sẽ cày cả 4 CN. Anh vừa mô tả cái bẫy: CN thành ngày farm.

**Quản lý:** Nên tôi CHẶN Ở CẶP. 2 CN = 1 khiên. CN thứ 3–4 = KHÔNG THÊM GÌ. Đường thưởng phẳng sau CN thứ 2 — không đường cong nào kéo người ta cày cả tháng.

**CHRO:** Chặn ở cặp cần nhưng CHƯA đủ. Vấn đề không phải đường cong, là ÁP LỰC XÃ HỘI: "thằng A đi 2 CN có khiên, mình không đi thì mình thiệt" — dù cap +1, cái *cảm giác* thiệt vẫn đẩy người ta ra khỏi giường sáng CN.

**Game Designer:** Đây đúng lằn ranh tôi mất ngủ. Nhưng cái "cảm giác thiệt" chỉ hình thành nếu người KHÔNG làm CN thực sự thiệt — mà họ KHÔNG. Ba chốt: (1) CN không nằm trong soft_pay → nghỉ đủ 4 CN vẫn full 4tr mềm; (2) streak recalibrate về ngày-làm T2–T7, CN bắc cầu tự động → người chưa bao giờ đi CN vẫn ăn trọn 1tr streak; (3) ai cũng có sẵn 2 khiên miễn phí + phép-duyệt. **Khiên nỗ lực chỉ là lớp bảo hiểm THỨ TƯ.**

**CFO:** Ba lớp trước đó — đó mới là câu trả lời tôi cần. Nếu khiên nỗ lực là thứ *dư ra* chứ không phải thứ *thiếu thì đứt*, thì áp lực CN sụp. Nhưng tôi giữ tay trên van chi: cap TIÊU 1 khiên nỗ lực/tháng, cap streak 1tr cứng. Anh có gom cả kho khiên cũng không chọc thủng trần chi.

**CHRO:** Được. Nhưng tôi thêm điều kiện KHÔNG THƯƠNG LƯỢNG: câu "**Chủ Nhật là ngày nghỉ — không làm CN bạn KHÔNG mất gì**" phải hiển thị NGAY CẠNH badge CN, không giấu trong FAQ. Và tôi theo dõi "% người làm ≥3 CN/tháng"; vượt 20–30% đều → tín hiệu áp lực ngầm → gỡ nguồn (a).

**Quản lý:** Đồng ý hết. Tôi chỉ đòi: đừng bắt CN hợp-lệ phải là "việc nặng". Khu vắng khách không có gì sửa — cho "kiểm tra nhà 1 chạm" đủ tick CN. Không thì người ở toà xa vĩnh viễn không kiếm nổi khiên, thành đặc quyền toà đông.

**Game Designer:** Chốt: CN hợp-lệ = ĐÚNG chuẩn ngày-công thường (1 việc thật qua cổng ảnh-hash + geofence). Không nới cổng cho CN kẻo 2 phiếu rác farm khiên. Nhưng "kiểm tra nhà tốt" tính là việc thật, nên toà vắng vẫn làm được. Ai không có cơ hội CN thì nguồn (b) "off ≤1 ngày" đủ kiếm khiên → không thành đặc quyền địa lý.

**— Chốt con số full/floor —**

**Game Designer:** Bốn vai lệch nhau: tôi & CFO FLOOR=10/FULL=22; CHRO 10/20; Quản lý 12/22. Điểm chung tuyệt đối: **KHÔNG ai để FULL=26** (biến mọi ngày ốm thành cắt lương) và **KHÔNG giữ FULL=18** của v2 (quá dễ sau khi loại CN khỏi mẫu số).

**Quản lý:** 400k/ngày tròn quan trọng — anh em nhẩm được. Cần FULL−FLOOR=10.

**CHRO:** Giữa 20 và 22, khi CHƯA có dữ liệu Phase 0, tôi nghiêng phía DỄ hơn (FULL=20, buffer rộng hơn) để không cắt lương ngầm.

**CFO:** FULL=22 là PHỎNG ĐOÁN median ≥22. Nếu Phase 0 đo trung vị thực <22 mà giữ 22 → cắt lương trá hình hàng loạt → sập gain-framing. Khởi điểm ở phía an toàn, config-driven, **hạ được nhưng khó nâng**.

**Game Designer:** Tôi nhượng. Lấy đơn giá tròn **400k/ngày** làm bất biến truyền thông → ép FULL−FLOOR=10. Đặt cặp phía an toàn: **FLOOR=10, FULL=20**. Vừa tròn 400k, vừa buffer rộng, vừa dễ hạ FULL nếu cần mà không đụng đơn giá.

**Quản lý:** 10/20, mỗi ngày 400k, off tới 6 ngày-làm vẫn full 8tr — anh em tôi chịu con này. Nhẩm được, nghỉ thoải mái, lười thì rớt.

**➤ ĐỒNG THUẬN:** `FLOOR=10, FULL=20, 400k/ngày`; điểm-bù = khiên phi-tiền (2 CN → +1, off ≤1 → +1; cap kiếm 1/tháng, cap tồn 2, cap tiêu 1/tháng); CN vẫn off mặc định (bắc cầu chuỗi miễn phí); banner "không làm CN không mất gì"; Phase 0 shadow ≥3 tháng trả đủ 8tr.

**➤ CÒN MỞ:** cap tồn khiên 2 vs 3; carry "nửa cặp" CN lẻ; ngưỡng % làm ≥3 CN để gỡ nguồn (a) — 20% vs 30%; van xả điểm kiếm-thừa; tháng Tết ngắn.

---

## PHẦN B — Recalibrate ngày-công (bản chốt)

**Tham số (config trong `salary_bonus_rules.rules`, KHÔNG hard-code):**

```
FLOOR_DAY = 10        FULL_DAYS = 20        SOFT_CAP = 4.000.000đ (phẳng)
HARD_BASE = 4.000.000đ (phẳng)             DENOM = 26 ngày-làm (T2–T7, CN không tính)

soft_pay = 4.000.000 × clamp((ngày_công − 10) / (20 − 10), 0, 1)
Đơn giá vùng dốc [10..20] = 400.000đ / ngày-công   (10 bậc tròn, tự nhẩm)
total    = 4.000.000 (cứng) + soft_pay + (streak / thưởng-việc / KPI — trên đỉnh)
```

**Bảng quy đổi ngày-công → soft_pay → tổng nền:**

| ngày-công | ≤10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | **20** | 21–26 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| soft_pay | 0 | 400k | 800k | 1,2tr | 1,6tr | 2,0tr | 2,4tr | 2,8tr | 3,2tr | 3,6tr | **4,0tr** | 4,0tr |
| tổng nền | 4,0tr | 4,4tr | 4,8tr | 5,2tr | 5,6tr | 6,0tr | 6,4tr | 6,8tr | 7,2tr | 7,6tr | **8,0tr** | 8,0tr |

**Worked examples (nền = cứng + mềm; chưa gồm trên-đỉnh):**

| Chân dung | ngày-công | soft_pay | Nền | Ghi chú |
|---|---:|---:|---:|---|
| **Siêng** | 24 | 4,0tr | 8,0tr | Off 2 ngày-làm + 4 CN vẫn full; dư địa ăn streak/thưởng trên đỉnh. |
| **Bình thường** | 20 | 4,0tr | 8,0tr | Off tới 6 ngày-làm + 4 CN (~10 ngày nghỉ) vẫn đúng 8tr. |
| **Đủ-sống** | 16 | 2,4tr | 6,4tr | Rớt rõ nhưng chưa "mất sống" — tín hiệu sớm. |
| **Đi-cho-có** | 13 | 1,2tr | 5,2tr | Nghỉ nửa tháng, tụt mạnh. |
| **Ở-nhà** | ≤10 | 0 | 4,0tr | Chạm sàn cứng phẳng. |

**Chốt chặn calibration:** Phase 0 shadow ≥3 tháng, trả đủ 8tr bất kể điểm. Nếu **trung vị ngày-công thực < 20 → HẠ `FULL_DAYS`** (giữ đơn giá tròn thì hạ về 18/FLOOR 8). **KHÔNG NÂNG** FULL trên dữ liệu. Geofence phải ≥90% chuẩn trước khi bật.

---

## PHẦN C — Khiên dự trữ (điểm-bù-streak)

**Bản chất:** khiên kiếm bằng nỗ lực, **0đ trực tiếp**, chỉ để **NỐI LẠI chuỗi ngày-làm đã đứt** (cứu mốc streak trên đỉnh). **KHÔNG đụng 4tr mềm/4tr cứng.**

### 3 loại khiên (tiêu theo thứ tự cố định)

| # | Loại | Số lượng | Reset/Carry | Nguồn |
|---|---|---|---|---|
| 1 | **Khiên miễn phí** | 2/tháng | Reset đầu tháng, KHÔNG carry | Mặc định, ai cũng có |
| 2 | **Phép-duyệt** | không giới hạn (đã duyệt) | — | Xin phép trước, chủ duyệt |
| 3 | **Khiên dự trữ** (MỚI) | kiếm được | **CARRY-OVER**, cap tồn 2 | Làm 2 CN / off ≤1 ngày |

### Cách kiếm khiên dự trữ (đúng 2 nguồn)

**(a) Nguồn CHỦ NHẬT — đếm theo CẶP:**
- 2 CN hợp-lệ trong tháng → **+1 khiên**. CN lẻ (1, 3) → 0.
- **Cap nguồn (a) = +1/tháng** — CN thứ 3–4 KHÔNG sinh thêm khiên (triệt động cơ farm 4 CN).
- CN hợp-lệ = **đúng chuẩn ngày-công thường**: ≥1 việc thật qua cổng ảnh-hash + geofence (kể cả "kiểm tra nhà 1 chạm"). Không nới cổng cho CN.

**(b) Nguồn CHUYÊN CẦN — off ≤1 ngày:**
- Cả tháng off ≤1 ngày-làm (≥25/26) → **+1 khiên**, cấp khi LOCK cuối tháng.
- Off 0 ngày → +1 (không thưởng thêm — tránh ép làm kiệt).
- **Ngày phép-duyệt KHÔNG tính là "off"** → nghỉ ốm có phép vẫn giữ tư cách "gần hoàn hảo" (chống ép đi làm khi ốm).

### Cap & carry-over (chốt)

| Tham số | Giá trị |
|---|---|
| **Cap KIẾM MỚI / tháng** | **+1/tháng** (dù vừa làm 2 CN VỪA off ≤1 → vẫn chỉ +1). Bất-khả-thương-lượng — chống presenteeism. |
| **Cap TỒN KHO** (bank) | **2 khiên dự trữ** |
| **Cap TIÊU / tháng** | **1 khiên dự trữ/tháng** |
| **Carry-over** | **CÓ** (khiên dự trữ không reset; khiên miễn phí thì reset) |
| **Tổng lá chắn tối đa/tháng** | 2 free + 1 earned tiêu được = **3 lần vá/tháng** |

> **CÒN MỞ #1:** cap tồn 2 vs 3 chưa chốt tuyệt đối — khởi điểm **2**. Quyết sau khi đo % người chạm mốc 20 nhờ vá: nếu >70% → hạ cap tồn về 1.

### Cách VÁ chuỗi (server-authoritative, tự động)

Khi lỡ 1 ngày-làm (không phép), engine tiêu **tự động** theo thứ tự cố định (dùng "đồ reset" trước, giữ "đồ quý tích luỹ"):

```
1) Phép-duyệt (ngày đó có phép)     → đóng băng, KHÔNG tốn gì.
2) Khiên miễn phí (tháng còn)       → đóng băng.
3) Khiên dự trữ (bank > 0, chưa tiêu trong tháng) → tiêu 1, vá đúng 1 ngày, chuỗi LIỀN MẠCH (không reset về 0).
4) Hết cả 3 → đứt: "Bắt đầu chuỗi mới 🔥" (0 hồi tố, 0 trừ tiền).
```

- Mỗi khiên vá **đúng 1 ngày**. Lỗ 2 ngày liền cần 2 khiên → nhưng cap tiêu 1/tháng ⇒ thực tế lỗ 2 ngày liền = đứt.
- Vá **retroactive tự động** khi `record_attendance_day` phát hiện gap; nhân viên KHÔNG bấm.

### UI gain (cấm framing âm)

- Badge: `🛡️ x2 miễn phí · 🔰 x1 dự trữ (kiếm được)`
- Kiếm: `🔰 +1 Khiên dự trữ! (làm 2 Chủ Nhật) — giữ chuỗi cả khi lỡ 1 ngày.`
- Vá: `🔰 Đã dùng 1 Khiên dự trữ vá ngày hôm qua — chuỗi 15 ngày vẫn liền 🔥. Còn 1 khiên dự trữ.`
- Kho đầy: `Kho khiên đã đầy 2/2 — dùng bớt để tích tiếp.`
- **Cấm tuyệt đối** "−1 khiên / mất khiên / mất chuỗi". Luôn "đã dùng để BẢO VỆ chuỗi".

---

## PHẦN D — Van an toàn chống presenteeism (CN là ngày nghỉ bất khả xâm phạm)

1. **CN KHÔNG ra tiền, KHÔNG vào công thức 4tr.** Nghỉ đủ 4 CN vẫn full 4tr mềm. Làm CN chỉ ảnh hưởng nguồn khiên (a) + thưởng-việc-thật trên đỉnh (đã có +50k ký HĐ CN/Lễ). CN không làm tăng "20 ngày full".
2. **Streak định nghĩa lại theo ngày-làm T2–T7, CN bắc cầu tự động** → người KHÔNG BAO GIỜ đi CN vẫn ăn full 8tr + trọn 1tr streak. Khiên dự trữ chỉ là **lớp bảo hiểm THỨ TƯ**.
3. **Thưởng theo CẶP + cap +1/tháng, KHÔNG per-CN** → sau 2 CN, làm thêm = 0 khiên → tối ưu về phía NGHỈ.
4. **Banner** "Chủ Nhật là ngày nghỉ của bạn. Không làm CN bạn KHÔNG mất gì" cạnh badge CN; onboarding: "Nếu tự nguyện làm 2 CN, hệ thống tặng 1 khiên như lời cảm ơn."
5. **Giám sát:** metric "% nhân viên làm ≥3 CN/tháng"; ngưỡng gỡ nguồn (a) = **20–30%** (chốt sau shadow) + cảnh báo mềm "nhớ nghỉ ngơi" + owner review.
6. CN nghỉ mặc định **tự đóng băng chuỗi MIỄN PHÍ** (không tốn khiên nào).

---

## PHẦN E — Tích hợp kỹ thuật

**Schema:**

```sql
ALTER TABLE salary_streak_state
  ADD COLUMN shields_left      INT NOT NULL DEFAULT 2,   -- khiên miễn phí, reset đầu tháng
  ADD COLUMN shields_earned    INT NOT NULL DEFAULT 0,   -- khiên dự trữ, carry-over, cap 2
  ADD COLUMN earned_this_month INT NOT NULL DEFAULT 0,   -- đã kiếm mới trong tháng (cap 1)
  ADD COLUMN spent_this_month  INT NOT NULL DEFAULT 0;   -- đã tiêu trong tháng (cap 1)

CREATE TABLE salary_shield_ledger (          -- audit
  id BIGSERIAL PRIMARY KEY,
  staff_id UUID NOT NULL, user_id UUID NOT NULL,
  kind TEXT NOT NULL,        -- EARN_SUNDAY | EARN_PERFECT | SPEND_PATCH
  month DATE NOT NULL, gap_date DATE, delta INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, gap_date)                -- dedup vá 1 ngày 1 lần
);
```

**RPC / logic (server-authoritative, vn_local):**

| Hàm | Khi nào | Việc |
|---|---|---|
| `record_attendance_day(staff, date)` | realtime khi có việc qua cổng | Cập nhật ngày-công; phát hiện gap ngày-làm chưa vá → `patch_streak_gap`. |
| `patch_streak_gap(staff, gap_date)` | trong record | Tiêu khiên theo thứ tự phép→free→earned; ghi SPEND_PATCH; dedup `UNIQUE(staff,gap_date)`; tôn trọng `spent_this_month < 1`. |
| `award_sunday_shield(staff)` | realtime khi CN thứ 2 hợp-lệ | Nếu `earned_this_month<1 AND shields_earned<2` → +1, ghi EARN_SUNDAY. |
| `salary_month_lock(staff, month)` | cuối tháng khi LOCK | Đếm off-days (loại phép-duyệt); off ≤1 AND `earned_this_month<1 AND shields_earned<2` → +1 EARN_PERFECT. Reset `shields_left=2, earned_this_month=0, spent_this_month=0` (giữ `shields_earned`). |

**Công thức cap (enforce ở RPC):**

```
earn:  shields_earned' = LEAST(2, shields_earned + 1)  CHỈ khi earned_this_month = 0
spend: CHỈ khi spent_this_month = 0 AND shields_earned > 0 → shields_earned − 1
mốc streak: 3/7/13/20 ngày-làm liên tiếp = +100/200/300/400k, cap LEAST(tổng, 1.000.000)/tháng
```

- **Đếm CN hợp-lệ:** `COUNT(DISTINCT date WHERE dow=CN AND có việc qua cổng ảnh+geofence)`. Nguồn (a) kích hoạt khi `count >= 2`.
- **Đếm off-days:** `26 − COUNT(ngày-làm có công) − COUNT(ngày-làm có phép-duyệt)`. Off ≤1 khi ≤1.

---

## PHẦN F — Còn mở

1. **Cap tồn kho khiên = 2 hay 3?** Khởi điểm **2**. Quyết sau khi đo % người chạm mốc 20 nhờ vá: nếu >70% → hạ cap tồn về 1.
2. **Carry "nửa cặp" CN lẻ** (làm 3 CN → carry 1 CN?): khởi điểm **bỏ carry CN lẻ, chỉ carry khiên nguyên** (đơn giản). A/B test thanh "1/2 cặp CN" nếu cần.
3. **Ngưỡng % làm ≥3 CN để gỡ nguồn (a):** 20% (CHRO) vs 30% (Game Designer). Chốt sau shadow.
4. **Van xả điểm kiếm-thừa khi kho đầy:** đổi 1 khiên dư → badge phi-tiền "Tháng Hoàn Hảo"? Mở, chưa quyết.
5. **Tháng Tết/tháng ngắn:** dùng "phép-duyệt full" thủ công của chủ thay vì hạ ngưỡng đại trà. UI/luồng duyệt chưa thiết kế.

---

## Tóm tắt cho chủ doanh nghiệp (v3)

- **Tuần T2–T7, CN nghỉ.** Làm **20/26 ngày-làm = full 8tr** (nghỉ tới ~6 ngày-làm + 4 CN vẫn đủ). Mỗi ngày-công đáng **400k** (khoảng 10→20 ngày). Ở-nhà = sàn 4tr; đi-cho-có tụt rõ.
- **Không dính lương cơ sở/BHXH/luật** — thuần tối ưu lương cá nhân.
- **Khiên dự trữ (điểm-bù-streak):** tự nguyện làm **2 CN** hoặc **off ≤1 ngày cả tháng** → kiếm **+1 khiên** (tích tối đa 2, dùng 1/tháng) để vá chuỗi khi lỡ 1 ngày. **Không làm CN vẫn full lương + full streak** — khiên chỉ là bảo hiểm thêm cho người siêng.
- **Vẫn phải:** 3 tháng shadow (trả đủ 8tr, chỉ hiện thanh) để chốt `FULL_DAYS=20` theo dữ liệu thật trước khi "bật công tắc tiền".
