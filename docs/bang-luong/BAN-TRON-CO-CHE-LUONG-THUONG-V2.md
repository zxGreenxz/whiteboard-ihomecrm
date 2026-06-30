# Bàn tròn v2 — Cơ chế "LEO 4 LÊN 8": tái cấu trúc 8tr thành 4 cứng + 4 mềm ghi-nhận-công

> **v2** theo yêu cầu chủ doanh nghiệp: tách lương cứng 8.000.000đ → **~4.000.000đ CỨNG vô điều kiện** + **~4.000.000đ MỀM kiếm lại qua HOẠT ĐỘNG THẬT hằng ngày** (kiểm tra nhà, sửa chữa, ký HĐ, thu tiền mặt, hay bất cứ việc gì). **Mục tiêu KHÔNG phải cắt lương** — người làm bình thường vẫn giữ đủ 8tr; chỉ "ở nhà không làm" hay "đi cho có" mới rớt. Hệ thống **tự ghi nhận + tính điểm hằng ngày**, không chấm công máy móc (quản lý làm việc di động).
>
> Tiếp nối [BAN-TRON-CO-CHE-LUONG-THUONG.md](BAN-TRON-CO-CHE-LUONG-THUONG.md) (v1) và [THIET-KE-BANG-LUONG-KPI-GAMING.md](THIET-KE-BANG-LUONG-KPI-GAMING.md) (kỹ thuật). 6 vai bàn lại 4 điểm căng MỚI của v2.
>
> Cập nhật: 2026-07-01.

---

## ⚠️ Thay đổi triết lý so với v1 — đọc trước

v1 chốt "**lương cứng bất khả xâm phạm**". v2 **cố ý phá** điều đó theo ý chủ: gắn một phần base vào hoạt động. Điều này **làm TĂNG rủi ro** mà v1 đã cảnh báo (presenteeism, cờ-bạc-hoá tiền sống, vi phạm lương tối thiểu vùng). Vì vậy v2 đặt **5 van an toàn bắt buộc** để biến nó từ "cắt lương" thành "ghi nhận công":

1. **GAIN-framing tuyệt đối** — UI hiện thanh "đã tích X/4tr — **leo tiếp** 🚀", **CẤM** chữ "−/mất/bị trừ". Người quen 8tr không được thấy "đang bị cắt".
2. **Đáy hợp pháp = lương tối thiểu vùng** (không phải 4tr — xem cảnh báo dưới).
3. **Target DỄ đạt** — làm ~17–18 ngày/tháng là full mềm (nghỉ tới ~8 ngày vẫn đủ).
4. **3 tháng SHADOW** — tính điểm + hiện thanh nhưng **vẫn trả đủ 8tr bất kể điểm**, để hiệu chỉnh + cho quen UI trước khi "bật công tắc tiền".
5. **Streak KHÔNG nằm trong 4tr** — streak là thưởng cảm xúc **TRÊN ĐỈNH** 8tr, để chuỗi đứt không bao giờ chạm tiền-sống.

---

## 🚨 CHẶN CỨNG #1 — Lương tối thiểu vùng (pháp lý)

**"4tr cứng" KHÔNG được ghi vào hợp đồng lao động** nếu dưới lương tối thiểu vùng (vùng I 2026 ≈ **4,96tr**; vùng II ≈ 4,41tr). Cách xử lý đã đồng thuận:

- Trên **HĐLĐ**, dòng "lương cơ bản đóng BHXH" = **mức tối thiểu vùng áp dụng** (vd vùng I = 4,96tr).
- "4tr cứng" chỉ là **khái niệm nội bộ** về rủi-ro-mất tối đa, KHÔNG phải dòng nào trên hợp đồng.
- Phần biến đổi ghi là **"phụ cấp năng suất / chuyên cần" có quy chế** (cần HR/luật sư văn bản hoá để không bị xem là "lương giữ trái luật").
- → **Biên mềm thực tế = từ tối thiểu vùng tới 8tr.** Vùng I: cứng 4,96tr + **mềm 3,04tr** (KHÔNG phải 4+4). Mọi công thức `SOFT_CAP` phải scale theo địa bàn (tham số config, không hard-code).

Dưới đây vẫn minh hoạ với `SOFT_CAP = 4.000.000` cho dễ đọc; khi triển khai thay bằng `8.000.000 − region_min_wage`.

---

# PHẦN A — BÀN LUẬN 4 ĐIỂM CĂNG v2

## ① Chia 8tr = 4 cứng + 4 mềm: GHI NHẬN CÔNG (gain) hay CỜ-BẠC-HOÁ (loss)?

**Quản lý:** Tôi là người bị chia, nên tôi hỏi trước. 4tr cứng — chỗ tôi vùng I — **dưới** tối thiểu vùng 4,96tr. Anh ghi vào hợp đồng kiểu gì?

**CFO:** Tôi không ghi 4tr vào hợp đồng. HĐLĐ ghi "lương cơ bản đóng BHXH" = tối thiểu vùng 4,96tr. "4tr cứng" là khái niệm **nội bộ** về rủi-ro-mất. Phần còn lại ghi "phụ cấp năng suất" có quy chế.

