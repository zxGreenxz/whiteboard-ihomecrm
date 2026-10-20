# B3 — Thiết kế RPC phòng lọc trong SQL `hermes_available_rooms_page_v1` (20/10/2026, chưa viết migration)

Thiết kế từ khảo sát source (chỉ đọc) trên worktree `claude/hermes-toc-do-dot1-20261020`; chưa đo thời gian/plan trên TEST. Mục tiêu theo PLAN-TOI-UU-TOC-DO-TOI-DA §3 B3 và §10 (plan nằm ở worktree Codex, chưa commit): đẩy lọc tòa/trạng thái/trang xuống SQL, giữ đủ điều kiện trang Sale, dùng chung công thức trạng thái, tổng trên cùng tập lọc, không ảnh/JSON thừa nhưng giữ nội thất chữ/giá/trạng thái/che contact.

Nguồn chính: `supabase/migrations/20261010022101_public_room_sale_policy.sql` (PUB, `get_public_available_rooms`), `20261010114500_…` (FACT, `room_sale_workflow_fact_v1`), `20261016080232_hermes_sale_listing_parity_v1.sql` (PAYLOAD), `20261017023242_hermes_scope_buildings_v1.sql` (SCOPE), `20261019144508_…tombstones_v1.sql` (TOMB), `20261019040111_hermes_domain_read_fast_v1.sql` (FAST), `infra/hermes-broker/room-read-service.mjs` (SVC), `room-read-projection.mjs` (PROJ), `broker.mjs` (BRK), `group-preview-adapter.mjs` (GADAPT), `web-parity.json`, `scripts/check-hermes-web-parity.mjs`.

## 0. Quyết định thiết kế (đề xuất)

1. **Nhận binding 4 trường bắt buộc** (`connectionId, tokenDigest, expectedEpoch, expectedSessionRevision`) như `hermes_domain_read_fast_v1`: DB tự kiểm kết nối và tự suy tập tòa được phép; `p_organization_id` chỉ để khẳng định; `p_building_ids` chỉ thu hẹp, không là bằng chứng quyền.
2. **STABLE + SECURITY DEFINER, một hàm public**; không dùng khuôn "INVOKER wrapper + DEFINER rows(plan)" vì reader dòng ở đây buộc phải DEFINER (`room_sale_workflow_fact_v1` đã REVOKE khỏi `authenticated`; `public_room_share_tokens` có RLS theo owner nên phải đọc chéo owner như `hermes_sale_listing_payload_v1`).
3. **Công thức trạng thái = gọi nguyên `app_private.room_sale_workflow_fact_v1`** (không gọi `_base_` vì mất lock tạm). Vì thôi gọi `get_public_available_rooms`, phần chọn trang (token→owner, `soon_days`, overlay pass, che contact, địa chỉ, hotline, thứ tự) phải chép lại — rủi ro lớn nhất (R1).
4. **Tổng và trang trong cùng một câu**: CTE `MATERIALIZED`, `count(*)` riêng, `row_number()` theo thứ tự có ID.
5. **Group preview/send/lịch giữ đường legacy** (digest ở `GADAPT:236-237` buộc payload cũ).
6. **Cờ `roomRead: 'legacy'|'page'`** mặc định `legacy`; thiếu RPC thì lỗi, không ngầm fallback.

## 1. Bảng điều kiện Sale → RPC mới giữ bằng cách nào

