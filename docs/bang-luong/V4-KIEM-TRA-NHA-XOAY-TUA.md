# v4.3 — "Kiểm tra nhà" thành nguồn ngày-công + hệ thống coverage xoay tua

> Trả lời 2 câu hỏi sống còn của cơ chế v4: **(1) Ngày không có việc thì nhân viên lấy gì để tick ngày-công/streak?** và **(2) Làm sao đảm bảo bao quát HẾT toà — chất lượng, không hình thức?** Kèm: **setting ngày-nghỉ-có-lương/tháng** (chủ yêu cầu).
>
> Hội đồng 6 vai bàn trên **DỮ LIỆU THẬT** (query DB prod 2026-07-02). Nền: [BAN-TRON-CO-CHE-LUONG-THUONG-V4.md](BAN-TRON-CO-CHE-LUONG-THUONG-V4.md) (v4.2: chuyên cần 6tr = 231k/ngày × 26; streak 3tr mốc 4/8/13/18/23/26).
>
> Cập nhật: 2026-07-02.

---

## 0. DỮ LIỆU THẬT — vì sao bài toán này cấp bách

**NATHAN — 9 toà ở (172 phòng, 165 đang thuê) + Kho VP Chung. ~104 việc/60 ngày ≈ 2 việc/ngày-làm:**

| Toà | Phòng | Việc/60d | Ghi chú |
|---|---:|---:|---|
| 1392QT | 35 | 32 | Rất bận |
| 102LVT | 40 | 17 | Bận |
| 331PHI | 12 | 15 | Bận |
| 512TT | 17 | 12 | Bận |
| 403PVB | 15 | 9 | việc cuối 22/6 |
| 405PVB | 19 | 7 | **im 2 tuần** (việc cuối 17/6) |
| 481NVK | 10 | 5 | Vừa |
| 15KV | 8 | 4 | Êm |
| 44TL | 16 | 3 | Êm |

**JOEY — 7 toà ở (91 phòng, 90 đang thuê) + Kho. Chỉ ~20 việc/60 ngày ≈ 0,4 việc/ngày-làm:**

| Toà | Phòng | Việc/60d | Ghi chú |
|---|---:|---:|---|
| 111PVC | 19 | 5 | |
| 80DS3 | 21 | 5 | Toà lớn nhất |
| 32PVC | 8 | 4 | **trắng việc từ 25/5 — hơn 1 tháng** |
| 417LVT | 15 | 3 | |
| 158PVC | 13 | 2 | |
| 162NVK | 9 | 1 | **trắng việc từ 25/5** |
| 65NTG | 6 | **0** | **ĐIỂM MÙ TUYỆT ĐỐI — 0 việc/60 ngày, không ai ghé 2 tháng** |

**Hai kết luận không cãi được:**
1. **Joey KHÔNG THỂ full chuyên cần nếu chỉ dựa việc-phát-sinh** — việc chỉ cover ~10/26 ngày. Đó không phải lười; toà của Joey ÊM (và êm là TỐT). → Kiểm tra nhà phải là nguồn ngày-công hạng nhất.
2. **65NTG / 32PVC / 162NVK là lỗ hổng quản trị tài sản** — 6-9 phòng khách đang ở mà cả tháng+ không ai đặt chân tới (rò nước, PCCC, khách âm thầm bất mãn rồi đi). → Cần SLA coverage cứng + app nhắc chủ động, bất kể chuyện lương.

---

## 1. NGUYÊN TẮC CHỐT (đồng thuận 6 vai)

