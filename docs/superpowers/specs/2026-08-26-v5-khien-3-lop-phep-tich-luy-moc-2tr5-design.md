# V5.1 — Khiên 3 lớp · Phép tích lũy theo năm · Thang streak 2.5tr đỉnh động

**Ngày:** 2026-08-26 · **Trạng thái:** Chủ đã duyệt thiết kế (hội thoại 26/08) · **Hiệu lực:** 01/09/2026

Thay đổi chính sách lương v5 theo quyết định của chủ, gồm 4 khối. Mọi mô tả "luật cũ"
tham chiếu `docs/bang-luong/V5-HE-THONG-LUONG-THUONG-THONG-NHAT.md` (§4.3, §4.4) và engine
`v5_recompute_streak` / `v5_close_period` / `request_paid_leave` hiện hành.

## 1. Bộ khiên 3 lớp (thay khiên miễn phí 3 + khiên dự trữ cũ)

| Lớp | Tên | Cách kiếm | Kho tối đa | Mang qua tháng |
|---|---|---|---|---|
| 1 | Khiên miễn phí | Phát 1 cái mùng 1 hằng tháng (cũ: 3) | 1 | Không — không dùng thì mất |
| 2 | Khiên tháng-hoàn-hảo | Tháng đi đủ 100% ngày làm việc (KHÔNG nghỉ ngày nào, **kể cả nghỉ có phép**) → +1 | 3 | Có |
| 3 | Điểm Chủ nhật | Mỗi CN có ngày công (tick bất kỳ nguồn) → **+0.5 điểm** | Không giới hạn | Có, vĩnh viễn |

- Khi lỡ 1 ngày làm việc (không tick, không phép): tiêu **lớp 1 → lớp 2 → lớp 3** (1 ngày = 1.0 điểm
  lớp 3, tức 2 CN đổi 1 ngày). **Không còn trần tiêu theo tháng** (bỏ `spend_cap`). Hết cả 3 lớp
  → chuỗi về 0.
- Dùng khiên **không mất gì khác** — mốc trọn-tháng đã bỏ (mục 3), vết lỡ chỉ còn dùng để xét
  điều kiện kiếm lớp 2.
- **Khiên dự trữ cũ bị khai tử.** Tồn kho `shields_reserve` hiện có của nhân viên quy đổi 1:1
  sang lớp 2 (một lần, trong migration — không ai thiệt).
- Luật kiếm lớp 2 khác luật cũ ở hai điểm: (a) điều kiện nghiêm hơn — cũ cho phép nghỉ-ngang ≤1
  và nghỉ phép không tính; mới đòi đi đủ 100% ngày làm việc, nghỉ phép cũng làm mất suất;
  (b) cap tồn tăng 2 → 3.

## 2. Phép tích lũy theo năm

- Tích **+1 ngày phép đầu mỗi tháng** (rate = config `paid_leave_days_per_month`, giữ default 1).
- Không dùng thì **dồn trong năm dương lịch**, tối đa 12 ngày/năm. **Reset 01/01** — số tồn về 0,
  tích lại từ đầu.
- Kiểm tra khi xin (`request_paid_leave`): `số dư = số tháng đã trôi trong năm (1..12) × rate
  − số ngày phép (approved + pending) đã dùng trong năm`. Bỏ luật đếm-trong-tháng cũ.
  Được nghỉ nhiều ngày phép trong cùng một tháng nếu còn số dư.
- Các luật khác giữ nguyên: chỉ xin cho hôm nay/tương lai; CN không xin được; ngày đã tick
  không đổi thành phép; phép bắc cầu chuỗi + trừ N_chuẩn cá nhân (tiền chuyên cần không hụt);
  pending bắc cầu tạm, từ chối thì trả lại số dư.
- Năm 2026 chuyển tiếp: số dư tính từ tháng 1/2026 (year-to-date) trừ đi phép đã dùng trong năm.

## 3. Thang streak 2.5tr — đỉnh động = N_chuẩn, bỏ mốc trọn-tháng

Budget pool streak: 3.000.000 → **2.500.000**. Pool chuyên cần giữ nguyên 6.000.000.

