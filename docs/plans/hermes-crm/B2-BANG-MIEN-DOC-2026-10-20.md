# B2 — Bảng miền đọc chưa đi đường nhanh (khảo sát source 20/10/2026)

Khảo sát chỉ đọc trên worktree `claude/hermes-toc-do-dot1-20261020` (base `b37089f1d`), không chạy test/SQL. Mục đích: chọn miền chuyển sang đường nhanh theo PLAN-TOI-UU-TOC-DO-TOI-DA §3 B2 (plan nằm ở worktree Codex, chưa commit). Số trong ngoặc = số lượt gọi trong 17 phiên Zalo thật 15–19/10.

Quy ước: V/S = VOLATILE/STABLE; D/I = DEFINER/INVOKER; phạm vi T = tòa, C = công ty, S = sổ quỹ, P = platform, Me = người hỏi. Bind7 = `connectionId, tokenDigest, expectedEpoch, expectedPolicyVersion, expectedMembershipId, expectedAuthorizationVersion, expectedSessionRevision` (`bound-user-operation.mjs:48-50`); Bind4 (fast) = `connectionId, tokenDigest, expectedEpoch, expectedSessionRevision` (`domain-read-fast.mjs:13-16`). readAuthority = authority gọn của đường nhanh: `rooms.view` + caps v1/v2/v3 (`server.mjs:147-149`).

**Đường thường (mọi tool dưới đây):** mỗi lượt dựng quyền đầy đủ 2 lần (resolve + checkUnchanged), mỗi lần 1 Auth + 14 RPC capabilities ≈ 31 request/lượt, thêm `verifySession` ở prepare; SQL gọi `hermes_private_command_connection_v1` 2 lần (khoá hàng `organizations` `FOR NO KEY UPDATE`). Đường nhanh: 7 request khi cache trượt, 0 khi trúng (vẫn 4 lần `hermes_store_read_connection_v1`).

**B2-2 — đường thường dùng cache catalog (20/10, nhánh `claude/hermes-b2-2-cached-admission-20261020`):** khi host bật `readFastPath`, 18 miền còn lại (`CACHED_READ_OPERATIONS` trong `domain-contract.mjs`; trừ `crm_read_zalo_conversations`) giữ nguyên RPC đã review (`hermes_domain_read_v1/v2/v3`, `hermes_w2_read_v1`) và Bind7 dựng từ snapshot `readConnection` sống, nhưng lấy identity từ `createReadCatalogAuthority` (cache ≤5 phút, khoá = hash cả snapshot) và bỏ `auth.verifySession` ở prepare lẫn `checkUnchanged` ở broker và finalize (`bound-user-operation.mjs` chế độ `admission: 'cachedBinding'`) — vì chính SQL đã so `auth.uid()`, `session_id` của JWT, gate phiên và đủ 7 trường binding (42501/PT409), cùng lập luận đường nhanh chủ đã chấp nhận 19/10. Kỳ vọng mỗi lượt: bỏ ≈1,1 s checkUnchanged, resolve 1,0–1,7 s → ≈60 ms khi cache trúng; TG3b (server.test): 93 → 7 request Auth/capability cho 3 lượt lạnh+ấm. `tool_call_timing.path` = `cached`, `checkMs` null. `zalo_conversations` giữ đường thường vì `chat_zalo.view` do group adapter cấp, không có trong readAuthority (nếu ép sẽ `tool_not_available`). Hệ quả: rào `scopesByPermission` phía broker có thể cũ ≤5 phút nhưng chỉ thu hẹp, không nới (SQL quyết định cuối; mọi đổi phân quyền nhảy `authorizationVersion` ⇒ cache trượt). Tắt cờ: không đổi gì; §6 (4 lần `hermes_store_read_connection_v1`/lượt) vẫn là chỗ tối ưu tiếp.