1. **Ngày không việc → job "Kiểm tra nhà" ĐẠT CHUẨN = 1 ngày-công đầy đủ (231k)**, ngang hàng sửa chữa/thu tiền/ký HĐ. Không phải "phao chuyên cần" — công ty trả tiền **MUA COVERAGE** (mắt giám sát trên tài sản tiền tỷ); với người quản toà êm, chi phí biên ≈ 0đ.
2. **Chất lượng > hình thức:** đạt chuẩn = đủ checklist + đủ ảnh camera-only + dwell tối thiểu + hạng mục random. Fail gate → chỉ ghi *presence* (reset đồng hồ SLA), **KHÔNG tick ngày-công**. *"Mua sự kiểm tra, không mua sự có mặt."*
3. **Binary tuyệt đối:** đi 3 toà/ngày vẫn 1 ngày-công; phần vượt chỉ cộng ĐIỂM HOẠT ĐỘNG phi-tiền (diminishing theo recency). Kiểm tra nhà **0đ/phiếu vĩnh viễn** trong tiền-sống.
4. **Gợi ý ≠ ra lệnh:** app xếp lịch hộ, nhân viên tự sắp lại; ràng buộc máy duy nhất là **SLA theo TOÀ**. Quá SLA không trừ tiền/streak — chỉ visibility lên chủ. *Trừ máy = dạy nhân viên đánh lừa máy.*
5. **Ngoại lệ kỷ luật duy nhất:** gian lận dữ liệu ảnh (hash trùng, né camera-only, EXIF giả) = huỷ ngày-công đó + mất streak tháng.
6. **Van an toàn:** GPS/geocode lỗi → flag "ảnh hợp lệ, geofence fail" cho chủ duyệt tay 1 chạm. Mọi ngưỡng là SETTING. SHADOW 3 tháng trước khi gate cắt tiền; grace 14 ngày đầu không escalate.
7. Ngày đã có việc → phiên kiểm tra chỉ cộng điểm (chặn "né việc khó đi chụp ảnh dạo"). **Kho VP Chung không tick công** trừ khi có job thật.

---

## 2. PHÂN LOẠI TOÀ + CADENCE (phân loại ĐỘNG theo cửa sổ trượt 30 ngày, cron đêm tính lại)

Hạng: **BẬN** ≥6 việc/30d · **VỪA** 2–6 · **ÊM** <2 (hoặc 30 ngày trắng việc).

### NATHAN

| Toà | Hạng | SLA touch (max ngày không chạm) | FULL inspection | Cách phủ chính |
|---|---|---|---|---|
| 1392QT, 102LVT, 331PHI, 512TT | BẬN | 7 (việc tự phủ) | ≤14 ngày (app tự chèn) | **Piggyback — CẤM chuyến riêng** |
| 403PVB + 405PVB | VỪA | 7 | ≤7–14 | **Luôn cặp 1 chuyến 2 toà** (cùng cụm; xoá điểm mù 405) |
| 481NVK | VỪA | 7 | ≤7–14 | Lịch tuần |
| 15KV, 44TL | ÊM | 7 | ≤7 (1 FULL/tuần) | Lịch cứng |
| Kho VP | — | 14 | — | Chỉ điểm, không tick công |

### JOEY — theo cửa sổ 30 ngày, **cả 7 toà đều ÊM** → kiểm tra là xương sống ngày-công

| Toà | Rủi ro | SLA touch | Nhịp đề xuất |
|---|---|---|---|
| 80DS3 (21p) | Toà lớn nhất | 7 | 1 FULL/tuần + 1 chạm 2 |
| 111PVC, 417LVT, 158PVC | Cụm PVC/êm | 7 | 1 FULL/tuần (luân phiên FULL/QUICK trong cụm) |
| 32PVC | **ĐIỂM MÙ** | 7 | 1 FULL/tuần cứng |
| 162NVK | **ĐIỂM MÙ** | 7 | 1 FULL/tuần cứng, ngày cố định |
| 65NTG | **ĐIỂM MÙ TUYỆT ĐỐI** | 7 | **2 lần/tuần 4 tuần đầu, slot ghim T6**; sau về 1/tuần |
| Kho VP | — | 14 | 2 tuần/lần, không tick công |

**Rút SLA:** toà có phòng trống đang chào khách HOẶC HĐ đáo hạn ≤30 ngày → touch **5 ngày** (ngưỡng màu 3/5/7).

---

## 3. LỊCH TUẦN MẪU (khung GỢI Ý — engine risk hoán đổi mỗi sáng; việc phát sinh luôn thế chỗ phiên kiểm tra của toà đó; CN nghỉ)

### NATHAN (~4–6 phiên kiểm tra/tuần; trần ~8 chuyến riêng/tháng — vượt = lỗi thuật toán điều phối)