| Mốc chuỗi | 4 | 8 | 13 | 18 | 23 | **Đỉnh = N_chuẩn** |
|---|---|---|---|---|---|---|
| Delta | +300k | +400k | +500k | +500k | +400k | **+400k** |
| Cộng dồn | 300k | 700k | 1.200k | 1.700k | 2.100k | **2.500k** |

- **Mốc đỉnh là số ĐỘNG** = N_chuẩn của từng người từng tháng (số ngày làm việc của tháng trừ
  ngày phép duyệt của riêng họ). Tháng lễ dài tự co; người nghỉ phép vẫn chạm đỉnh được.
- **Mốc `full_month` (sentinel) bị bỏ hẳn** — không còn gate `breaks_no_leave = 0` cho tiền.
  Đỉnh đạt bằng số học chuỗi thuần túy: chuỗi chỉ +1 ngày thực đi làm, nên ai lỡ 1 ngày (dù
  khiên che, chuỗi không đứt) có chuỗi tối đa N_chuẩn − 1 → hụt đúng mốc đỉnh. Hệ quả này
  đã nói rõ với chủ và được duyệt.
- Nếu N_chuẩn < một mốc số nào đó (tháng lễ cực ngắn/nghỉ phép nhiều): cắt mốc đó, **delta dồn
  vào mốc cao nhất còn lại** (đổi đích dồn — cũ dồn vào full_month).
- Điểm CN (+0.5) **không cộng vào con số chuỗi** — chỉ vào kho lớp 3.

## 4. Sửa dữ liệu Joey tháng 7 — ĐÃ LÀM XONG 26/08

23/7 & 25/7 chèn `leave_approved` (audit `owner_backfill_leave`), recompute: breaks 0,
full_month bank, tháng 7 = 6tr + 3tr = 9tr (theo luật CŨ — tháng 7-8 vẫn chạy luật cũ, xem §6).

## 5. Thiết kế kỹ thuật

### 5.1 Nguồn sự thật kho khiên: SUY RA TỪ SỔ, không phải biến bị trừ tay

Kho lớp 2 + lớp 3 và lượng đã tiêu đều **derive được thuần túy** từ `salary_attendance_day`
kể từ 01/09/2026 (mốc hiệu lực, hằng trong config `system_v5.shield_bank_from`). Engine mô phỏng
timeline theo thứ tự thời gian: mỗi tháng lần lượt (earn cuối tháng trước → phát free →
duyệt từng ngày, tiêu 1→2→3). Bấm recompute bao nhiêu lần kết quả vẫn y hệt (idempotent),
không có bug trừ-trùng. Bảng `salary_streak_state` thêm cột cache để UI đọc nhanh:
`shields_perfect` (int), `sunday_points` (numeric(6,1)) — giá trị TẠI THỜI ĐIỂM recompute,
luôn ghi đè bằng số derive.

- CN trước 01/09/2026 không truy thu điểm. Khiên dự trữ cũ quy đổi qua một hàng seed
  (bảng `salary_shield_seed`: user_id, perfect_seed int) đọc như số dư khởi điểm lớp 2.
- `v5_recompute_streak(p_user, p_month)` cho tháng ≥ 09/2026 phải mô phỏng từ
  `shield_bank_from` tới cuối `p_month` (dữ liệu nhỏ: ≤ vài trăm row/người/năm).

### 5.2 Điểm chạm code