| # | Điều kiện | Nơi hiện có | RPC mới |
|---|---|---|---|
| 1 | Link chia sẻ còn hiệu lực theo công ty | PAYLOAD:37-39; PUB:44-50 | CTE `owners` cùng vị từ; `publishedPages = count(owners)`; token không ra khỏi hàm |
| 2 | Một trang mỗi owner | PAYLOAD:36-39 | `GROUP BY t.owner_id` |
| 3 | Chỉ tòa của owner có link | PUB:86 | `JOIN owners ON owner_id = b.user_id` |
| 4 | Đúng công ty | PUB:82; PAYLOAD:51,63 | `b.organization_id = v_org AND r.organization_id = b.organization_id` |
| 5 | Loại tòa ảo/xóa mềm, phòng xóa mềm | PUB:87-89 | cùng 3 vị từ ở tầng tĩnh |
| 6 | `soon_days` theo owner (mặc định 30) | PUB:52-55 | `LEFT JOIN public_room_settings` theo `b.user_id` |
| 7 | Room-pass đúng owner và active | PUB:83-84 | `LEFT JOIN` y hệt; `has_pass := pl.id IS NOT NULL` |
| 8 | Công thức trạng thái (cọc giữ chỗ, next_claims, RESERVED, HĐ, notice, PREPARING, lock tạm) | PUB:85; FACT:82-157 | `CROSS JOIN LATERAL room_sale_workflow_fact_v1(...)` chỉ trên phòng ứng viên; guard `calls` ở web-parity + test đột biến |
| 9 | Chỉ `free/soon/pass` | PUB:92; PROJ:106 | `status_public IN (...) AND (p_statuses IS NULL OR = ANY)`; giá trị khác → 22023 |
| 10–11 | Che contact pass khi `contact_manager`; giá/chính sách/ngày pass chỉ khi `status='pass'` và `pass_avail_date ≥ sale_today` | PUB:74-79 | CASE y hệt |
| 12 | Allowlist cột (không ảnh, `sale_bonus_note`, `sale_lock`, `max_occupants`) | PAYLOAD:44-63 | liệt kê tường minh 23 cột phòng + 8 cột tòa |
| 13 | Nội thất chữ | PAYLOAD:55; PROJ:46-52,127 | trả `amenities` jsonb + `left(description,241)`; ghép chữ ở JS |
| 14–16 | Hotline/contact tòa; chính sách sale trang; địa chỉ | PUB:112-125,148-162 | LATERAL hotline đúng thứ tự; `salePolicies` theo thứ tự xuất hiện trên toàn tập lọc |
| 17 | Phạm vi quyền: `rooms.view` CRM ∩ phạm vi trợ lý (ORG/BUILDING/AREA; CASHBOOK=0; tombstone=0) | SCOPE:25-49; TOMB:91-137 | DB suy `A_db` từ kết nối, fork khối admission FAST:54-99 với `'rooms.view'` |
| 18 | Kết nối hợp lệ (ACTIVE, token, phiên, assistant, epoch, revision) | TOMB:31-50; FAST:54-67 | `p_binding`; lệch epoch/revision → PT409, còn lại 42501 |
| 19 | Trần 2000 và `completeness` | SCOPE:280; PROJ:135 | phải chốt (R5) |
| 20 | Thứ tự phòng | PAYLOAD:69-72 | `ORDER BY b.name, b.id, r.floor DESC NULLS LAST, r.name, r.id` |
| 21 | Lọc tên tòa chuỗi con, không phân biệt hoa thường, không trim | PROJ:107 | `strpos(lower(b.name), lower(v_q)) > 0` (không ILIKE vì `%`/`_`) |
| 22 | `no_sale_page` ≠ hết phòng | PAYLOAD:43; PROJ:136 | `publishedPages` độc lập bộ lọc/phạm vi |
| 24 | "Hôm nay" theo múi giờ công ty | trong fact (`org_today_v1`) | tự theo |

Khác legacy có chủ ý: RPC mới kiểm kết nối Hermes ngay trong DB (legacy `hermes_sale_listing_rooms_v1` chỉ kiểm membership + `rooms.view`).

## 2. Chữ ký

```sql
public.hermes_available_rooms_page_v1(
  p_binding jsonb,                     -- bắt buộc, 4 trường
  p_organization_id uuid,              -- chỉ khẳng định = org của kết nối
  p_building_ids uuid[] DEFAULT NULL,  -- chỉ thu hẹp; ngoài tập → 42501
  p_building_name text DEFAULT '',
  p_statuses text[] DEFAULT NULL,      -- NULL = cả 3; khác {free,soon,pass} hoặc rỗng → 22023
  p_limit integer DEFAULT 50,          -- 1..100
  p_offset integer DEFAULT 0           -- 0..2000
) RETURNS jsonb  -- {authority:{organizationId,userId,connectionId,permission:'rooms.view',buildingIds,cashbookIds:[]}, result:{publishedPages,totalCount,offset,limit,nextOffset,rooms,buildings,salePolicies}}
```

Tên khớp regex `^hermes_[a-z0-9_]+_v[1-9][0-9]*$` của `createBoundUserRpcTransport`. Mã lỗi: 42501 (không authenticated, kết nối/phiên/token sai, `rooms.view` tắt/loại, org khác, `p_building_ids` ngoài tập, tập tòa rỗng); PT409 (epoch/revision lệch); 22023 (tham số sai, >256 tòa).