| Thứ | Tuyến | Loại |
|---|---|---|
| T2 | **403PVB + 405PVB** — 1 chuyến 2 toà | 2 FULL |
| T3 | Việc phát sinh nhóm bận + piggyback QUICK tại toà đang làm | Piggyback |
| T4 | 44TL (êm nhất) + 481NVK | 2 FULL |
| T5 | 15KV + việc phát sinh | 1 FULL |
| T6 | FULL luân phiên nhóm bận: tuần lẻ 1392QT+102LVT, tuần chẵn 331PHI+512TT + Kho VP (2 tuần/lần) | FULL quét sâu |
| T7 | Quét toà VÀNG/ĐỎ còn sót theo risk + việc tồn | Bù |

### JOEY (~15–16 chuyến FULL/tháng ≈ khít số ngày cần tick; mỗi ngày 1 toà FULL + tối đa 1–2 QUICK cùng cụm)

| Thứ | Tuyến | Loại |
|---|---|---|
| T2 | **111PVC (FULL) + 32PVC (QUICK)** — cùng trục Phạm Văn Chiêu, 1 chuyến; toà FULL luân phiên tuần sau | FULL + QUICK |
| T3 | **80DS3** riêng — 21 phòng, làm kỹ + ảnh sale phòng trống | FULL sâu |
| T4 | 417LVT (FULL) + 162NVK (FULL/QUICK luân phiên) | FULL + Q |
| T5 | 158PVC (FULL) + Kho VP (2 tuần/lần) | FULL |
| T6 | **65NTG — SLOT GHIM, không trôi tuần** (4 tuần đầu thêm chuyến 2 vào T3; tuần đầu: gặp khách hỏi thăm — "trả nợ quan hệ" 2 tháng không ai ghé) | FULL |
| T7 | Quét nợ theo risk + chạm thứ 2 cho 80DS3/111PVC + việc phát sinh | Bù |

Quy tắc lai cụm: đi cụm thì **1 toà FULL (nguồn tick) + toà còn lại QUICK (reset touch)**; toà FULL luân phiên. Không chạy 3 FULL/ngày.

---

## 4. PROTOCOL TẠI TOÀ

**Phiên FULL** = job "Kiểm tra nhà" (job_type có sẵn), checklist sinh theo toà. UI: **"Bắt đầu"** (1 chạm, auto geofence 70m) → chụp theo checklist (toggle mặc định OK, chỉ chạm khi có vấn đề, KHÔNG nhập text) → **"Hoàn tất"** + trường **"Tình trạng nhà": Tốt / Có vấn đề** (1 chạm; "Có vấn đề" → +1 ảnh cận → app **TỰ sinh job sửa chữa** prefill toà + ảnh). **Ngoài thao tác chụp: đúng 2 chạm.**

**Checklist điểm cố định:**
1. Tủ điện tổng / CB (tiện đọc số nếu sát kỳ chốt)
2. PCCC — bình (tem hạn / kim áp) + lối thoát không bị chắn
3. Hành lang **TẦNG do app chỉ định random**
4. Nước — bơm / bồn / đồng hồ tổng / khu rác
5. **PHÒNG TRỐNG (bắt buộc khi toà đang chào khách)** — mở cửa vào trong, ảnh nạp thẳng module Sale Phòng (*giá trị kép: hàng sẵn bán + không thể fake từ ngoài xe vì phải có chìa khoá*)
6. **+1 hạng mục sâu random theo seed ngày+toà** (không đoán trước được)
7. Chip tuỳ chọn "Chạm khách" [Ổn]/[Có phản ánh] — chỉ cộng điểm, không là điều kiện công

| Cỡ toà | Ảnh tối thiểu | Vị trí | Dwell tối thiểu (setting) | Thực tế | Áp dụng |
|---|---|---|---|---|---|
| ≤10 phòng | ≥4 | ≥2 vị trí | **8′** | 10–15′ | 65NTG, 32PVC, 162NVK, 15KV, 481NVK |
| 11–20 phòng | ≥5 | ≥3 vị trí | **12′** | 15–25′ | 403/405PVB, 44TL, 512TT, 331PHI, 111PVC, 417LVT, 158PVC |
| >20 phòng | ≥7 | **≥2 tầng khác nhau** | **18′** | 25–45′ | 1392QT, 102LVT, 80DS3 |

