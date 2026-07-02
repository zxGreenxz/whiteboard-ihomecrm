# V5 — NHẬT KÝ THỰC HIỆN + BẢN ĐỒ REVERT

> Theo dõi từng phase của [V5-PLAN-THUC-HIEN.md](V5-PLAN-THUC-HIEN.md). **Mọi phase đều revert được**:
> - **Code:** mỗi phase 1 commit prefix `feat(salary-v5): S<n>` — revert bằng `git revert <sha>` hoặc reset về tag **`pre-v5-salary`** (mốc trước khi bắt đầu, đã push).
> - **DB:** mỗi phase có file rollback SQL trong `scripts/` — chạy qua `node scripts/apply-sql.mjs scripts/v5_rollback_s<n>.sql` (Node UTF-8).
> - **Hành vi:** feature flags `system_v5.feature_flags` mặc định OFF (`v5_money:false, v5_coverage:false`) — chưa bật thì hệ hiện tại không đổi 100%.

| Mốc revert | Giá trị |
|---|---|
| Git tag trước v5 | `pre-v5-salary` (= commit `5371948`) |
| Rollback DB S1 | `scripts/v5_rollback_s1.sql` |

---

## S0 — Chuẩn bị (2026-07-03) ✅

- Tag `pre-v5-salary` đã tạo + push.
- **Đối chiếu schema live qua Management API** (không tin file migrations): 6 bảng v5 CHƯA tồn tại; `buildings` có `latitude/longitude`, chưa có `cluster_id`; `income_expenses` chưa có `collect_*`; CHECK `salary_adjustments.source` = 4 giá trị cũ; `salary_bonus_rules.rules` chỉ có key legacy; đủ `vn_local_*`, `award_job_bonus` (SECDEF), `get_acceptance_geofence_config`, enum `SALARY_BONUS`, geofence config `{enabled:true, radius_m:70}`; owner = super_admin đầu; 6 ngày lễ.
- **Phát hiện dữ liệu quan trọng:** ảnh hoàn thành job được MERGE vào `jobs.attachments` (49/129 job COMPLETED có ảnh) — `completion_attachments` = 0/129. Mọi chỗ đọc "job có ảnh" phải chấp nhận CẢ HAI cột.
- **Biên bản model phép (Mục 0 plan):** chủ ra lệnh "thực hiện toàn bộ plan" ⇒ duyệt model **phép TRUNG TÍNH** (leave_approved loại khỏi N_chuẩn, không tick, bắc cầu streak — kinh tế tương đương phép có lương). Nếu chủ muốn đổi lại → chỉ US-1.5/2.4/5.3 đổi AC.

## S1 — Nền dữ liệu (2026-07-03) ✅

**Migration:** `supabase/migrations/20260703000001_v5_foundation.sql` — đã apply live qua `scripts/apply-sql.mjs` (Node UTF-8).

Nội dung: 6 bảng (`inspection_sessions` [status KHÔNG có 'failed' — fail=presence], `inspection_photos` [UNIQUE session+hash], `salary_attendance_day` [UNIQUE user+date, 9 status], `salary_streak_state` [banked + khiên + sim_cap2], `cron_runs` [UNIQUE job+idem_key], `salary_award_errors`) + RLS (staff own-rows, ghi qua SECDEF) + cột `income_expenses.collect_*` + `buildings.cluster_id` + ALTER CHECK `salary_adjustments.source` (+ATTEND_V5/STREAK_V5) + VIEW `building_coverage` (3 nguồn dấu chân) + seed 4 khối settings v5 (flags OFF) + 4 RPC: `vn_workdays`, `v5_n_chuan`, `get_salary_v5_config`, `set_salary_v5_config` (💰 → pending tháng kế + audit + validate).

**TS:** `src/lib/v5Calendar.ts` (mirror calendar, không hardcode), `src/lib/v5Copy.ts` (copy tập trung + danh sách từ cấm), tests `src/lib/__tests__/v5Calendar.test.ts` + `v5Copy.test.ts`; scripts `apply-sql.mjs`, `v5-calendar-parity.mjs`, rollback `v5_rollback_s1.sql`.