**Quản lý:** Vậy anh tự mâu thuẫn. Hợp đồng cứng 4,96tr thì mềm tôi kiếm chỉ còn **3,04tr**, không phải 4tr. Bảng điểm 150k × (ngày−17) cap 3tr + streak 1tr = 4tr của anh **sai từ tổng**.

**CFO:** Đúng, tôi nhận. Vùng I: cứng 4,96tr, mềm co còn 3,04tr, bậc thang scale lại. Nhưng lập luận **cost-neutral** giữ nguyên: người làm bình thường vẫn chạm trần 8tr, P&L không đổi.

**Game Designer:** CFO khoan — anh vừa phá thiết kế của tôi. Tôi cần **MỘT con số đáy DUY NHẤT** hiển thị đầu màn. Lập lờ "4tr cứng nội bộ" mà hợp đồng ghi 4,96tr thì người chơi hỏi "0,96tr chênh đó là cứng hay mềm?". Mơ hồ là kẻ thù của gain-framing.

**CEO:** Cắt nút thắt: con số đáy hiển thị = mức ghi HĐLĐ = tối thiểu vùng. Thanh leo chạy từ **4,96tr → 8tr** (biên mềm 3,04tr). Hết mơ hồ. Và **3 tháng shadow** — trả đủ 8tr bất kể điểm, chỉ cho nhân viên NHÌN thanh.

**CSKH:** Tôi hoan nghênh shadow, nhưng nỗi sợ thật từ ghế khách: khi 3,04tr tiền-gần-sống treo trên hoạt động ngày, quản lý tối ưu cho HỆ THỐNG ĐIỂM hay cho KHÁCH? Đi thu tiền vội để kịp tick. Kiểm tra nhà chụp cho-có-ảnh.

**Game Designer:** Đó là lý do tôi đặt **NGÀY-CÔNG = BINARY**. 1 việc-ảnh-hợp-lệ = đủ điểm danh trọn ngày. Làm 1 việc hay 8 việc, điểm danh GIỐNG NHAU → **không có động cơ "làm cho nhiều"**, không có lý do giục khách.

**CSKH:** Binary chặn "làm cho nhiều", nhưng không chặn "làm cho dối": chụp 1 tấm ảnh sảnh, geofence ok, đủ điểm, về — khách trong nhà rò nước cả tuần. Tôi đòi phiếu "Kiểm tra nhà" có trường bắt buộc **"Tình trạng nhà"** (Tốt / Phát hiện vấn đề).

**Quản lý:** Một trường 1-chạm Tốt/Có-vấn-đề thì tôi chịu. Nhưng 5 trường bắt điền giữa trời nắng khi khách đứng chờ thì tôi **veto** — không thêm gánh hành chính.

**Game Designer:** Mối lo lớn nhất chưa ai chạm: **anchoring**. Người quen 8tr vô điều kiện sẽ tự trừ trong đầu "8tr lẽ ra − phần chưa đạt", dù UI gain đẹp cỡ nào. Toán bằng nhau nhưng cảm xúc là CẮT LƯƠNG. Không gain-framing nào cứu nổi nếu **target sai**.

**CEO:** Vì thế shadow 3 tháng + buffer rộng. Ba con số hội tụ quanh "**làm ~18–22 ngày là full**" → nghỉ 4 ngày/tháng vẫn đủ. Đó là buffer thật.

**Quản lý:** Với điều kiện CN không bắt buộc + phép-duyệt + 2 khiên đóng băng chuỗi không tốn gì. Ốm 3 ngày báo trước không được mất chuỗi VÀ không tụt dưới ngưỡng full. **Presenteeism là cái tôi sợ nhất.**

**➤ ĐỒNG THUẬN:**
1. **Pháp lý CHẶN:** lương ghi HĐLĐ = tối thiểu vùng; "4tr cứng" là khái niệm nội bộ; phần biến đổi = "phụ cấp năng suất" có quy chế.
2. **Biên mềm = tối thiểu vùng → 8tr** (vùng I: 4,96 + 3,04). Một con số đáy duy nhất hiển thị.
3. **GAIN tuyệt đối:** thanh "đã tích X/[mềm] — leo tiếp!"; cấm "−/mất/bị trừ"; đứt streak = "chuỗi mới", 0 hồi tố.
4. **3 tháng SHADOW** trả đủ 8tr bất kể điểm.
5. **Ngày-công BINARY**, đếm NGÀY không đếm việc; buffer rộng (~18 ngày full); CN không bắt buộc; phép + 2 khiên đóng băng chuỗi.
6. **Geofence AUDIT-ONLY** cho điểm chuyên cần tới khi backend đo ≥90% ngày-công đã geofence_ok ≤70m.
7. **KHÔNG gắn tiền vào số tiền/số phòng/đầu phiếu** trong phần mềm.
8. **Trần tuyệt đối ~10,6tr/người/tháng**; sàn = tối thiểu vùng. P&L dự đoán ±10%.
9. Hai lớp tách cứng (realtime "tạm tính" vs LOCK); `award_job_bonus` PHẢI log `salary_award_errors`.
10. Phi-tiền = 0đ thật; khách không bao giờ thấy điểm.