**Phiên QUICK (piggyback):** 2 ảnh (PCCC/lối thoát + tủ điện), 3–5′, 1 chạm mở từ màn hình hoàn-thành-job, geofence dùng lại. Reset touch + cộng điểm, **KHÔNG reset FULL, không tự là ngày-công**. Toà chỉ toàn QUICK vẫn phải 1 FULL/14 ngày (app tự chèn).

- Dwell = timestamp ảnh đầu → ảnh cuối trong geofence, hệ tự đo — không ai bấm giờ.
- **Fail gate báo NGAY TẠI TOÀ**, gain-framing: *"còn 2 mục nữa là đủ công hôm nay"* — cho bổ sung tại chỗ.
- **Lằn ranh riêng tư:** ảnh chỉ KHU CHUNG + phòng TRỐNG; cấm cửa/nội thất phòng khách đang ở, cấm mặt khách.

---

## 5. PRIORITY SCORE + NHẮC CHỦ ĐỘNG

**Công thức hợp nhất** (cron đêm; mọi trọng số là setting):

```
score = D × (1 + P/20)                        -- D = ngày (trừ CN) từ DẤU CHÂN THẬT gần nhất; P = số phòng
      + 10  nếu có phòng trống đang chào khách
      + 5 × số HĐ đáo hạn ≤30 ngày (cap 10)
      + 5   nếu kỳ chốt điện nước / thu tiền ≤3 ngày tới
      + 15  nếu có sự cố điện/nước/PCCC đang mở (90 ngày)
```

**Dấu chân thật (reset đồng hồ D):** job hoàn thành có ảnh+geofence · phiên kiểm tra đạt chuẩn (FULL/QUICK) · phiếu thu bấm-tại-chỗ có GPS. Job không ảnh / phiếu không GPS → **không reset**.

*Kiểm chứng data go-live 02/07: 65NTG ≈ 78+, 162NVK ≈ 55, 32PVC ≈ 53, 405PVB ≈ 29, 403PVB ≈ 17 → hàng đợi tự xếp đúng thứ tự chủ đang lo.*

| Nấc | Ngưỡng thường / toà chào khách | Hành động | Kênh |
|---|---|---|---|
| **VÀNG** | D ≥ 5 / ≥ 3 | Toà vào khối "Hôm nay nên đi" (sort risk, kèm **lý do bằng chữ** + gợi ý ghép cụm), không push | In-app |
| **ĐỎ** | D ≥ 7 / ≥ 5 | Web Push đích danh, gain-framing: *"65NTG đã 7 ngày chưa ai ghé — ghé hôm nay là chắc 1 ngày-công"* + deep-link mở phiên prefill | 1 digest/người/ngày, 7h00 |
| **ESCALATE** | D ≥ 10 / ≥ 7 | Push chủ + toà ghim đỏ dashboard + ghi SLA-breach vào KPI coverage tuyến (không trừ tiền ai) | Push chủ |

**Chống spam:** đúng 1 digest push coverage/người/ngày (gộp top 2–3 toà); tắt CN + ngày phép đã duyệt; quiet hours 21h–7h; thẻ "Tuyến sáng mai" hiện in-app từ 19h (không notification). **Grace 14 ngày đầu:** digest chạy ngay, escalate tạm tắt (tránh ngày 1 Joey ăn 3 dòng đỏ vì nợ cũ 2 tháng).

---

## 6. CƠ CHẾ APP