**R2a — `summary` phía máy chủ (21/10, migration `20261020233934_hermes_domain_summary_v1` + `20261021004841_hermes_w2_domain_summary_v1`, đã áp production 21/10 09:46–09:51):** mỗi kết quả của 13 tool danh sách mang `summary` ngay sau `domain`, tính trên TOÀN tập đã lọc (query/buildingId/status/fromDate/toDate), bỏ cursor/limit, cùng phạm vi quyền/toà với `items` (đường nhanh: cùng RLS người hỏi). Khuôn chung `{count, byStatus, sum}`: `byStatus` đếm theo cột trạng thái (assets: `condition`), chỉ giá trị có mặt, `{}` khi miền không có; `sum` là tiền/số lượng dạng chuỗi như dòng, `{}` khi miền không có. Ba miền đường nhanh không có trong bảng dưới: `crm_read_customers` (v3 + lõi nhanh) `{count, {}, {}}`; `crm_read_contracts` `{count, byStatus, {}}` — đường nhanh `count` = `total` của lõi, `byStatus` = null khi có `query` (lõi khớp ILIKE nhiều cột); `crm_read_invoices` `{count, {}, {}}` (cả hai lane không cộng tiền: tổng mọi trạng thái dễ đọc sai, tổng kỳ ở `crm_read_invoice_report report=stats`). Connector kiểm khuôn chính xác + bất biến (`count` ≥ số dòng trang, `byStatus` đúng bộ lọc, `byBuilding` trong phạm vi khoá); lọc theo phòng ở connector thay `summary` bằng summary của các hàng giữ lại khi đã đọc hết, còn trang thì `null`. Cửa sổ phát hành: connector chấp nhận VẮNG summary một bản (`DOMAIN_SUMMARY_TOLERANT`, `summaryTolerant` của monthly_pnl) ⇒ connector lên TRƯỚC, hai migration SAU; revert soạn sẵn ở `docs/plans/hermes-crm/revert/`. Không đổi byte `tools/list`.

**R2c — phiếu lớn nhất theo loại (21/10, migration `20261021035022_hermes_domain_summary_largest_by_type_v1`, CHƯA áp TEST/production):** production hỏi "khoản chi lớn nhất tháng này" ⇒ `crm_read_income_expenses {fromDate,toDate}` (tool không có tham số loại) ⇒ `summary.largest` là phiếu lớn nhất của cả thu lẫn chi (một phiếu THU). Mỗi phần tử `byType.<INCOME|EXPENSE>` thêm `largest` (cùng khuôn `largest`, phiếu lớn nhất của loại đó trên cùng tập đã lọc, bỏ CANCELLED, hoà thì id nhỏ hơn); `largest` toàn bộ giữ nguyên. Chỉ nhánh income_expenses của `hermes_domain_read_v2` đổi. Connector R2c đóng cửa sổ R2a (summary bắt buộc) và mở cửa sổ một bản cho khoá con này (`DOMAIN_SUMMARY_ENTRY_TOLERANT`) ⇒ connector lên TRƯỚC, migration SAU; revert soạn sẵn `docs/plans/hermes-crm/revert/hermes_domain_summary_largest_by_type_revert_v1.sql`. Không đổi byte `tools/list`.

## 1. Họ v1 — `hermes_domain_read_v1` (V/D, `20261014081902`), Bind7, `domainResult` generic, test `domain-composition.test.mjs`

| Tool | Quyền · phạm vi | Web RPC/core chung | Công B2 | `summary` (R2a) |
|---|---|---|---|---|
| `crm_read_leads` | `leads.view` · T (lead không tòa cần C) | Không (web đọc bảng dưới RLS) | Vừa: chưa có core INVOKER, ít dùng | `{count, byStatus (status), sum {}}` |
| `crm_read_assets` | `assets.view` · T (+C) | `assets_list_v1` (W2D, S/I; sắp theo created_at ≠ keyset id) | Vừa: nên đi qua `crm_read_report` | `{count, byStatus (condition), sum {quantity}}` |
| `crm_read_services` | `services.view` · T | `services_list_v1` (W2D, S/I) | Vừa | `{count, byStatus {}, sum {}}` |
| `crm_read_tasks` | `tasks.view` · T | Không (`useJobs.ts` đọc bảng jobs) | Vừa: cần core jobs INVOKER | `{count, byStatus (status), sum {}, overdue}` — `overdue` = IN_PROGRESS có `deadline` < now() |

## 2. Họ v2 — `hermes_domain_read_v2` (V/D, `20261015120000`, khoá org 2 lần), Bind7, `domainResult` v2 (+`source`, `fetchedAt`, kiểm ngày), test `domain-v2.test.mjs`