**➤ CÒN MỞ:** % geofence_ok thực tế; định danh pháp lý "phụ cấp năng suất"; tỷ trọng effort/outcome (70/30?); chuẩn hoá outcome theo toà; anti-collusion tầng-2; động lực nửa cuối tháng sau khi chạm trần.

---

## ② Hệ thống ĐIỂM hoạt động ngày: chấm sao để ghi nhận công di động mà chống Goodhart?

**Quyết định cốt lõi của v2** (giải mâu thuẫn "tính điểm" vs "chống Goodhart"): **TÁCH hai thứ.**

- **TIỀN (4tr mềm)** chỉ tính theo **SỐ NGÀY-CÔNG hợp lệ** (binary mỗi ngày) — đơn vị có trần tự nhiên, không bơm được.
- **ĐIỂM hoạt động (30/20/15…)** là **PHI-TIỀN** — chỉ nuôi leaderboard / hạng / badge / cảm giác tiến bộ. Cày điểm KHÔNG ra thêm tiền (diminishing tuyệt đối).

> **CFO:** "1 ngày hay 10 việc đều = 1 điểm-ngày. Việc chỉ MỞ CỔNG ngày, KHÔNG cộng dồn tiền. 4tr gắn vào NGÀY-CÔNG và STREAK — đơn vị có trần; số việc là đơn vị bơm vô hạn."
>
> **Game Designer:** "Điểm hoạt động (phi-tiền) cho cảm giác 'hôm nay làm được nhiều' mà không đẻ ra tiền → thoả gamification, triệt Goodhart. Ai thèm xé phiếu ăn 5k khi cái đáng giá — tick ngày 200k — đã lấy xong từ phiếu đầu?"

**➤ ĐỒNG THUẬN:** ngày-công binary → 4tr mềm; điểm hoạt động → leaderboard phi-tiền; thưởng việc-thật (sửa/HĐ) nằm **TRÊN ĐỈNH** 8tr (cap 1,5tr/tháng), KHÔNG trong 4tr.

---

## ③ Thu tiền mặt & kiểm tra nhà thành PHIẾU / GHI NHẬN: điểm danh + chống gian lận + đối soát

> **CẬP NHẬT THEO YÊU CẦU CHỦ DOANH NGHIỆP (quan trọng):** thu tiền mặt **KHÔNG** tạo phiếu công việc thủ công riêng. Quản lý **bắt buộc bấm nút "Thu tiền" ngay tại page Thu tiền vào đúng thời điểm nhận tiền mặt của khách** (để ghi nhận + ghi nhớ tức thì), và **hệ thống bắt GPS ngay tại đó**. → Chính hành động thu tiền vừa là phiếu thu tài chính, vừa là **bằng chứng có-mặt chính xác + tín hiệu điểm-danh**. Một hành động, hai mục đích, không thao tác kép. **Kiểm tra nhà** thì vẫn là một **phiếu công việc** trên page Công việc.

**CFO:** "Đơn giản vậy thôi" là chỗ tiền sống rò ra. **LẰN RANH ĐỎ:** không một đồng, không một điểm-tiền nào gắn vào **SỐ TIỀN thu** hay **SỐ PHÒNG**. Nhánh (D) CASH giữ `bonus=NULL` vĩnh viễn. Cho điểm theo số tiền = mở thẳng cửa khai khống phiếu ảo.

**Quản lý:** "0đ" tôi phản đối — thu tiền là việc tôi làm **nhiều nhất**, **cầm tiền mặt rủi ro** (mất là tôi đền). Đề 5k/phiếu, trần 30k/ngày.

**Game Designer:** Cả hai bỏ lỡ điều chính: **giá trị thật của thu tiền với quản lý = nó TICK NGÀY-CÔNG (~200k giá trị mềm)**, không phải 5k. 200k áp đảo 5k tới 40 lần. Phiếu đầu trong ngày đã tick trọn ngày → phiếu 2-6 chỉ còn 5k lẻ → **động cơ xé phiếu xẹp hẳn**.

**Quản lý:** ...được. 5k/phiếu nhưng **diminishing, cap đếm-điểm 2 phiếu/ngày**, phiếu 3+ = 0đ chỉ audit.

**CSKH:** Mỗi lần thu gắn nút **"Khách phàn nàn?"**; khiếu nại Zalo 48h → **cờ review thủ công** (KHÔNG tự rớt ngày-công, KHÔNG trừ máy móc — nếu ngày đó có việc khác qua cổng, ngày-công vẫn tick).

**CFO:** Đối soát **bắt buộc**: hành động thu phải gắn `salary_staff_id` (**auto theo người đăng nhập**, dấu *, bỏ heuristic tên) + **ảnh chứng từ biên nhận** + **GPS lúc bấm thu** (theo yêu cầu chủ). Không có = không đối soát = không tick.