- **Nhiệm vụ ngày:** cron 6h00 tính score → 7h00 phát danh sách 1–3 toà + job sẵn có; engine **bắt buộc thử piggyback trước khi tạo chuyến riêng**.
- **Coverage map:** grid toà, màu theo **D thuần** (dễ hiểu; score chỉ để sort): XANH ≤4, VÀNG 5–7, ĐỎ >7 (toà chào khách 3/5/7). Hai đồng hồ hiển thị: touch + FULL.
- **Piggyback prompt:** xong job tại toà D≥5 (hoặc toà cùng cụm ≤500m có D≥5 — vd xong 403PVB → *"405PVB cách vài trăm mét, 12 ngày chưa ai ghé"*) → prompt 1 chạm mở QUICK, kèm "+15đ". Tối đa 1 prompt/toà/ngày; nút "Để sau" to bằng "Quét luôn"; từ chối không bị log xấu.
- **Điểm hoạt động (phi-tiền vĩnh viễn, diminishing theo recency):** quét toà ĐỎ +25 / VÀNG +15 / XANH +5; Perfect Day (trọn Nhiệm vụ ngày) +10; cap 1 lượt/toà/ngày. Thanh **"PHỦ TUẦN %"** cạnh thanh chuyên cần trên self-view. *(Bảng điểm tự nhiên nghiêng về Joey — kênh công nhận đúng cho người tuần tra.)*

---

## 7. CHỐNG ĐỐI PHÓ (5 lớp + audit)

| Mánh | Khoá |
|---|---|
| Chụp 1 tấm sảnh rồi về | Checklist đa-vị-trí (tủ điện + tầng random + sân thượng + TRONG phòng trống) + min dwell theo cỡ toà + min ảnh/vị trí |
| Nộp lại ảnh cũ / chụp hộ | Camera-only (không gallery) + ảnh-hash + EXIF tăng dần + watermark Timemark GPS-address + geofence từng ảnh trên device đang đăng nhập |
| 6 tấm cùng góc | Similarity check giữa ảnh trong phiên (perceptual hash; chưa kịp thì tạm: tầng random + hash exact + audit) |
| Ngồi quán cà phê trong bán kính 70m chờ dwell | Checklist bắt di chuyển (sân thượng, trong phòng trống — không chụp được từ quán) |
| Reset 3 đồng hồ 1 buổi hời hợt | Từng phiên qua trọn cổng riêng + **travel-time plausibility**: ảnh cuối phiên A → ảnh đầu phiên B ≥ thời gian di chuyển thực giữa 2 toạ độ toà (403→405 4′ OK; 80DS3→65NTG 4′ = cờ đỏ) |
| Dồn tick / farm | Binary + điểm diminishing (toà xanh ≈ 0 điểm) + Joey max 1 toà-chính/ngày |
| Kho in ngày-công | Kho chỉ tick khi có job thật |

**Spot-audit chủ:** 2–3 phiếu/tuần (~5%/tháng). Chỉ báo sức khoẻ: 20–30% chuyến sinh 1 việc/ghi chú = lành mạnh; 0% kéo dài 3–4 tuần = soi hồ sơ ảnh (KHÔNG mặc định nghi gian khi "Tốt" liên tục; **KHÔNG thưởng tiền theo số vấn đề phát hiện** — đã bác từ v2 vì tạo động cơ bịa vấn đề).

---

## 8. SETTINGS (owner chỉnh không cần deploy — `salary_bonus_rules.rules` jsonb + override per-toà)

| Key | Default | Range | Ghi chú |
|---|---|---|---|
| **`paid_leave_days_per_month`** | **1** | **0–4** | **Yêu cầu chủ: ngày-nghỉ-có-lương/tháng là SETTING.** Không dồn; phép duyệt tính như ngày công + đóng băng streak |
| `sla_touch_days` | 7 | per-toà | Kho VP = 14 |
| `sla_touch_vacant_days` | 5 | — | Toà có phòng trống chào / HĐ đáo hạn ≤30d |
| `coverage_yellow / red / escalate` | 5 / 7 / 10 | — | Toà chào khách: 3 / 5 / 7 |
| `full_inspection_interval_days` | 14 | per-toà | Toà êm thực tế FULL hàng tuần |
| `dwell_min_small / medium / large` | 8′ / 12′ / 18′ | per-toà | Tinh chỉnh trong shadow |
| `min_photos_small / medium / large` | 4 / 5 / 7 | — | Large: ≥2 tầng |
| `piggyback_threshold_days` | 5 | — | Ngưỡng hiện prompt |
| `score_weights` (vacant/contract/cycle/incident) | 10 / 5 / 5 / 15 | — | + cap HĐ = 10 |
| `points_red / yellow / green / perfect_day` | 25 / 15 / 5 / 10 | — | Phi-tiền |
| `quiet_hours` | 21h–7h | — | + tắt CN, ngày phép |
| `grace_period_days` | 14 | — | Escalate tắt khi mới bật |
| `solo_trip_budget_per_month` | 8 | per-người | Trần chuyến riêng Nathan — vượt = sửa thuật toán điều phối |
| `dwell_fail_mode` | `audit_flag` (shadow) | `audit_flag` / `hard_gate` | Quyết sau shadow |

