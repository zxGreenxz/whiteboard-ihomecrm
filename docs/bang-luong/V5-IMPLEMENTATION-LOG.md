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

## S2 — Engine dấu chân ⏳ (kế tiếp)

## S3 — /my-day ⏳

## S4 — Đo đếm + LOCK ⏳

## S5 — Shadow + kill-switch ⏳

## E2E toàn trình ⏳