| Tool | Quyền · phạm vi | Web RPC/core chung | Công B2 | `summary` (R2a) |
|---|---|---|---|---|
| `crm_read_income_expenses` | `income_expenses.view` · T | Không (`queries.ts` đọc bảng) | Lớn: loại phiếu hạn chế, RLS phiếu thu nặng (`20261018044046`) | `{count, byStatus (approvalStatus), sum {totalAmount}, byType {INCOME/EXPENSE: {count, sum, largest}}, largest}` — tiền (`sum`, `byType`, `largest`) KHÔNG gồm phiếu CANCELLED, `count`/`byStatus` gồm; `byType.<loại>.largest` (R2c) = phiếu lớn nhất của loại |
| `crm_read_receivables` **(23)** | `invoices.view` · T | Không RPC riêng; web đọc bảng invoices (`useDashboard.ts:251-262`, `financeReports.ts:28-68`); `invoice_list_core_v1` thiếu lọc due_date/remaining>0/trạng thái | **Vừa — chuyển trước số 1** | `{count, byStatus, sum {totalAmount, paidAmount, remainingAmount}, byBuilding}` — `byBuilding` ≤ 50 toà, `remainingAmount` giảm dần; cùng SQL hai lane |
| `crm_read_meter_readings` | `meter_readings.view` · T | Không | Vừa | `{count, byStatus, sum {consumption}, byType (meterType), rooms}` |
| `crm_read_deposits_held` | `deposits.view` · T | `get_held_deposit_summary` (S/I) — Hermes đã gọi đúng RPC | Nhỏ | `{count (toà), sum {expected, held, shortfallAll}, contractCount, fullCount, shortCount}` |
| `crm_read_building_profit` | `reports_finance.analysis` · T | `fa_monthly_pnl` (S/D, tự kiểm `can_access_building`) | Nhỏ–Vừa | `{count (toà), sum {revenue, expense, net}}` |

## 3. Họ v3 — `hermes_domain_read_v3` (V/D, `20261018000000:528-792`); báo cáo qua `app_private.hermes_report_read_v2` (V/D); Bind7; test `domain-v3`, `full-read-report`, `full-read-sql-fixture`

| Tool | Quyền · phạm vi | Web RPC/core chung | Công B2 | `summary` (R2a) |
|---|---|---|---|---|
| `crm_read_occupancy` (3) | `reports_real_estate.occupancy` · T | `occupancy_snapshot_v2` (S/I) — cùng RPC | Nhỏ | `{count (toà), total, occupied, available}` — tổng các dòng snapshot |
| `crm_read_occupancy_report` | cùng khoá · T | `occupancy_snapshot_v2`, `occupancy_upcoming_vacancy_v2` | Nhỏ–Vừa (phong bì báo cáo) | — (`summary` null như trước) |
| `crm_read_monthly_pnl` (4) | `reports_finance.analysis` · T | `fa_monthly_pnl_accrual`/`fa_monthly_pnl` (S/D); phần chờ duyệt `hermes_pnl_pending_v1` chỉ ở `app_private` (D) | Vừa: 11 khoá input; chưa có số đo SQL | `{basis, pendingIncome, pendingExpense, pendingVouchers}` + `{revenue, expense, net, rows}` — tổng MỌI hàng (mọi trang, cùng toà/kỳ) |
| `crm_read_invoice_report` | `invoices.view` (+`customers.view`) · T | `invoice_list_v1`/core, `invoice_statistics_v3` | Vừa: core đã đủ lọc | `report=stats`: summary sẵn có (không đổi) |
| `crm_read_contract_search` | `contracts.view` (+`customers.view`) · T | `contract_list_v1`/core, `contract_stats_v2` | Vừa | — |
| `crm_read_pending_approvals` | `income_expenses.view` · C và Me | `list_my_pending_approvals_v1` | Vừa: scope fast phải tính org_wide ∩ overlay | — |
| `crm_read_zalo_conversations` | `chat_zalo.view` · C | Không (RLS `zalo_authorized_org_ids`) | Vừa–Lớn: khoá không nằm trong readAuthority | summary sẵn có (không đổi) |
| `crm_read_customer_detail` | `customers.view` (+`contracts.view`) | Không | Vừa–Lớn: SQL lớn, PII | — (chi tiết) |
| `crm_read_contract_detail` | `contracts.view` (+`customers.view`) | Không | Vừa–Lớn | — (chi tiết) |

## 4. W2 — `crm_read_report_list`, `crm_read_report` (`hermes_w2_read_v1` V/I → `hermes_w2_scope_v1` V/D → gói `hermes_w2{a..d}_read_v1` V/I dưới RLS → `hermes_w2_finish_v1` V/D), Bind7, 35 khoá W2, phạm vi T/C/S/Me/P, projection `listResult`/`runResult` (fence)

Công **Vừa–Lớn**: bỏ được core vì pack đã INVOKER, nhưng phải viết `scope_fast` + `finish_fast` mới, bỏ khoá org, binding 7→4; `domainFastResult` không dùng được (`permission=null`, phong bì dùng `fence`); test nhân theo 4 gói.

## 5. Adapter riêng