---

## 9. TÍCH HỢP KỸ THUẬT

> Tận dụng hạ tầng sẵn: jobs + job_type "Kiểm tra nhà", geofence 70m + `buildings.lat/lng`, camera-only + Timemark + ảnh-hash từ nghiệm thu, notifications + Web Push `send-push`, pg_cron, `salary_work_ledger`.

| Thành phần | Chi tiết |
|---|---|
| **`building_coverage`** (mới) | `building_id PK, assignee_id, last_touch_at, last_touch_type (job/full/quick/receipt_gps), last_full_at, tier (busy/mid/quiet — cron tính từ jobs 30d), cluster_id, sla_override jsonb, updated_at` |
| **`inspection_sessions`** (mới) | `id, job_id FK jobs, building_id, user_id, mode (FULL/QUICK), started_at, ended_at, dwell_seconds, photos_count, checklist jsonb, condition (good/issue), quality_pass bool, fail_reasons text[], geofence_flag bool (chờ duyệt tay), spawned_job_id` |
| **`inspection_photos`** (mới) | `session_id, slot (checklist item), storage_path, sha256_hash UNIQUE, phash, exif_time, lat/lng, distance_m` |
| Cột mới | `buildings.cluster_id` (cụm đường: PVB, PVC…) |
| RPC | `get_daily_missions(p_user)` — score + lý do chữ + ghép cụm · `start_inspection(p_building)` — checklist theo cỡ toà + hạng mục random seed(ngày+toà) + danh sách phòng trống từ DB · `submit_inspection_photo` (hash + geofence + EXIF) · `complete_inspection` — chấm gate tại chỗ, pass → mirror `salary_work_ledger` (nguồn ngày-công như award_job_bonus) · `start_quick_check(p_building, p_source_job)` · `recompute_building_coverage()` (SECURITY DEFINER — nhớ bug class generator/RLS) |
| Cron (pg_cron) | 02:00 recompute tier 30d + coverage · 06:00 tính score + snapshot · 07:00 edge `send-push` digest/người (1 tin) · T7 digest tuần *"phủ 6/7 toà — còn 162NVK"* |
| Dấu chân thật | Query hợp nhất: `jobs` hoàn thành có attachments+geofence ∪ `inspection_sessions.quality_pass` ∪ `income_expenses` phiếu thu có GPS → ghi `building_coverage.last_touch_at` qua trigger/cron |
| FE | Khối "Hôm nay nên đi" + coverage map trên home mobile; piggyback prompt ở màn hình hoàn-thành-job; deep-link từ push (sw.js sẵn); duyệt tay geofence-fail 1 chạm cho owner |
| Travel-time check | `ended_at` phiên trước vs `started_at` phiên sau + haversine(buildings.lat/lng) / 25km/h → cờ audit |

---

## 10. METRICS + TRÌNH TỰ BẬT + CÒN MỞ

**Metrics (dashboard owner, chạy thật từ ngày 1 shadow):**
- % toà đạt SLA-7; **max days_since_touch toàn hệ thống** (mục tiêu: từ 60+ về ≤7 ổn định — **tiêu chí thoát shadow: 65NTG/32PVC/162NVK về nhịp ≤7 ngày**); heatmap coverage.
- % ngày-công từ kiểm tra nhà (Joey dự kiến ~60–70% — bình thường với danh mục êm); tỷ lệ fail-dwell của người-làm-thật (>10–15% → chỉnh ngưỡng; <5% → cân nhắc bật hard-gate); dwell trung vị per-toà.
- Tỷ lệ chuyến "Có vấn đề" (lành mạnh 20–30%); **% sự cố được bắt bởi kiểm tra / tổng sự cố (mục tiêu ≥20% sau 2 quý — KPI hoàn vốn)**; push ignore rate (>50% → giãn ngưỡng 7/10/15).

