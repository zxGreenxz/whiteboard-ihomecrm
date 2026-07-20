# V5 — NHẬT KÝ THỰC HIỆN + BẢN ĐỒ REVERT

> **Reviewed:** 2026-07-20. Đây là nhật ký triển khai và rollback, không phải bảng trạng thái live; stage/feature flags phải đọc từ UI hoặc DB lúc vận hành.

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

## S4 + S5 — Đo đếm + LOCK + Shadow/kill-switch (2026-07-03) ✅

**Migration:** `20260703000005_v5_money_lock.sql` — đã apply live. **Rollback:** `scripts/v5_rollback_s4.sql`.
- `v5_month_money` (trần 6tr/3tr enforce trong hàm, sàn mềm config) · `get_salary_progress_v5` (lưới tháng self-view) · `v5_flag_day`/`v5_appeal`/`v5_verdict` (C2 đủ due-process: máy flag → 48h kháng nghị → chủ kết án; confirm → voided + TƯỚC banked tháng + reset_from_date, ngày sạch giữ) · `v5_lock_assert` (**3 ASSERT**: trần · không-nghi-án-mở · 100% tick PAYMENT join phiếu thu GPS thật) · `v5_apply_lock_adjustments` (**CHẶN khi flag OFF — assert cấm ghi trong shadow**; pass assert mới ghi 2 dòng `salary_adjustments` ATTEND_V5/STREAK_V5, idempotent) · `v5_shadow_report`.
- **LỆCH SPEC CÓ CHỦ ĐÍCH:** nhánh UNION hiển thị trong `salary_work_ledger` → BACKLOG (display-only; tránh đụng hàm tiền legacy). Nguồn TIỀN duy nhất = `salary_adjustments` qua apply (đúng C9 phần tiền).
- **FE:** `/reports/coverage` = **OwnerDashboardV5 5 tab** (Coverage map grid màu D · Nghi án + kết án 2 chiều · Đối soát tháng 3 ASSERT + nút "Ghi tiền v5" (disable khi shadow) · Shadow/Gates · Cài đặt v5: kill-switch flags + stage + chạy-lại 5 job + cron_runs) — *lệch nhỏ US-5.1: settings đặt tại dashboard v5 thay vì GeneralSettingsPage; chủ có đúng 1 nơi vận hành*. Banner **onboarding "Tôi đã hiểu"** ở /my-day (hiện từ chặng shadow_money, lưu `ui_preferences.v5_onboarding_ack`). **Runbook:** `docs/bang-luong/V5-RUNBOOK.md`.

**Test (PASS):**
| # | Ca | Kết quả |
|---|---|---|
| L1 | **Kill-switch/shadow guard:** flag OFF → apply RAISE "v5_money đang TẮT" (= biên bản diễn tập TẮT) | ✅ |
| L2 | Flow tiền trọn vòng (rollback): tick 2 ngày → 444.444 (2×222.222, n=27) → 3 ASSERT ✅ → apply → đúng 1 dòng ATTEND_V5 → **apply lần 2 idempotent** → flag → a2=false **CHẶN LOCK** → verdict → voided + banked=[] + tiền tự về 222.222 (ngày sạch giữ — đúng C2) (= biên bản diễn tập BẬT) | ✅ |
| L3 | tsc: 0 lỗi từ file v5 (đợt 106→118 xác minh do **phiên làm việc song song khác** trên working tree, không thuộc v5) | ✅ |

**Ghi chú vận hành:** working tree đang có phiên khác sửa nhiều file src — commit v5 CHỈ add đích danh file v5, tuyệt đối không `git add -A`.

**Commit:** `feat(salary-v5): S4+S5 — money/LOCK/verdict + dashboard chủ + kill-switch + runbook`

## E2E toàn trình (2026-07-03) ✅

**Ma trận case đã chạy qua toàn bộ 5 phase (SQL trong transaction-rollback + Playwright trên ptcrm production):**