| Thành phần | Việc |
|---|---|
| Config (`get_salary_v5_config` seed + validator `update_salary_v5_config`) | `shields_free` 3→1; bỏ `spend_cap`/`reserve_cap`/`shield_earn` cũ; thêm `perfect_shield_cap: 3`, `sunday_point: 0.5`, `shield_bank_from: '2026-09-01'`; `streak_v5.budget` 2.5tr; `milestones: [4,8,13,18,23,'n_top']`, `deltas` mới; validator Σdeltas = budget giữ nguyên; phép: thêm `leave_accrual: 'yearly'` |
| `public_v5_effective_milestones` | sentinel `n_top` → mốc số = N_chuẩn; luật cắt dồn vào mốc cao nhất còn lại |
| `v5_recompute_streak` | bỏ nhánh full_month + reserve; thêm mô phỏng kho 3 lớp (§5.1); tháng < 09/2026 giữ nguyên luật cũ (§6) |
| `v5_close_period` | bỏ bank full_month + earn reserve cũ; không cần earn riêng (derive), chỉ giữ expire + mở SSS tháng mới với free=1 |
| `request_paid_leave` (+ hàm duyệt) | quota theo số dư năm (§2) |
| `v5_month_money` | không đổi công thức; tổng streak tự ≤ 2.5tr theo deltas mới; ASSERT trần đọc từ config (đã đọc động — kiểm lại) |
| UI | `SalarySelf*`, `MyDayPage`/`useMyDay`, `OwnerDashboardV5`, màn cấu hình lương: hiển thị 3 lớp khiên (1 free · x/3 hoàn hảo · y.z điểm CN), số dư phép năm, thang mốc mới, `incomeGoal` 9tr → 8.5tr |
| Copy `v5Copy.ts` | tổng lũy kế hợp lệ mới: 300/700/1.200/1.700/2.100/2.500; bỏ copy trọn-tháng, thêm copy mốc đỉnh động |
| Docs | V5-HE-THONG (§4.3, §4.4, worked examples), `docs/he-thong/17-luong-thuong.md` |
| Test | test thuần lib (nếu đụng), script SQL harness `scripts/test-v5-shield-bank.mjs` mô phỏng các ca: đứt khi hết 3 lớp, thứ tự tiêu, cap 3, điểm CN 0.5, đỉnh động, phép tích lũy, idempotency recompute ×2 |

### 5.3 Migration & lane

Một migration forward `20260901000000_v5_1_khien_3_lop_phep_nam_moc_2tr5.sql` (idempotent,
qua `gate:migration-idempotent`), đi `npm run migrate:forward` (lane tự backup). Provenance
qua `provenance:generate`. Config data-patch nằm trong cùng migration (UPDATE
`salary_bonus_rules` + audit entry), kèm seed quy đổi khiên dự trữ.

## 6. Chuyển tiếp & lùi

- **Tháng 7, 8/2026 chạy trọn luật CŨ** (engine rẽ nhánh theo `shield_bank_from`): mốc cũ 3tr,
  full_month, khiên 3+dự trữ — vì nhân viên đã chơi 2 tháng theo luật đó, đổi giữa chừng là
  loss-framing. LOCK tháng 8 vẫn ra số theo luật cũ.
- Từ kỳ 09/2026: luật mới toàn phần. Thông báo nhân viên trước 01/09 (khiên free 3→1 là chiều
  siết — cần truyền thông; nội dung thông báo do chủ quyết, ngoài phạm vi spec).
- Đường lùi: migration không xoá cột cũ (`shields_reserve` giữ nguyên, chỉ ngừng dùng);
  rollback = migration đảo config về giá trị cũ + engine bản cũ (giữ file SQL cũ nguyên vẹn
  trong lịch sử để tái tạo).

## 6b. Tu chỉnh đợt 2 (chủ quyết 26/08, sau phát hành đợt 1)

**Thang tiền 2.5tr đỉnh động áp cho CẢ tháng 7–8/2026** (migration
`20260826150000`), thay điều khoản "tháng 7–8 giữ trọn luật cũ" ở §6. Chỉ THANG TIỀN
hồi tố; CƠ CHẾ khiên/phép của kỳ legacy giữ nguyên (free 3, dự trữ, quota phép tháng) —
không bắt quá khứ chơi lại luật khiên mới. Hệ quả đã báo chủ: tháng 7 của người đủ
N_chuẩn từ 9tr về **8.5tr**; mốc trọn-tháng biến mất khỏi mọi kỳ; `v5_month_money`
còn một trần duy nhất đọc từ config.

## 7. Ngoài phạm vi

- Không đụng pool chuyên cần 6tr, sàn mềm, nguồn tick, chống gian lận, coverage, SLA.
- Không truy thu điểm CN quá khứ; không đổi cách LOCK/snapshot/salary_adjustments.
- Thưởng việc-thật CN/Lễ (+20k/+50k) giữ nguyên — điểm CN là quyền lợi CỘNG THÊM.