**Trình tự bật:** Tuần 1–2 grace (digest, chưa escalate) → shadow coverage 4 tuần (chỉnh dwell/ngưỡng per-toà) → 3 tháng shadow trước khi gate gắn vào tiền chuyên cần (bất biến v4).

**CÒN MỞ (quyết bằng dữ liệu shadow / chủ quyết):**
1. Dwell-fail = auto-không-tick (CEO) hay chỉ cờ audit (CFO) — >10–15% người-thật fail → cờ audit + chỉnh ngưỡng; <5% → auto-gate.
2. Con số dwell 8/12/18 vs 10/15/25 — tinh chỉnh per-toà.
3. Similarity check client-side (perceptual hash mobile) khả thi đến đâu; fallback = tầng random + hash exact + audit.
4. Bonus 15k/phiếu kiểm tra (trên-đỉnh) — chỉ XÉT sau 3 tháng shadow nếu chất lượng phiếu lành mạnh; CFO giữ phủ quyết.
5. **Chuyển 44TL + 15KV (24 phòng êm) từ Nathan sang Joey** để cân tải 172p vs 91p — sau 1 tháng shadow + kiểm tra cụm đường.
6. Kiểm tra chéo Nathan↔Joey 2 tuần/lần (CEO muốn fresh-eyes; HR lo thành giám sát lẫn nhau).
7. **Số phận 65NTG:** 6 phòng, 0 việc/60 ngày — nếu sau 1 quý chi phí ghé/doanh thu vẫn xấu nhất hệ thống → quyết định danh mục tài sản (gộp tuyến/thoái), không phải bài toán lương.
8. Trọng số score (10/5/5/15), ngưỡng piggyback D≥5, ngưỡng push 5/7/10 vs 7/10/15 — hiệu chỉnh shadow.
9. Chip "chạm khách" trong checklist FULL mặc định hay tuỳ chọn (tranh cãi riêng tư).
10. Số toà tối đa/ngày của Joey: CFO đòi cứng 1 chính + 1 piggyback vs engine tự quyết theo cụm.

---

## Tóm tắt cho chủ doanh nghiệp

- **Ngày không việc:** đi "Kiểm tra nhà" đạt chuẩn (checklist + ảnh + đủ thời gian tại toà) = **1 ngày-công đầy đủ 231k** — với Joey (7 toà êm, 0,4 việc/ngày) đây là xương sống ngày-công; với công ty đây là mua bảo hiểm tài sản rẻ nhất.
- **Không toà nào bị bỏ rơi:** SLA cứng **7 ngày/toà** (5 ngày nếu đang chào khách); app tự nhắc 3 nấc (vàng in-app → đỏ push nhân viên → ngày 10 push chủ). 65NTG/32PVC/162NVK về mặt toán học **không thể tái diễn** — đồng hồ idle chạy tự động.
- **Chất lượng không hình thức:** checklist đa-vị-trí + phòng trống phải mở cửa vào trong + hạng mục random + dwell tối thiểu theo cỡ toà + ảnh-hash/camera-only + travel-time check. Fail = không tick công, báo ngay tại toà cho bổ sung.
- **Piggyback:** có việc ở toà nào → app nhắc *"sẵn ở đây, quét nhanh 10 phút?"* (1 chạm) — kể cả toà cùng cụm cách vài trăm mét (403↔405).
- **Setting:** ngày-nghỉ-có-lương/tháng = `paid_leave_days_per_month` (mặc định 1, chỉnh 0–4) + toàn bộ ngưỡng cadence/dwell/điểm đều chỉnh được không cần deploy.

Thư mục `docs/bang-luong/`: kỹ thuật · bàn tròn v1 · v2 · v3 · v4 (cơ chế tiền) · **v4.3 file này (coverage xoay tua)**.