| Nhóm | Case | Nơi test | KQ |
|---|---|---|---|
| Nền | 6 bảng + RLS + settings seed + flags OFF + calendar (T7=27/T9=25) + parity SQL≡TS 24 tháng + config staff-context + 💰 pending tháng kế + validate Σdeltas | SQL T1–T12 (S1) | ✅ |
| Engine | tick idempotent · FULL fail→presence→resume→pass→tick+spawn-job · hash-dup chặn · C14 piggyback · pending_check→treo-dedup→QUICK→tick PAYMENT→notify READ · đơn giá động T6/T7 | SQL F-core→F4 (S2) | ✅ |
| Jobs | cron idem · digest 3 người + dedup · close_period · edge fn live 401/run/skipped · missions khớp dự báo spec (65NTG 78→162NVK 55→32PVC 53) | SQL J1–J3 + HTTP E1–E3 (S2) | ✅ |
| My-day | summary/missions Joey-context · phép: quota-block → approve → N_chuẩn 27→26 · phép idempotent | SQL (S3) | ✅ |
| Tiền/LOCK | shadow-guard chặn khi OFF · money→3 ASSERT→apply idempotent→flag CHẶN LOCK→verdict tước-banked-giữ-ngày-sạch (C2) | SQL L1–L2 (S4) | ✅ |
| **Production (Playwright)** | login → **/my-day**: header + Xin phép (còn 1) + "chưa có ngày công" + 0/27 TẠM TÍNH + "Đã tích 0đ/6.000.000đ — leo tiếp! 🚀" + chuỗi/mốc +300k + khiên 2+0 (tự tiêu đúng ngày 1/7 lỡ) + footer TẠM TÍNH · **/reports/coverage**: 5 tab render, Coverage 17 toà sort đúng D (65NTG "chưa từng" đứng đầu), Đối soát 3 nhân viên 3 ASSERT ✅ + nút chốt tiền **disabled "Đang SHADOW"** · **console 0 error** cả 2 màn | ptcrm.vercel.app | ✅ |

**Trạng thái bàn giao:** hệ v5 code xong S0–S5 + E2E, flags OFF (hành vi hệ cũ nguyên vẹn). Việc còn lại là VẬN HÀNH theo V5-RUNBOOK.md: ① chủ thêm env `CRON_SECRET` trên Vercel; ② restart worker (nạp watchdog); ③ đặt stage=grace để bắt đầu chặng 0 → theo gates Ch.11. Backlog kỹ thuật: nhánh UNION hiển thị trong salary_work_ledger (display-only); hàng-chờ-duyệt phép/sự-cố dạng UI riêng (hiện duyệt qua thông báo + RPC); Playwright staff-flow đầy đủ khi có account nhân viên test.

## Vận hành đã thực thi (2026-07-03)

- **Env `CRON_SECRET` trên Vercel** đã thêm (Sensitive, Production+Preview) + redeploy + verify live: `GET /api/salary-v5-cron?job=digest` → 200 `{ok:true, digest pushes:3}`, `cron_runs` ghi nhận (không lỗi). Cron Jobs nhận 2 lịch (nightly 45 23 UTC, digest 0 0 UTC), Enabled. Worker Zalo KHÔNG dùng (watchdog đã gỡ 66be930).
- **SEED khởi động thử** (`scripts/v5_seed_trial_start_2026_07_03.sql`, revert `..._rollback.sql`): cho JOEY + NATHAN bắt đầu dùng v5 hôm nay **không mất chuỗi**.
  - Tick ngày-công 01/07 + 02/07 (source FULL, evidence note `seed khởi động thử…`) → cả 2: `current=2, best=2, breaks_no_leave=0, khiên free=3`. Hôm nay tick tiếp = chuỗi 3; mốc 4 còn 2 ngày.
  - 17 toà thật (rooms>0) mỗi toà 1 phiên FULL `passed` ngày 01/07 (attribution theo `staff_assignments.staff_id` THẬT: **Nathan 9, Joey 7, B.Huy 1** — 45/3 Trần Thái Tông giao RIÊNG B.Huy, không Joey/Nathan; marker `condition_note='OK — seed khởi động thử v5 (2026-07-03)'`). Coverage: mọi toà D=2 (102LVT D=1 do job thật 02/07) — **không toà nào chạm SLA 4/3**. Verify Playwright /reports/coverage: 17 thẻ "Chạm 2 ngày trước", console 0 error.
  - Số LIVE sau seed (v5_month_money 07/2026): JOEY & NATHAN = 2/27 ngày công · 444.444đ tạm tính (đơn giá 222.222 = 6tr/27); B.Huy = 0/27 (ngoài đợt seed streak). Đối soát/Shadow refresh sẽ hiện đúng (ảnh 0/27 là trước seed).
  - Idempotent + revert theo marker; recompute streak sau revert đưa SSS về trạng thái tự nhiên.