**CSKH (kiểm tra nhà):** Kiểm tra nhà chụp-cho-có là rác. Trường bắt buộc **"Tình trạng nhà"** (Tốt / Phát hiện vấn đề + ảnh cận). Phát hiện vấn đề THẬT dẫn tới job sửa nghiệm thu trong 72h → thưởng gấp đôi.

**Quản lý:** Phản đối "gấp đôi" — tạo động cơ **BỊA vấn đề**, tự tạo + tự đóng job sửa ảo.

**Game Designer + CFO:** Đồng ý bỏ "gấp đôi" khỏi phần mềm. Giữ trường "Tình trạng nhà" làm **cổng chất lượng phi-tiền**. Mọi thưởng theo đầu phiếu (nếu có) nằm TRÊN ĐỈNH trong quỹ thưởng-việc cap 1,5tr.

**➤ ĐỒNG THUẬN:**
1. **Thu tiền mặt** = bấm "Thu tiền" tại page Thu tiền **ngay lúc thu** + **GPS** + ảnh chứng từ + `salary_staff_id` auto. **Tick ngày-công** từ lần thu hợp lệ đầu tiên. Tiền trực tiếp = 0đ (hoặc 5k diminishing cap 2/ngày — **mặc định v2 = 0đ chỉ tick**, xét bật sau).
2. **Kiểm tra nhà** = job_type trên page Công việc; trường bắt buộc "Tình trạng nhà"; trần **1 tick/toà/ngày**; bonus nhỏ 15k (trên đỉnh).
3. **KHÔNG gắn điểm/tiền theo số tiền/số phòng/đầu phiếu** trong phần mềm; nhánh (D) CASH `bonus=NULL`.
4. **Geofence AUDIT-ONLY** giai đoạn đầu cho cả hai; cổng tick = ảnh-qua-cổng + ảnh-không-trùng-hash/ngày. Nâng geofence thành điều kiện chỉ sau khi đo ≥90%.
5. CSAT 48h im lặng = OK; khiếu nại = cờ review không tự trừ.
6. `salary_award_errors` bắt buộc; 1-2 chạm tối đa; khách không thấy điểm.

**➤ CÒN MỞ:** 5k/phiếu có thành chi phí mới đáng kể không; ngưỡng geofence 90% vs 85%; định nghĩa "job sửa nghiệm thu" cho thưởng gấp đôi.

---

## ④ Streak & chuyên cần khi gắn 4tr: đủ nhân văn & calibrate chưa?

**Quyết định cốt lõi #2:** **Streak KHÔNG nằm trong 4tr mềm** — streak là thưởng **TRÊN ĐỈNH 8tr**. 4tr mềm = **chuyên cần (số ngày-công) THUẦN**. Lý do: gắn streak vào tiền-sống = bom presenteeism; tách ra → đứt chuỗi chỉ mất thưởng-thêm trên đỉnh, không bao giờ chạm tiền-sống.

- **Buffer:** full mềm ở ~18 ngày-công (tháng ~26 ngày làm) → cho nghỉ tới ~8 ngày vẫn full. Tuyến tính, không cliff.
- **Khiên 2/tháng + phép-duyệt** (1 chạm, đóng băng chuỗi miễn phí) + **CN không bắt buộc**.
- **Toà êm:** 1 phiếu "Kiểm tra nhà" (bấm "Tốt", 1 chạm) là đủ tick + nuôi chuỗi. "Tốt" nhiều ngày = kết quả tốt, KHÔNG nghi gian.
- **Đứt chuỗi:** "Bắt đầu chuỗi mới 🔥", 0 hồi tố, 0 trừ tiền đã chốt.

**➤ ĐỒNG THUẬN:** streak trên đỉnh (mốc 3/7/14/26 = 100/200/300/400k cộng dồn, cap 1tr); 4tr mềm thuần ngày-công; safeguards như v1 nhưng buffer rộng hơn vì giờ chạm tiền-gần-sống.

**➤ CÒN MỞ:** target FULL_DAYS=18 phải xác nhận theo phân bố ngày-công thực (nếu trung vị <18 → hạ target, kẻo cắt lương trá hình).

---

# PHẦN B — CƠ CHẾ v2 "LEO 4 LÊN 8" (bản chốt, sẵn build)

## B.1 — Triết lý v2 (5 nguyên tắc)

1. **LEO LÊN, không MẤT ĐI.** Mọi giao tiếp/UI là "tích từ đáy lên 8tr". Cấm loss-framing. Toán giống nhau, cảm xúc khác nhau — và cảm xúc quyết định niềm tin.
2. **Ghi nhận CÔNG, không bán SỐ.** 4tr mềm gắn **NGÀY-CÔNG có việc thật** (đơn vị có trần), KHÔNG gắn số việc/số tiền/số phòng (đơn vị bơm vô hạn).
3. **Làm bình thường = đủ 8tr.** Target buffer rộng; "ở nhà/đi-cho-có" mới rớt. Phân biệt siêng/lười, không phạt người làm thật.
4. **Tiền tách cảm xúc.** Realtime "tạm tính"; tiền chốt khi LOCK. Điểm hoạt động + streak + badge = lớp cảm xúc/phi-tiền, không bao giờ là tiền-sống.
5. **Hệ thống tự chấm.** Quản lý chỉ làm việc + chụp ảnh tại chỗ (+GPS khi thu tiền). Không khai báo, không chấm công máy móc.