Thứ tự lọc bắt buộc: `owners` → tòa tĩnh (org, chưa xóa, không ảo, `id = ANY(v_scope)`, owner có link, tên khớp) → phòng của các tòa đó → fact đúng một lần mỗi phòng → lọc `status_public`/`p_statuses` → đếm tổng, cắt trang. Không tiền lọc theo `rooms.status` (nhánh HĐ của fact không phụ thuộc nó). **Chi phí = số phòng ứng viên**: lợi lớn khi có `buildingName`/`p_building_ids`; không lọc thì chỉ đỡ JSON/ảnh/tòa ngoài phạm vi (R6).

## 3. Khung SQL

Xem khối pseudo-SQL trong lịch sử khảo sát (agent B3 20/10): helper `app_private.hermes_room_page_admission_v1(p_binding)` (fork FAST:54-99 cho `rooms.view`), hàm public DEFINER STABLE với CTE `owners` → `cb` (tòa tĩnh + settings + hotline LATERAL) → `facts` (rooms ⋈ pass ⋈ LATERAL fact) → `listed` (lọc trạng thái + `row_number()`) → `page`; `jsonb_build_object` trả `authority` + `result`; cuối migration `OWNER postgres`, `REVOKE ALL` khỏi PUBLIC/anon/authenticated/service_role/hermes_store_executor rồi `GRANT EXECUTE … TO authenticated`, `DO $assert$` (ACL, prosecdef, provolatile='s', thân chứa `room_sale_workflow_fact_v1(` và không chứa `get_public_available_rooms(`), `NOTIFY pgrst,'reload schema'`.

Tái dùng nguyên: `room_sale_workflow_fact_v1` (+`_base_`, `room_sale_lock_open_id_v1`, `org_today_v1`, `room_has_holding_deposit`); trong admission: `hermes_metadata_member_v1`, `hermes_metadata_domain_grant_v1`, `get_authorization_context_v1`, `hermes_effective_org_policy_v1`, `is_actor_offboarded_v1`, `hermes_request_v1`, `hermes_uuid_v1`, `hermes_integer_v1`. Phải chép (có test chống trôi): vị từ chọn trang của PUB và khối admission FAST. Không đụng: `hermes_sale_listing_rooms_v1`, `hermes_sale_listing_payload_v1`, `hermes_room_scope_map_v1`, `hermes_group_*`, hàm lịch.

## 4. Trường trả ra (so với projection hiện tại)

Phòng 23 cột: `id, building_id, floor, name, code, area, rent_price, deposit_amount, amenities, description, sale_note, room_type, status_public, sale_state, avail_date, sale_today, expected_ready_on, pass_contact_name, pass_contact_phone, pass_sale_policy, pass_price, pass_avail_date, pass_contact_manager` (clip `left(…,241)`/`left(…,81)` để JS 240/80 cho cùng kết quả). Bỏ: `images`, `max_occupants`, `sale_bonus_note`, `sale_lock`, phòng `rented`, phòng ngoài trang. Tòa 8 cột: `id, name, code, address, public_contact_name, public_contact_phone, page_contact_name, page_contact_phone` (chỉ tòa có phòng trong trang). Tổng: `totalCount, nextOffset, publishedPages, salePolicies`. JS giữ: `source`, `readAt`, `currency`, `completeness`, kiểm lại `nextOffset`, `statusLines/availability/roomType/amenities` (`roomSaleFacts.ts`). Cần sửa `BRK:131` chấp nhận nhãn `source` mới; đường group giữ nhãn cũ.

## 5. Test