**Test đã chạy (12 ca, tất cả PASS):**
| # | Ca | Kết quả |
|---|---|---|
| T1 | 6 bảng tạo đúng | ✅ |
| T2 | VIEW coverage khớp thực tế (65NTG=NULL; 162NVK/32PVC D=38; 405PVB D=15) — **bug ảnh-ở-attachments đã bắt & sửa ngay trong phase** | ✅ sau fix |
| T3 | Seed config: flags OFF, sla 4, deltas Σ=3tr | ✅ |
| T4 | Calendar SQL: T7/2026=27, T9/2026=25 (lễ 2/9) | ✅ |
| T5 | `get_salary_v5_config` đọc bằng ngữ cảnh NHÂN VIÊN (Joey) | ✅ |
| T6 | `set_salary_v5_config` CHẶN nhân viên (RAISE tiếng Việt font đúng) | ✅ |
| T7 | `v5_n_chuan` với 1 phép = 27−1=26 | ✅ |
| T8 | RLS SAD: Joey chỉ thấy dòng mình (1/2) | ✅ |
| T9 | Key 💰 → pending `2026-08-01`, giá trị hiện tại giữ, audit +1 | ✅ |
| T10 | Validate Σdeltas ≠ budget → RAISE | ✅ |
| T11 | Key phi-tiền áp NGAY (sla 4→5, rollback) | ✅ |
| T12 | vitest 15/15 · parity SQL≡TS 24/24 tháng · tsc 0 lỗi mới (baseline 106) · 0 hardcode 230769/26 trong logic | ✅ |

**Commit:** `feat(salary-v5): S1 — nền dữ liệu v5` *(điền SHA sau commit)*

## S2 — Engine dấu chân (2026-07-03) ✅

**Migrations:** `20260703000002_v5_engine.sql` + `20260703000003_v5_jobs.sql` — đã apply live (Node UTF-8). **Rollback:** `scripts/v5_rollback_s2.sql`.

Nội dung: `v5_tick_attendance` (hàm lõi B5 — advisory lock, idempotent, mọi nguồn đi qua, log `salary_award_errors`) · `v5_recompute_streak` (banked + 2 tầng khiên + sim_cap2 + reset_from_date cho án gian lận) · `start_inspection` (RESUME đúng phiên + nâng cấp QUICK→FULL) · `submit_inspection_photo` (hash-dedup theo ngày, geofence audit từ config acceptance_geofence) · `complete_inspection` (gate tại toà: checklist + ảnh 4/5/7 + Σdwell 8/12/18′; fail=presence + missing gain-framing; "Có vấn đề"→tự sinh job sửa; QUICK pass chốt tick nguồn PAYMENT khi đang nợ check-sau-thu) · `v5_tick_from_job` (nguồn 1, chấp nhận ảnh ở attachments) · `record_payment_gps` (nguồn 3: ok→tick-nếu-đã-check / pending_check+notify-treo-dedup / C14 ngày-đã-tick→piggyback_prompt; KHÔNG BAO GIỜ fail phiếu) · `v5_expire_stale` · jobs: `v5_daily_missions` (score+màu+lý-do-bằng-chữ) · `v5_run_digest` (1 digest/người/ngày dedup, tắt CN/phép) · `v5_close_period` (vật chất hoá pending config + bank full_month khi đứt-không-phép=0 + carry/earn khiên) · `v5_cron_start/finish` (idem).

**Hạ tầng cron (C5 — KHÔNG pg_cron):** edge fn `supabase/functions/salary-v5-jobs` (ĐÃ DEPLOY, auth = CRON_SECRET/service-key/admin-JWT; secret đã set vào Supabase) · Vercel Cron 2 job trong `vercel.json` (`nightly` 23:45 UTC = 06:45 VN gồm tier+score+close_period-ngày-1; `digest` 00:00 UTC = 07:00 VN) — **cần chủ thêm env `CRON_SECRET` trên Vercel** (giá trị = secret đã set ở Supabase; xem Edge Function Secrets) · `api/salary-v5-cron.js` (Vercel fn chuyển tiếp) · **worker watchdog** vài dòng cuối `worker/index.js` (đọc heartbeat `cron_runs`, 08h/09h VN chưa thấy thì gọi bù edge fn — CAVEAT: sửa block này phải RESTART worker). Lưu ý: `vercel.json` rewrites thêm exclude `api/` (giữ nguyên khối headers/cache — án lệ 85d9515); lịch close_period chạy 06:45 VN ngày 1 (gộp nightly) thay 03:00 do Vercel Hobby giới hạn 2 cron — chấp nhận vì job không sinh tiền.