| Tool | Đường hiện tại | Công B2 |
|---|---|---|
| `crm_available_rooms` (29) | `room-read-service.mjs` → `hermes_room_scope_map_v1` (S/D) rồi `hermes_sale_listing_rooms_v1` (S/D), tuần tự; đường `room` đã bỏ `checkUnchanged` nhưng vẫn authority đầy đủ + `verifySession` lần 2; payload tới 2 MB lọc ở Node | Vừa, gần như chỉ ở broker (SQL đã STABLE): đổi sang readAuthority, bỏ `verifySession` lần 2, gộp 2 RPC — và B3 đẩy lọc xuống SQL |
| `crm_room_lookup` (6) | `hermes_room_pass_upsert_v2` (V/D) bọc upsert v1 (có bảng biên nhận) | Lớn: hàm ghi/đọc gộp, PII — cần hàm lookup chỉ-đọc mới |
| `crm_task_follow_list` (10) | `hermes_task_follow_read_v1` (V/D, khoá org + FOR SHARE); bảng `app_private.hermes_task_follows` chỉ ở Hermes | Vừa–Lớn |
| `crm_task_input_options` **(21)** | `hermes_task_input_options_v1` (V/I) = guard V/D (khoá org, `authorize_tenant_action_v3` từng tòa) → rows V/I (RLS); quyền action `tasks.create` không nằm trong readAuthority | **Vừa — chuyển trước số 2** |

## 6. Khoá cache của `read-catalog-authority.mjs:28-48`

Khoá = `hash(JSON.stringify(snapshot))` của `connectionStore.readConnection` (SQL `app_private.hermes_store_read_connection_v1`, `20261014000503:128-157`, V/D, `FOR SHARE`). Trường **đổi theo thời gian** trong snapshot: `connection.expiresAt` (mỗi lần gia hạn token, ≈10 phút/lần), `session.revision` (+1 mỗi refresh phiên), `session.envelope.*` (mới mỗi refresh), `session.expiresAt`; `membership.authorizationVersion` nhảy khi có bất kỳ thay đổi phân quyền trong công ty. ⇒ TTL cứng ≤ 5 phút nhưng gia hạn cắt khoá ≈ 10 phút/lần: khoảng một nửa cửa sổ bị cắt. Có thể bỏ bốn trường thời gian khỏi khoá vì SQL fast tự đối chiếu epoch/session revision từ lần đọc tươi ở `prepare`, nhưng phải sửa test negative-control `read-catalog-authority.test.mjs:80-93` — **không làm trong B2**. Chi phí nền khi cache trúng: 4 lần `hermes_store_read_connection_v1` mỗi lượt (identify, joined trong resolve, joined trong prepare, readConnection trong prepare) — chỗ tối ưu tiếp (dùng lại snapshot trong một request).

## 7. Kết luận

1. Đường nhanh hiện cứng 3 miền ở `domain-read-fast.mjs:5`, `broker.mjs:348-349,923`; cờ `readFastPath` boolean (`host-config.mjs:122`). B2 cần allowlist theo miền; thiếu RPC phải fail-closed (`server.test.mjs:203-207`) → áp SQL trước, đổi JS sau.
2. **Chuyển trước số 1: `crm_read_receivables`** — đi đúng ống nhanh có sẵn (cùng mount, readAuthority đã có `invoices.view`, cùng RPC `hermes_domain_read_fast_v1`). Việc: ánh xạ quyền trong `hermes_domain_read_scope_fast_v1` + nhận 7 khoá input (có ngày); nhánh rows + core INVOKER lọc `due_date`, `remaining>0`, 3 trạng thái; trả `source`/`fetchedAt` cho v2; thêm `receivables` vào `FAST_READ_OPERATIONS`. Không có trang web để bắt chước → chốt nghĩa Hermes; rủi ro: RLS thay lọc tay có thể trả ít dòng hơn (như vụ 4 trường khách) → cặp parity normal-vs-fast bắt buộc.
3. **Chuyển trước số 2: `crm_task_input_options`** — rows đã INVOKER, cần scope STABLE kiểu fast cho khoá action `tasks.create` + bản STABLE của rows; điều kiện: mở readAuthority bằng `createTaskAuth`; rà `initialReadAdmission` cho khoá action; quyết giữ/bỏ `authorize_tenant_action_v3` từng tòa và hạn `nearest_deadline`; sửa nhánh task ở `broker.mjs:834-849`.
4. Chưa đưa vào B2: `task_follow_list`, `income_expenses`, W2 report, `room_lookup`, `customer/contract_detail`; `crm_available_rooms` làm ở B3.
5. Gói rẻ nếu không đụng authority: `occupancy`, `deposits_held`, `building_profit`, `monthly_pnl` (Hermes đã gọi đúng RPC web) — lợi ích nhỏ vì ít dùng.
6. Gate mỗi miền mới: migration forward; cập nhật digest `scripts/hermes-read-function-specs.mjs` và ACL `scripts/__tests__/hermes-durable-schema.test.mjs`; mục `web-parity.json`, schema-change-evidence, provenance; test parity normal-vs-fast trên cùng fixture.