## B.2 — Cấu trúc thu nhập v2

```
Thu nhập = ĐÁY CỨNG (HĐLĐ = lương tối thiểu vùng, vd 4,96tr vùng I)   ← vô điều kiện, ≥ luật
         + PHẦN MỀM "phụ cấp năng suất" (đáy → 8tr; vd 3,04tr)         ← theo SỐ NGÀY-CÔNG, chốt khi LOCK
         ──────────────────────────────────────────  = "8tr" người làm bình thường giữ đủ
         + Thưởng việc-thật (sửa 30k, HĐ ngoài giờ +50k, CN/Lễ +20k…)  ← TRÊN ĐỈNH, cap 1,5tr/tháng
         + Streak (mốc 3/7/14/26 ngày)                                 ← TRÊN ĐỈNH, cap 1tr/tháng
         + KPI kết quả quý (occupancy/ontime/retention)                ← TRÊN ĐỈNH, cap 3,3tr/quý
         + HH Sale (bắt buộc salary_staff_id) − Ứng − Tiền phòng
```

**Trần tuyệt đối/người/tháng ≈ 10,6tr** (8tr + 1,5 thưởng-việc + ~1,1 KPI). **Sàn = tối thiểu vùng.** P&L dự đoán ±10%.

## B.3 — Catalog hoạt động + điểm

| Hoạt động | Tạo qua | Tick ngày-công? | Điểm leaderboard (PHI-TIỀN) | Tiền trực tiếp | Cổng hợp lệ |
|---|---|---|---|---|---|
| **Kiểm tra nhà** | phiếu công việc (page Công việc) | ✅ | +30đ (cap 1/toà/ngày) | 15k (trên đỉnh) | ảnh + trường "Tình trạng nhà" |
| **Thu tiền mặt** | **nút "Thu tiền" page Thu tiền + GPS lúc bấm** | ✅ | +20đ (cap 2 phiếu/ngày) | **0đ** (mặc định) | ảnh biên nhận + GPS + salary_staff_id auto |
| **Sửa chữa** | phiếu công việc | ✅ | +30đ | 30k (trên đỉnh) + escrow 30% | ảnh + CSAT/clawback |
| **Ký HĐ / đón khách** | nhánh CONTRACT | ✅ | +30đ | +50k nếu ngoài giờ/CN-Lễ (trên đỉnh) | — |
| **Việc khác hợp lệ** | phiếu công việc | ✅ | +10đ | theo job_type | ảnh |

- **Điểm leaderboard = PHI-TIỀN** (hạng, badge, "hôm nay làm được nhiều"). Cày điểm KHÔNG ra thêm tiền mềm.
- **Tiền mềm chỉ tính theo SỐ NGÀY có ≥1 dòng tick** (binary). 1 việc hay 8 việc/ngày = 1 ngày-công.

## B.4 — Công thức 4tr mềm (theo ngày-công)

```
SOFT_CAP   = 8.000.000 − region_min_wage        (vd vùng I: 3.040.000; minh hoạ dùng 4.000.000)
FLOOR_DAY  = 8     (≤8 ngày = 0 mềm → "ở nhà/đi cho có")
FULL_DAYS  = 18    (đạt = full mềm; tham số config, hiệu chỉnh theo dữ liệu thật)

soft_pay = SOFT_CAP × clamp( (ngày_công − FLOOR_DAY) / (FULL_DAYS − FLOOR_DAY), 0, 1 )
```

- Đơn giá ngày trong khoảng [9,18] = `SOFT_CAP / 10` (với 4tr → **400.000đ/ngày-công**). Tuyến tính, KHÔNG cliff.
- Vùng phẳng [18 → hết tháng] = 100% (ngày 19+ chỉ thêm badge phi-tiền).

**Bảng quy đổi (SOFT_CAP = 4tr):**

| Ngày-công | ≤8 | 10 | 12 | 14 | 16 | **18** | 22 | 26 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| soft_pay | 0 | 800k | 1,6tr | 2,4tr | 3,2tr | **4,0tr** | 4,0tr | 4,0tr |

> **Calibration (Phase 0):** nếu phân bố ngày-công thực có **trung vị < 18** → HẠ `FULL_DAYS` (vd 15) để không "cắt lương trá hình". `FULL_DAYS`/`FLOOR_DAY`/`SOFT_CAP` là **config** trong `manager_salary_config`/`salary_bonus_rules.rules`.

## B.5 — Worked example

### Một ngày mẫu — quản lý "Hùng", thứ Ba, toà đông