- **Parity với oracle thật** (PG17, `SET ROLE authenticated`, loader `definitions()` của `crm-shared-read-sql-fixture.mjs` phải lấy bản cuối của hàm): P1 nhiều owner (hotline/soon_days/chính sách khác, 2 token cùng owner), P2 không link (`publishedPages=0`), P3 scope xóa mềm (unrestricted trả tòa sống; restricted: legacy lỗi — khác biệt đã duyệt), P4 tòa ảo/xóa, P5 mọi trạng thái (READY/PREPARING/NOTICE biên soon_days/OVERDUE/RESERVED/cọc giữ chỗ/next_claims/lock tạm/MAINTENANCE), P6 pass và che contact, P7 trang rỗng/cuối (ghép trang = tập đầy đủ), P8 tên tòa trùng + ký tự `%`/`_`/chữ Việt, P9 lọc trạng thái, P10 phạm vi ORG/BUILDING/AREA/CASHBOOK-only, P11 quy mô 2001 phòng.
- **Bảo mật** S1–S10: kết nối user khác, token sai/revoke/hết hạn, epoch/revision lệch (PT409), session_id JWT lệch, `rooms.view` bị loại/policy tắt/offboarded, org khác, `p_building_ids` ngoài tập, anon/service_role/store_executor gọi (ACL), output không chứa token/ảnh/dữ liệu owner không link, thu hồi giữa hai lượt.
- **Chống trôi** G1 mục `mirrored` mới trong `web-parity.json` (hash PUB, `calls: ['room_sale_workflow_fact_v1']`), G2 so khối admission với `hermes_domain_read_scope_fast_v1`, G3 đếm số lần gọi fact = số ứng viên, G4 13 đột biến (bỏ JOIN owners, bỏ is_virtual/deleted_at, bỏ `pl.user_id=b.user_id`, bỏ che contact, soon_days cố định, fact→`_base_`, bỏ lọc status, `count(*) OVER()`, bỏ tie-break id, tin `p_building_ids`, bỏ kiểm epoch, ILIKE, LIMIT trước lọc), G5 `DO $assert$` + `hermes-durable-schema.test.mjs` + `gen:types`.
- **Broker/JS** J1 `projectAvailableRoomsPage` deep-equal legacy, J2 `hermesSaleListingParity.test.ts`, J3 `room-read-service.test.mjs` page mode gọi đúng 1 RPC + map lỗi + mặc định legacy, J4 group giữ legacy và digest không đổi, J5 `roomResult` nhận page mode.
- **Đo TEST**: `EXPLAIN (ANALYZE, BUFFERS)` (loops fact = số ứng viên), bytes legacy vs page, thời gian theo tòa ≤ 0,8 s ấm (chưa có số).

## 6. Rủi ro và quyết định cần chốt

- **R1 Bản chép thứ tư của trang Sale** (`get_public_available_rooms` đã định nghĩa lại 16 lần từ 06/06 đến 10/10). Giảm thiểu bằng G1+G2+parity oracle thật. **Hướng sạch dài hạn:** trích lõi dùng chung, đổi `get_public_available_rooms` thành wrapper byte-for-byte như TG5 đã làm cho `customer_list_v1`/`contract_list_v1`/`invoice_list_v1` — PR riêng vì đụng endpoint công khai.
- **R2/R3** Hai nguồn "phòng đang đăng" (tool page vs group legacy); `prepareAvailableRooms` dùng chung phải nhận tham số nội bộ `legacy|page`; group preview không bao giờ đi page.
- **R4** Admission kiểu FAST khoan dung hơn legacy với scope restricted trỏ đích xóa mềm (legacy 22023); tập tòa rỗng → 42501 thay vì `backend_unavailable`.
- **R5** Trần 2000/`completeness`: legacy cắt trước lọc scope trợ lý/tên; page tính đúng — chốt giữ `totalCount` thật + `sourceCapped`, hay kẹp 2000.
- **R6** Chi phí fact theo số ứng viên; không lọc tòa thì gần bằng legacy — cần đo; nếu admission chiếm phần lớn thì xét giảm sau.
- **R7** `lower()` PG phụ thuộc `lc_ctype` (chưa kiểm); **R8** lệch có sẵn NOPAGE vs PUB (soon_days/pass theo org) — không sửa trong B3; **R9** 100 phòng dễ vượt trần tool 64 KiB, mặc định 50; **R10** `statement_timeout` role authenticated chưa kiểm; **R11** điểm chạm migration: tên file > `20261019144508`, receipt, `DSCHEMA` PUBLIC list, `gen:types`, mục parity, cờ `roomRead` ở `server.mjs:110,117`, `room-read-service.test.mjs`.

**Chốt trước khi viết migration:** (1) chép trang cho B3 hay trích lõi dùng chung trước (khuyến nghị: B3 chép + G1/G2, lõi dùng chung là PR sau); (2) binding 4 trường (khuyến nghị); (3) `p_building_ids` ngoài tập → 42501 (khuyến nghị); (4) hành vi trần 2000; (5) nhãn `source` và tên khóa (`rooms`/`buildings`); (6) chấp nhận R4.
