# Plan — Chủ xem «Hôm nay» của từng quản lý và điểm danh GPS tự động

> **Trạng thái:** đã thi hành và lên production ngày 09/11/2026 (PR #403, #402); điểm danh GPS còn tắt tới khi chủ bật. Các điểm khác plan và số đo ở Phụ lục D. Bản vẽ: [bảng vẽ riêng tư](https://claude.ai/artifact/8YKt1tGucf8PckRLU3MNsq). Sự thật kỹ thuật đo trên `origin/main` `056571087` và production (chỉ đọc) ngày 09/11/2026. Luật thi hành: [Project Contract](../../engineering/PROJECT_CONTRACT.md) — plan này không thay Contract; chỗ nào lệch thì Contract thắng.

## Tóm tắt

- **Xem theo người.** Chủ công ty và super admin mở «Hôm nay» chọn được từng quản lý để xem: đang làm gì, hành trình trong ngày trên bản đồ, lịch tháng; sau đó là báo cáo so sánh theo kỳ. Chỉ xem, không sửa.
- **Điểm danh GPS tự động.** Một app Android nhỏ cài trên máy quản lý tự ghi vị trí mỗi 15/30/60 phút trong các khung giờ chủ đặt (thêm, bớt khung được). Ngoài khung giờ app không ghi; dấu có mặt lấy từ việc đã xong, check nhà, thu tiền như hiện nay.
- **Không đổi tiền.** Plan này không đổi cách tính ngày công hay lương v5 (xem Q1).
- **Bốn đợt:** Đợt 1 xem theo người → Đợt G điểm danh GPS → Đợt 2 báo cáo đánh giá → Đợt 3 bổ sung. Bước G0 (đo trên hai máy thật) chạy song song Đợt 1 vì đó là chỗ rủi ro nhất.
- **Chưa xác minh:** hành vi chạy nền của Android trên hai máy thật (G0) và bảy phép đo dữ liệu M1–M7 ở Đợt 1. Bản vẽ chưa được soát bằng mắt.

## 0. Quyết định cần chủ chốt

Mỗi câu có đề xuất mặc định; không trả lời thì thi hành theo mặc định.

| # | Câu hỏi | Đề xuất mặc định | Nếu chọn khác |
|---|---|---|---|
| Q1 | Dấu GPS tự động có tính vào ngày công/lương không? | **Không.** GPS chỉ là dấu giám sát; ngày công v5 vẫn tick theo việc xong, check nhà FULL, thu tiền như hiện nay. | Thành một đợt riêng thuộc nhóm tiền: nguồn tick mới trong `v5_tick_attendance`, đối soát, chống vị trí giả. Chưa nằm trong plan này. |
| Q2 | Giá trị khi bật lần đầu | Mốc 30 phút, trễ quá 10 phút tính mất tín hiệu, hai khung 08:00–11:30 và 13:30–17:30, nghỉ Chủ nhật, ngày lễ, ngày phép đã duyệt. Chủ sửa được hết ở màn 8. | Chỉ đổi dữ liệu khởi tạo. |
| Q3 | Giữ dấu GPS chi tiết bao lâu? | 180 ngày; quá hạn xoá toạ độ, giữ số tổng theo ngày (bao nhiêu mốc có dấu). | Đổi một con số cấu hình. |
| Q4 | Quản lý có được tự tạm dừng trong app không? | Có. Các mốc khi tạm dừng ghi «đã tắt» và chủ nhìn thấy. | Bỏ nút tạm dừng; quản lý vẫn tắt được quyền vị trí của máy, khi đó ghi «mất tín hiệu — quyền vị trí bị tắt». |
| Q5 | Đổi khung giờ có hiệu lực khi nào? | Từ mốc kế tiếp. Các mốc trước đó vẫn tính theo cài đặt cũ. | «Từ ngày mai»: đơn giản hơn nhưng không thử ngay được. |
| Q6 | Nền bản đồ | OpenStreetMap, miễn phí, không cần khoá. | Goong: cần khoá riêng dùng phía trình duyệt và sửa CSP theo tên miền Goong. |
| Q7 | Khoá ký APK | Dùng lại khoá ký của app iHome Gateway (không phải tạo secret mới). | Tạo khoá mới và hai secret GitHub mới. |
| Q8 | Đồng ý của nhân viên | **Đã chốt 09/11:** app nội bộ, mặc định coi như mọi quản lý được áp dụng đã đồng ý. Không làm màn đồng ý, không lưu vết đồng ý. | — |
| Q9 | Sửa kèm lỗi có sẵn: màu ảnh ở «Nhật ký kiểm tra» của Vận hành lương v5 không bao giờ lên | Sửa trong Đợt 1 (một dòng so sai giá trị). | Để nguyên, ghi vào known-gaps. |
| Q10 | Máy nằm yên lâu, Android cho ngủ sâu nên không lấy được vị trí mới | Tính «có dấu — đứng yên» nếu vị trí gần nhất không quá 60 phút tuổi. Chốt lại sau khi có số đo G0. | Tính «mất tín hiệu»: chặt hơn nhưng dễ báo oan khi quản lý ngồi một chỗ. |

## 1. Đã chốt với chủ (không hỏi lại)

- Phạm vi là màn `/my-day` «Ngày hôm nay của tôi». Việc cá nhân lưu trên máy (`/viec-cua-toi`) để ngoài.
- Người xem: super admin và vai Chủ công ty. Quản lý không xem chéo nhau. Nhân viên không thấy các màn của chủ.
- Danh sách người: quản lý đang chấm công v5.
- Lối vào: ô «Hôm nay» thêm bộ chọn người; trên máy tính mở thêm từ Vận hành lương v5.
- Bản đồ là bắt buộc. Lịch tháng theo người lùi tới 07/2026.
- Báo cáo: so sánh theo kỳ, không tự chấm điểm, không quy ra tiền; nhận xét tay để đợt sau.
- Chỉ xem. Làm mới 60 giây. Chưa xuất file, chưa nối Hermes.
- Điểm danh GPS (09/11): tự động trên máy nhân viên, không bấm tay; cả hai quản lý dùng máy Android; chủ tự đặt nhiều khung giờ; ngoài khung giờ điểm danh theo việc hoặc check nhà.
- Đồng ý (09/11): đây là app nội bộ, chỉ nhân viên và người nội bộ dùng, nên mặc định coi như đã đồng ý toàn bộ. Không có bước hỏi đồng ý trong CRM hay trong app; phần thoả thuận với nhân viên do chủ lo ngoài phần mềm. Android vẫn buộc người cầm máy tự bấm cấp quyền vị trí một lần khi cài — đó là giới hạn của hệ điều hành, app không cấp thay được.

## 2. Hiện trạng đo được

| Sự thật | Nguồn |
|---|---|
| `/my-day` chỉ gọi hàm «của chính tôi»: `get_my_day_summary()`, `v5_route_candidates_self()`; không có khối hành trình hay lịch tháng. | `src/hooks/useMyDay.ts`, `src/pages/my-day/MyDayPage.tsx` |
| `get_my_day_summary()` có ghi: gọi `v5_recompute_streak` (upsert `salary_streak_state`). Không dùng lại để xem người khác. | `20260826123000_v5_1_my_day_phep_nam.sql` |
| `v5_route_candidates(p_user)` chỉ cấp cho `service_role`, thân hàm không có cổng quyền. | `20260721140000_v5_route_planning_phase12.sql` |
| RLS bốn bảng v5 (`inspection_sessions`, `inspection_photos`, `salary_attendance_day`, `salary_streak_state`): chính mình hoặc `is_admin()`; `is_admin()` ≡ `is_super_admin()`. | `20260710140000…`, `20261018044046…` |
| Tài khoản chủ công ty không nằm trong `super_admins` nên hôm nay không đọc được dữ liệu của quản lý và bị chặn ở `/reports/coverage` (`AdminOnlyRoute`). | Đo production 07/11 |
| Cổng vai đúng cho «Chủ công ty»: `app_private.ie_actor_is_company_owner_v1(org, actor)`; cờ hiển thị `public.is_company_owner_self_v1()` → `useIsCompanyOwner`. | `20260827140000…`, `src/hooks/useIsCompanyOwner.ts` |
| Quy tắc dự án: hàm SECURITY DEFINER tự lọc toà bằng `can_access_building()`, không viết lối tắt `is_super_admin() OR …`. | `docs/engineering/DATA_ENVIRONMENTS.md` |
| Gate `check-definer-body-authz` đòi thân hàm definer chạm `profiles`, `income_expenses`, `manager_salary_config`… phải có primitive phạm vi (`auth.uid()`, `can_access_building`…). | `scripts/check-definer-body-authz.mjs` |
| Mỗi lần tick ngày công ghi `evidence` dạng `{at, source, ref_id, note}`; `income_expenses` không có cột người tạo dạng uuid (chỉ `creator_name`). | `20260720190000_v5_date_hardening.sql`, baseline |
| `jobs` có `completion_time`, `completion_lat/lng/distance_m`, `completion_geofence_status`; `buildings` có `latitude/longitude`; bán kính nằm ở `settings.acceptance_geofence` (mặc định 70 m); khoảng cách tính bằng `public.v5_distance_m`. | baseline, `20260628000001…`, `20260703000002…` |
| CSP ở `vercel.json`: `img-src` chưa có máy chủ ảnh nền OpenStreetMap; app chưa có thư viện bản đồ nào. | `vercel.json:36`, `package.json` |
| Repo đã có app Android iHome Gateway (Java, WorkManager, hàng đợi mã hoá AES-GCM, biên nhận, CI ký APK) và cổng nhận `bank-event-ingest` (bearer là mã kết nối, máy chủ chỉ giữ SHA-256, idempotency, biên nhận). | `extensions/sms-webhook/android/`, `supabase/functions/bank-event-ingest/` |
| App Gateway chưa có quyền vị trí, dịch vụ nền, hay nhận tín hiệu khởi động máy. Repo chưa có bảng dấu vị trí nào. | `AndroidManifest.xml`, tra toàn repo |
| Cả hai quản lý chưa có dòng `push_subscriptions`. | Đo production 09/11 |
| Edge function triển khai tay, không có workflow CI nào deploy; manifest bề mặt `contracts/surfaces/edge-function-surface.json` phải sinh lại ngay sau khi deploy, và hàm chưa có ở production phải khai trong `CHUA_CO_O_PRODUCTION` để thử trên TEST. | `supabase/functions/README.md`, `scripts/test-env/edge.mjs` |
| `OwnerDashboardV5.tsx:69` so `geo === "inside" / "outside"` trong khi DB ghi `ok / out_of_range / gps_denied`. | Đọc source |
| Một phiên khác đang sửa `/my-day` sau kiểm thử toàn trang, chưa commit. | Ghi nhớ phiên 07–09/11 |

## 3. Cách thi hành chung

1. Mỗi PR một worktree riêng từ `origin/main`, draft PR. Tier `migration`, `authorization`, `infrastructure` trong `tooling/risk-map.json` cần review chéo một lượt trên diff cuối.
2. Migration: `node scripts/tao-ten-migration.mjs <slug>` → `git add` file → `npm run provenance:generate` → `npm run gate:migration-provenance` → thử trên TEST bằng `npm run test-env:thu-sql -- <file>` → `npm run migrate:forward -- <file>` (dry-run) → thêm `--apply` khi đủ review và dry-run xanh. Idempotent, không sửa file đã merge.
3. Hàm mới: `SECURITY DEFINER`, `SET search_path = pg_catalog, public, app_private`, thân hàm gọi `auth.uid()` và cổng quyền **trước** mọi truy vấn theo UUID người ngoài truyền vào. `REVOKE ALL … FROM PUBLIC, anon` (thêm `authenticated`, `service_role` với hàm nội bộ) rồi `GRANT` tường minh. Hàm đọc là `STABLE` và không ghi; hàm ghi hoặc khoá dòng là `VOLATILE`.
4. Dữ liệu gắn toà lọc bằng `can_access_building()`; không tự viết lối tắt theo super admin.
5. Kiểm quyền bằng JWT thật với năm vai: chính mình, quản lý khác, chủ công ty, super admin, chủ công ty của tổ chức khác. Thêm ca vào `scripts/test-cross-tenant.mjs`; đo `scripts/measure-org-leak.mjs`; kiểm đột biến (gỡ cổng thì test phải đỏ).
6. Sau apply: `npm run gen:types` → `types:normalize` → `types:check`, sinh lại catalog/surfaces, gọi hàm thật qua PostgREST.
7. Giao diện: dữ liệu qua hook typed và biên nhận zod (mẫu `daySummaryReceipt`), không gọi RPC trong component; phân biệt lỗi quyền `42501` với lỗi tải. Kiểm màn bị đổi bằng Playwright MCP ở khổ 390 px (màn 6 thêm 1280 px), kèm ảnh và console.
8. Trước push: `npm run gate:truoc-push -- --plan` rồi `npm run gate:truoc-push`; chờ CI bằng `npm run ci:wait -- --sha <sha>`. `main` là Preview; production qua `npm run promote:production -- --sha <sha>` khi đủ bằng chứng.
9. Thử trên project TEST; không ghi vào tổ chức thật; fixture phải dọn. Repo public: không đưa toạ độ thật, tên tài khoản thật vào code, test, log.
10. Thư mục `_design-viec-quan-ly/` là nguồn bản vẽ, không commit.

## 4. Thiết kế kỹ thuật

### 4.1 Cổng quyền «được xem việc của người này»

Hàm nội bộ mới, không cấp cho ai gọi trực tiếp:

```sql
-- app_private.staff_day_can_view_v1(p_target uuid) RETURNS boolean
-- LANGUAGE sql STABLE SECURITY DEFINER, search_path = pg_catalog, public, app_private
SELECT CASE
  WHEN p_target IS NULL OR (SELECT auth.uid()) IS NULL THEN false
  WHEN p_target = (SELECT auth.uid()) THEN true
  ELSE EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = p_target AND m.status = 'ACTIVE'
      AND ( app_private.ie_actor_is_company_owner_v1(m.organization_id, (SELECT auth.uid()))
         OR ((SELECT public.is_super_admin()) AND m.organization_id = ANY (public.my_org_ids())) )
  )
END;
```

- Không có nhánh `service_role`: chưa có job nào cần. Không mở theo `session_user`.
- Super admin chỉ xem người trong tổ chức mà chính họ là thành viên, để không trộn dữ liệu DEMO với công ty thật.
- Quản lý không phải Chủ công ty nên nhận `false` khi hỏi về người khác.
- Hàm đi kèm cho màn «cả đội»: `app_private.staff_day_viewer_org_v1(p_org uuid DEFAULT NULL)` trả tổ chức đang xem (`COALESCE(p_org, app_private.v5_salary_org_of_user_v1(auth.uid()))`) và `RAISE 42501` nếu người gọi không phải Chủ công ty của tổ chức đó (hoặc super admin là thành viên).

### 4.2 Hàm đọc theo người (Đợt 1)

Tất cả ở schema `public`, `GRANT EXECUTE … TO authenticated`, mở đầu bằng cổng 4.1, sai quyền thì `RAISE … USING ERRCODE = '42501'`.

| Hàm | Trả về | Ghi chú |
|---|---|---|
| `staff_day_team_v1(p_date date DEFAULT NULL, p_org uuid DEFAULT NULL)` → jsonb | `members[]`: người, trạng thái ngày công, đang làm gì, số toà đã ghé/cần ghé, việc xong, dấu chân gần nhất; `overdue_buildings[]` | Người = có `manager_salary_config` hiệu lực hôm đó **hoặc** có dòng `salary_attendance_day` trong 30 ngày, thuộc tổ chức đang xem. |
| `staff_day_summary_v1(p_user uuid, p_date date DEFAULT NULL)` → jsonb | Cùng khoá với `get_my_day_summary` ở phần `today`, `streak`, `pending_checks`, `leave`, `stage`, `as_of`; thêm `now` (phiên kiểm tra đang mở), `open_jobs[]` | **Không** gọi `v5_recompute_streak`: đọc `salary_streak_state` nguyên trạng và trả kèm `updated_at`. **Không** trả tiền (`day_rate`, `tam_tinh`, `budget`). |
| `staff_day_route_v1(p_user uuid)` → bảng | Cùng cột với `v5_route_candidates` | Bọc hàm gốc, thêm cổng và lọc `can_access_building`. |
| `staff_day_journey_v1(p_user uuid, p_date date)` → jsonb | `events[]` theo giờ, `stops[]` (điểm dừng có toạ độ, đánh số), `totals` | Loại sự kiện: mở phiên, cụm ảnh của phiên (số ảnh khớp/ngoài vùng/thiếu GPS), hoàn tất phiên (đạt/có mặt, thời gian ở toà, việc tự sinh), việc hoàn thành, thu tiền, mốc được tính ngày công, xin phép. Quãng đường = tổng `v5_distance_m` giữa các điểm liên tiếp. |
| `staff_day_calendar_v1(p_user uuid, p_month date)` → jsonb | `days[]`: loại ngày (có công, phép, không công, Chủ nhật, lễ, chưa tới), nguồn tick, số toà ghé; `totals` | Không lùi quá `system_v5.effective_from`. |

Quy tắc chung: `p_date`/`p_month` không nhận ngày tương lai; ngày «hôm nay» tính theo giờ Việt Nam. Số «ngày chuẩn» dùng lại `vn_workdays` / `v5_n_chuan`, không chép công thức (phụ thuộc phép đo M2).

### 4.3 Dữ liệu điểm danh GPS (Đợt G)

Năm bảng mới trong schema `app_private`, bật RLS, không policy, `REVOKE ALL` với mọi vai — theo đúng tiền lệ các bảng `bank_event_*`. Mọi đọc/ghi đi qua hàm ở 4.4.

| Bảng | Cột chính | Ý nghĩa |
|---|---|---|
| `gps_checkin_settings` | `organization_id`, `version`, `effective_from timestamptz`, `enabled`, `interval_min` (15/30/60), `late_tolerance_min` (5/10/15), `windows jsonb`, `skip_sunday`, `skip_holidays`, `skip_approved_leave`, `retention_days`, `created_by` | Chỉ thêm dòng, không sửa: mỗi lần chủ lưu là một phiên bản mới. |
| `gps_checkin_members` | `organization_id`, `user_id`, `applies`, `updated_by`, `updated_at` | Chủ bật/tắt theo người. Không có cột đồng ý: mặc định coi như đã đồng ý (mục 1). |
| `gps_checkin_pair_codes` | `code_digest`, `organization_id`, `user_id`, `expires_at`, `used_at` | Mã ghép nối dùng một lần, hạn 10 phút; chỉ lưu SHA-256. |
| `gps_checkin_devices` | `organization_id`, `user_id`, `device_id`, `credential_digest`, `fingerprint`, `paired_at`, `revoked_at`, `last_seen_at`, `state jsonb` | Mỗi người một máy đang hoạt động (unique index một phần). `state` giữ model, phiên bản Android, phiên bản app, quyền vị trí, miễn tối ưu pin, pin, đang tạm dừng. |
| `gps_checkin_pings` | `organization_id`, `user_id`, `device_ref`, `external_id`, `slot_at`, `recorded_at`, `received_at`, `fix_status` (fresh/stale/none), `lat`, `lng`, `accuracy_m`, `provider`, `fix_age_ms`, `is_mock`, `reason`, `battery_pct`, `device_idle`, `settings_version`, `nearest_building_id`, `nearest_distance_m`, `payload_hash` | `UNIQUE (device_ref, external_id)`; index `(organization_id, user_id, slot_at)`. |

- `windows` là mảng `{from:"HH:MM", to:"HH:MM"}` theo giờ Việt Nam: 1–6 khung, `from < to`, không chồng nhau, phút là bội của 5.
- Toạ độ chỉ được lưu khi `slot_at` nằm trong khung giờ của phiên bản cài đặt đang hiệu lực; ngoài khung máy chủ từ chối và không lưu.
- Thêm hai bảng `gps_checkin_pings`, `gps_checkin_devices` vào `DANH_SACH_NHAY_CAM` của `scripts/check-definer-body-authz.mjs`.
- Dọn theo hạn lưu: hàm nhận dấu tự xoá toạ độ quá hạn của tổ chức đó, mỗi ngày tối đa một lần; không thêm cron.

### 4.4 Hàm điểm danh GPS

| Hàm | Ai gọi | Việc |
|---|---|---|
| `gps_checkin_settings_get_v1(p_org DEFAULT NULL)` → jsonb | Chủ công ty, super admin | Cài đặt hiện hành và danh sách người kèm tình trạng máy. |
| `gps_checkin_settings_set_v1(p_patch jsonb)` → jsonb | Chủ công ty, super admin | Kiểm hợp lệ, thêm phiên bản mới hiệu lực từ bây giờ, trả biên nhận có `version`. |
| `gps_checkin_member_set_v1(p_user, p_applies)` | Chủ công ty, super admin | Bật/tắt theo người. |
| `gps_checkin_my_status_v1()` → jsonb | Chính quản lý | Dữ liệu màn 7: có áp dụng không, tình trạng máy, khung giờ, các mốc hôm nay. |
| `gps_checkin_pair_start_v1()` → jsonb | Chính quản lý | Sinh mã ghép nối một lần (chỉ khi đang được áp dụng), trả mã và link mở app. |
| `gps_checkin_device_revoke_v1(p_device)` | Chính quản lý hoặc chủ | Thu hồi máy. |
| `gps_checkin_slots_v1(p_user, p_date)` → jsonb | Theo cổng 4.1 | Dải mốc trong ngày và trạng thái từng mốc (Phụ lục B). Lõi tính nằm ở `app_private.gps_checkin_slots_core_v1`, được các hàm 4.2 và báo cáo gọi lại. |
| `gps_checkin_pair_v1(…)`, `gps_checkin_ingest_v1(…)` | Chỉ `service_role` (edge function) | Đổi mã ghép nối lấy quyền gửi; nhận dấu, chống trùng, chặn tần suất, gắn toà gần nhất, trả cài đặt mới nhất. |

Sau Đợt G, `staff_day_team_v1`, `staff_day_summary_v1`, `staff_day_journey_v1`, `staff_day_calendar_v1` trả thêm phần mốc GPS bằng một migration `CREATE OR REPLACE` giữ nguyên chữ ký và kiểu trả về (jsonb thêm khoá).

### 4.5 Cổng nhận `gps-checkin-ingest`

- Edge function mới, `verify_jwt = false` trong `supabase/config.toml` (xác thực bằng bearer của máy, kiểm trong DB như `bank-event-ingest`).
- Chỉ `POST`; `Authorization: Bearer <token của máy>` (64 hex); `X-Idempotency-Key` = `id` của sự kiện; JSON tối đa 16 KiB; bộ khoá phải khớp chính xác theo loại sự kiện.
- Ba loại sự kiện: `device.pair`, `location.ping`, `device.state`. Hợp đồng ở Phụ lục A.
- Gọi RPC bằng service role; ánh xạ lỗi `28000→401`, `42501→403`, `PT409→409`, `PT429→429`, `22xxx→400`, còn lại `503`. Biên nhận sai dạng từ DB trả `502`.
- Không qua proxy trên VPS: app gọi thẳng địa chỉ edge function (VPS hiện tại hết hạn 04/12).
- Không thêm secret mới, nên không làm các hàm khác tăng phiên bản.

### 4.6 App Android «iHome Điểm danh»

- Thư mục mới `extensions/diem-danh/android/`, sao khung từ Gateway: JDK 17, Gradle 8.11.1, AGP 8.9.2, compile/target SDK 35, minSdk 26, Java thuần, không Google Play Services. `applicationId vn.ihome.diemdanh`; bản thử có hậu tố `.thu` và trỏ project TEST để cài song song.
- Giữ nguyên từ Gateway: `SecureStorage`, mô hình `QueueStore` (hàng đợi SQLite mã hoá, lưu trước gửi sau), mô hình gửi của `GatewayWork` (WorkManager, cần mạng, lùi dần, đòi biên nhận hợp lệ).
- Thành phần mới:

| Lớp | Việc |
|---|---|
| `CheckinPolicy` | Java thuần, test không cần máy: tính mốc từ khung giờ và tần suất, kiểm hợp lệ gói gửi và biên nhận, `id = sha256(deviceId + "\|" + slotAt)`. |
| `CheckinSettings` | Token của máy, `deviceId`, cài đặt nhận từ máy chủ, cờ tạm dừng. Địa chỉ máy chủ cố định theo bản build. |
| `SlotScheduler` | Đặt báo thức chính xác cho mốc kế tiếp (`setExactAndAllowWhileIdle`); mỗi lần chạy xong đặt mốc sau. Không đặt gì ngoài khung giờ và trong ngày nghỉ. |
| `SlotAlarmReceiver` → `CaptureService` | Dịch vụ nền trước loại `location`, sống tối đa 45 giây: lấy vị trí bằng `LocationManager` (nguồn `fused` nếu máy có, không thì mạng và GPS song song, chọn kết quả tốt nhất), ghi `fresh / stale / none` kèm lý do, đưa vào hàng đợi, tự tắt. |
| `DeliveryWork` | Gửi hàng đợi, nhận biên nhận, cập nhật cài đặt theo biên nhận. |
| `SafetyNetWork` | Chạy định kỳ 15 phút: đặt lại báo thức nếu mất, gửi `device.state`. |
| `BootReceiver` | Sau khi máy khởi động lại hoặc app cập nhật: đặt lại báo thức. |
| `MainActivity`, `PairActivity` | Giao diện dựng bằng code như Gateway: ghép nối (mở từ link `ihomediemdanh://pair?c=…` hoặc gõ mã), cấp quyền từng bước, trạng thái, bốn dòng «Máy của bạn», các mốc hôm nay, nút Tạm dừng/Tiếp tục. |

- Quyền khai báo: `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `USE_EXACT_ALARM` (Android 13+), `SCHEDULE_EXACT_ALARM` (tới Android 12L), `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- Riêng tư theo cấu trúc: ngoài khung giờ không có báo thức nào nên app không lấy vị trí; đang tạm dừng thì gửi mốc `paused` không kèm toạ độ.
- Chống gian lận tối thiểu: cờ vị trí giả (`isMock`), tuổi của vị trí, lệch giờ máy so với giờ máy chủ, mỗi người một máy, đổi máy phải ghép lại và chủ nhìn thấy.
- Phát hành: workflow `.github/workflows/android-diem-danh.yml` (sao từ `android-gateway.yml`), APK ký trên `main`, đăng GitHub Release, hằng số phiên bản và link tải trong mã web (mẫu `gatewayApk` ở `src/pages/bank-events/labels.ts`).
- **Giả định cần đo ở G0, chưa phải sự thật:** báo thức chính xác có chạy đúng giờ khi máy ngủ sâu không; `USE_EXACT_ALARM` có được cấp khi cài ngoài Play không; dịch vụ `location` khởi từ báo thức có lấy được vị trí trên Android 14/15 không; chất lượng vị trí trong nhà trên máy Android dưới 12 khi không có nguồn `fused`; hãng máy có tự tắt app không.

### 4.7 Giao diện web

| Màn (artboard) | Route | Trang | Dữ liệu |
|---|---|---|---|
| 1 Hôm nay — cả đội (`Main`) | `/my-day/team` | `TeamDayPage` | `staff_day_team_v1` |
| 2 Một quản lý — hiện tại (`QuanLy-HomNay`) | `/my-day/nguoi/:userId` | `StaffDayPage` | `staff_day_summary_v1`, `staff_day_route_v1`, `gps_checkin_slots_v1` |
| 3 Hành trình một ngày (`HanhTrinh-Ngay`) | `/my-day/nguoi/:userId/hanh-trinh?ngay=` | `StaffJourneyPage` | `staff_day_journey_v1` |
| 4 Lịch tháng (`Lich-Thang`) | `/my-day/nguoi/:userId/lich?thang=` | `StaffCalendarPage` | `staff_day_calendar_v1` |
| 5–6 Báo cáo (`BaoCao-DienThoai`, `BaoCao-MayTinh`) | `/my-day/bao-cao` | `StaffReportPage` (một trang, co giãn) | `staff_period_report_v1` |
| 7 Điểm danh — phía quản lý (`DiemDanh`) | `/my-day/diem-danh` | `GpsCheckinPage` | `gps_checkin_my_status_v1` |
| 8 Cài đặt điểm danh (`CaiDat-DiemDanh`) | `/my-day/diem-danh/cai-dat` | `GpsCheckinSettingsPage` | `gps_checkin_settings_get_v1` / `_set_v1` |

- `/my-day` giữ nguyên cho chính mình; thêm `PersonPicker` ở đầu khi `useIsCompanyOwner() || useIsSuperAdmin()`.
- Cửa hiển thị mới `StaffDayViewerRoute` (`src/components/auth/`), theo mẫu `AdminOnlyRoute`: khung chờ khi đang tải quyền, vùng lỗi khi lỗi, không đủ quyền thì về `/my-day`. Đây chỉ là cửa hiển thị; hàng rào thật là các hàm ở 4.2 và 4.4.
- Khai trang trong `src/app/lazyPages.ts` đúng mẫu `export const X = lazy(() => import("…"))`, route trong `src/app/routes/financeWorkRoutes.tsx`. Không đặt tên file `index.tsx`.
- Thêm `{ route: "/my-day/*", … }` vào `COPILOT_PAGE_EXEMPTIONS` (`src/app/capabilities/registry.ts`).
- Hook ở `src/hooks/staff-day/` và `src/hooks/gps-checkin/`: `staleTime` 30 giây, `refetchInterval` 60 giây khi tab đang hiện. Biên nhận zod và hàm đổi nhãn/màu ở `src/lib/staffDay.ts`, `src/lib/gpsCheckin.ts`.
- Thành phần ở `src/components/staff-day/`: `PersonPicker`, `TeamMemberCard`, `OverdueBuildings`, `DayStatusCard`, `NowCard`, `FootprintList`, `SlotStrip`, `RouteRemaining`, `OpenJobs`, `JourneyTimeline`, `JourneyMap`, `DaySummary`, `MonthCalendar`.
- Lối vào trên máy tính: nút «Việc của quản lý» ở đầu trang Vận hành lương v5 (super admin) và bộ chọn người ở `/my-day` (cả hai vai). Mục menu bên trái cho vai Chủ công ty để Đợt 3, vì kiểu `CapabilityDefinition` hiện chỉ diễn đạt được «chỉ super admin» hoặc «theo quyền module».

### 4.8 Bản đồ

- Thư viện `leaflet` (thêm `@types/leaflet`), nạp bằng `import()` bên trong `JourneyMap` để không vào chunk đầu; không thêm vào `manualChunks` của `vite.config.ts`.
- Ảnh nền `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, ghi nguồn «© OpenStreetMap». Địa chỉ ảnh nền lấy từ một hằng số cấu hình để đổi nhà cung cấp về sau.
- Sửa CSP: thêm máy chủ ảnh nền vào `img-src` ở `vercel.json:36` (tier `infrastructure`, review chéo) và ở CSP của luồng Chrome TEST (`scripts/test-env/chrome.mjs`); chạy `npm run gate:csp-build-attestation`.
- Ghim đánh số dùng `L.divIcon` (không dùng ảnh ghim mặc định của Leaflet), đường nối nét đứt, chấm mốc GPS, dấu riêng cho ảnh ngoài bán kính.
- Đường lùi khi ảnh nền không tải được: ẩn bản đồ, hiện danh sách điểm dừng kèm link Google Maps (dùng lại bộ dựng link ở `src/lib/v5Routing.ts`).

### 4.9 Báo cáo đánh giá (Đợt 2)

`staff_period_report_v1(p_from date, p_to date, p_org uuid DEFAULT NULL)` → jsonb, chỉ Chủ công ty và super admin, kỳ tối đa 92 ngày. Không có tiền.

| Chỉ số | Nguồn |
|---|---|
| Ngày công / ngày chuẩn | `salary_attendance_day` (ticked) và `vn_workdays` / `v5_n_chuan` |
| Chuỗi tốt nhất, đứt chuỗi không phép | `salary_streak_state` (chỉ hiện với kỳ theo tháng) |
| Phép đã dùng | `salary_attendance_day` (`leave_approved`) |
| FULL đạt · có mặt · hết giờ; thời gian ở toà trung bình | `inspection_sessions` |
| Ảnh ngoài vùng / thiếu GPS | `inspection_photos.geofence_status` |
| Toà quá hạn ghé (số toà · số lần) | Lịch sử chạm toà so với `coverage_v5.sla_days`. Đề xuất định nghĩa «một lần» = một khoảng giữa hai lần chạm liên tiếp vượt SLA; chốt ở đầu Đợt 2. |
| Việc đúng hạn / tổng | `jobs` |
| Thu tiền có GPS khớp | `income_expenses.collect_geofence_status` (cách gắn người theo M4) |
| Điểm danh tự động | Mốc có dấu / mốc mong đợi (Phụ lục B) |
| Nghi án | `salary_attendance_day` (`flagged`, `voided`) |

Kèm dải ngày công từng ngày của mỗi người và danh sách toà quá hạn trong kỳ.

## 5. Các đợt và việc cụ thể

Cỡ: Nhỏ ≈ dưới một phiên làm việc, Vừa ≈ một đến hai phiên, Lớn ≈ từ ba phiên. Là ước lượng thô.

### Đợt 1 — Xem theo người

| # | Việc | Chỗ sửa | Kiểm | Cỡ |
|---|---|---|---|---|
| 1.0 | Bảy phép đo chỉ đọc M1–M7 (dưới bảng) | `npm run db:query` trên production và TEST | Ghi số đo vào mô tả PR | Nhỏ |
| 1.1 | Migration A `staff_day_xem_theo_nguoi_v1`: cổng 4.1 và năm hàm 4.2, ACL, khối `DO` tự kiểm | `supabase/migrations/` | `gate:migration-provenance`, `check-definer-acl`, `check-definer-body-authz`, `check-stable-fn-locks`, dry-run trên TEST | Lớn |
| 1.2 | Kiểm SQL và quyền: script giao dịch-rồi-rollback năm vai; ca `staff_day.*` trong ma trận cross-tenant; đo rò giữa tổ chức; kiểm đột biến gỡ cổng | `scripts/test-staff-day-authz.mjs`, `scripts/test-cross-tenant.mjs`, `scripts/measure-org-leak.mjs` | Năm vai × năm hàm: đúng người thì có dữ liệu, sai người nhận `42501`, khác tổ chức không thấy gì | Vừa |
| 1.3 | Áp TEST, sinh lại types và surfaces | `src/integrations/supabase/types.ts`, `contracts/surfaces/` | `types:check`, `check-rpc-surface` | Nhỏ |
| 1.4 | Hook, biên nhận zod, hàm nhãn/màu | `src/hooks/staff-day/`, `src/lib/staffDay.ts` | Vitest: biên nhận sai dạng bị từ chối; `42501` ra thông báo quyền | Vừa |
| 1.5 | Cửa hiển thị, route, bộ chọn người, miễn trừ Copilot | `src/components/auth/StaffDayViewerRoute.tsx`, `lazyPages.ts`, `financeWorkRoutes.tsx`, `registry.ts`, `MyDayPage.tsx` | Vitest cho cửa (mẫu `AdminOnlyRoute.feedback.test.tsx`); `navRoutesExist`, `copilotPageContracts` | Vừa |
| 1.6 | Màn 1 «Hôm nay — cả đội» | `src/pages/my-day/TeamDayPage.tsx`, `src/components/staff-day/` | Vitest; spec fleet giả lập RPC ở 390×844 | Vừa |
| 1.7 | Màn 2 «Một quản lý — hiện tại» | `StaffDayPage.tsx` | như trên | Vừa |
| 1.8 | Màn 4 «Lịch tháng» | `StaffCalendarPage.tsx`, `MonthCalendar` | Vitest cho ô ngày (Chủ nhật, lễ, phép, chưa tới) | Vừa |
| 1.9 | Màn 3: dòng thời gian và tổng kết ngày | `StaffJourneyPage.tsx`, `JourneyTimeline`, `DaySummary` | Vitest cho từng loại sự kiện | Vừa |
| 1.10 | Bản đồ và CSP | `JourneyMap.tsx`, `package.json`, `vercel.json`, `scripts/test-env/chrome.mjs` | `gate:csp-build-attestation`, `gate:bundle` (chunk đầu không tăng), Playwright: ảnh nền tải được và đường lùi khi bị chặn | Vừa |
| 1.11 | Sửa kèm (nếu Q9 đồng ý): màu ảnh ở Nhật ký kiểm tra | `src/pages/reports/OwnerDashboardV5.tsx` | Test có sẵn `InspectionPhoto.feedback.test.tsx` bổ sung ca màu | Nhỏ |
| 1.12 | Kiểm trên TEST bằng vai thật | `npm run test-env:check`; Playwright MCP 390 px | Tài khoản chủ thấy bộ chọn người và cả bốn màn; tài khoản quản lý không thấy và không đọc được người khác | Vừa |
| 1.13 | Tài liệu | `docs/he-thong/17-luong-thuong.md` (§4.12, §5.3), `13-bao-cao-dashboard-thong-bao.md` | `npm run docs:check` | Nhỏ |
| 1.14 | Phát hành | `main` → Preview → `promote:production` | `release:verify`; mở bằng tài khoản chủ trên production, chỉ đọc | Nhỏ |

Chia PR: **1A** = 1.1–1.3 (migration, review chéo); **1B** = 1.4–1.9, 1.11; **1C** = 1.10 (CSP, review chéo). 1.12–1.14 đi theo từng PR. PR 1B rebase sau PR sửa `/my-day` của phiên kia để không giẫm nhau.

Phép đo trước khi viết SQL:

- **M1** Ai qua cổng Chủ công ty theo từng tổ chức; super admin là thành viên tổ chức nào.
- **M2** Chủ công ty có qua `app_private.v5_can_view_salary_v1` không. Không qua thì hàm mới không gọi được `v5_n_chuan` cho người khác; khi đó chỉ hiện số ngày công, bỏ «ngày chuẩn» ở Đợt 1.
- **M3** `manager_salary_config.organization_id` có dòng NULL không; tập quản lý đang hiệu lực so với tập có chấm công 30 ngày.
- **M4** Thu tiền: tỉ lệ phiếu có `collect_*` mà có và không có `evidence` nguồn PAYMENT; cách gắn phiếu ↔ người thu ↔ giờ thu.
- **M5** Tỉ lệ việc hoàn thành 30 ngày có `completion_lat/lng`.
- **M6** Một ngày của một người có bao nhiêu phiên, ảnh, việc, phiếu (để chốt trần kích thước JSON).
- **M7** `salary_holidays` theo tổ chức; giá trị `system_v5.effective_from`.

### Đợt G — Điểm danh GPS tự động

| # | Việc | Chỗ sửa | Kiểm | Cỡ |
|---|---|---|---|---|
| G0 | Bản thử đo trên hai máy thật, chưa cần máy chủ: báo thức theo mốc, lấy vị trí, ghi nhật ký trong máy, nút chia sẻ nhật ký. Ghi lại model, phiên bản Android, hãng của hai máy. | `extensions/diem-danh/android/` (nhánh thử) | Hai ngày làm việc. Đạt khi ≥ 90 % mốc ghi trong ±5 phút, gồm hai tình huống: máy nằm yên từ 2 giờ, và sau khi khởi động lại máy. Không đạt thì thêm bước miễn tối ưu pin hoặc dịch vụ chạy suốt khung giờ rồi đo lại. | Vừa + 2 ngày đo |
| G1 | Migration B `gps_checkin_v1`: năm bảng 4.3, hàm 4.4, ACL, khối tự kiểm; thêm bảng vào danh sách nhạy cảm | `supabase/migrations/`, `scripts/check-definer-body-authz.mjs` | Như 1.1, cộng `check-forward-migration-idempotent` | Lớn |
| G2 | Kiểm SQL: hàm sinh mốc (PGlite, thuần), ghép nối, nhận dấu, chống trùng, chặn tần suất, từ chối ngoài khung giờ và ngày nghỉ, thu hồi máy; ca cross-tenant `gps_checkin.*` | `scripts/__tests__/gps-checkin-sql.test.mjs`, `scripts/test-gps-checkin.mjs`, `scripts/test-cross-tenant.mjs` | Kiểm đột biến cho cổng quyền và cho luật «ngoài khung giờ không lưu toạ độ» | Vừa |
| G3 | Edge function `gps-checkin-ingest`, test Deno, khai vào ma trận | `supabase/functions/gps-checkin-ingest/`, `supabase/config.toml`, `tooling/test-matrix.json`, `scripts/test-env/edge.mjs` (`CHUA_CO_O_PRODUCTION`) | `deno test`; `npm run test-env:edge -- gps-checkin-ingest`; sau deploy sinh lại `edge-function-surface.json` ngay | Vừa |
| G4 | App: khung dự án, lưu trữ, hàng đợi, gửi, ghép nối | `extensions/diem-danh/android/` | Test đơn vị `CheckinPolicy`; test trên máy ảo cho hàng đợi, ghép nối, biên nhận | Lớn |
| G5 | App: lịch mốc, lấy vị trí, dịch vụ nền, khởi động lại, tạm dừng, màn trạng thái | như trên | Test trên máy ảo với nguồn vị trí giả lập: đúng mốc, không ghi ngoài khung, đặt lại sau khởi động | Lớn |
| G6 | CI, ký, phát hành APK | `.github/workflows/android-diem-danh.yml`, `tooling/test-matrix.json`, `tooling/runtime-matrix.json`, hằng số link tải | Workflow xanh; chữ ký APK khớp; review chéo (tier `infrastructure`) | Vừa |
| G7 | Màn 8 cài đặt của chủ | `GpsCheckinSettingsPage.tsx`, `src/hooks/gps-checkin/` | Vitest: thêm/xoá khung, khung chồng nhau bị từ chối, lưu ra phiên bản mới | Vừa |
| G8 | Màn 7 phía quản lý: ghép nối (link mở app và mã gõ tay), tình trạng máy, mốc hôm nay, khối «Máy ghi những gì» | `GpsCheckinPage.tsx` | Vitest; Playwright 390 px | Vừa |
| G9 | Nối dải mốc vào màn 1–4 và hành trình | Migration nhỏ `CREATE OR REPLACE` bốn hàm 4.2; `SlotStrip`, `JourneyMap` | Chạy lại bộ 1.2; Vitest cho ô «ngoài khung giờ» | Vừa |
| G10 | Nghiệm thu trên TEST: app bản thử trên một máy thật, đủ một ngày | TEST | Màn 2, 3, 7, 8 khớp nhật ký của app; đổi khung giờ giữa ngày ra đúng như Q5 | Vừa + 1 ngày |
| G11 | Lên production theo từng người: áp migration, deploy edge, phát hành APK, bật cho một quản lý 2–3 ngày rồi người còn lại | production | Theo dõi tỉ lệ mốc có dấu và lý do mất tín hiệu mỗi ngày | Vừa + 3 ngày |
| G12 | Tài liệu hệ thống và hướng dẫn cài app cho quản lý (kèm bước tắt tiết kiệm pin theo hãng) | `docs/he-thong/27-diem-danh-gps.md`, README chỉ mục | `npm run docs:check` | Nhỏ |

Chia PR: **GA** = G1–G2; **GB** = G3; **GC** = G4–G6; **GD** = G7–G9. G0 không merge vào `main` nếu chỉ là bản thử.

### Đợt 2 — Báo cáo đánh giá

| # | Việc | Chỗ sửa | Kiểm | Cỡ |
|---|---|---|---|---|
| 2.1 | Chốt định nghĩa «toà quá hạn ghé» và «việc đúng hạn» với chủ, đo thử trên dữ liệu một tháng | `npm run db:query` | So tay với Vận hành lương v5 cho một tháng đã khoá | Nhỏ |
| 2.2 | Migration C `staff_period_report_v1` | `supabase/migrations/` | Như 1.1–1.2; đối chiếu số với `v5_shadow_report` cùng tháng | Lớn |
| 2.3 | Trang báo cáo co giãn (màn 5 trên điện thoại, màn 6 trên máy tính), chọn Tháng/Tuần/Tuỳ chọn | `StaffReportPage.tsx` | Vitest; Playwright 390 px và 1280 px | Lớn |
| 2.4 | Kiểm TEST, tài liệu, phát hành | như 1.12–1.14 | | Nhỏ |

### Đợt 3 — Bổ sung

| # | Việc | Ghi chú | Cỡ |
|---|---|---|---|
| 3.1 | Nhận xét và xếp loại tay theo kỳ | Bảng `app_private.staff_period_reviews` và hai hàm đọc/ghi; chỉ chủ thấy | Vừa |
| 3.2 | Xuất Excel báo cáo | Dùng `xlsx` đã có sẵn trong repo, nạp động; không thêm hàm DB | Nhỏ |
| 3.3 | Làm mới nhanh hơn 60 giây ở màn 1–2 | Chọn giữa rút ngắn chu kỳ và Supabase Realtime sau khi đo tải | Vừa |
| 3.4 | Mục menu «Việc của quản lý» cho vai Chủ công ty | Cần mở rộng `CapabilityDefinition` và các test hợp đồng đi kèm | Vừa |
| 3.5 | Tuỳ chọn: báo cho chủ khi một người mất tín hiệu nhiều mốc liên tiếp | Dùng web push sẵn có | Nhỏ |

## 6. Ma trận kiểm thử

| Lớp | Công cụ | Ca chính |
|---|---|---|
| Quyền trong DB | Script giao dịch-rồi-rollback với JWT giả lập, ma trận cross-tenant | Chính mình được; chủ công ty cùng tổ chức được; quản lý khác, chủ tổ chức khác nhận `42501` hoặc rỗng; `anon` không gọi được |
| Đột biến | Gỡ cổng, đổi dấu so sánh trong luật khung giờ | Bộ kiểm phải đỏ; ghi hash trước/sau theo `docs/CODEBASE_STRUCTURE.md#kiểm-thử` |
| Rò giữa tổ chức | `scripts/measure-org-leak.mjs` | Không thấy dòng của tổ chức khác; lỗi đo không được tính là đạt |
| Hàm thuần | PGlite trong `app-unit` | Sinh mốc từ khung giờ và tần suất; khung chồng nhau; đổi cài đặt giữa ngày |
| Giao diện | Vitest | Biên nhận sai dạng, lỗi quyền, trạng thái rỗng, từng loại sự kiện, từng loại ô lịch |
| Luồng màn hình | Spec fleet giả lập RPC, 390×844 | Chọn người → hiện tại → hành trình → lịch |
| Vai thật | `npm run test-env:check`, Playwright MCP trên TEST | Chủ thấy; quản lý không thấy |
| Edge | `deno test`, `npm run test-env:edge` | Sai bearer `401`; sai bộ khoá `400`; trùng `id` khác nội dung `409`; quá tần suất `429` |
| Android | JUnit, máy ảo SDK 35 | Tính mốc, hàng đợi, đặt lại báo thức, không ghi ngoài khung |
| Máy thật | G0, G10 | Tỉ lệ mốc đúng giờ; hành vi khi máy ngủ, khởi động lại, mất mạng |

## 7. Rủi ro và cách giảm

| Rủi ro | Cách giảm |
|---|---|
| Android hoặc hãng máy tự tắt app chạy nền, làm mất mốc | G0 đo trước khi dựng phần còn lại; báo thức chính xác; bước miễn tối ưu pin; hướng dẫn theo hãng; màn tình trạng máy để phân biệt «máy bị chặn» với «người tắt». |
| Vị trí giả | Cờ `isMock` gửi kèm, hiện cho chủ; đối chiếu với dấu chân việc, check nhà, thu tiền vốn có ảnh và GPS riêng. |
| Vị trí là dữ liệu cá nhân của nhân viên | Chủ đã quyết 09/11: app nội bộ, mặc định coi như đã đồng ý, không làm màn đồng ý; phần thoả thuận với nhân viên do chủ lo ngoài phần mềm. Phần mềm vẫn giữ: chỉ chủ công ty và super admin xem; không ghi ngoài khung giờ; có hạn lưu (Q3); app luôn hiện rõ là đang ghi (thông báo lúc lấy vị trí, màn trạng thái). |
| Lộ dữ liệu theo UUID đoán được | Cổng trong thân mọi hàm, ma trận năm vai, kiểm đột biến, hai bảng mới vào danh sách nhạy cảm của gate. |
| Xem người khác mà lại ghi dữ liệu | Hàm đọc mới là `STABLE`, không gọi `v5_recompute_streak`. |
| Trộn dữ liệu DEMO với công ty thật | Tổ chức đang xem lấy từ người gọi; super admin chỉ xem tổ chức mình là thành viên. |
| Ảnh nền bản đồ bị chặn hoặc nhà cung cấp đổi chính sách | Lượng dùng rất nhỏ; có đường lùi không bản đồ; địa chỉ ảnh nền là hằng số cấu hình. |
| Tăng dung lượng tải trang | Leaflet nạp động; kiểm `gate:bundle`. |
| Giờ máy sai | Lưu cả giờ máy và giờ máy chủ; cảnh báo khi lệch quá 2 phút. |
| Dấu đến muộn vì mất mạng | Trạng thái mốc tính lại mỗi lần đọc; mốc chưa nhận được hiện «chờ máy gửi» trong hạn, quá hạn mới thành «mất tín hiệu», và tự chuyển «có dấu» khi dấu về. |
| Giẫm lên phiên đang sửa `/my-day` | PR 1B rebase sau PR đó. |
| VPS hiện tại hết hạn 04/12 | App gọi thẳng edge function, không qua proxy. |
| APK tải công khai từ repo public | App vô dụng khi chưa ghép nối; mã ghép nối một lần, hạn 10 phút. |

## 8. Ngoài phạm vi

- Dấu GPS tính vào ngày công hoặc lương (Q1).
- iPhone.
- Theo dõi liên tục giữa các mốc: bản đồ nối thẳng các dấu, không phải đường đi thật.
- Hermes, Zalo.
- Nhân viên xem báo cáo so sánh.
- Sale, kỹ thuật và các vai không chấm công v5.
- Đổi cấu hình lương v5 hay `/reports/coverage` cho vai Chủ công ty.

## 9. Thứ tự và phụ thuộc

| Thứ tự | Việc | Phụ thuộc |
|---|---|---|
| 1 | Chủ duyệt bản vẽ và trả lời mục 0 | — |
| 2 | Đợt 1: M1–M7 → 1A → 1B → 1C | Bản vẽ được duyệt |
| 2 (song song) | G0 đo trên hai máy | Hai quản lý cài bản thử lên máy |
| 3 | GA → GB → GC → GD → G10 → G11 | G0 đạt; 1A đã lên |
| 4 | Đợt 2 | Đợt 1; chỉ số điểm danh cần Đợt G, thiếu thì để trống |
| 5 | Đợt 3 | Đợt 2 |

## Phụ lục A — Hợp đồng dữ liệu app ↔ máy chủ

Toạ độ dưới đây là số giả.

```jsonc
// POST …/functions/v1/gps-checkin-ingest
// Authorization: Bearer <token của máy, 64 hex>   X-Idempotency-Key: <id>

// 1) Ghép nối
{ "schemaVersion": 1, "event": "device.pair", "id": "<sha256(deviceId|pair|mã)>",
  "deviceId": "<uuid>", "pairCode": "<mã một lần>", "recordedAt": "2026-01-05T01:00:00Z",
  "device": { "model": "…", "sdkInt": 34, "appVersion": "1.0.0" } }

// 2) Một mốc
{ "schemaVersion": 1, "event": "location.ping", "id": "<sha256(deviceId|slotAt)>",
  "deviceId": "<uuid>", "slotAt": "2026-01-05T01:30:00Z", "recordedAt": "2026-01-05T01:30:07Z",
  "settingsVersion": 3,
  "fix": { "status": "fresh", "lat": 10.0, "lng": 106.0, "accuracyM": 12,
           "provider": "fused", "ageMs": 800, "mock": false },
  "reason": null,
  "device": { "batteryPct": 64, "charging": false, "idle": false, "powerSave": false,
              "appVersion": "1.0.0", "sdkInt": 34,
              "locationPermission": "always", "batteryOptimizationIgnored": true } }
// fix.status = "none" thì không có lat/lng và reason ∈
//   permission_denied | location_off | timeout | paused

// 3) Tình trạng máy (không có vị trí): event "device.state", cùng khối "device"

// Biên nhận
{ "schemaVersion": 1, "ok": true,
  "data": { "status": "accepted", "externalId": "<id>", "acceptedAt": "2026-01-05T01:30:09Z",
    "settings": { "version": 3, "enabled": true, "applies": true,
      "intervalMin": 30, "toleranceMin": 10,
      "windows": [["08:00","11:30"],["13:30","17:30"]],
      "skipSunday": true, "offDates": ["2026-01-11"],
      "tz": "Asia/Ho_Chi_Minh", "serverNow": "2026-01-05T01:30:09Z" } } }
// status ∈ paired | accepted | duplicate | state | ignored_out_of_window | ignored_off_day
```

- Máy chủ chỉ giữ SHA-256 của token. Token do app tự sinh, không bao giờ hiện ra màn hình.
- Trùng `id` cùng nội dung trả `duplicate`; trùng `id` khác nội dung trả `409`.
- App coi một mốc là đã gửi chỉ khi nhận biên nhận đúng dạng với `externalId` trùng `id`.

## Phụ lục B — Cách tính mốc và trạng thái

1. **Mốc mong đợi** của một người trong một ngày: với mỗi phiên bản cài đặt có hiệu lực trong ngày, sinh các thời điểm `from + k × interval` trong từng khung (không vượt `to`), chỉ giữ mốc rơi vào khoảng hiệu lực của phiên bản đó.
2. **Bỏ mốc** khi: tính năng tắt; người đó không được áp dụng; Chủ nhật, ngày lễ (`salary_holidays` của tổ chức), ngày phép đã duyệt (theo ba công tắc).
3. **Chưa sẵn sàng** (không tính vào mẫu số): tại thời điểm mốc người đó chưa có máy ghép nối.
4. **Trạng thái mốc**, tính lại mỗi lần đọc:

| Trạng thái | Điều kiện |
|---|---|
| Có dấu | Có dấu `fresh` với `recorded_at` trong khoảng từ 2 phút trước mốc tới hết hạn trễ. |
| Có dấu — đứng yên | Dấu `stale`, máy báo đang ngủ, vị trí không quá 60 phút tuổi (theo Q10). |
| Mất tín hiệu | Hết hạn trễ mà không có dấu hợp lệ. Lý do: máy báo `permission_denied`, `location_off`, `timeout`; hoặc «máy không báo gì». |
| Đã tắt | Máy báo `paused` (quản lý bấm tạm dừng trong app, theo Q4). |
| Chờ máy gửi | Mốc đã qua, chưa có dấu, còn trong hạn trễ cộng 5 phút. |
| Chưa tới | Mốc ở tương lai. |
| Ngoài khung giờ | Không phải mốc; chỉ là ô hiển thị giữa các khung. Dấu có mặt lúc này lấy từ việc xong, check nhà, thu tiền. |

5. **Tỉ lệ điểm danh** = số mốc «có dấu» (gồm «đứng yên») chia cho tổng «có dấu» và «mất tín hiệu». «Đã tắt» hiện riêng.
6. Dấu có cờ vị trí giả vẫn tính là có dấu nhưng mang nhãn «nghi vị trí giả» ở mọi màn của chủ.

## Phụ lục C — Thứ cần chủ làm

- Duyệt hoặc góp ý bản vẽ theo số màn.
- Trả lời mục 0 (ít nhất Q1, Q3, Q4).
- Báo hai quản lý về việc ghi vị trí và nhờ cài bản thử G0.
- Khi tới G11: nhờ từng quản lý cài app, ghép nối, cấp quyền vị trí «Luôn cho phép».

## Phụ lục D — Nhật ký thực hiện (09/11/2026)

Chủ duyệt bản vẽ và cả plan ngày 09/11; các câu mục 0 lấy theo mặc định đã nêu. Làm trong một PR thay vì chia 1A/1B/1C và GA–GD, vì các phần nối vào nhau và cùng áp một lần.

Số đo:

- M1, M2: chủ công ty qua cổng xem lương và thấy đủ toà; quản lý không qua.
- M3: hai quản lý đang hiệu lực.
- M4: `income_expenses.collect_*` không có dòng mới từ 19/07/2026, nên GPS của phiếu thu đã ngừng ghi. Nguyên nhân chưa xác nhận. Chưa sửa vì việc này đổi cách chấm công; cần chủ quyết.
- M5: mọi việc hoàn thành trong 30 ngày đều có GPS.
- M6: tối đa 4 phiên và 24 ảnh một ngày.
- M7: `effective_from` là 01/07/2026.
- Ảnh kiểm nhà: mọi ảnh trong 10 ngày có `storage_object_links` gắn tổ chức, nên chủ công ty không phải super admin vẫn mở được.

Khác plan:

| Mục | Plan | Đã làm | Lý do |
|---|---|---|---|
| G0 | Đo trên hai máy trước khi dựng tiếp | Dựng trước, đo gộp vào lần cài máy thật | Chỉ chủ và quản lý cài được lên máy thật. Mặc định tắt nên chưa ảnh hưởng ai cho tới khi chủ bật. |
| G4–G6 | Cùng đợt với cổng nhận | App Android ở PR riêng (#402) | Nhánh độc lập, CI Android riêng. Phải phát hành APK trước khi lên production để link tải có thật. |
| 1.6–1.9, 2.3 | Spec fleet giả lập RPC | Vitest, và Playwright MCP trên TEST bằng tài khoản thật | Một spec fleet mới kéo theo nghĩa vụ biên nhận riêng; Playwright trên TEST kiểm được luồng thật. |
| 3.3 | Chọn rút ngắn chu kỳ hoặc Realtime | Làm mới 30 giây | Chủ không có RLS trên các bảng nguồn nên Realtime không gửi sự kiện. |
| 3.5 | Tuỳ chọn báo mất tín hiệu | Chưa làm | Tuỳ chọn; để sau khi có số liệu thật. |
| Bản đồ | `tile.openstreetmap.org` | Thêm hai nguồn lùi OSM Đức, OSM Pháp | DNS mạng văn phòng không phân giải được tên miền chính. |
| 4.3 Dọn hạn lưu | Hàm nhận dấu tự xoá, mỗi ngày tối đa một lần | Mọi sự kiện từ máy và mỗi lần lưu cài đặt đều dọn; hàm đọc ẩn toạ độ quá hạn | Chỉ dọn lúc nhận dấu thì tắt tính năng rồi toạ độ cũ còn đọc được. Lọc đọc mới là bảo đảm chính. |
| Báo cáo «toà quá hạn» | Đúng ba nguồn của `building_coverage` | Thêm phiên có mặt đã bị job đêm đổi `expired` | View quên các phiên này sau nửa đêm; người đã đến không nên bị tính quá hạn. |