| Giờ | Hoạt động | Tick ngày | Điểm (phi-tiền) | Tiền-thật (trên đỉnh) |
|---|---|---|---|---|
| 8:30 | Kiểm tra nhà A (5 phòng), "Tốt" | ✅ (lần đầu) | +30 | 0 |
| 9:15 | Kiểm tra nhà B → phát hiện rò nước → tạo job sửa | đã tick | +30 | sửa xong → +30k |
| 14:00 | **Thu tiền 3 phòng** (bấm Thu tiền + GPS) | đã tick | +20×2 (cap 2) | **0đ** |
| 17:30 | Ký HĐ ngoài giờ B-203 | đã tick | +30 | +50k |

**Kết ngày:** ngày-công = **1** (binary, dù 6 thao tác). Tiền mềm cộng dồn = **+400k tạm tính** (1 ngày). Tiền-thật trên đỉnh = **80k** (đếm vào trần thưởng-việc 1,5tr). Leaderboard +140đ phi-tiền.

### Một tháng mẫu (SOFT_CAP = 4tr, FULL_DAYS = 18)

| Hồ sơ | Ngày-công | Mềm | Cứng | Thưởng-việc | Streak | KPI/3 | **Tổng** |
|---|---:|---:|---:|---:|---:|---:|---:|
| **A — Siêng** (24 ngày, 4 HĐ ngoài giờ, chuỗi 26) | 24 | 4,0tr | 4,0tr | ~520k | 1,3tr | ~1,1tr | **≈10,9tr** |
| **B — Bình thường** (20 ngày) | 20 | 4,0tr | 4,0tr | ~150k | 300k | ~600k | **≈9,05tr** |
| **C — Đủ-sống** (đúng 18, làng nhàng) | 18 | 4,0tr | 4,0tr | 0 | 0 | ~400k | **≈8,4tr** |
| **D — Đi cho có** (12 ngày) | 12 | 1,6tr | 4,0tr | 0 | 0 | 0 | **=5,6tr** |
| **E — Ở nhà** (≤8 ngày) | 8 | 0 | 4,0tr | 0 | 0 | 0 | **=4,0tr (sàn)** |

→ **Đúng ý chủ:** làm bình thường (B, C) ≥ 8tr; siêng (A) ~10,9tr; đi-cho-có (D) & ở-nhà (E) rớt rõ rệt nhưng **không bao giờ dưới sàn cứng**. (Vùng I: sàn hiển thị = 4,96tr, SOFT_CAP co 3,04tr — full ở 18 ngày vẫn ra ~8tr.)

## B.6 — Streak & chuyên cần v2

| Khía cạnh | Quy tắc |
|---|---|
| Đơn vị | Chuỗi ngày-công-hợp-lệ LIÊN TIẾP. Server-authoritative, nhân viên không bấm gì. |
| Vai trò tiền | **TRÊN ĐỈNH 8tr**, KHÔNG trong 4tr mềm. Đứt = 0 trừ, 0 hồi tố. |
| Mốc | 3→+100k · 7→+200k · 14→+300k · 26→+400k (cộng dồn, cap 1tr). Dedup (staff, mốc, tháng). Chốt khi LOCK. |
| Khiên | 2/tháng, tự đóng băng khi lỡ 1 ngày, reset đầu tháng. |
| Ngày phép | Phép-DUYỆT (1 chạm) → đóng băng MIỄN PHÍ (không tốn khiên). |
| Chủ nhật | Không bắt buộc, tự đóng băng. |
| Toà êm | 1 phiếu kiểm tra nhà "Tốt" = đủ tick + nuôi chuỗi. KHÔNG đòi việc nặng. |
| UI khi đứt | "Bắt đầu chuỗi mới 🔥" — cấm "đã mất chuỗi N ngày". |

## B.7 — Tích hợp kỹ thuật

> Tái dùng tối đa hạ tầng sẵn (jobs, award_job_bonus, income_expenses, geofence). Tên cột/RPC theo schema thật.

### Thu tiền mặt — cơ chế GPS-tại-chỗ (theo yêu cầu chủ)

```sql
-- Thêm cột bắt GPS lúc bấm "Thu tiền"
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS collect_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS collect_lng NUMERIC,
  ADD COLUMN IF NOT EXISTS collect_distance_m INT,
  ADD COLUMN IF NOT EXISTS collect_geofence_status TEXT;  -- 'ok'|'out'|'gps_denied' (audit-only đầu)
```
- Nút **"Thu tiền"** trên page Thu tiền: lúc bấm → lấy `navigator.geolocation` (lat/lng) + tính khoảng cách tới `buildings.lat/lng` → ghi `collect_*` + set `salary_staff_id = auth.uid()` (dấu *) + ép ảnh biên nhận. **Bắt buộc**, không lưu phiếu nếu thiếu (gps_denied vẫn lưu nhưng cờ).
- Trigger `AFTER INSERT` trên `income_expenses WHERE salary_role='CASH_COLLECTION'` → gọi `record_attendance_day(salary_staff_id, voucher_date, 'CASH', collect_geofence_status)`. → **hành động thu tiền = tín hiệu điểm-danh có-GPS**, không cần phiếu công việc riêng.

### job_types + job_type mới "Kiểm tra nhà"