**Test đã chạy (PASS toàn bộ):**
| # | Ca | Kết quả |
|---|---|---|
| F-core | tick 2 lần cùng ngày = 1 dòng SAD (idempotent) | ✅ |
| F1 | FULL 65NTG: checklist sinh đúng (size nhỏ: 4 ảnh/480s + mục random + phòng trống) → hash trùng bị chặn → complete thiếu = **presence** + missing gain-framing → **resume giữ checklist** → pass → tick FULL + **tự sinh job sửa** | ✅ |
| F2 | C14: thu tiền khi ngày ĐÃ tick → `piggyback_prompt`, KHÔNG treo | ✅ |
| F3 | Thu tiền ngày chưa tick → `pending_check` + 1 thông báo treo (gọi lần 2 dedup) → QUICK 2 ảnh pass → **tick nguồn PAYMENT** + thông báo tự READ | ✅ |
| F4 | Streak: current/best/next-milestone đúng; **đơn giá động tự chứng minh** (ngày rơi T6: n=26→230.769đ; T7: n=27→222.222đ) | ✅ |
| J1 | `v5_cron_start` idempotent (true/false) | ✅ |
| J2 | Digest 3 nhân viên, chạy lần 2 = 0 (dedup) | ✅ |
| J3 | `close_period('2026-08-01')` xử lý 3 staff, tạo SSS tháng mới | ✅ |
| E1-3 | Edge fn live: sai secret 401 · nightly chạy thật (tier+score 30 rows) · lần 2 skipped | ✅ |
| M | `v5_daily_missions(Joey)` khớp DỰ BÁO SPEC: 65NTG 78 đỏ "Chưa có dấu chân nào" · 162NVK 55.1 · 32PVC 53.2 | ✅ |

**Commit:** `feat(salary-v5): S2 — engine dấu chân + cron/watchdog`

## S3 — "Ngày hôm nay của tôi" + wiring FE (2026-07-03) ✅

**Migration:** `20260703000004_v5_myday.sql` — đã apply live. **Rollback:** `scripts/v5_rollback_s3.sql`.
RPC: `v5_daily_missions_self` (guard self) · `get_my_day_summary` (1 round-trip, lazy streak-touch) · `request_paid_leave`/`approve_leave` (phép 1-chạm 2 phía, quota theo config, notify 2 chiều gain-framing) · `report_device_issue`/`approve_device_issue` (US-2.8 → tick MANUAL_DEVICE_ISSUE).

**FE mới:** `src/pages/my-day/MyDayPage.tsx` (route `/my-day`, khối A trạng-thái-ngày xanh/xám → D nhắc-treo check-sau-thu → B tuyến gợi ý (lý do bằng chữ + nút Bắt đầu) → C việc của tôi → F 2 thanh tiến trình TẠM TÍNH + chuỗi + khiên + mốc 🔒 banked → xin phép 1-chạm) · `src/components/inspections/InspectionRunner.tsx` (chạy phiên FULL/QUICK: checklist → JobCaptureCamera tái dùng nguyên pipeline → sha256 client → submit → Hoàn tất; fail hiện missing gain-framing + resume; nút Báo sự cố thiết bị) · `src/hooks/useMyDay.ts` · `src/lib/v5PaymentGps.ts`.

**FE patch:** `useBulkRecordPayment` (+`voucherIds` trả về) · `useQuickCollect` (bắn `captureGpsAndRecord` NỀN sau khi phiếu lưu — không bao giờ chặn thu) · `TaskCompleteDialog` (+`v5_tick_from_job` fire-and-forget) · `launcherTiles` (tile "Hôm nay" ☀️ hot) · `App.tsx` (route lazy `/my-day`).

**Test:** phép flow SQL (request→quota-block→approve→N_chuẩn 27→26) ✅ · summary/missions bằng ngữ cảnh Joey ✅ · vitest 15/15 ✅ · `tsc` 0 lỗi mới (106 baseline; 1 lỗi khớp filter là pre-existing trong HEAD) ✅ · `vite build` ✅ · Playwright smoke trên ptcrm sau deploy (mục E2E).

**Commit:** `feat(salary-v5): S3 — màn Ngày hôm nay + wiring FE`

## S4 — Đo đếm + LOCK ⏳ (kế tiếp)

## S3 — /my-day ⏳

## S4 — Đo đếm + LOCK ⏳

## S5 — Shadow + kill-switch ⏳

## E2E toàn trình ⏳