```sql
ALTER TABLE public.job_types
  ADD COLUMN IF NOT EXISTS activity_points INT NOT NULL DEFAULT 0,   -- điểm leaderboard phi-tiền
  ADD COLUMN IF NOT EXISTS is_attendance   BOOLEAN NOT NULL DEFAULT true;

INSERT INTO public.job_types (user_id, name, bonus_amount, is_repair, counts_for_salary, activity_points, is_attendance)
SELECT sa.user_id, 'Kiểm tra nhà', 15000, false, true, 30, true
FROM public.super_admins sa
WHERE NOT EXISTS (SELECT 1 FROM job_types jt WHERE jt.user_id=sa.user_id AND jt.name='Kiểm tra nhà');
-- Trường "Tình trạng nhà": jobs.metadata jsonb { house_status:'good'|'issue', issue_items:[...] }
```

### Bảng điểm + chuỗi + lỗi

```sql
CREATE TABLE public.salary_attendance_day (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL, staff_id UUID NOT NULL,
  work_date DATE NOT NULL,
  is_valid BOOLEAN NOT NULL DEFAULT false,
  source_kind TEXT, source_id UUID,            -- 'JOB'|'CASH'
  geofence_ok BOOLEAN, manager_override BOOLEAN DEFAULT false, flagged BOOLEAN DEFAULT false,
  activity_points INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_id, work_date)                  -- idempotent, chống re-complete
);
CREATE TABLE public.salary_streak_state (
  staff_id UUID PRIMARY KEY, user_id UUID NOT NULL,
  current_streak INT DEFAULT 0, best_streak INT DEFAULT 0, last_valid_date DATE,
  shields_left INT DEFAULT 2, shield_month DATE, updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE public.salary_award_errors (        -- nợ kỹ thuật v1 §1.9.4 — BẮT BUỘC (tiền sống)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID, job_id UUID, source_id UUID, fn_name TEXT, error_text TEXT, payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Đường ghi nhận + chốt tiền
- `award_job_bonus(p_job_id)` (đã có) → mở rộng: sau (A)JOB+(B)DAY_BONUS gọi `record_attendance_day(...)`, bọc `EXCEPTION → INSERT salary_award_errors` (KHÔNG nuốt lỗi).
- `record_attendance_day(staff,date,source,geofence)` (mới, SECURITY DEFINER): upsert `salary_attendance_day` (UNIQUE → idempotent), kiểm ảnh-không-trùng-hash, cập nhật `salary_streak_state` (tăng/khiên/đóng băng), INSERT `notifications` (popup "tạm tính"). Geofence ghi audit, KHÔNG chặn giai đoạn đầu.
- Khi LOCK: `salary_adjustments.source` += `'ATTENDANCE'`,`'STREAK'`; RPC LOCK tính `ngày_công` → áp công thức §B.4 → INSERT 1 dòng `source='ATTENDANCE'` (phụ cấp năng suất N ngày-công) + dòng `source='STREAK'`. **Realtime = "tạm tính"; LOCK = bản chốt.**

### Self-view "leo lên 8tr"
- RPC `salary_self_progress(month)` → `{ hard_floor, soft_cap, ngay_cong, soft_pay_tamtinh, full_days, streak, shields_left, on_top_bonus }`.
- UI (`SalarySelf*.tsx`): vòng "Hôm nay đã ghi nhận ✅" + thanh tháng đầy dần *"Đã tích X / [soft_cap] — leo tiếp! Còn Y ngày để full"*; đáy *"Đáy an toàn đã chốt: [hard_floor]"*.

## B.8 — Chống gian lận

| Lớp | Cơ chế |
|---|---|
| Đếm NGÀY không đếm việc | 1 việc hay 8 việc = 1 ngày-công → diệt động cơ "làm cho nhiều" tận gốc |
| Ảnh trùng hash/ngày | hash `completion_attachments`; trùng cùng staff/ngày = 0 tick + cờ |
| Cap đếm-điểm | kiểm tra 1/toà/ngày; thu tiền 2 phiếu/ngày; thừa = audit |
| Không tiền theo SỐ TIỀN/SỐ PHÒNG | nhánh (D) CASH `bonus=NULL` vĩnh viễn |
| Đối soát thu tiền | salary_staff_id auto + ảnh chứng từ + **GPS lúc bấm thu** |
| Cờ review thủ công | >8 việc/ngày · khiếu nại Zalo 48h · bịa-vấn-đề lặp → owner duyệt, KHÔNG tự trừ |
| Escrow job sửa | 70% ngay + 30% sau 48h im lặng/CSAT tốt; clawback reopen 10 ngày |
| Geofence | audit-only đầu; điều kiện chi chỉ sau Phase 0 ≥90%; override có audit |
| Truy vết | `award_job_bonus` + record PHẢI log `salary_award_errors` |
| Diminishing | việc/phiếu thừa = 0đ (chỉ điểm phi-tiền) → không bơm tiền bằng số việc |

## B.9 — Self-view UI & thông báo (gain-framing)

- **Thanh leo:** đầy dần từ đáy. *"Đã ghi nhận 3.600.000 / 4.000.000 — leo tiếp! 🚀"*. Đáy cứng tách riêng: *"Đáy an toàn đã chốt: 4.960.000 (vùng I)"*. **CẤM** `−` / "mất" / "bị trừ".
- **Popup ghi nhận** (realtime): *"✅ Đã ghi nhận ngày công hôm nay (tạm tính +400.000). Còn 4 ngày để full tháng này."* — luôn "tạm tính".
- **Streak popup:** *"🔥 Chuỗi 7 ngày! +200K vào quỹ thưởng (tạm tính)."* · Đứt: *"Bắt đầu chuỗi mới 🔥 — khiên còn 1."*
- **Daily recap 19:00** (push, tắt 21h–7h): *"Hôm nay: 1 ngày-công ✅ · 6 thao tác · chuỗi 12 ngày. Tháng này 3,6/4,0tr."*
- **Onboarding 5 phút:** *"Mỗi ngày đi làm, làm 1 việc thật (kiểm tra nhà / thu tiền / sửa / ký HĐ) + chụp ảnh tại chỗ là đủ tick ngày. Đủ 18 ngày = full phần mềm = 8 triệu. Nghỉ phép báo trước không mất chuỗi."*
- **Khách KHÔNG BAO GIỜ thấy điểm** của quản lý. Mọi cờ review có người duyệt.

## B.10 — Phase 0 (ĐO trước khi "bật công tắc tiền") + rủi ro

### PHẢI ĐO trước (chốt chặn)

| # | Phép đo | Nguồn | Ngưỡng quyết |
|---|---|---|---|
| 1 | % việc COMPLETED có ảnh + `geofence_status='ok'` ≤70m / 90 ngày | `jobs` | ≥90% → bật geofence điều kiện chi; <90% → audit-only, ảnh-hash là cổng duy nhất |
| 2 | Phân bố số ngày-có-việc-qua-cổng/tháng/người | `jobs`+`income_expenses` | trung vị <18 → HẠ `FULL_DAYS` trước khi gắn tiền |
| 3 | Tỷ lệ phiếu CASH có `salary_staff_id` + GPS | `income_expenses` | thấp → đẩy form auto-set + GPS trước |
| 4 | % ảnh camera-only thật | `completion_attachments` | làm cổng hash |

### SHADOW MODE 3 tháng
Tính điểm + hiện thanh leo từ 0, **VẪN trả đủ 8tr bất kể điểm**. Không một đồng rớt vì "không đạt điểm". Dùng hiệu chỉnh `FULL_DAYS` theo dữ liệu thật + cho nhân viên quen UI gain trước anchoring.

### Rủi ro còn lại
1. **Anchoring 8tr cũ** (cảm giác "bị cắt") — shadow + gain-framing + truyền thông; **CÒN MỞ**.
2. **Pháp lý "phụ cấp năng suất"** bị gộp thành "lương giữ trái luật" — **CHẶN**, cần HR/luật sư.
3. **% geofence_ok thực tế thấp** (nhà bê tông) — đo #1; <90% = audit-only.
4. **Presenteeism** — streak tách khỏi 4tr + khiên + phép + CN miễn + buffer 8 ngày (giảm mạnh).
5. **Khai khống ngày-công** (1 việc rác/ngày) — ảnh-hash + geofence audit + cờ >8 việc + KPI quý; residual chấp nhận.
6. **Anti-collusion tầng-2** (tự tạo + tự đóng job sửa bịa) — cần audit mẫu ngẫu nhiên; **CÒN MỞ**.
7. **Động lực nửa cuối tháng** (đủ 18 ngày rồi nghỉ tay) — KPI quý + badge + "tháng hoàn hảo"; **CÒN MỞ**.

---

## Tóm tắt cho chủ doanh nghiệp

- **8tr không mất:** ai đi làm bình thường (≥18 ngày có việc thật) vẫn nhận đủ 8tr. Chỉ "ở nhà/đi cho có" mới rớt về sàn (= lương tối thiểu vùng).
- **Hệ thống tự chấm:** mỗi việc thật (kiểm tra nhà, thu tiền **bấm tại chỗ + GPS**, sửa, ký HĐ) tự tick ngày-công + tính điểm, không cần khai báo.
- **4tr mềm = số ngày-công** (400k/ngày trong khoảng 8→18 ngày). **Streak + thưởng việc + KPI = thưởng THÊM trên đỉnh** (có thể vượt 8tr).
- **Bắt buộc làm trước:** đo % GPS-ok thật + chạy 3 tháng shadow (trả đủ 8tr, chỉ hiện thanh) + xác nhận lương tối thiểu vùng với luật sư.

Chi tiết schema/RPC: [THIET-KE-BANG-LUONG-KPI-GAMING.md](THIET-KE-BANG-LUONG-KPI-GAMING.md) Phần 2 · Đồng thuận nền: [BAN-TRON-CO-CHE-LUONG-THUONG.md](BAN-TRON-CO-CHE-LUONG-THUONG.md).
